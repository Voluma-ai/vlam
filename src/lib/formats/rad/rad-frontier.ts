import type { SplatData } from '../../core/splat-data';
import { FRONTIER_FOVEATION_DEFAULTS, type FrontierFoveation } from './frontier-worker-protocol';

/**
 * CPU evaluation of Spark's LOD tree cut, for the page-table renderer.
 *
 * A whole-chunk GPU cull would waste the pool on the ~90% of each chunk that is
 * off-screen or the wrong LOD. Instead {@link traverseFrontier} runs Spark's
 * best-first tree descent here on the CPU and returns just the *selected*
 * splats, so only the frontier is paged to the GPU (Spark's selected-index
 * model). See `docs/formats/rad-notes.md` M14.6.
 *
 * The cut keeps exactly one node per root→leaf ray - full coverage, no
 * double-draw - for any camera and any subset of resident chunks. Detail away
 * from the view direction is *foveated* (see {@link FrontierView}), never culled,
 * so the scene is covered the moment the camera moves rather than a traversal
 * later.
 */

/** A chunk available for frontier selection, keyed by its file index. */
export interface FrontierChunk {
  readonly file: number;
  readonly data: SplatData;
}

/** Packed SH words per splat at a band count (1, 2 or 3). */
function shWordsPerSplat(bands: 1 | 2 | 3): number {
  return bands === 1 ? 3 : bands === 2 ? 8 : 15;
}

/**
 * Gathers arbitrary global splat indices (possibly spanning several chunks) into
 * one packed `SplatData`, in the given order. Used by the frontier worker to
 * build the data for a paging plan's moves and appends. Copies positions,
 * colors, covariances and packed SH (the render needs SH); `frontierParent` is
 * not carried (the page-table material draws the resident set with no cut).
 *
 * Splats whose chunk is absent are written as zeros (degenerate/invisible), and
 * counted in `stats.missing`. That case is a bug, not a fallback: the slot stays
 * inside the drawn resident prefix, so a miss is a hole punched in the coverage -
 * the dark speckle a refining region used to show. The eviction policy keeps it
 * at zero (see `FrontierPager.hasResidentIn`); the counter is what proves it.
 */
export function gatherGlobals(
  cache: ReadonlyMap<number, SplatData>,
  globals: ArrayLike<number>,
  chunkSize: number,
  stats?: { missing: number },
): SplatData {
  const count = globals.length;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  // SH is present iff any cached chunk carries it; take the band count from one.
  let shBands: 1 | 2 | 3 | 0 = 0;
  let shRange: NonNullable<SplatData['shPacked']>['range'] | null = null;
  for (const data of cache.values()) {
    if (data.shPacked) {
      shBands = data.shPacked.bands;
      shRange = data.shPacked.range;
      break;
    }
  }
  const shWords = shBands ? shWordsPerSplat(shBands) : 0;
  const packed = shBands ? new Uint32Array(count * shWords) : null;

  for (let j = 0; j < count; j++) {
    const global = globals[j] as number;
    const file = Math.floor(global / chunkSize);
    const data = cache.get(file);
    if (!data) {
      if (stats) stats.missing++;
      continue; // chunk absent → zeros (invisible): a coverage hole, see above
    }
    const i = global - file * chunkSize;
    const sp = data.positions;
    const sc = data.colors;
    const sv = data.covariances;
    positions[j * 3] = sp[i * 3] as number;
    positions[j * 3 + 1] = sp[i * 3 + 1] as number;
    positions[j * 3 + 2] = sp[i * 3 + 2] as number;
    colors[j * 4] = sc[i * 4] as number;
    colors[j * 4 + 1] = sc[i * 4 + 1] as number;
    colors[j * 4 + 2] = sc[i * 4 + 2] as number;
    colors[j * 4 + 3] = sc[i * 4 + 3] as number;
    for (let k = 0; k < 6; k++) covariances[j * 6 + k] = sv[i * 6 + k] as number;
    if (packed && data.shPacked && data.shPacked.bands === shBands) {
      const src = data.shPacked.packed;
      for (let k = 0; k < shWords; k++) packed[j * shWords + k] = src[i * shWords + k] as number;
    }
  }

  return {
    count,
    positions,
    colors,
    covariances,
    ...(packed && shBands && shRange
      ? { shPacked: { bands: shBands, packed, range: shRange } }
      : {}),
  };
}

