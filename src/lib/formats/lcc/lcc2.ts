import * as THREE from 'three/webgpu';
import type { LodRun } from '../../streaming/lod-scheduler';
import type {
  CollisionMeshDescriptor,
  LodSource,
  LodSourceOptions,
  SplatCollisionData,
  StreamedScene,
} from '../../streaming/lod-source';
import type { SplatDatasetSource } from '../../streaming/dataset-source';
import { createLcc2ToThreeMatrix } from './lcc2-transform';
import { warn } from '../../core/logging';

/**
 * Reader for XGRIDS' `.lcc2` datasets (see `docs/formats/lcc2-notes.md`).
 *
 * An `.lcc2` manifest is a cut-based LOD octree: each node holds one splat
 * range (`{file, start, count}`) representing its spatial region at one
 * level, and every level fully tiles the scene, so rendering picks a *cut*
 * (one node per root→leaf path) rather than a level per leaf. Coarse nodes
 * are shared ancestors, so per-leaf independent selection would double-draw;
 * {@link OctreeLodSource} therefore selects a valid cut directly.
 *
 * The splat tiles are standard SOG v2 bundles (one file packs many nodes at
 * different `start` offsets), so the existing chunk cache and pool reuse
 * everything. Implemented from XGRIDS' openly published spec; no XGRIDS code
 * is used, and their capture data is never redistributed.
 */

/** Optional host quality policy for desktop LCC2; other formats keep their own ladder. */
export interface Lcc2QualityPolicy {
  /** Use a budget-derived base split and scene-scaled adaptive detail distances. */
  readonly quality: 'desktop';
}

/** Read-only manifest selection diagnostics, before fetch/staging/publication. */
export interface Lcc2SelectionState {
  readonly profile: 'desktop' | 'distance';
  readonly totalLevels: number;
  readonly baseDepth: number | null;
  readonly budget: number;
  readonly manifestNodeDepthCounts: Readonly<Record<number, number>>;
  readonly desired: readonly (LodRun & { readonly depth: number })[];
}

/** LCC2-specific options for manifest selection without changing persisted scene data. */
export interface Lcc2SceneOptions extends LodSourceOptions {
  readonly lcc2Policy?: Lcc2QualityPolicy;
}

/** Out-of-frustum nodes act this many times farther away (see LodScheduler). */
const FRUSTUM_PENALTY = 3;
/** Frustum test margin, as a fraction of each node's own size. */
const FRUSTUM_MARGIN = 0.1;
// Match Voluma's Spark LCC2 loading hints: expand around the view while moving,
// but keep actual visibility separate so preloading cannot displace on-screen detail.
const DESKTOP_LOAD_MARGIN = 8;
const DESKTOP_LOAD_MARGIN_SCENE_FACTOR = 0.03;
const DESKTOP_MOVING_LOAD_MARGIN = 24;
const DESKTOP_MOVING_LOAD_MARGIN_SCENE_FACTOR = 0.08;
const DESKTOP_MOVEMENT_GRACE_MS = 1500;
const DESKTOP_MOVEMENT_DISTANCE_SQ = 0.08 ** 2;
const DESKTOP_MOVEMENT_DIRECTION_DOT = 0.9995;
/** Hysteresis dead-band around each LOD distance threshold. */
const THRESHOLD_MARGIN = 0.1;
/** Minimum time a cell must hold a level before changing again, ms. */
const DWELL_MS = 500;

interface OctNode {
  file: number;
  offset: number;
  count: number;
  bounds: THREE.Box3;
  /** `totalLevels − depth`; 0 is finest. */
  level: number;
  children: number[];
  /** Finest-cell interval `[leafStart, leafEnd)` over this node's subtree. */
  leafStart: number;
  leafEnd: number;
}

interface RawNode {
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  child?: Record<string, RawNode>;
  data?: {
    '3dgs'?: { name: number; start: number; count: number };
    /** Collision/nav mesh for this node's region; `name` indexes `meshFiles`. */
    mesh?: { name: number; vertex: number; face: number };
    /**
     * Always-resident environment/background tile; root only. `name` indexes
     * `splatFiles`. Carries no `count` - the manifest never states how many
     * env splats there are, so it is measured when the tile decodes.
     */
    env?: { name: number };
  };
}

