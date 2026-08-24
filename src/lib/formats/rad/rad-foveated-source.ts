import * as THREE from 'three/webgpu';
import type { LodRun } from '../../lod-scheduler';
import type { LodSource, LodSourceOptions } from '../../lod-source';
import { RadParentSizes } from './rad-parent-sizes';
import type { SplatData } from '../../splat-data';

/** Stand-in for an infinite parent size (root, or parent not yet decoded); the
 * frontier cut treats any node at this size as "always big enough to keep".
 * Matches `FRONTIER_ROOT_SIZE` in the material. */
const FRONTIER_ROOT_SIZE = 1e30;

/** Spark's ~1.75× LOD merge ratio: a node's parent is roughly this much bigger.
 * Used as the `parent_size` fallback when the real parent has not decoded yet. */
const RAD_MERGE_RATIO = 1.75;

/**
 * LOD source for a `.rad` too large to load whole (its leaf count exceeds the
 * budget-lift ceiling). Where {@link RadLodSource} renders the frontier of a
 * coarse→fine *prefix* - uniform detail, capped by the budget - this loads a
 * camera-directed **set** of chunks and renders them whole, letting the
 * material's screen-radius band cull pick the LOD cut per splat.
 *
 * The resident set is chunk 0's whole-scene coarse shell (a few shallow chunks,
 * always resident for far coverage) plus the nearest chunks by bounds distance,
 * up to the budget. There is **no ancestor-closedness requirement** - the
 * per-splat band cull is correct over any resident set (it draws exactly the
 * splats whose on-screen size lands in the band, one LOD level per view ray),
 * so it sidesteps the entangled-DAG wall that defeats a chunk cut. Loading
 * follows the camera: fetch the nearest undecoded refinements of the resident
 * set. See `docs/formats/rad-notes.md` M14.6.
 */

/** Undecoded refinements fetched per reschedule to pull detail in. Ranked by
 * on-screen coarseness (Spark's descend-biggest-pixel-scale-first), so the near,
 * in-view, under-refined regions load ahead of distant ones. */
const PREFETCH_AHEAD = 16;
/** Out-of-frustum regions are deprioritized by this factor (they are not drawn,
 * so refine what is on screen first). */
const FRUSTUM_PENALTY = 8;
/** Shallowest chunks kept resident always, for whole-scene coarse coverage. */
const COARSE_BASE = 4;
/** Floor on distance when scoring, so a splat at the camera can't divide by ~0. */
const MIN_SCORE_DISTANCE = 0.05;

export class RadFoveatedSource implements LodSource {
  budget: number;
  lodBaseDistance: number;
  lodMultiplier: number;

  private readonly chunkSize: number;
  private readonly chunkCounts: readonly number[];
  private readonly numChunks: number;
  private readonly decoded = new Set<number>();
  /** Real bounds of a decoded chunk (AABB of its splat centers). */
  private readonly bounds: (THREE.Box3 | null)[];
  /** Region estimated from decoded parents, to rank an undecoded chunk. */
  private readonly estBounds: (THREE.Box3 | null)[];
  /** Per chunk: the chunks its internal splats refine into (for prefetch). */
  private readonly childChunks: (Set<number> | null)[];
  /** Inverts the tree's forward links to give each splat its parent's size,
   * for the frontier cut. Fed the same `own_size` measure the material derives. */
  private readonly parentSizes: RadParentSizes;

  /** Splats chunk 0's coarse shell draws (the minimum-coverage floor). */
  coverageSplatCount = 1;

  /**
   * Whether per-splat `parent_size` is needed. Only the GPU cuts
   * (`foveationMode: 'band' | 'frontier'`) read `frontierParent`; the page-table
   * pager runs its own traversal in the worker and `gatherGlobals` never carries
   * it. Computing it anyway costs a full covariance pass per chunk *and* leaves
   * one pending-range object per internal node alive in {@link RadParentSizes}
   * until its child chunk decodes - tens of millions of live objects on an
   * 800-chunk capture, enough GC pressure to read as a frozen page.
   */
  needsParentSizes = true;

  private readonly scratchPoint = new THREE.Vector3();

  constructor(chunkSize: number, chunkCounts: readonly number[], options: LodSourceOptions) {
    this.chunkSize = chunkSize;
    this.chunkCounts = chunkCounts;
    this.numChunks = chunkCounts.length;
    this.budget = options.budget;
    this.lodBaseDistance = options.lodBaseDistance;
    this.lodMultiplier = options.lodMultiplier;
    this.bounds = Array.from({ length: this.numChunks }, () => null);
    this.estBounds = Array.from({ length: this.numChunks }, () => null);
    this.childChunks = Array.from({ length: this.numChunks }, () => null);
    this.parentSizes = new RadParentSizes(chunkSize);
  }

