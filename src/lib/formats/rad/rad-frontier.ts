import type { SplatData } from '../../core/splat-data';
import {
  FRONTIER_FOVEATION_DEFAULTS,
  type FrontierFoveation,
  type FrontierSkipReason,
  type FrontierSkipSample,
  type FrontierCutDiagnostic,
} from './frontier-worker-protocol';

/**
 * CPU evaluation of Spark's LOD tree cut, for the page-table renderer.
 *
 * {@link traverseFrontier} follows Spark's best-first tree descent. Storage is
 * different: Spark 2.1 keeps complete 65,536-splat GPU pages and changes an index
 * list; VLAM gathers only selected splats into its slot pool. Matching the
 * traversal does not make the staging or residency strategies equivalent.
 * See `docs/formats/rad-notes.md` M14.6.
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

/** Shared foveated node-size calculation for the heap and threshold cuts. */
export function pixelScaleOf(data: SplatData, local: number, view: FrontierView): number {
  const pos = data.positions;
  const b = local * 3;
  const dx = (pos[b] as number) - view.origin.x;
  const dy = (pos[b + 1] as number) - view.origin.y;
  const dz = (pos[b + 2] as number) - view.origin.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
  const scale = (data.radTree!.size[local] as number) / d;
  const forward = view.forward;
  if (!forward) return scale;
  // Spark's ramp weights off-cone content but never removes its coarse cover.
  const forwardDot = dx * forward.x + dy * forward.y + dz * forward.z;
  if (forwardDot <= 0) return scale * view.behindFoveate;
  const dot = forwardDot / d;
  if (dot >= view.coneDot0) return scale;
  if (dot >= view.coneDot) {
    const t = (dot - view.coneDot) / (view.coneDot0 - view.coneDot);
    return scale * (view.coneFoveate + (1 - view.coneFoveate) * t);
  }
  return (
    scale * (view.behindFoveate + (view.coneFoveate - view.behindFoveate) * (dot / view.coneDot))
  );
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
 * (`traverse_lod_trees`, `lod_tree.rs` in Spark 2.1.0):
 * - **Complete coverage.** Every root→leaf ray ends with exactly one node in the
 *   output, whatever the camera or the cache state - there is no cull that can
 *   leave a region unrepresented.
 * - **In budget by construction.** The count is checked *before* each descent,
 *   so a single pass is always within `maxSplats`. Spark accepts
 *   `lastPixelLimit` but does not use it; the configured pixel threshold is
 *   the stop condition and leftover draw budget is not spent by a second walk.
 *
 * `chunkMap` resolves a file index to its decoded chunk; `roots` are global
 * indices to seed from (maintained incrementally by the caller).
 */
export interface FrontierTraversalOptions {
  /** Reused heap/output storage. Capacity is retained across walks. */
  readonly scratch?: FrontierScratch;
  /** Collect selected-node samples for an explicit diagnostic run. */
  readonly collectDiagnostics?: boolean;
}

export interface FrontierWaiter {
  readonly parentGlobal: number;
  readonly pixelScale: number;
  readonly files: readonly number[];
}

export interface FrontierScratch {
  readonly heap: MaxHeap;
  readonly picks: Map<number, number[]>;
  readonly touched: Map<number, number>;
  readonly waiters: FrontierWaiter[];
}

export function createFrontierScratch(): FrontierScratch {
  return {
    heap: new MaxHeap(),
    picks: new Map(),
    touched: new Map(),
    waiters: [],
  };
}

export interface FrontierTraversalResult {
  selection: FrontierSelection;
  count: number;
  touched: Map<number, number>;
  waiters: readonly FrontierWaiter[];
  /** The descent stopped because refining further would exceed `maxSplats`. */
  budgetClamped: boolean;
  /** Even the root set exceeds `maxSplats`; do not publish or re-walk until allocation grows. */
  rootCoverInfeasible: boolean;
  /**
   * Some frontier node still has cached children, so a finer `limit` would
   * select more splats. This is what tells a caller whether spending leftover
   * budget is possible at all, or whether the cut has simply reached the
   * capture's leaves (or the edge of what is cached).
   */
  refinable: boolean;
  /** Highest-importance selected nodes, for skip-reason diagnostics. */
  notables: readonly { global: number; pixelScale: number }[];
}

export function traverseFrontier(
  chunkMap: ReadonlyMap<number, SplatData>,
  roots: readonly number[],
  chunkSize: number,
  view: FrontierView,
  limit: number,
  maxSplats = Number.POSITIVE_INFINITY,
  options: FrontierTraversalOptions = {},
): FrontierTraversalResult {
  const scratch = options.scratch ?? createFrontierScratch();
  const heap = scratch.heap;
  const picks = scratch.picks;
  const touched = scratch.touched;
  const waiters = scratch.waiters;
  heap.clear();
  picks.clear();
  touched.clear();
  waiters.length = 0;

  const notables: { global: number; pixelScale: number }[] | null = options.collectDiagnostics
    ? []
    : null;
  const note = (global: number, pixelScale: number): void => {
    if (!notables) return;
    if (notables.length < 8) {
      notables.push({ global, pixelScale });
      return;
    }
    let min = 0;
    for (let i = 1; i < notables.length; i++) {
      if ((notables[i] as { pixelScale: number }).pixelScale < notables[min]!.pixelScale) min = i;
    }
    if (pixelScale > notables[min]!.pixelScale) notables[min] = { global, pixelScale };
  };
  const output = (file: number, local: number, pixelScale: number, _data: SplatData): void => {
    let picked = picks.get(file);
    if (!picked) {
      picked = [];
      picks.set(file, picked);
    }
    picked.push(local);
    note(file * chunkSize + local, pixelScale);
  };

  const touchMissing = (
    parentGlobal: number,
    pixelScale: number,
    firstChunk: number,
    lastChunk: number,
  ): boolean => {
    const files: number[] = [];
    let allCached = true;
    for (let cc = firstChunk; cc <= lastChunk; cc++) {
      if (chunkMap.has(cc)) continue;
      allCached = false;
      files.push(cc);
      if (pixelScale > (touched.get(cc) ?? 0)) touched.set(cc, pixelScale);
    }
    if (!allCached) waiters.push({ parentGlobal, pixelScale, files });
    return allCached;
  };

  // Seed the roots. `numSplats` tracks heap + output, exactly as Spark's
  // `num_splats` does, so the budget can be checked before each descent.
  let numSplats = 0;
  const seeded = new Set<number>();
  for (const r of roots) {
    if (seeded.has(r)) continue;
    const file = Math.floor(r / chunkSize);
    const data = chunkMap.get(file);
    if (!data?.radTree) continue;
    seeded.add(r);
    heap.push(r, pixelScaleOf(data, r - file * chunkSize, view));
    numSplats++;
  }

  let budgetClamped = false;
  const rootCoverInfeasible = Number.isFinite(maxSplats) && numSplats > maxSplats;
  while (heap.size > 0) {
    const pixelScale = heap.peekPriority();
    if (pixelScale <= limit) break;
    const global = heap.peek();
    const file = Math.floor(global / chunkSize);
    const data = chunkMap.get(file);
    const local = global - file * chunkSize;
    if (!data?.radTree) {
      heap.pop();
      numSplats--;
      continue;
    }
    const tree = data.radTree;
    const childCount = tree.childCount[local] as number;

    if (childCount === 0) {
      heap.pop();
      output(file, local, pixelScale, data);
      continue;
    }
    const nextSplats = numSplats - 1 + childCount;
    if (nextSplats > maxSplats) {
      budgetClamped = true;
      break;
    }

    heap.pop();
    const childStart = tree.childStart[local] as number;
    const firstChunk = Math.floor(childStart / chunkSize);
    const lastChunk = Math.floor((childStart + childCount - 1) / chunkSize);
    if (!touchMissing(global, pixelScale, firstChunk, lastChunk)) {
      output(file, local, pixelScale, data);
      continue;
    }
    for (let c = 0; c < childCount; c++) {
      const child = childStart + c;
      const childFile = Math.floor(child / chunkSize);
      const childData = chunkMap.get(childFile)!;
      const childLocal = child - childFile * chunkSize;
      const childScale = pixelScaleOf(childData, childLocal, view);
      if (childScale <= limit) {
        output(childFile, childLocal, childScale, childData);
      } else {
        heap.push(child, childScale);
      }
    }
    numSplats = nextSplats;
  }

  // Spark emits remaining heap entries linearly and keeps the scratch buffer.
  // Membership is the selected set; request ordering is tracked separately.
  let refinable = false;
  for (let i = 0; i < heap.size; i++) {
    const global = heap.itemAt(i);
    const pixelScale = heap.priorityAt(i);
    const file = Math.floor(global / chunkSize);
    const data = chunkMap.get(file);
    const local = global - file * chunkSize;
    if (!data?.radTree) continue;
    output(file, local, pixelScale, data);
    if (refinable) continue;
    const childCount = data.radTree.childCount[local] as number;
    if (childCount <= 0) continue;
    const childStart = data.radTree.childStart[local] as number;
    const firstChunk = Math.floor(childStart / chunkSize);
    const lastChunk = Math.floor((childStart + childCount - 1) / chunkSize);
    let allCached = true;
    for (let cc = firstChunk; cc <= lastChunk && allCached; cc++) {
      if (!chunkMap.has(cc)) allCached = false;
    }
    if (allCached) refinable = true;
  }
  heap.clear();

  const selection: FrontierSelection = new Map();
  let count = 0;
  for (const [file, picked] of picks) {
    selection.set(file, Uint32Array.from(picked));
    count += picked.length;
  }
  notables?.sort((a, b) => b.pixelScale - a.pixelScale);
  return {
    selection,
    count,
    touched,
    waiters: waiters.slice(),
    budgetClamped,
    refinable,
    rootCoverInfeasible,
    notables: notables ?? [],
  };
}

/**
 * Why a selected (or candidate) node was not subdivided, using the same tests
 * as {@link traverseFrontier}. `would-subdivide` means the walk kept a node that
 * Spark would have expanded: children resident, above the pixel threshold, and
 * inside the draw budget.
 */
export function explainFrontierNode(
  chunkMap: ReadonlyMap<number, SplatData>,
  global: number,
  chunkSize: number,
  view: FrontierView,
  limit: number,
  maxSplats: number,
  traversal: { readonly count: number; readonly budgetClamped: boolean },
): FrontierSkipSample | null {
  const file = Math.floor(global / chunkSize);
  const data = chunkMap.get(file);
  if (!data) return null;
  const local = global - file * chunkSize;
  const px = local * 3;
  const center = [
    data.positions[px] as number,
    data.positions[px + 1] as number,
    data.positions[px + 2] as number,
  ] as const;
  if (!data.radTree) {
    return {
      global,
      center,
      size: 0,
      childCount: 0,
      childStart: 0,
      pixelScale: 0,
      reason: 'no-tree' satisfies FrontierSkipReason,
      missingFiles: [],
    };
  }
  const childCount = data.radTree.childCount[local] as number;
  const childStart = data.radTree.childStart[local] as number;
  const size = data.radTree.size[local] as number;
  const pixelScale = pixelScaleOf(data, local, view);
  const missingFiles: number[] = [];
  if (childCount > 0) {
    const firstChunk = Math.floor(childStart / chunkSize);
    const lastChunk = Math.floor((childStart + childCount - 1) / chunkSize);
    for (let cc = firstChunk; cc <= lastChunk; cc++) {
      if (!chunkMap.has(cc)) missingFiles.push(cc);
    }
  }
  let reason: FrontierSkipReason;
  if (childCount === 0) reason = 'leaf';
  else if (pixelScale <= limit) reason = 'below-threshold';
  else if (missingFiles.length > 0) reason = 'missing-children';
  else if (traversal.budgetClamped || traversal.count - 1 + childCount > maxSplats)
    reason = 'budget';
  else reason = 'would-subdivide';
  return { global, center, size, childCount, childStart, pixelScale, reason, missingFiles };
}

/** A bounded depth-first cut; falls back to the heap before any over-cap cut escapes. */
export function traverseFrontierBounded(
  chunkMap: ReadonlyMap<number, SplatData>,
  roots: readonly number[],
  chunkSize: number,
  view: FrontierView,
  threshold: number,
  maxSplats: number,
  stack: number[] = [],
): ReturnType<typeof traverseFrontier> & { fallback: boolean; rootCoverInfeasible: boolean } {
  const fallback = (rootCoverInfeasible: boolean) => ({
    ...traverseFrontier(chunkMap, roots, chunkSize, view, threshold, maxSplats),
    fallback: true,
    rootCoverInfeasible,
  });
  if (!Number.isSafeInteger(maxSplats) || maxSplats < 1) return fallback(true);
  stack.length = 0;
  const seeded = new Set<number>();
  for (const root of roots) {
    if (seeded.has(root)) continue;
    if (!chunkMap.get(Math.floor(root / chunkSize))?.radTree) continue;
    seeded.add(root);
    stack.push(root);
  }
  if (stack.length > maxSplats) {
    stack.length = 0;
    return fallback(true);
  }

  const picks = new Map<number, number[]>();
  const touched = new Map<number, number>();
  let count = stack.length; // selected outputs plus unresolved stack nodes
  let refinable = false;
  while (stack.length > 0) {
    const global = stack.pop() as number;
    const file = Math.floor(global / chunkSize);
    const data = chunkMap.get(file);
    const local = global - file * chunkSize;
    if (!data?.radTree || local >= data.count) {
      count--;
      continue;
    }
    const tree = data.radTree;
    const childCount = tree.childCount[local] as number;
    const scale = pixelScaleOf(data, local, view);
    let allCached = true;
    if (childCount > 0) {
      const childStart = tree.childStart[local] as number;
      const firstChunk = Math.floor(childStart / chunkSize);
      const lastChunk = Math.floor((childStart + childCount - 1) / chunkSize);
      for (let cc = firstChunk; cc <= lastChunk; cc++) {
        if (chunkMap.has(cc)) continue;
        allCached = false;
        if (scale > threshold && scale > (touched.get(cc) ?? 0)) touched.set(cc, scale);
      }
    }
    if (childCount === 0 || scale <= threshold || !allCached) {
      let selected = picks.get(file);
      if (!selected) {
        selected = [];
        picks.set(file, selected);
      }
      selected.push(local);
      if (childCount > 0 && allCached) refinable = true;
      continue;
    }
    const nextCount = count - 1 + childCount;
    if (nextCount > maxSplats) {
      stack.length = 0;
      return fallback(false);
    }
    count = nextCount;
    const childStart = tree.childStart[local] as number;
    for (let child = childStart + childCount - 1; child >= childStart; child--) stack.push(child);
  }
  const selection: FrontierSelection = new Map();
  for (const [file, locals] of picks) selection.set(file, Uint32Array.from(locals));
  return {
    selection,
    count,
    touched,
    waiters: [],
    budgetClamped: false,
    refinable,
    fallback: false,
    rootCoverInfeasible: false,
    notables: [],
  };
}

/** Minimal binary max-heap of (global, priority), for the frontier traversal. */
export class MaxHeap {
  private readonly items: number[] = []; // global indices
  private readonly prio: number[] = [];

  get size(): number {
    return this.items.length;
  }

  /** Drops entries without releasing backing arrays. */
  clear(): void {
    this.items.length = 0;
    this.prio.length = 0;
  }

  /** Remaining heap entry at `index`, in storage order, not priority order. */
  itemAt(index: number): number {
    return this.items[index] as number;
  }

  /** Priority of {@link itemAt}. */
  priorityAt(index: number): number {
    return this.prio[index] as number;
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

/** Projected-quality measurements for one selected RAD cut. */
export interface FrontierRevealQuality {
  readonly revealReady: boolean;
  readonly maxCentralProjectedRatio: number;
  readonly maxVisibleProjectedRatio: number;
}

const REVEAL_CENTRAL_DOT = Math.cos(Math.PI / 6);

function footprintVisibleInFrustum(
  x: number,
  y: number,
  z: number,
  projection: ArrayLike<number>,
  covariances: Float32Array,
  offset: number,
  stdDev: number,
): boolean {
  if (projection.length < 16) return true;
  // A coarse parent's centre can be outside the view while its ellipse covers
  // it. Test the fitted ellipsoid against each clip plane, not just its centre.
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const nx = (projection[3] as number) + sign * (projection[axis] as number);
      const ny = (projection[7] as number) + sign * (projection[4 + axis] as number);
      const nz = (projection[11] as number) + sign * (projection[8 + axis] as number);
      const d = (projection[15] as number) + sign * (projection[12 + axis] as number);
      const variance =
        nx * nx * (covariances[offset] as number) +
        2 * nx * ny * (covariances[offset + 1] as number) +
        2 * nx * nz * (covariances[offset + 2] as number) +
        ny * ny * (covariances[offset + 3] as number) +
        2 * ny * nz * (covariances[offset + 4] as number) +
        nz * nz * (covariances[offset + 5] as number);
      if (nx * x + ny * y + nz * z + d + stdDev * Math.sqrt(Math.max(0, variance)) < 0)
        return false;
    }
  }
  return true;
}

/**
 * Evaluates whether a selected cut is safe to show as the first RAD frame.
 * Internal nodes use the hierarchy's fitted size and camera distance; leaves
 * are ignored because they have no finer child cut to wait for.
 */
export function assessFrontierRevealQuality(
  chunkMap: ReadonlyMap<number, SplatData>,
  globals: readonly number[],
  chunkSize: number,
  view: FrontierView,
  projection: ArrayLike<number>,
  targetLimit: number,
): FrontierRevealQuality {
  let maxCentralProjectedRatio = 0;
  let maxVisibleProjectedRatio = 0;
  const forward = view.forward;
  for (const global of globals) {
    const file = Math.floor(global / chunkSize);
    const data = chunkMap.get(file);
    if (!data?.radTree) continue;
    const local = global - file * chunkSize;
    if ((data.radTree.childCount[local] as number) <= 0) continue;
    const offset = local * 3;
    const x = data.positions[offset] as number;
    const y = data.positions[offset + 1] as number;
    const z = data.positions[offset + 2] as number;
    const dx = x - view.origin.x;
    const dy = y - view.origin.y;
    const dz = z - view.origin.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    const ratio = pixelScaleOf(data, local, view) / targetLimit;
    if (forward) {
      const dot = (dx * forward.x + dy * forward.y + dz * forward.z) / distance;
      if (dot >= REVEAL_CENTRAL_DOT) {
        maxCentralProjectedRatio = Math.max(maxCentralProjectedRatio, ratio);
        continue;
      }
    }
    const alpha = ((data.colors[local * 4 + 3] as number) / 255) * 2;
    const stdDev = 3 + 0.7 * Math.max(0, Math.min(5, alpha * 4 - 3) - 1);
    if (footprintVisibleInFrustum(x, y, z, projection, data.covariances, local * 6, stdDev)) {
      maxVisibleProjectedRatio = Math.max(maxVisibleProjectedRatio, ratio);
    }
  }
  return {
    revealReady:
      Number.isFinite(targetLimit) &&
      targetLimit > 0 &&
      maxCentralProjectedRatio <= 4 &&
      maxVisibleProjectedRatio <= 8,
    maxCentralProjectedRatio,
    maxVisibleProjectedRatio,
  };
}

export type HierarchyIntermediateCutResult =
  | { readonly cut: number[]; readonly reason: 'bounded'; readonly newCount: number }
  | {
      readonly cut: null;
      readonly reason:
        'waiting-for-children' | 'non-refinement' | 'already-at-target' | 'invalid-cut';
      readonly newCount: 0;
    };

/**
 * Validates a selected RAD cut for an explicit diagnostic run. The walk stops
 * at selected nodes in the normal case, but continues below selected nodes so
 * an ancestor/descendant overlap is reported rather than hidden by the cut.
 */
export function validateHierarchyCut(
  chunkMap: ReadonlyMap<number, SplatData>,
  roots: readonly number[],
  globals: ArrayLike<number>,
  chunkSize: number,
): FrontierCutDiagnostic {
  const selected = new Set<number>();
  let duplicate = false;
  for (const global of Array.from(globals)) {
    if (selected.has(global)) duplicate = true;
    selected.add(global);
  }
  const seenSelected = new Set<number>();
  const visiting = new Set<number>();
  let ancestorOverlap = false;
  const visit = (global: number, selectedAncestor: boolean): void => {
    if (visiting.has(global)) return;
    const file = Math.floor(global / chunkSize);
    const data = chunkMap.get(file);
    const local = global - file * chunkSize;
    if (!data?.radTree || local < 0 || local >= data.count) return;
    visiting.add(global);
    const isSelected = selected.has(global);
    if (isSelected) {
      seenSelected.add(global);
      if (selectedAncestor) ancestorOverlap = true;
    }
    const childCount = data.radTree.childCount[local] as number;
    const childStart = data.radTree.childStart[local] as number;
    for (let i = 0; i < childCount; i++) {
      visit(childStart + i, selectedAncestor || isSelected);
    }
    visiting.delete(global);
  };
  for (const root of roots) visit(root, false);
  let missing = false;
  for (const global of selected) {
    const file = Math.floor(global / chunkSize);
    const data = chunkMap.get(file);
    const local = global - file * chunkSize;
    if (!data?.radTree || local < 0 || local >= data.count || !seenSelected.has(global)) {
      missing = true;
    }
  }
  return {
    valid: !duplicate && !ancestorOverlap && !missing,
    ancestorOverlap,
    duplicate,
    missing,
  };
}

/**
 * Builds one hierarchy-valid refinement step from a published cut toward a
 * finer cut. A parent is replaced only by its complete immediate child range,
 * so every returned cut remains a cover even while the final selection is
 * staged in later plans.
 *
 * This is intentionally a worker-side helper. It never coarsens a cut and it
 * refuses children whose chunks are not resident, because publishing those
 * children would turn a valid cover into a hole. The returned cut adds at most
 * `maxNewSplats` globals relative to the input cut.
 */
export function hierarchyIntermediateCut(
  chunkMap: ReadonlyMap<number, SplatData>,
  roots: readonly number[],
  currentGlobals: ArrayLike<number>,
  desiredGlobals: ArrayLike<number>,
  chunkSize: number,
  maxNewSplats = 512_000,
  view?: FrontierView,
): HierarchyIntermediateCutResult {
  if (maxNewSplats <= 0) {
    return { cut: null, reason: 'waiting-for-children', newCount: 0 };
  }
  const desiredValues = Array.from(desiredGlobals);
  const desired = new Set(desiredValues);
  const current = currentGlobals.length
    ? Array.from(currentGlobals)
    : roots.filter((global) => {
        const file = Math.floor(global / chunkSize);
        const data = chunkMap.get(file);
        return data?.radTree !== undefined && global - file * chunkSize < data.count;
      });
  if (current.length === 0 || (currentGlobals.length === 0 && current.length > maxNewSplats)) {
    return { cut: null, reason: 'waiting-for-children', newCount: 0 };
  }
  if (new Set(current).size !== current.length || desired.size !== desiredValues.length) {
    return { cut: null, reason: 'invalid-cut', newCount: 0 };
  }
  if (current.length === desired.size && current.every((global) => desired.has(global))) {
    return { cut: null, reason: 'already-at-target', newCount: 0 };
  }
  const desiredBelow = new Map<number, boolean>();
  const hasDesiredBelow = (global: number): boolean => {
    if (desired.has(global)) return true;
    const remembered = desiredBelow.get(global);
    if (remembered !== undefined) return remembered;
    const file = Math.floor(global / chunkSize);
    const data = chunkMap.get(file);
    if (!data?.radTree) {
      desiredBelow.set(global, false);
      return false;
    }
    const local = global - file * chunkSize;
    const childCount = data.radTree.childCount[local] as number;
    const childStart = data.radTree.childStart[local] as number;
    for (let i = 0; i < childCount; i++) {
      if (hasDesiredBelow(childStart + i)) {
        desiredBelow.set(global, true);
        return true;
      }
    }
    desiredBelow.set(global, false);
    return false;
  };
  const importance = (global: number): number => {
    if (!view) return 0;
    const file = Math.floor(global / chunkSize);
    const data = chunkMap.get(file);
    return data ? pixelScaleOf(data, global - file * chunkSize, view) : 0;
  };
  const heap = new MaxHeap();
  let nonRefinement = false;
  let waitingForChildren = false;
  for (const global of current) {
    if (desired.has(global)) continue;
    if (hasDesiredBelow(global)) heap.push(global, importance(global));
    else nonRefinement = true;
  }
  const nextSet = new Set(current);
  const originalSet = new Set(current);
  const replacements = new Map<number, number[]>();
  let newCount = 0;
  let changed = false;
  while (heap.size > 0) {
    const global = heap.pop();
    if (!nextSet.has(global) || desired.has(global)) continue;
    const file = Math.floor(global / chunkSize);
    const data = chunkMap.get(file);
    if (!data?.radTree) continue;
    const local = global - file * chunkSize;
    const childCount = data.radTree.childCount[local] as number;
    if (childCount <= 0) continue;
    const childStart = data.radTree.childStart[local] as number;
    const children: number[] = [];
    let resident = true;
    for (let i = 0; i < childCount; i++) {
      const child = childStart + i;
      const childFile = Math.floor(child / chunkSize);
      const childData = chunkMap.get(childFile);
      const childLocal = child - childFile * chunkSize;
      if (
        !childData?.radTree ||
        childLocal < 0 ||
        childLocal >= childData.count ||
        !hasDesiredBelow(child)
      ) {
        resident = false;
        break;
      }
      children.push(child);
    }
    if (!resident) {
      waitingForChildren = true;
      continue;
    }
    const added = children.reduce((count, child) => count + (originalSet.has(child) ? 0 : 1), 0);
    // The displayed parent stays resident until the matching publication is
    // acknowledged, so it cannot fund any of the candidate's new children.
    // Count every child that was not already present in the displayed cut.
    if (newCount + added > maxNewSplats) {
      waitingForChildren = true;
      continue;
    }
    newCount += added;
    nextSet.delete(global);
    replacements.set(global, children);
    for (const child of children) {
      nextSet.add(child);
      if (!desired.has(child)) heap.push(child, importance(child));
    }
    changed = true;
  }
  if (!changed) {
    return {
      cut: null,
      reason: nonRefinement && !waitingForChildren ? 'non-refinement' : 'waiting-for-children',
      newCount: 0,
    };
  }
  const next: number[] = [];
  const append = (global: number): void => {
    const children = replacements.get(global);
    if (!children) {
      next.push(global);
      return;
    }
    for (const child of children) append(child);
  };
  for (const global of current) append(global);
  if (new Set(next).size !== next.length) {
    return { cut: null, reason: 'invalid-cut', newCount: 0 };
  }
  return { cut: next, reason: 'bounded', newCount };
}

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
