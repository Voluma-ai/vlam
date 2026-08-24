/**
 * Wire protocol for the `.rad` page-table frontier worker
 * (`frontier-worker.ts`).
 *
 * Split from the worker module so `StreamedSplatMesh` can be typed against it
 * without pulling worker source into the published declarations - the worker is
 * reached only through `?worker&inline` and is not a public entry point.
 */
import type { SplatData } from '../../splat-data';

/**
 * Foveation ramp for the frontier traversal, matching Spark's `SparkRenderer`
 * defaults (`coneFov0` / `coneFov` / `coneFoveate` / `behindFoveate`). Detail is
 * full inside `coneFov0`, falls to `coneFoveate` by `coneFov`, and to
 * `behindFoveate` directly behind the camera - a *weight*, never a cull, so the
 * scene stays covered when the camera turns. Lives here (a dependency-free
 * module) because both the worker and `StreamedSplatMesh` need it.
 */
export const FRONTIER_FOVEATION_DEFAULTS = {
  coneFov0: 90,
  coneFov: 120,
  coneFoveate: 0.4,
  behindFoveate: 0.2,
} as const;

/** Degrees / weights describing the foveation ramp. */
export interface FrontierFoveation {
  readonly coneFov0: number;
  readonly coneFov: number;
  readonly coneFoveate: number;
  readonly behindFoveate: number;
}

/** A decoded chunk's arrays, as forwarded from the main thread. */
export interface FrontierChunkMessage {
  readonly type: 'chunk';
  readonly file: number;
  readonly count: number;
  readonly positions: Float32Array;
  readonly colors: Uint8Array;
  readonly covariances: Float32Array;
  readonly childCount: Uint16Array;
  readonly childStart: Uint32Array;
  readonly size: Float32Array;
  readonly shBands: 0 | 1 | 2 | 3;
  readonly shPacked?: Uint32Array;
  readonly shRange?: {
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  };
}

export interface FrontierInitMessage {
  readonly type: 'init';
  readonly capacity: number;
  readonly chunkSize: number;
  readonly cpuCacheBytes: number;
}

/**
 * Changes how many slots the pager may fill, after the host grew or shrank the
 * storage behind them (a near mesh climbing its budget, a distant one giving
 * pages back). The chunk cache is untouched - only the pager is resized - so no
 * chunk is re-downloaded.
 */
export interface FrontierResizeMessage {
  readonly type: 'resize';
  readonly capacity: number;
}

/**
 * Changes the byte cap the chunk cache evicts against, after the scene's shared
 * `ChunkCacheBudget` re-split it - a near mesh climbing, a far one giving bytes
 * back.
 *
 * Only the cap moves; nothing is dropped here. Eviction stays on the one path
 * that knows what the frontier still needs (`evict` runs inside `reschedule`,
 * against `neededFiles` and the pager's resident set), and the `evicted` list
 * only reaches the main thread on a plan. Evicting off that path would drop
 * chunks out from under resident splats with no way to tell the host - the
 * dark-speckle failure the resident-set guard exists to prevent.
 */
export interface FrontierCacheBudgetMessage {
  readonly type: 'cacheBudget';
  readonly cpuCacheBytes: number;
}

export interface FrontierRescheduleMessage {
  readonly type: 'reschedule';
  readonly seq: number;
  readonly cameraLocal: [number, number, number];
  /** Unit camera forward in mesh-local space. Detail falls off away from it -
   * the traversal foveates rather than frustum-culls, so the scene stays covered
   * when the camera turns or zooms out. */
  readonly cameraForward: [number, number, number];
  /** Foveation ramp, in degrees / weights (Spark's `coneFov0`/`coneFov`/…). */
  readonly coneFov0: number;
  readonly coneFov: number;
  readonly coneFoveate: number;
  readonly behindFoveate: number;
  /** Cut on foveated `size / distance` - `2·tan(fovY/2) / renderHeight`, scaled
   * by `foveationTargetPx`. Fixed per frame; the budget is what bounds the cut. */
  readonly limit: number;
  /** Maximum drawn splats; enforced inside the traversal, never after. */
  readonly budget: number;
}

export type FrontierRequest =
  | FrontierInitMessage
  | FrontierChunkMessage
  | FrontierResizeMessage
  | FrontierCacheBudgetMessage
  | FrontierRescheduleMessage;

/** Packed splats to write, in slot order (a subset of {@link SplatData}). */
export interface PlanSplats {
  readonly count: number;
  readonly positions: Float32Array;
  readonly colors: Uint8Array;
  readonly covariances: Float32Array;
  readonly shPacked?: SplatData['shPacked'];
}

export interface FrontierPlanMessage {
  readonly type: 'plan';
  readonly seq: number;
  /** Survivors relocated by swap-remove: write `moves` splat j at `moveSlots[j]`. */
  readonly moveSlots: Uint32Array;
  readonly moves: PlanSplats;
  /** Newcomers written contiguously at `[appendStart, appendStart + appends.count)`. */
  readonly appendStart: number;
  readonly appends: PlanSplats;
  /** Freed tail slots to degenerate. */
  readonly degenerateStart: number;
  readonly degenerateCount: number;
  /** Chunks the frontier wants next, biggest-on-screen first. */
  readonly touched: Uint32Array;
  /** Drawn (non-degenerate) frontier size - the true on-screen splat count. */
  readonly residentCount: number;
  /**
   * Splats this plan could not gather because their chunk had been evicted, and
   * so wrote as zeros into slots that are still drawn - coverage holes, seen as
   * dark speckle in a region while it refines. Eviction protects every chunk
   * with resident splats, so this is 0; a non-zero value is a bug.
   */
  readonly gatherMissing: number;
  /** Newcomers the slab had no room for. The traversal is budget-bounded, so
   * this is 0 unless the slab is smaller than the draw budget - a real bug. */
  readonly dropped: number;
  /** Chunks evicted from the worker cache this round. The main thread must
   * forget them (`pageTableCachedFiles`) or they could never be refetched. */
  readonly evicted: Uint32Array;
  /**
   * The cut this plan was built at - at or below the requested `limit`, because
   * the worker refines past the quality target to spend the draw budget.
   *
   * The host needs it because its screen-radius band was chosen for the *target*
   * cut: a finer cut selects smaller splats, and a band left at the coarse
   * setting would cull exactly the detail the refinement just bought.
   */
  readonly solvedLimit: number;
  /**
   * The pager capacity this plan was built against.
   *
   * The host grows and shrinks the storage behind the slots, so a plan can
   * arrive describing slots that no longer exist: a `reschedule` posted before a
   * `resize` is answered from the old capacity, and applying that answer writes
   * some splats nowhere while leaving their slots holding whatever was there
   * before - a coarse node's data in a slot the frontier now wants fine, which
   * draws as a single enormous splat. The host compares this and drops such a
   * plan instead.
   */
  readonly capacity: number;
  /**
   * False when the plan was held short of the traversal's frontier to bound how
   * much the host must write in one tick, so the resident set is an intermediate
   * one - some newcomers deferred, some replaced nodes still drawn. The host must
   * reschedule promptly, otherwise convergence stalls wherever the cap left it.
   */
  readonly converged: boolean;
  /**
   * Decoded bytes the worker's chunk cache is holding, and the cap it evicts
   * against.
   *
   * Reported because the cache lives entirely in the worker, so a host watching
   * a scene that will not stop streaming cannot otherwise tell "the working set
   * does not fit" from "still converging" - and the main thread's own mirror of
   * which files are cached is not enough to reconstruct the byte total.
   */
  readonly cacheBytes: number;
  readonly cacheLimitBytes: number;
}