  onChunkDecoded(file: number, data: SplatData): void {
    if (this.decoded.has(file)) return;
    this.decoded.add(file);
    this.bounds[file] = boundsOf(data);

    const tree = data.radTree;
    if (tree) {
      const children = new Set<number>();
      const pos = data.positions;
      for (let i = 0; i < tree.childCount.length; i++) {
        if (tree.childCount[i] === 0) continue;
        const childChunk = Math.floor((tree.childStart[i] as number) / this.chunkSize);
        children.add(childChunk);
        let est = this.estBounds[childChunk];
        if (!est) {
          est = new THREE.Box3().makeEmpty();
          this.estBounds[childChunk] = est;
        }
        est.expandByPoint(
          this.scratchPoint.set(pos[i * 3] ?? 0, pos[i * 3 + 1] ?? 0, pos[i * 3 + 2] ?? 0),
        );
      }
      this.childChunks[file] = children;
      if (this.needsParentSizes) this.attachFrontierParent(file, data, tree, computeOwnSizes(data));
    }
    if (file === 0) this.coverageSplatCount = Math.max(1, this.chunkCounts[0] as number);
  }

  /**
   * Computes each splat's `parent_size` for the frontier cut and packs it, with
   * a leaf-sign bit, onto `data.frontierParent` (uploaded into `covarianceB.w`).
   *
   * `own_size` is derived from the covariance the same way the material does -
   * `2·√(trace(Σ)/3)`, which with the merged-node-expanded scales already carries
   * the expansion - so a node's own size and its children's `parent_size` are the
   * identical measure, giving clean level transitions.
   *
   * The catch: this source streams chunks in **camera** order, not tree order, so
   * a child frequently decodes before its parent and `RadParentSizes` returns
   * `Infinity` (unknown). Making every such splat a root would defeat the cut -
   * a root always passes the "parent too big" half, so it can never be culled and
   * the drawn count runs away. Instead an unknown parent falls back to Spark's
   * ~1.75× merge ratio (`parent ≈ own · 1.75`), which brackets the splat to one
   * level per ray (a per-splat band). Chunk 0 - the always-resident coarse shell -
   * keeps the true-root sentinel so far rays always have coverage.
   */
  private attachFrontierParent(
    file: number,
    data: SplatData,
    tree: NonNullable<SplatData['radTree']>,
    ownSize: Float32Array,
  ): void {
    const count = data.count;
    const parentSize = this.parentSizes.resolve(file, tree.childCount, tree.childStart, ownSize);
    const frontierParent = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let p = parentSize[i] as number;
      if (!Number.isFinite(p)) {
        p = file === 0 ? FRONTIER_ROOT_SIZE : (ownSize[i] as number) * RAD_MERGE_RATIO;
      }
      p = Math.min(p, FRONTIER_ROOT_SIZE);
      frontierParent[i] = tree.childCount[i] === 0 ? -p : p; // leaves negative
    }
    (data as { frontierParent?: Float32Array }).frontierParent = frontierParent;
  }

  computeDesiredRuns(cameraLocal: THREE.Vector3, frustum: THREE.Frustum, _now: number): LodRun[] {
    const resident = this.buildResident(cameraLocal, frustum);
    const runs: LodRun[] = [];
    let residentSplats = 0;
    let farthest = 0;
    for (const c of resident) {
      runs.push(this.wholeChunkRun(c));
      residentSplats += this.chunkCounts[c] as number;
      farthest = Math.max(farthest, this.chunkDistance(c, cameraLocal, frustum));
    }
    // Pull the nearest undecoded refinements of the resident set toward the
    // camera. Bound the fetch to chunks that could actually become resident -
    // nearer than the farthest resident chunk once the set is full - so a fixed
    // view does not eventually download the whole scene. A fetch-intent run only
    // needs a valid `file`; it becomes the real whole-chunk run once decoded.
    const limit = residentSplats >= this.budget ? farthest : Infinity;
    for (const c of this.nearestUndecodedRefinements(resident, cameraLocal, frustum, limit)) {
      runs.push(this.wholeChunkRun(c));
    }
    return runs;
  }

  /** The coarse shell covers far/loading regions via the band cull, so there
   * are no separate substitute runs. */
  coarsestRunsFor(): LodRun[] {
    return [];
  }

  /** Chunk 0's coarse shell plus the nearest decoded chunks, up to the budget. */
  private buildResident(cameraLocal: THREE.Vector3, frustum: THREE.Frustum): Set<number> {
    const resident = new Set<number>();
    let residentSplats = 0;
    for (let c = 0; c < Math.min(COARSE_BASE, this.numChunks); c++) {
      if (this.decoded.has(c)) {
        resident.add(c);
        residentSplats += this.chunkCounts[c] as number;
      }
    }
    const nearest = [...this.decoded]
      .filter((c) => !resident.has(c))
      .sort(
        (a, b) =>
          this.chunkDistance(a, cameraLocal, frustum) - this.chunkDistance(b, cameraLocal, frustum),
      );
    for (const c of nearest) {
      if (residentSplats >= this.budget) break;
      resident.add(c);
      residentSplats += this.chunkCounts[c] as number;
    }
    return resident;
  }

  private nearestUndecodedRefinements(
    resident: ReadonlySet<number>,
    cameraLocal: THREE.Vector3,
    frustum: THREE.Frustum,
    maxDistance: number,
  ): number[] {
    const candidates = new Set<number>();
    for (const c of resident) {
      const children = this.childChunks[c];
      if (!children) continue;
      for (const cc of children) {
        if (!this.decoded.has(cc) && this.chunkDistance(cc, cameraLocal, frustum) <= maxDistance) {
          candidates.add(cc);
        }
      }
    }
    // Refine the coarsest *on-screen* region first: score by the parent node's
    // `size / distance` (its projected coarseness), out-of-frustum penalized. This
    // is Spark's descend-biggest-pixel-scale-first order - the near surfaces the
    // camera is looking at refine ahead of distant ones, instead of by raw
    // whole-chunk bounds distance (which a scene-spanning coarse chunk defeats).
    return [...candidates]
      .sort(
        (a, b) =>
          this.refineScore(b, cameraLocal, frustum) - this.refineScore(a, cameraLocal, frustum),
      )
      .slice(0, PREFETCH_AHEAD);
  }

  /** Refine priority for an undecoded chunk (higher = sooner): nearest, in-view
   * region first, scored against its *localized* estimated bounds (not the
   * scene-spanning whole-chunk bounds). Off-screen regions - not drawn - are
   * strongly penalized so the surfaces the camera faces refine first. */
  private refineScore(c: number, cameraLocal: THREE.Vector3, frustum: THREE.Frustum): number {
    const box = this.estBounds[c] ?? this.bounds[c];
    if (!box) return 0;
    const d = Math.max(box.distanceToPoint(cameraLocal), MIN_SCORE_DISTANCE);
    return (frustum.intersectsBox(box) ? 1 : 1 / FRUSTUM_PENALTY) / d;
  }

  private chunkDistance(c: number, cameraLocal: THREE.Vector3, frustum: THREE.Frustum): number {
    const box = this.bounds[c] ?? this.estBounds[c];
    if (!box) return Infinity;
    const d = box.distanceToPoint(cameraLocal);
    return frustum.intersectsBox(box) ? d : d * FRUSTUM_PENALTY;
  }

  /** One run covering a whole chunk; the material cull selects splats within. */
  private wholeChunkRun(chunk: number): LodRun {
    return {
      file: chunk,
      level: this.numChunks - chunk,
      offset: 0,
      count: this.chunkCounts[chunk] as number,
      leafStart: chunk,
      leafEnd: chunk + 1,
    };
  }
}

/** Per-splat world `own_size` (`2·√(trace(Σ)/3)`) - the same measure the material
 * derives on the GPU and the frontier `parent_size` uses. */
function computeOwnSizes(data: SplatData): Float32Array {
  const count = data.count;
  const cov = data.covariances;
  const ownSize = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const trace = (cov[i * 6] as number) + (cov[i * 6 + 3] as number) + (cov[i * 6 + 5] as number);
    ownSize[i] = 2 * Math.sqrt(Math.max(trace, 0) / 3);
  }
  return ownSize;
}

/** World-space AABB of a decoded chunk's splat centers. */
function boundsOf(data: SplatData): THREE.Box3 {
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  const pos = data.positions;
  for (let i = 0; i < data.count; i++) {
    p.set(pos[i * 3] ?? 0, pos[i * 3 + 1] ?? 0, pos[i * 3 + 2] ?? 0);
    box.expandByPoint(p);
  }
  return box.isEmpty()
    ? new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))
    : box;
}
