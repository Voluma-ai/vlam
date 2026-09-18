/**
 * Wire protocol for the `.rad` page-table frontier worker
 * (`frontier-worker.ts`).
 *
 * Split from the worker module so `StreamedSplatMesh` can be typed against it
 * without pulling worker source into the published declarations - the worker is
 * reached only through `?worker&inline` and is not a public entry point.
 */
import type { SplatData } from '../../core/splat-data';

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
  /** Stable-slot pager is the indexed path; chunk-pages keeps whole RAD chunks resident. */
  readonly pagerMode?: 'classic' | 'indexed' | 'chunk-pages';
  readonly capacity: number;
  readonly chunkSize: number;
  readonly cpuCacheBytes: number;
  /** Most pool writes one plan may deliver, including freed-tail clears. */
  readonly maxPlanWrites: number;
  /**
   * Minimum complete frontier size to publish before requested children arrive.
   * `0` (default) publishes the first complete cover immediately. A very large
   * value restores the target-detail hold.
   */
  readonly initialPublishMinSplats?: number;
  /** Enables detailed traversal samples for an explicit diagnostic run. */
  readonly diagnostics?: boolean;
}

/** Requests one coherent worker-owned state snapshot. */
export interface FrontierSnapshotMessage {
  readonly type: 'snapshot';
  readonly requestId: number;
}

/** Worker state captured without starting another traversal. */
export interface FrontierSnapshotReply {
  readonly type: 'snapshot';
  readonly requestId: number;
  readonly revision: number;
  readonly traversalId: number;
  readonly cacheRevision: number;
  readonly threshold: number;
  readonly budget: number;
  readonly selectionCount: number;
  readonly cachedFiles: Uint32Array;
  readonly cameraLocal: readonly [number, number, number] | null;
  readonly cameraForward: readonly [number, number, number] | null;
  readonly displayedGeneration: number;
  readonly candidateGeneration: number | null;
  readonly awaitingPublication: boolean;
  readonly dependencyFiles: Uint32Array;
  readonly discoveryQueued: number;
  readonly discoveryWaiting: number;
  readonly skipSamples: readonly FrontierSkipSample[];
}