interface RawManifest {
  version: string;
  totalLevels: number;
  lodSplats: number[];
  root: RawNode & {
    splatFiles: string[];
    /** Triangle-mesh PLYs, referenced by nodes' `data.mesh.name`. */
    meshFiles?: string[];
    /**
     * XGRIDS' own `.btree` BVHs over `meshFiles`. Deliberately unread: the
     * format is proprietary and undocumented, and a host that wants an
     * acceleration structure builds one from the meshes itself.
     */
    bvhFiles?: string[];
  };
}

/** Builds a scene from a parsed `.lcc2` manifest (JSON already fetched). */
export function buildLcc2Scene(
  json: unknown,
  dataset: SplatDatasetSource,
  options: Lcc2SceneOptions,
  shBands: 0 | 1 | 2 | 3 = 0,
): StreamedScene {
  const raw = json as RawManifest;
  const chunkUrls = raw.root.splatFiles.map((path) => {
    const url = dataset.resolve(path);
    if (url === null) throw new Error(`LCC2 dataset is missing the tile "${path}".`);
    return url;
  });

  const nodes: OctNode[] = [];
  const cellNodes: number[] = []; // node index of each finest cell, by cell index
  let nextLeaf = 0;
  // Flatten every node that carries splat data (all but the root). Finest
  // cells are the childless nodes, numbered in DFS order; each node's
  // [leafStart, leafEnd) spans the cells in its subtree, so ancestor
  // intervals nest over descendants (what the swap grouping needs).
  const build = (rawNode: RawNode, depth: number): number => {
    const range = rawNode.data?.['3dgs'];
    if (!range) throw new Error('LCC2 node is missing 3dgs data.');
    const index = nodes.length;
    nodes.push(null as unknown as OctNode); // reserve slot (children get later indices)

    const leafStart = nextLeaf;
    const children: number[] = [];
    const rawChildren = rawNode.child ? Object.values(rawNode.child) : [];
    if (rawChildren.length === 0) {
      cellNodes[nextLeaf] = index; // this node is one finest cell
      nextLeaf++;
    } else {
      for (const child of rawChildren) children.push(build(child, depth + 1));
    }
    const leafEnd = rawChildren.length === 0 ? leafStart + 1 : nextLeaf;

    nodes[index] = {
      file: range.name,
      offset: range.start,
      count: range.count,
      bounds: boxFromRaw(rawNode.boundingBox),
      level: raw.totalLevels - depth,
      children,
      leafStart,
      leafEnd,
    };
    return index;
  };

  const rootChildren = Object.values(raw.root.child ?? {}).map((child) => build(child, 1));

  const source = new OctreeLodSource(
    nodes,
    rootChildren,
    cellNodes,
    raw.totalLevels - 1,
    options,
    boxFromRaw(raw.root.boundingBox).getSize(new THREE.Vector3()).length(),
  );
  const pinnedFiles = new Set<number>(rootChildren.map((i) => (nodes[i] as OctNode).file));

  // The environment tile (root `data.env`) is an always-resident background -
  // one whole `.sog`, no LOD ladder, no `count` in the manifest (measured at
  // decode). Pin its file so a fetch in flight is never cancelled by an LOD
  // reschedule, and StreamedSplatMesh loads it once and toggles it live.
  const envName = raw.root.data?.env?.name;
  const environment =
    envName !== undefined && chunkUrls[envName] !== undefined ? { file: envName } : undefined;
  if (envName !== undefined && environment === undefined) {
    warn(`LCC2 root references env tile #${envName}, which the manifest does not list.`);
  }
  if (environment) pinnedFiles.add(environment.file);

  const packShBands = shBands >= 1 ? (shBands as 1 | 2 | 3) : undefined;

  return {
    source,
    chunkUrls,
    chunkKind: 'file', // LCC2 tiles are single bundled .sog (ZIP) files
    // Explicit format: a dropped folder resolves tiles to `blob:` URLs with no
    // `.sog` extension, so the chunk loader cannot sniff the parser from the URL.
    chunkOptions: chunkUrls.map(() => ({
      format: 'sog' as const,
      ...(packShBands ? { sog: { packShBands } } : {}),
    })),
    bounds: boxFromRaw(raw.root.boundingBox),
    pinnedFiles,
    maxResidentSplats: raw.lodSplats[0] ?? options.budget,
    minimumCoverageSplats: Math.max(
      1,
      rootChildren.reduce((sum, index) => sum + (nodes[index] as OctNode).count, 0),
    ),
    ...collisionFrom(raw, dataset),
    ...(environment ? { environment } : {}),
    ...(packShBands ? { shBands: packShBands } : {}),
    // Match the established XGRIDS LCC and Spark viewer coordinate frame.
    // Bounds remain source-local and matrixWorld handles the conversion.
    formatTransform: createLcc2ToThreeMatrix(),
  };
}