/** Own size of splat `i` from its covariance trace (`2·√(trace/3)`). */
function ownSizeAt(cov: Float32Array, i: number): number {
  const trace = (cov[i * 6] as number) + (cov[i * 6 + 3] as number) + (cov[i * 6 + 5] as number);
  return 2 * Math.sqrt(Math.max(trace, 0) / 3);
}

/** `frontierParent` magnitude at or above this marks a root / undecoded parent. */
export const FRONTIER_ROOT_THRESHOLD = 1e29;

/**
 * Where the camera is and how sharply detail falls off away from where it looks.
 *
 * Spark's `new_compute_pixel_scale` (`rust/spark-worker-rs/src/lod_tree.rs`)
 * never *culls* by frustum - it scales a node's on-screen size by a foveation
 * weight, so off-cone and behind-camera geometry stops refining early but is
 * still selected. That is what keeps the whole scene covered the instant the
 * camera turns or zooms out; a frustum cull leaves a hole with nothing to draw
 * until the next traversal lands. Omit `forward` for an unfoveated cut (weight 1
 * everywhere), which is what the algorithmic tests use.
 */
export interface FrontierView {
  readonly origin: { x: number; y: number; z: number };
  /** Unit camera forward, in the same (mesh-local) frame as `origin`. */
  readonly forward?: { x: number; y: number; z: number };
  /** `cos(coneFov0 / 2)` - inside this cone the weight is 1. */
  readonly coneDot0: number;
  /** `cos(coneFov / 2)` - at this angle the weight has fallen to `coneFoveate`. */
  readonly coneDot: number;
  /** Weight at the edge of `coneFov`. */
  readonly coneFoveate: number;
  /** Weight directly behind the camera. */
  readonly behindFoveate: number;
}

/** Builds a {@link FrontierView} from degrees, as Spark's renderer does. */
export function frontierView(
  origin: { x: number; y: number; z: number },
  forward: { x: number; y: number; z: number } | undefined,
  foveation: FrontierFoveation = FRONTIER_FOVEATION_DEFAULTS,
): FrontierView {
  return {
    origin,
    ...(forward ? { forward } : {}),
    coneDot0: foveation.coneFov0 > 0 ? Math.cos((0.5 * foveation.coneFov0 * Math.PI) / 180) : 1,
    coneDot: foveation.coneFov > 0 ? Math.cos((0.5 * foveation.coneFov * Math.PI) / 180) : 1,
    coneFoveate: foveation.coneFoveate,
    behindFoveate: foveation.behindFoveate,
  };
}

/**
 * Spark's priority-frontier tree traversal - the O(frontier) selection.
 *
 * Descends the LOD forest from `roots` by a max-heap on the foveated
 * `pixel_scale = size / distance · foveate(angle)`: peek the biggest-on-screen
 * node; if it is small enough (`≤ limit`) then it and everything left in the
 * heap are the frontier - stop and emit them all; if it is a leaf, emit it; if
 * descending would push the output past `maxSplats`, stop; else if every chunk
 * its child range spans is cached, descend into the children, otherwise emit it
 * as a coarse stand-in and record the missing chunks as **touched** (the detail
 * to fetch next). Visits ~frontier-many nodes regardless of total splats.
 *
 * Two properties matter and are what Spark relies on
 * (`new_traverse_lod_trees`, `lod_tree.rs`):
 * - **Complete coverage.** Every root→leaf ray ends with exactly one node in the
 *   output, whatever the camera or the cache state - there is no cull that can
 *   leave a region unrepresented.
 * - **In budget by construction.** The count is checked *before* each descent,
 *   so a single pass is always within `maxSplats`; no outer limit search, and
 *   nothing for the pager to truncate afterwards.
 *
 * `chunkMap` resolves a file index to its decoded chunk; `roots` are global
 * indices to seed from (maintained incrementally by the caller).
 */