/** Releases the previous display only after the matching backend publication. */
export interface FrontierPublishAckMessage {
  readonly type: 'published';
  readonly generation: number;
  /** Active-list version that crossed the renderer's publication boundary. */
  readonly activeListVersion: number;
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

/** Confirms that no indexed display or pending selection references the tail. */
export interface FrontierResizeSafeMessage {
  readonly type: 'resizeSafe';
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

/** Current whole-chunk GPU residency, mirrored into the traversal worker. */
export interface FrontierChunkPagesMessage {
  readonly type: 'chunkPages';
  readonly files: Uint32Array;
}

export interface FrontierRescheduleMessage {
  readonly type: 'reschedule';
  readonly seq: number;
  /** Finish the worker's publish-safe queued cut before solving this newer camera. */
  readonly continuePendingPlan?: boolean;
  readonly cameraLocal: [number, number, number];
  /** Unit camera forward in mesh-local space. Detail falls off away from it -
   * the traversal foveates rather than frustum-culls, so the scene stays covered
   * when the camera turns or zooms out. */
  readonly cameraForward: [number, number, number];
  /** Local-position to clip matrix, column-major. */
  readonly projection?: readonly number[];
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
  /** Host-owned camera/configuration revision. Echoed by every demand reply. */
  readonly revision?: number;
  /** First-publish threshold for the current accepted draw allowance. */
  readonly initialPublishMinSplats?: number;
  /** Enables detailed traversal samples for an explicit diagnostic run. */
  readonly diagnostics?: boolean;
}

/** Request-only camera snapshot. Its generation is independent of pager plans. */
export interface FrontierDemandMessage extends Omit<
  FrontierRescheduleMessage,
  'type' | 'seq' | 'continuePendingPlan'
> {
  readonly type: 'demand';
  readonly generation: number;
  /** Local-position to clip matrix, column-major. */
  readonly projection: readonly number[];
}

export interface FrontierDemandWant {
  readonly file: number;
  /** 0 visible, 1 edge/uncertain, 2 off-screen (still eligible). */
  readonly tier: 0 | 1 | 2;
  readonly priority: number;
}

export type FrontierDemandReason = 'traversed' | 'draining' | 'discovery' | 'traversal-slice';

export interface FrontierDemandReply {
  readonly type: 'demand';
  readonly generation: number;
  readonly wants: readonly FrontierDemandWant[];
  /** Partial wants can fill free slots, but never prove an omitted request obsolete. */
  readonly complete: boolean;
  /** Camera/configuration revision. Movement replaces queued demand promptly. */
  readonly revision: number;
  /** Traversal that produced this demand; `0` for incremental chunk discovery. */
  readonly traversalId: number;
  /** Reschedule sequence that owns this demand. */
  readonly seq?: number;
  /** Why this demand was posted. Discovery/drain never imply a fresh quality cut. */
  readonly reason?: FrontierDemandReason;
  readonly traversalStartedAt?: number;
  readonly firstSliceAt?: number;
}

/** Diagnostic lifecycle event emitted when a cooperative walk is superseded. */
export interface FrontierTraversalCancelledReply {
  readonly type: 'traversalCancelled';
  readonly seq: number;
  readonly revision: number;
  readonly cancelledAt: number;
}

/**
 * Why a pager plan was posted. `traversalId` alone cannot tell a held or drained
 * reply from a walk that inspected nearby nodes and left them coarse.
 */
export type FrontierPlanReason =
  | 'traversed'
  | 'draining'
  | 'awaiting-publication'
  | 'capacity-blocked'
  | 'unchanged-selection'
  | 'intermediate'
  | 'waiting-for-children'
  | 'non-refinement'
  | 'already-at-target';

/** Opt-in worker-side validation of a candidate hierarchy cut. */
export interface FrontierCutDiagnostic {
  readonly valid: boolean;
  readonly ancestorOverlap: boolean;
  readonly duplicate: boolean;
  readonly missing: boolean;
}

export type FrontierSkipReason =
  'leaf' | 'below-threshold' | 'missing-children' | 'budget' | 'would-subdivide' | 'no-tree';

/** Nearby selected node that was not subdivided, with the exact stop reason. */
export interface FrontierSkipSample {
  readonly global: number;
  readonly center: readonly [number, number, number];
  readonly size: number;
  readonly childCount: number;
  readonly childStart: number;
  readonly pixelScale: number;
  readonly reason: FrontierSkipReason;
  readonly missingFiles: readonly number[];
}

export type FrontierRequest =
  | FrontierInitMessage
  | FrontierSnapshotMessage
  | FrontierPublishAckMessage
  | FrontierChunkMessage
  | FrontierResizeMessage
  | FrontierCacheBudgetMessage
  | FrontierChunkPagesMessage
  | FrontierDemandMessage
  | FrontierRescheduleMessage;

/** Packed splats to write, in slot order (a subset of {@link SplatData}). */
export interface PlanSplats {
  readonly count: number;
  /** Stable `.rad` global splat IDs, aligned with every packed attribute. */
  readonly globals: Uint32Array;
  readonly positions: Float32Array;
  readonly colors: Uint8Array;
  readonly covariances: Float32Array;
  readonly shPacked?: SplatData['shPacked'];
}

export interface FrontierPlanMessage {
  readonly type: 'plan';
  readonly seq: number;
  /** Build-time-only traversal diagnostics for benchmark comparisons. */
  readonly traversalStrategy?: 'heap' | 'bounded-threshold' | 'one-pass';
  readonly traversalFallback?: boolean;
  readonly traversalFallbackCount?: number;
  readonly rootCoverInfeasible?: boolean;
  readonly traversalMs?: number;
  readonly traversalStartedAt?: number;
  readonly firstSliceAt?: number;
  readonly traversalCompletedAt?: number;
  /** Survivors relocated by swap-remove: write `moves` splat j at `moveSlots[j]`. */
  readonly moveSlots: Uint32Array;
  readonly moves: PlanSplats;
  /** Newcomers written contiguously at `[appendStart, appendStart + appends.count)`. */
  readonly appendStart: number;
  readonly appends: PlanSplats;
  /** Indexed-pager destination slots, aligned with `appends`; absent for classic plans. */
  readonly writeSlots?: Uint32Array;
  /** Candidate whose selected slots become drawable together after sorting. */
  readonly candidateGeneration?: number;
  /** Camera/configuration revision that selected the candidate. */
  readonly candidateRevision?: number;
  /** Camera/configuration key that selected the candidate. */
  readonly candidateCameraKey?: string;
  /** Candidate generation discarded before it could be acknowledged. */
  readonly cancelledCandidateGeneration?: number;
  /** Complete selected slot list. Present only when this candidate is ready to publish. */
  readonly candidateSlots?: Uint32Array;
  /** Complete selected RAD global-id list for whole-chunk residency. */
  readonly selectionGlobals?: Uint32Array;
  /** Bounded worker-side candidate node sample for an explicit diagnostic run. */
  readonly diagnosticCandidateGlobals?: Uint32Array;
  readonly diagnosticCut?: FrontierCutDiagnostic;
  /** Bounded source chunks absent while gathering this plan's writes. */
  readonly diagnosticGatherMissingFiles?: Uint32Array;
  /** Bounded-candidate ownership diagnostics for development traces. */
  readonly candidateSize?: number;
  readonly candidateNewSlots?: number;
  readonly candidateReusedSlots?: number;
  readonly candidateComplete?: boolean;
  readonly candidateFinal?: boolean;
  /** Projected-quality diagnostics for the candidate generation. */
  readonly revealReady?: boolean;
  readonly maxCentralProjectedRatio?: number;
  readonly maxVisibleProjectedRatio?: number;
  readonly candidateCancellationCount?: number;
  readonly boundedCutRefusalReason?:
    'waiting-for-children' | 'non-refinement' | 'already-at-target' | 'invalid-cut';
  readonly protectedCacheBytes?: number;
  readonly activePageTableFetches?: number;
  /**
   * Unique id of the last actual walk. Drain, publication-hold, and capacity
   * replies keep that id; they do not reset it to `0`. Combine with
   * {@link planReason} to tell a fresh cut from a held one.
   */
  readonly traversalId?: number;
  /** Distinguishes a walk from drain / publication-hold / capacity / unchanged. */
  readonly planReason?: FrontierPlanReason;
  /** Highest-importance selected nodes that were not subdivided. */
  readonly skipSamples?: readonly FrontierSkipSample[];
  /** Freed tail slots to degenerate. */
  readonly degenerateStart: number;
  readonly degenerateCount: number;
  /** Chunks the frontier wants next, biggest-on-screen first. */
  readonly touched: Uint32Array;
  /** Drawn (non-degenerate) frontier size - the true on-screen splat count. */
  readonly residentCount: number;
  /**
   * Drawn prefix. While a replacement is staged this stays at the last
   * published cut; the host must not draw `[displayCount, residentCount)`.
   */
  readonly displayCount?: number;
  /** Changes whenever the contents of the drawn prefix change, even at equal count. */
  readonly displayGeneration?: number;
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
   * The cut this plan was built at - the configured pixel target, unless a
   * benchmark override still runs extra budget-filling walks.
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
  /** The next best resident subdivision would exceed the draw budget. */
  readonly budgetClamped?: boolean;
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
  readonly pendingFrontierSplats?: number;
  readonly staleResidentSplats?: number;
  readonly lastPlanAppends?: number;
  readonly lastPlanMoves?: number;
  readonly cameraLocal?: readonly [number, number, number];
  readonly planBudget?: number;
  readonly planGeneration?: number;
}