/**
 * Collects the dataset's collision-mesh tiles, if it ships any.
 *
 * Nodes name their mesh by index into `root.meshFiles`, and several nodes can
 * share one file, so tiles are deduped by that index and carry the bounds of
 * the first node that claimed them. Unlike a splat tile, a missing mesh is not
 * fatal - collision is optional, and a partial set still beats none.
 */
function collisionFrom(
  raw: RawManifest,
  dataset: SplatDatasetSource,
): { collision?: SplatCollisionData } {
  const meshFiles = raw.root.meshFiles;
  if (!meshFiles || meshFiles.length === 0) return {};

  const boundsByFile = new Map<number, THREE.Box3>();
  const visit = (node: RawNode): void => {
    const mesh = node.data?.mesh;
    if (mesh && !boundsByFile.has(mesh.name)) {
      boundsByFile.set(mesh.name, boxFromRaw(node.boundingBox));
    }
    for (const child of Object.values(node.child ?? {})) visit(child);
  };
  visit(raw.root);

  // Nodes are the authority on which files are collision meshes and where they
  // sit. A manifest that lists the files but never references them still gets
  // its meshes loaded, just without per-tile bounds.
  const wanted: { file: number; bounds?: THREE.Box3 }[] =
    boundsByFile.size > 0
      ? [...boundsByFile].map(([file, bounds]) => ({ file, bounds }))
      : meshFiles.map((_, file) => ({ file }));

  const meshes: CollisionMeshDescriptor[] = [];
  for (const { file, bounds } of wanted) {
    const path = meshFiles[file];
    if (path === undefined) {
      warn(`LCC2 node references mesh file ${file}, which the manifest does not list.`);
      continue;
    }
    const url = dataset.resolve(path);
    if (url === null) {
      warn(`LCC2 dataset is missing the collision mesh "${path}"; skipping it.`);
      continue;
    }
    meshes.push({ url, ...(bounds ? { bounds } : {}) });
  }
  return meshes.length > 0 ? { collision: { meshes } } : {};
}

/**
 * Selects a budget-bounded cut through an LCC2 octree with the same
 * stability as the SOG scheduler. The stable state is a per-finest-cell
 * desired level (0 = finest), updated from camera distance with a dead-band
 * and dwell so a still or slowly-panning camera does not flip levels - this
 * is what stops the "two LODs fighting" flicker. From those levels a valid
 * cut is built (descend into a node only while some cell in its subtree
 * wants finer than the node provides), then budget-adjusted: coarsen the
 * farthest cells if over budget, refine the nearest with any leftover.
 * Because coarse nodes are shared ancestors, the cut construction - not
 * per-cell independent selection - is what guarantees no double-draw.
 */
class OctreeLodSource implements LodSource {
  budget: number;
  lodBaseDistance: number;
  lodMultiplier: number;

  private readonly nodes: OctNode[];
  private readonly rootChildren: number[];
  private readonly cellNodes: number[];
  private readonly coarsest: number;
  /** Finest available level per cell (its own node's level). */
  private readonly cellFinestLevel: Int32Array;
  /** Stable, dwelled desired level per cell. */
  private readonly cellLevel: Int32Array;
  /** Timestamp of each cell's last level change, for dwell. */
  private readonly changedAt: Float64Array;
  /** Index into {@link rootChildren} of the subtree containing each cell. */
  private readonly cellRootChild: Uint32Array;

  private lastDesiredRuns: LodRun[] = [];
  private lastSelectionAt = -Infinity;
  private lastSelectionBudget = -1;
  private readonly lastSelectionCamera = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly lastSelectionForward = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly lastSelectionFrustum = new Float64Array(24);
  private lastSelectionBaseDistance = -1;
  private lastSelectionMultiplier = -1;
  private lastSelectionLoadMargin = -1;
  private loadFrustumMargin = 0;
  private movementGraceUntil = -Infinity;
  private readonly movementCamera = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly movementForward = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly qualityPolicy: Lcc2QualityPolicy | undefined;
  private readonly sceneDiagonal: number;
  private poolCapacitySlots = Infinity;
  private poolRowWidth = 1;
  private readonly scratchCenter = new THREE.Vector3();