export function traverseFrontier(
  chunkMap: ReadonlyMap<number, SplatData>,
  roots: readonly number[],
  chunkSize: number,
  view: FrontierView,
  limit: number,
  maxSplats = Number.POSITIVE_INFINITY,
): {
  selection: FrontierSelection;
  count: number;
  touched: Map<number, number>;
  /** The descent stopped because refining further would exceed `maxSplats`. */
  budgetClamped: boolean;
  /**
   * Some frontier node still has cached children, so a finer `limit` would
   * select more splats. This is what tells a caller whether spending leftover
   * budget is possible at all, or whether the cut has simply reached the
   * capture's leaves (or the edge of what is cached).
   */
  refinable: boolean;
} {
  const picks = new Map<number, number[]>();
  const touched = new Map<number, number>();
  const heap = new MaxHeap();
  const camX = view.origin.x;
  const camY = view.origin.y;
  const camZ = view.origin.z;
  const forward = view.forward;
  const fwdX = forward?.x ?? 0;
  const fwdY = forward?.y ?? 0;
  const fwdZ = forward?.z ?? 0;
  const foveated = forward !== undefined;
  const { coneDot0, coneDot, coneFoveate, behindFoveate } = view;

  /** Reads a node's world size + center; null if its chunk is not cached. */
  const nodeAt = (global: number): { data: SplatData; local: number } | null => {
    const file = Math.floor(global / chunkSize);
    const data = chunkMap.get(file);
    if (!data || !data.radTree) return null;
    return { data, local: global - file * chunkSize };
  };

  const output = (file: number, local: number): void => {
    let picked = picks.get(file);
    if (!picked) {
      picked = [];
      picks.set(file, picked);
    }
    picked.push(local);
  };

  /** Foveated on-screen size of the node at `local` in `data`. */
  const pixelScaleOf = (data: SplatData, local: number): number => {
    const pos = data.positions;
    const b = local * 3;
    const dx = (pos[b] as number) - camX;
    const dy = (pos[b + 1] as number) - camY;
    const dz = (pos[b + 2] as number) - camZ;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    const scale = (data.radTree!.size[local] as number) / d;
    if (!foveated) return scale;
    // Port of Spark's `new_compute_pixel_scale`: full weight inside `coneFov0`,
    // ramping to `coneFoveate` at `coneFov`, then to `behindFoveate` behind.
    const forwardDot = dx * fwdX + dy * fwdY + dz * fwdZ;
    if (forwardDot <= 0) return scale * behindFoveate;
    const dot = forwardDot / d;
    if (dot >= coneDot0) return scale;
    if (dot >= coneDot) {
      const t = (dot - coneDot) / (coneDot0 - coneDot);
      return scale * (coneFoveate + (1 - coneFoveate) * t);
    }
    return scale * (behindFoveate + (coneFoveate - behindFoveate) * (dot / coneDot));
  };

  // Seed the roots. `numSplats` tracks heap + output, exactly as Spark's
  // `num_splats` does, so the budget can be checked before each descent.
  let numSplats = 0;
  const seeded = new Set<number>(); // roots only - the tree itself never revisits
  for (const r of roots) {
    if (seeded.has(r)) continue;
    const node = nodeAt(r);
    if (!node) continue;
    seeded.add(r);
    heap.push(r, pixelScaleOf(node.data, node.local));
    numSplats++;
  }

  let budgetClamped = false;
  while (heap.size > 0) {
    const pixelScale = heap.peekPriority();
    if (pixelScale <= limit) break; // the heap max fits: so does everything below it
    const global = heap.peek();
    const node = nodeAt(global);
    if (!node) {
      heap.pop(); // chunk evicted between seed and pop
      numSplats--;
      continue;
    }
    const file = Math.floor(global / chunkSize);
    const tree = node.data.radTree!;
    const childCount = tree.childCount[node.local] as number;

    if (childCount === 0) {
      heap.pop();
      output(file, node.local); // a leaf has no finer level: it is a frontier node
      continue;
    }
    const nextSplats = numSplats - 1 + childCount;
    if (nextSplats > maxSplats) {
      // Descending would blow the draw budget. Report it: a caller solving for
      // the cut that spends the budget must know the difference between "the
      // budget stopped me" (coarsen) and "nothing was above the cut" (refine).
      budgetClamped = true;
      break;
    }

    heap.pop();
    // Descend only if *every* chunk the child range spans is cached. Children are
    // a contiguous global range and can straddle a chunk boundary (chunks cut at
    // exactly 65536 splats mid-append); descending with only the first chunk
    // resident would drop the tail children - an unrepresented region (coverage
    // hole). Keep the coarse stand-in until the whole range is resident, and
    // touch every missing chunk.
    const childStart = tree.childStart[node.local] as number;
    const firstChunk = Math.floor(childStart / chunkSize);
    const lastChunk = Math.floor((childStart + childCount - 1) / chunkSize);
    let allCached = true;
    for (let cc = firstChunk; cc <= lastChunk; cc++) {
      if (chunkMap.has(cc)) continue;
      allCached = false;
      if (pixelScale > (touched.get(cc) ?? 0)) touched.set(cc, pixelScale);
    }
    if (!allCached) {
      output(file, node.local); // coarse stand-in until its children load
      continue;
    }
    for (let c = 0; c < childCount; c++) {
      const child = childStart + c;
      const childNode = nodeAt(child)!; // the whole range is cached
      const childScale = pixelScaleOf(childNode.data, childNode.local);
      // Children already fine enough go straight out; only the ones that may
      // still refine cost a heap slot.
      if (childScale <= limit) {
        output(Math.floor(child / chunkSize), childNode.local);
      } else {
        heap.push(child, childScale);
      }
    }
    numSplats = nextSplats;
  }

  // Whatever is still on the heap is at or below the cut (or was stopped by the
  // budget): it is part of the frontier. Emitting it is what makes the output a
  // complete cover rather than a partial one.
  let refinable = false;
  while (heap.size > 0) {
    const global = heap.pop();
    const file = Math.floor(global / chunkSize);
    const local = global - file * chunkSize;
    output(file, local);
    // A drained node with cached children could still be refined, so a finer
    // limit would select more splats. Checked here rather than tracked during
    // the descent because this drain *is* the resulting frontier.
    if (!refinable) {
      const data = chunkMap.get(file);
      const tree = data?.radTree;
      const childCount = tree ? (tree.childCount[local] as number) : 0;
      if (childCount > 0) {
        const childStart = tree!.childStart[local] as number;
        const firstChunk = Math.floor(childStart / chunkSize);
        const lastChunk = Math.floor((childStart + childCount - 1) / chunkSize);
        let allCached = true;
        for (let cc = firstChunk; cc <= lastChunk && allCached; cc++) {
          if (!chunkMap.has(cc)) allCached = false;
        }
        if (allCached) refinable = true;
      }
    }
  }

  const selection: FrontierSelection = new Map();
  let count = 0;
  for (const [file, picked] of picks) {
    selection.set(file, Uint32Array.from(picked));
    count += picked.length;
  }
  return { selection, count, touched, budgetClamped, refinable };
}