  private readonly scratchBox = new THREE.Box3();
  private readonly scratchSize = new THREE.Vector3();

  constructor(
    nodes: OctNode[],
    rootChildren: number[],
    cellNodes: number[],
    coarsest: number,
    options: Lcc2SceneOptions,
    sceneDiagonal: number,
  ) {
    this.qualityPolicy = options.lcc2Policy;
    this.sceneDiagonal = sceneDiagonal;
    this.nodes = nodes;
    this.rootChildren = rootChildren;
    this.cellNodes = cellNodes;
    this.coarsest = coarsest;
    this.budget = options.budget;
    this.lodBaseDistance = options.lodBaseDistance;
    this.lodMultiplier = options.lodMultiplier;

    const n = cellNodes.length;
    this.cellFinestLevel = new Int32Array(n);
    this.cellLevel = new Int32Array(n).fill(coarsest);
    this.changedAt = new Float64Array(n);
    for (let c = 0; c < n; c++) {
      this.cellFinestLevel[c] = (nodes[cellNodes[c] as number] as OctNode).level;
    }
    this.cellRootChild = new Uint32Array(n);
    rootChildren.forEach((nodeIndex, r) => {
      const node = nodes[nodeIndex] as OctNode;
      for (let cell = node.leafStart; cell < node.leafEnd; cell++) this.cellRootChild[cell] = r;
    });
  }

  /** Bounds desktop cuts by actual row allocations without changing the authored budget. */
  setPoolCapacity(capacitySlots: number, rowWidth: number): void {
    if (!this.qualityPolicy) return;
    if (this.poolCapacitySlots === capacitySlots && this.poolRowWidth === rowWidth) return;
    this.poolCapacitySlots = capacitySlots;
    this.poolRowWidth = rowWidth;
    this.lastSelectionAt = -Infinity;
  }

  computeDesiredRuns(
    cameraLocal: THREE.Vector3,
    frustum: THREE.Frustum,
    now: number,
    cameraForward?: THREE.Vector3,
    onTiming?: (stage: 'levelUpdate' | 'budgetSelect' | 'collectCut', durationMs: number) => void,
  ): LodRun[] {
    this.updateLoadFrustumMargin(cameraLocal, now, cameraForward);
    const sameFrustum = frustum.planes.every((plane, index) => {
      const offset = index * 4;
      return (
        this.lastSelectionFrustum[offset] === plane.normal.x &&
        this.lastSelectionFrustum[offset + 1] === plane.normal.y &&
        this.lastSelectionFrustum[offset + 2] === plane.normal.z &&
        this.lastSelectionFrustum[offset + 3] === plane.constant
      );
    });
    const sameForward = cameraForward
      ? this.lastSelectionForward.equals(cameraForward)
      : this.lastSelectionForward.x === Infinity;
    // Chunk arrival changes readiness, not this manifest's desired cut. Keep
    // unfinished staging's selection while the pose/policy are unchanged;
    // re-evaluate at the dwell deadline so pending distance changes still land.
    if (
      this.lastSelectionCamera.equals(cameraLocal) &&
      sameForward &&
      sameFrustum &&
      this.lastSelectionBudget === this.budget &&
      this.lastSelectionBaseDistance === this.lodBaseDistance &&
      this.lastSelectionMultiplier === this.lodMultiplier &&
      this.lastSelectionLoadMargin === this.loadFrustumMargin &&
      now - this.lastSelectionAt < DWELL_MS
    ) {
      return this.lastDesiredRuns;
    }
    this.lastSelectionCamera.copy(cameraLocal);
    if (cameraForward) this.lastSelectionForward.copy(cameraForward);
    else this.lastSelectionForward.set(Infinity, Infinity, Infinity);
    frustum.planes.forEach((plane, index) => {
      this.lastSelectionFrustum.set(
        [plane.normal.x, plane.normal.y, plane.normal.z, plane.constant],
        index * 4,
      );
    });
    this.lastSelectionBudget = this.budget;
    this.lastSelectionBaseDistance = this.lodBaseDistance;
    this.lastSelectionMultiplier = this.lodMultiplier;
    this.lastSelectionLoadMargin = this.loadFrustumMargin;
    this.lastSelectionAt = now;
    const levelUpdateStartedAt = onTiming ? performance.now() : 0;
    const cellDistance = this.updateCellLevels(cameraLocal, frustum, now);
    if (onTiming) onTiming('levelUpdate', performance.now() - levelUpdateStartedAt);

    const budgetSelectStartedAt = onTiming ? performance.now() : 0;
    // resolved[] starts from the dwelled per-cell levels, then is
    // budget-adjusted; keeping the dwelled base separate (like the SOG
    // scheduler's level/resolved split) prevents budget changes from
    // feeding back into the hysteresis.
    const resolved = Int32Array.from(this.cellLevel);
    // A cell's level only affects the cut inside its own root-child subtree,
    // so per-subtree contributions are cached and each adjustment step
    // re-walks one subtree - not the whole tree, which made the enforce/fill
    // loops O(cells² · depth) on heavily over-budget scenes.
    const contributions = this.rootChildren.map((index) => this.subtreeCutTotal(index, resolved));
    let total = contributions.reduce((sum, count) => sum + count, 0);
    const slotContributions = Number.isFinite(this.poolCapacitySlots)
      ? this.rootChildren.map((index) => this.subtreeCutTotal(index, resolved, this.poolRowWidth))
      : undefined;
    let totalSlots = slotContributions?.reduce((sum, count) => sum + count, 0) ?? 0;
    const overLimit = (): boolean => total > this.budget || totalSlots > this.poolCapacitySlots;
    const adjust = (cell: number, delta: number): void => {
      resolved[cell] = (resolved[cell] as number) + delta;
      const r = this.cellRootChild[cell] as number;
      const next = this.subtreeCutTotal(this.rootChildren[r] as number, resolved);
      total += next - (contributions[r] as number);
      contributions[r] = next;
      if (slotContributions) {
        const slots = this.subtreeCutTotal(this.rootChildren[r] as number, resolved, this.poolRowWidth);
        totalSlots += slots - (slotContributions[r] as number);
        slotContributions[r] = slots;
      }
    };

    const visible = this.qualityPolicy
      ? this.cellNodes.map((_, cell) => this.cellIntersectsFrustum(frustum, cell))
      : undefined;
    const priorityDistance = this.cellNodes.map((index, cell) => {
      const distance = cellDistance[cell] as number;
      if (!this.qualityPolicy || !cameraForward) return distance;
      (this.nodes[index] as OctNode).bounds.getCenter(this.scratchCenter);
      this.scratchCenter.sub(cameraLocal).normalize();
      const dot = Math.max(0, this.scratchCenter.dot(cameraForward));
      return distance * (1 + (1 - dot) * Math.min(1, distance / 12));
    });
    const byDistanceDesc = [...this.cellNodes.keys()].sort(
      (a, b) =>
        (visible ? Number(visible[a]) - Number(visible[b]) : 0) ||
        (priorityDistance[b] as number) - (priorityDistance[a] as number),
    );
    // Enforce: coarsen the farthest cells until the cut fits the budget.
    for (let i = 0; i < byDistanceDesc.length && overLimit();) {
      const c = byDistanceDesc[i] as number;
      if ((resolved[c] as number) < this.coarsest) {
        adjust(c, +1);
      } else {
        i++;
      }
    }
    // Desktop detail owns the full active budget; hidden replacements have
    // separate pool checks. Keep the legacy stop threshold on constrained
    // devices and callers that did not opt into the desktop quality policy.
    const fillTarget = this.budget * (this.qualityPolicy ? 1 : 0.85);
    for (let i = byDistanceDesc.length - 1; i >= 0 && total < fillTarget;) {
      const c = byDistanceDesc[i] as number;
      const finestWanted = this.qualityPolicy
        ? (this.cellLevel[c] as number)
        : (this.cellFinestLevel[c] as number);
      if ((resolved[c] as number) > finestWanted) {
        adjust(c, -1);
        if (overLimit()) {
          adjust(c, +1); // Keep coverage before considering another refinement.
          if (!this.qualityPolicy) break; // Legacy distance selection stops at its first overshoot.
          i--;
        }
      } else {
        i--;
      }
    }

    if (onTiming) onTiming('budgetSelect', performance.now() - budgetSelectStartedAt);
    const collectCutStartedAt = onTiming ? performance.now() : 0;
    const runs: LodRun[] = [];
    this.collectCut(resolved, (index) => {
      const node = this.nodes[index] as OctNode;
      const distance = node.bounds.distanceToPoint(cameraLocal);
      node.bounds.getCenter(this.scratchCenter).sub(cameraLocal).normalize();
      const forwardDot = cameraForward ? Math.max(0, this.scratchCenter.dot(cameraForward)) : 1;
      // Carry the camera rank through to the shared fetch and staging queues.
      // A correct cut alone cannot make nearby detail arrive first when its
      // owners lose their distance/frustum metadata at this boundary.
      runs.push({
        ...runFromNode(node),
        distance,
        inView: frustum.intersectsBox(node.bounds),
        screenImportance: distance * (1 + (1 - forwardDot) * Math.min(1, distance / 12)),
      });
    });
    if (onTiming) onTiming('collectCut', performance.now() - collectCutStartedAt);
    this.lastDesiredRuns = runs;
    return runs;
  }