/** Minimal binary max-heap of (global, priority), for the frontier traversal. */
class MaxHeap {
  private readonly items: number[] = []; // global indices
  private readonly prio: number[] = [];

  get size(): number {
    return this.items.length;
  }

  /** Largest-priority item, without removing it. Undefined when empty. */
  peek(): number {
    return this.items[0] as number;
  }

  /** Priority of {@link peek}. */
  peekPriority(): number {
    return this.prio[0] as number;
  }

  push(global: number, priority: number): void {
    const items = this.items;
    const prio = this.prio;
    let i = items.length;
    items.push(global);
    prio.push(priority);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((prio[parent] as number) >= priority) break;
      items[i] = items[parent] as number;
      prio[i] = prio[parent] as number;
      items[parent] = global;
      prio[parent] = priority;
      i = parent;
    }
  }

  pop(): number {
    const items = this.items;
    const prio = this.prio;
    const top = items[0] as number;
    const lastGlobal = items.pop() as number;
    const lastPrio = prio.pop() as number;
    if (items.length > 0) {
      items[0] = lastGlobal;
      prio[0] = lastPrio;
      const n = items.length;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let largest = i;
        if (l < n && (prio[l] as number) > (prio[largest] as number)) largest = l;
        if (r < n && (prio[r] as number) > (prio[largest] as number)) largest = r;
        if (largest === i) break;
        const tg = items[i] as number;
        const tp = prio[i] as number;
        items[i] = items[largest] as number;
        prio[i] = prio[largest] as number;
        items[largest] = tg;
        prio[largest] = tp;
        i = largest;
      }
    }
    return top;
  }
}

/** Per-file selected local indices making up the frontier. */
export type FrontierSelection = Map<number, Uint32Array>;

/**
 * Spark's paging driver: the child chunks the frontier *wants* but does not have.
 *
 * For each cached internal node that is on screen and **too coarse** for its
 * distance (`own_size / d > limit`, so the cut culls it expecting a finer level),
 * its children are the missing detail - record that child chunk, scored by the
 * node's projected coarseness (`own / d`, so the nearest, biggest-on-screen gaps
 * refine first). The caller fetches the top uncached chunks. This is what makes
 * the room you're standing in load before the street: loading follows exactly
 * where the visible frontier is under-refined, not whole-chunk bounds distance.
 *
 * Returns `childChunk -> max score`.
 */