  /** Publish available child covers without waiting for every final descendant. */
  computeStreamingCut(
    desired: readonly LodRun[],
    available: (run: LodRun) => boolean,
    preparing?: (run: LodRun) => boolean,
  ): { runs: LodRun[]; pending: LodRun[] } {
    if (!this.qualityPolicy) return { runs: [...desired], pending: [] };
    const targets = new Set(
      desired.map((run) => `${run.file}:${run.level}:${run.offset}:${run.count}`),
    );
    const rankedRun = (node: OctNode): LodRun => {
      const owners = desired.filter(
        (run) => run.leafStart < node.leafEnd && run.leafEnd > node.leafStart,
      );
      return {
        ...runFromNode(node),
        distance: Math.min(...owners.map((run) => run.distance ?? Infinity)),
        inView: owners.some((run) => run.inView === true),
        screenImportance: Math.min(...owners.map((run) => run.screenImportance ?? Infinity)),
      };
    };
    type Cover = { runs: LodRun[]; pending: LodRun[]; ready: boolean };
    const visit = (index: number): Cover => {
      const node = this.nodes[index] as OctNode;
      const run = rankedRun(node);
      const ready = available(run);
      if (
        targets.has(`${run.file}:${run.level}:${run.offset}:${run.count}`) ||
        node.children.length === 0
      ) {
        return { runs: [run], pending: ready ? [] : [run], ready };
      }
      if (preparing?.(run)) {
        // Finish and publish a compatible intermediate already being uploaded.
        // A finer file arriving mid-upload must not erase that progress and
        // replace a small near-term swap with a much larger hidden transaction.
        return { runs: [run], pending: ready ? [] : [run], ready };
      }
      const children = node.children.map(visit);
      if (children.every((child) => child.ready)) {
        return {
          runs: children.flatMap((child) => child.runs),
          pending: children.flatMap((child) => child.pending),
          ready: true,
        };
      }
      // Only request the next unavailable children of a complete cover. This
      // bounds each ancestor swap and lets nearby child regions refine on their
      // own, instead of making the whole root wait for distant final leaves.
      return {
        runs: [run],
        pending: ready
          ? children.flatMap((child, childIndex) =>
              child.ready
                ? child.pending
                : [rankedRun(this.nodes[node.children[childIndex] as number] as OctNode)],
            )
          : [run],
        ready,
      };
    };
    const covers = this.rootChildren.map(visit);
    return {
      runs: covers.flatMap((cover) => cover.runs),
      pending: covers.flatMap((cover) => cover.pending),
    };
  }

  /** Snapshot manifest depths and desired owners without exposing mutable scheduler state. */
  get lcc2QualityState(): Lcc2SelectionState {
    const manifestNodeDepthCounts: Record<number, number> = {};
    for (const node of this.nodes) {
      const depth = this.coarsest + 1 - node.level;
      manifestNodeDepthCounts[depth] = (manifestNodeDepthCounts[depth] ?? 0) + 1;
    }
    return {
      profile: this.qualityPolicy ? 'desktop' : 'distance',
      totalLevels: this.coarsest + 1,
      baseDepth: this.qualityPolicy ? this.baseDepthForBudget() : null,
      budget: this.budget,
      manifestNodeDepthCounts,
      desired: this.lastDesiredRuns.map((run) => ({
        ...run,
        depth: this.coarsest + 1 - run.level,
      })),
    };
  }

  coarsestRunsFor(from: number, to: number): LodRun[] {
    const runs: LodRun[] = [];
    for (const index of this.rootChildren) {
      const node = this.nodes[index] as OctNode;
      if (node.leafStart < to && node.leafEnd > from) runs.push(runFromNode(node));
    }
    return runs;
  }

  /**
   * Initial base runs covering in-view finest cells. Desktop quality uses
   * its budget-derived base depth; legacy distance policy stays coarsest.
   * An empty frustum
   * falls back to the nearest cell's root child so a skyward start still paints
   * something rather than releasing an empty hold.
   */
  coverageRunsFor(cameraLocal: THREE.Vector3, frustum: THREE.Frustum): LodRun[] {
    const n = this.cellNodes.length;
    if (n === 0) return [];
    const picked = new Uint8Array(this.rootChildren.length);
    let anyInView = false;
    let nearestCell = 0;
    let nearestDist = Number.POSITIVE_INFINITY;
    for (let c = 0; c < n; c++) {
      const node = this.nodes[this.cellNodes[c] as number] as OctNode;
      const d = node.bounds.distanceToPoint(cameraLocal);
      if (d < nearestDist) {
        nearestDist = d;
        nearestCell = c;
      }
      if (this.cellIntersectsFrustum(frustum, c)) {
        picked[this.cellRootChild[c] as number] = 1;
        anyInView = true;
      }
    }
    if (!anyInView) picked[this.cellRootChild[nearestCell] as number] = 1;
    // Spark loads its budget-derived base before revealing the scene. Starting
    // desktop LCC2 at the shallowest cover instead adds several download/upload
    // transactions after the camera path has already begun.
    const baseLevel = this.qualityPolicy
      ? this.coarsest + 1 - this.baseDepthForBudget()
      : this.coarsest;
    const levels = new Int32Array(n).fill(baseLevel);
    const runs: LodRun[] = [];
    for (let r = 0; r < this.rootChildren.length; r++) {
      if (picked[r] !== 1) continue;
      this.visitCut(this.rootChildren[r] as number, levels, (index) => {
        runs.push(runFromNode(this.nodes[index] as OctNode));
      });
    }
    return runs;
  }

  /** Finest-cell AABB expanded by {@link FRUSTUM_MARGIN}, written into scratch. */
  private expandCellBox(cell: number): THREE.Box3 {
    const node = this.nodes[this.cellNodes[cell] as number] as OctNode;
    this.scratchBox.copy(node.bounds);
    node.bounds.getSize(this.scratchSize);
    this.scratchBox.expandByScalar(this.scratchSize.length() * FRUSTUM_MARGIN);
    return this.scratchBox;
  }

  private cellIntersectsFrustum(frustum: THREE.Frustum, cell: number): boolean {
    return frustum.intersectsBox(this.expandCellBox(cell));
  }

  /** Widens only desktop loading hints while translation or rotation continues. */
  private updateLoadFrustumMargin(
    cameraLocal: THREE.Vector3,
    now: number,
    cameraForward?: THREE.Vector3,
  ): void {
    if (!this.qualityPolicy) return;
    const moved =
      this.movementCamera.x === Infinity ||
      this.movementCamera.distanceToSquared(cameraLocal) > DESKTOP_MOVEMENT_DISTANCE_SQ ||
      (cameraForward !== undefined &&
        (this.movementForward.x === Infinity ||
          this.movementForward.dot(cameraForward) < DESKTOP_MOVEMENT_DIRECTION_DOT));
    if (moved) {
      this.movementCamera.copy(cameraLocal);
      if (cameraForward) this.movementForward.copy(cameraForward);
      this.movementGraceUntil = now + DESKTOP_MOVEMENT_GRACE_MS;
    }
    const moving = now < this.movementGraceUntil;
    this.loadFrustumMargin = Math.max(
      moving ? DESKTOP_MOVING_LOAD_MARGIN : DESKTOP_LOAD_MARGIN,
      this.sceneDiagonal *
        (moving ? DESKTOP_MOVING_LOAD_MARGIN_SCENE_FACTOR : DESKTOP_LOAD_MARGIN_SCENE_FACTOR),
    );
  }

  /** Distance (frustum-penalized) to each finest cell's node bounds. */
  private cellDistanceOf(cameraLocal: THREE.Vector3, frustum: THREE.Frustum, cell: number): number {
    const node = this.nodes[this.cellNodes[cell] as number] as OctNode;
    const d = node.bounds.distanceToPoint(cameraLocal);
    const inLoadFrustum = this.qualityPolicy
      ? frustum.intersectsBox(this.expandCellBox(cell).expandByScalar(this.loadFrustumMargin))
      : this.cellIntersectsFrustum(frustum, cell);
    return inLoadFrustum ? d : d * FRUSTUM_PENALTY;
  }