export function computeTouchedChunks(
  chunks: readonly FrontierChunk[],
  cameraLocal: { x: number; y: number; z: number },
  limit: number,
  chunkSize: number,
  mvp?: ArrayLike<number>,
): Map<number, number> {
  const touched = new Map<number, number>();
  const camX = cameraLocal.x;
  const camY = cameraLocal.y;
  const camZ = cameraLocal.z;
  for (const { data } of chunks) {
    const tree = data.radTree;
    if (!tree) continue;
    const cov = data.covariances;
    const pos = data.positions;
    const { childCount, childStart } = tree;
    for (let i = 0; i < data.count; i++) {
      if ((childCount[i] as number) === 0) continue; // leaf: no finer level to fetch
      if (mvp && !inFrustum(mvp, pos, i)) continue;
      const dx = (pos[i * 3] as number) - camX;
      const dy = (pos[i * 3 + 1] as number) - camY;
      const dz = (pos[i * 3 + 2] as number) - camZ;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const score = ownSizeAt(cov, i) / d;
      if (score <= limit) continue; // already fine enough on screen - the cut keeps it
      // The child range can straddle a chunk boundary - every spanned chunk is
      // missing detail (matching `traverseFrontier`'s all-cached descent gate).
      const start = childStart[i] as number;
      const firstChunk = Math.floor(start / chunkSize);
      const lastChunk = Math.floor((start + (childCount[i] as number) - 1) / chunkSize);
      for (let cc = firstChunk; cc <= lastChunk; cc++) {
        if (score > (touched.get(cc) ?? 0)) touched.set(cc, score);
      }
    }
  }
  return touched;
}

/** Clip-space frustum test of splat `i` against a model-view-projection matrix
 * (column-major, 16 elements), with the material's 1.2·w margin. */
function inFrustum(m: ArrayLike<number>, pos: Float32Array, i: number): boolean {
  const x = pos[i * 3] as number;
  const y = pos[i * 3 + 1] as number;
  const z = pos[i * 3 + 2] as number;
  const w = (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number);
  const margin = w * 1.2;
  const cz =
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number);
  if (cz <= -margin) return false;
  const cx = (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
  if (cx > margin || cx < -margin) return false;
  const cy = (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
  return cy <= margin && cy >= -margin;
}

/** Multiplier steps for the limit bisection: coarsen (fewer) / refine (more). */
const LIMIT_GROW = 1.6;

/**
 * Self-adjusts a frontier cut `limit` toward `targetCount` splats (Spark's
 * `pixelScaleLimit` / `maxSplats` feedback), never finer than `minLimit`.
 * `evaluate` runs the cut at a limit and returns at least its `count`.
 *
 * Invariants (E7 / ROADMAP L4):
 * - **Budget-safe:** never *refines* into an over-budget selection - a shrink
 *   step whose result exceeds the target is reverted, so the returned cut is
 *   over budget only when even the coarsest limit tried is (then the returned
 *   `limit` is that coarsest one, and the next call keeps coarsening).
 * - **Fixed point:** with static inputs, feeding the returned `limit` back in
 *   returns the identical selection - the search cannot oscillate between an
 *   over-budget and an under-budget cut across frames (the old grow/shrink
 *   loop could end a frame on the over-budget side of such a cycle).
 */
export function searchLimitWithinBudget<R extends { count: number }>(
  evaluate: (limit: number) => R,
  startLimit: number,
  minLimit: number,
  targetCount: number,
  maxIterations: number,
): { result: R; limit: number } {
  let limit = Math.max(startLimit, minLimit);
  let result = evaluate(limit);
  for (let it = 0; it < maxIterations; it++) {
    if (result.count > targetCount) {
      // Over budget → coarsen (grow the limit).
      limit *= LIMIT_GROW;
      result = evaluate(limit);
    } else if (result.count < targetCount * 0.6 && limit > minLimit) {
      // Comfortably under and not at the finest → try refining, so a receding
      // camera recovers detail - but never accept an over-budget refinement.
      const finer = Math.max(limit / LIMIT_GROW, minLimit);
      const refined = evaluate(finer);
      if (refined.count > targetCount) break; // refining overshoots: keep coarser
      limit = finer;
      result = refined;
    } else {
      break;
    }
  }
  return { result, limit };
}