  /** Advances each cell's dwelled level toward the distance target. */
  private updateCellLevels(
    cameraLocal: THREE.Vector3,
    frustum: THREE.Frustum,
    now: number,
  ): Float64Array {
    const { lodBaseDistance: base, lodMultiplier: m } = this;
    const baseDepth = this.qualityPolicy ? this.baseDepthForBudget() : 0;
    const threshold = (level: number): number => {
      if (!this.qualityPolicy) return base * m ** level;
      // Manifest depth grows toward fine detail; VLAM levels grow toward coarse.
      const depth = this.coarsest + 1 - level;
      const relative = depth - (baseDepth + 1);
      if (relative < 0) return Math.max(250, this.sceneDiagonal * 0.6);
      if (relative === 0) return Math.max(80, this.sceneDiagonal * 0.35);
      if (relative === 1) return Math.max(55, this.sceneDiagonal * 0.25);
      return Math.max(35, this.sceneDiagonal * 0.18);
    };
    const distances = new Float64Array(this.cellNodes.length);
    for (let c = 0; c < this.cellNodes.length; c++) {
      const d = this.cellDistanceOf(cameraLocal, frustum, c);
      distances[c] = d;

      const min = this.cellFinestLevel[c] as number;
      let level = Math.min(this.coarsest, Math.max(min, this.cellLevel[c] as number));
      // Dead-band: coarsen only past threshold·(1+margin), refine only
      // within threshold·(1−margin); threshold(L) = base·m^L.
      while (level < this.coarsest && d > threshold(level) * (1 + THRESHOLD_MARGIN)) level++;
      while (level > min && d <= threshold(level - 1) * (1 - THRESHOLD_MARGIN)) level--;

      if (
        level !== (this.cellLevel[c] as number) &&
        now - (this.changedAt[c] as number) >= DWELL_MS
      ) {
        this.cellLevel[c] = level;
        this.changedAt[c] = now;
      }
    }
    return distances;
  }

  /** Match the adapter's cumulative half-budget base while leaving the deepest rung adaptive. */
  private baseDepthForBudget(): number {
    const totals = new Map<number, number>();
    for (const node of this.nodes) {
      const depth = this.coarsest + 1 - node.level;
      totals.set(depth, (totals.get(depth) ?? 0) + node.count);
    }
    const depths = [...totals.keys()].sort((a, b) => a - b);
    let cumulative = 0;
    let baseDepth = depths[0] ?? 1;
    const deepest = depths[depths.length - 1] ?? 1;
    for (const depth of depths) {
      if (depth >= deepest) break;
      cumulative += totals.get(depth) ?? 0;
      if (cumulative > this.budget * 0.5 && depth > baseDepth) break;
      baseDepth = depth;
    }
    return baseDepth;
  }

  /** Splat total of one subtree's cut for the given per-cell levels. */
  private subtreeCutTotal(index: number, levels: Int32Array, rowWidth = 1): number {
    let total = 0;
    this.visitCut(index, levels, (i) => {
      total += Math.ceil((this.nodes[i] as OctNode).count / rowWidth) * rowWidth;
    });
    return total;
  }

  /**
   * Walks the tree emitting the cut for the given per-cell levels: a node is
   * selected (stop) unless some cell in its subtree wants finer than the
   * node provides, in which case its children are visited. Guarantees an
   * antichain - exactly one node per root→leaf path.
   */
  private collectCut(levels: Int32Array, emit: (index: number) => void): void {
    for (const index of this.rootChildren) this.visitCut(index, levels, emit);
  }

  /** {@link collectCut} restricted to one subtree. */
  private visitCut(index: number, levels: Int32Array, emit: (index: number) => void): void {
    const node = this.nodes[index] as OctNode;
    if (node.children.length > 0) {
      let minWanted = this.coarsest;
      for (let cell = node.leafStart; cell < node.leafEnd; cell++) {
        const level = levels[cell] as number;
        if (level < minWanted) minWanted = level;
      }
      if (minWanted < node.level) {
        for (const child of node.children) this.visitCut(child, levels, emit);
        return;
      }
    }
    emit(index);
  }
}

function runFromNode(node: OctNode): LodRun {
  return {
    file: node.file,
    level: node.level,
    offset: node.offset,
    count: node.count,
    leafStart: node.leafStart,
    leafEnd: node.leafEnd,
  };
}

function boxFromRaw(bound: RawNode['boundingBox']): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(bound.min[0], bound.min[1], bound.min[2]),
    new THREE.Vector3(bound.max[0], bound.max[1], bound.max[2]),
  );
}
