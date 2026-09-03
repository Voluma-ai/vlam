import {
  abortReason,
  buildHoldSwapGroups,
  buildSwapGroups,
  chunkBytes,
  isClassicLccSwapSet,
  enqueueClassicFetch,
  classicFetchPhaseForDesired,
  classicFetchPhaseForCoverage,
  compareClassicFetches,
  compareClassicSwapGroups,
  defaultCpuCacheBytes,
  groupPriority,
  isWaitingOnFinest,
  sliceSplatData,
  stampClassicFetchGroups,
  validateAppendCap,
  validateLodScale,
  type ClassicFetchWant,
  type SwapGroup,
} from './streamed-splat-mesh-utils';
export * from './streamed-splat-mesh-utils';
import * as THREE from 'three/webgpu';
import {
  DEFAULT_FOVEATION_TARGET_PX,
  MAX_SH_BANDS,
  resolveSplatPerformanceProfile,
  SplatMesh,
  isPageTableFoveation,
  resolveSplatFoveationMode,
  type SplatRange,
  type SplatChannelType,
  type SplatChannelOptions,
  type SplatMeshOptions,
  type SplatUpdateOptions,
} from '../core/splat-mesh';
import type { SplatData } from '../core/splat-data';
import { runKey, type LodRun, type LodScheduler } from './lod-scheduler';
import { buildSogScene, type StreamedScene } from './lod-source';
import type { CollisionMeshTile } from '../formats/lcc/collision-mesh';
import { createLocalDataset, httpDatasetSource, type SplatDatasetSource } from './dataset-source';
import {
  isAbortError,
  resolveSplatUrl,
  SplatLoadError,
  toRequestInit,
  toSplatLoadError,
  type SplatRequestOptions,
  type StreamedSplatFormat,
} from '../loaders/loading';
import {
  liftBudgetToFinestLevel,
  recommendedRadMaxStdDev,
  resolveSplatBudget,
  type SplatDeviceProfile,
} from '../core/splat-budget';
import { resolveXrView } from '../core/xr-view';
import { ChunkLoader } from '../loaders/chunk-loader';
import { yUpTransformForFormat } from '../core/orientation';
import {
  FRONTIER_FOVEATION_DEFAULTS,
  type FrontierFoveation,
  type FrontierPlanMessage,
  type FrontierRequest,
  type PlanSplats,
} from '../formats/rad/frontier-worker-protocol';
import { shCoefficientCount } from '../core/sh-pack';
import { warn } from '../core/logging';
import type {
  ChunkFetchHandle,
  ChunkFetchKind,
  ChunkFetchScheduler,
} from './chunk-fetch-scheduler';
import type { ChunkCacheBudget, ChunkCacheHandle } from './chunk-cache-budget';

/** Vite's `?worker&inline` default export - a Worker subclass constructor. */
type InlineWorkerCtor = new () => Worker;

const DATA_TEXTURE_WIDTH = 2048;
/** Max splats appended per frame (bounds the copy + staging-upload cost). */
/**
 * A coverage hold waits for in-view covering cells (classic nearby L1 / far
 * coarsest, or the nearby L0 home set when `'hold-near-l0'` is explicit).
 * After one minute it reveals the best staged coverage and continues refining.
 */
const INITIAL_REVEAL_TIMEOUT_MS = 60_000;
// Keep the attribution event aligned with WebGpuSortScheduler's content
// invalidation policy: only a region-sized visibility change forces a sort.
const CONTENT_FORCE_FRACTION = 0.25;
/**
 * Max chunk fetches in flight at once on the classic (non-page-table) path.
 * Matches the page-table pager so near-finest detail can fill the pipe instead
 * of waiting behind a long far-coarse pin queue.
 */
const MAX_INFLIGHT = 8;
/**
 * Backstop on how long the wave gate may hold a retirement back.
 *
 * Pool pressure, not elapsed time, is what should release a retirement: the rows
 * it frees only matter once something else needs them, and that is exactly the
 * condition `applyGroup` reports. A tick bound on top of that trades coverage
 * for nothing, and measurably so - on the 132-chunk `oldtimers-route` capture,
 * bounds of 8/24/64 ticks left 157/69/35 frames losing coverage, while releasing
 * on pool pressure alone left 3, none worse than 0.38% of the drawn set (against
 * 258 frames and 2.14% before the gate). Short bounds are worse than no gate in
 * one respect too: they retire in bulk when they fire.
 *
 * So this is set well past the point of interference and kept only so that a
 * pool roomy enough never to report pressure cannot hold superseded coverage for
 * the entire session. At 60 fps it is about ten seconds.
 *
 * Ticks, not wall clock, and deliberately so. A wall-clock bound looks more
 * principled - the same 600 ticks is thirty seconds at the 20 fps a heavy
 * `.rad` load actually runs at - but converting it to 10 s was measured on the
 * `veersetoren` capture at nine hundred early retirements against fifty-seven,
 * because a slow frame rate means chunks are arriving slowly too. The bound
 * wants to outlast the stream, and on a slow renderer the stream is long.
 */
const MAX_RETIRE_HELD_TICKS = 600;
/** Reschedule at least this often even when the camera is still, ms. */
const IDLE_RESCHEDULE_MS = 250;
/** Attempts before a chunk is given up on (a transient error retries). */
const MAX_CHUNK_ATTEMPTS = 4;
/** First retry delay; doubles each attempt (500, 1000, 2000 ms). */
const RETRY_BASE_MS = 500;
/** Fetch slots the page-table sweep keeps free for frontier-requested chunks, so
 * the detail the camera is pointed at never queues behind a file-order sweep.
 * Matches Spark's `numLodFetchers`. */
const PAGETABLE_PRIORITY_SLOTS = 3;
/** Default drawn-splat target for the page-table frontier (Spark's `maxSplats`)
 * when the caller gives no `foveationDrawBudget`. Sized to Spark's own default
 * for this class of scene - 800K is far too coarse for a 16M-leaf interior, so
 * the frontier coarsens and evicts near-camera detail to fit. Overridable via
 * `foveationDrawBudget` (`?foveationDraw=`), and always ≤ the pool budget. */
const PAGETABLE_DRAW_BUDGET = 4_000_000;

/**
 * Splats per slab page in `foveationMode: 'page-table'`.
 *
 * The frontier's slots are backed by pages of this size rather than one
 * contiguous reservation, so a mesh's storage need not be one block - the
 * property that lets meshes interleave in a shared pool, and lets a mesh
 * release storage as its budget falls. Matches Spark's `pageSplats` and the
 * `.rad` chunk size, and is a whole number of 2048-texel pool rows (32), so
 * page writes stay row-aligned.
 */
const SLAB_PAGE_SPLATS = 65_536;

/**
 * Ceiling on the page-table cache floor. A `.rad` frontier refines only into
 * chunks that are resident together, so a cache far smaller than the working set
 * thrashes and the view stays coarse - this is the headroom that prevents that,
 * for a scene big enough to need it.
 *
 * It is a *ceiling on a floor*, not a per-mesh allowance: `min(this, the
 * capture's own decoded size)` means a small mesh asks for what it can
 * actually use, and a host that set a larger share still gets it.
 */
const PAGETABLE_CACHE_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Rough decoded size of a whole streamed scene, for sizing the cache floor:
 * positions (12 B) + colors (4 B) + covariances (24 B) per splat, plus the LOD
 * tree arrays a `.rad` chunk carries (`childCount` 4 B + `childStart` 4 B +
 * `size` 4 B) and packed SH when the scene carries it. Deliberately an
 * over-estimate - the floor should never be the reason a capture cannot hold
 * itself, and it must match what the frontier worker charges its cache, or a
 * capture the cap was sized to hold starts evicting itself mid-load.
 *
 * Exported for unit testing only; not part of the public API.
 */
export function estimateSceneDecodedBytes(scene: StreamedScene): number {
  const perSplat =
    12 + 4 + 24 + 12 + (scene.shBands ? 16 * Math.ceil(shCoefficientCount(scene.shBands) / 4) : 0);
  // Size from what the cache actually holds: whole decoded *chunks*, every splat
  // in them. `contentSplatCount` is the wrong number for a LOD tree - for `.rad`
  // it is the **leaf** count, while a chunk carries internal (merged) nodes too,
  // and those are most of what a coarse frontier draws. On the 5.9M-leaf
  // reference capture the tree holds 8.59M nodes, so counting leaves alone
  // under-estimated by 32% and produced a floor *below* the frontier's working
  // set - the exact opposite of this function's purpose. The symptom was a
  // permanent 1-chunk oscillation: resident chunks alternating 75/76 with a
  // fetch every couple of seconds, the cache reporting full, and the frontier
  // refetching what it had just been forced to evict.
  //
  // Raising the ceiling does not by itself cost memory: it is a cap on a cache
  // that only ever holds what has been fetched, and with the background sweep
  // declined on mobile that is the working set and nothing more.
  //
  // Still approximate on the low side: a `.rad` chunk also carries the LOD tree
  // columns (`child_count` u16 + `child_start` u32, ~6 B/splat) which this does
  // not count. That was the last ~5% of the overshoot above - 76 chunks measured
  // ~229 MB against the old 224 MB floor - and the chunk-count fix now clears it
  // by a wide enough margin that adding the columns is not worth the extra
  // memory it would reserve on every device. Revisit if a capture thrashes with
  // resident chunks close to this estimate.
  const chunkSplats =
    scene.chunkSize === undefined ? undefined : scene.chunkSize * scene.chunkUrls.length;
  const splats = chunkSplats ?? scene.contentSplatCount ?? scene.maxResidentSplats;
  return Math.max(1, splats) * perSplat;
}

/**
 * Read-only startup-hold progress for {@link StreamedSplatMeshOptions.initialReveal}.
 * Exported for hosts that gate visibility on the first useful coverage frame
 * (classic `.lcc` nearby L1 / far coarsest, `.lcc2` in-view coarsest, or an
 * explicit nearby-L0 hold).
 */
export type InitialRevealState =
  | { readonly status: 'disabled' }
  | {
      readonly status: 'pending';
      readonly stagedSplats: number;
      readonly totalSplats: number;
      readonly readyGroups: number;
      readonly totalGroups: number;
    }
  | { readonly status: 'ready' }
  | {
      readonly status: 'degraded';
      readonly reason: 'capacity' | 'fetch-failed' | 'timeout';
      readonly stagedSplats: number;
      readonly totalSplats: number;
      readonly readyGroups: number;
      readonly totalGroups: number;
    };

/** Options for {@link StreamedSplatMesh.load}. */
export interface StreamedSplatMeshOptions extends SplatMeshOptions {
  /** Active-splat budget. Defaults to {@link resolveSplatBudget}. */
  budget?: number;
  /**
   * A ceiling on the *resolved default* budget, for callers that want to
   * tighten without overriding what the library knows.
   *
   * `budget` is absolute: it wins over the device tier, the format's cost class
   * and everything else, because a caller who names a number has said they know
   * better. That is the right contract, and the wrong tool for "the same as
   * usual, but no more than N" - which is what a performance toggle or a host
   * default actually means. Pinning a number there has twice shipped as a bug:
   * a demo performance mode that *raised* the load on the weakest device tested,
   * and a host whose default bypassed every device tier.
   *
   * Applied only when `budget` is omitted, and only downward - it never raises
   * a budget the device would not otherwise have taken. It also suppresses the
   * finest-level lift, which exists to raise a budget far enough to hold a
   * scene whole and is exactly what "no more than N" rules out. Unrelated to
   * {@link maxBudget}, which sizes the pool and bounds
   * {@link StreamedSplatMesh.setBudget}.
   *
   * Forwarded to `resolveSplatBudget` as `SplatBudgetOptions.cap`.
   *
   * @throws {RangeError} at load if not a positive finite number.
   */
  budgetCap?: number;
  /**
   * Device signals for budget / quality defaults. Defaults to
   * {@link detectSplatDeviceProfile}. Pass a profile enriched with
   * {@link probeSplatGpuClass} so desktop integrated GPUs take the laptop
   * tier instead of the workstation 8M path.
   */
  deviceProfile?: SplatDeviceProfile;
  /**
   * Ceiling {@link StreamedSplatMesh.setBudget} may raise this mesh to, and the
   * size its pool is allocated from. Defaults to `budget`.
   *
   * Set this above `budget` when a `CameraBudgetGovernor` or `BudgetGovernor`
   * should be able to *grow* this mesh's share: the pool is allocated once at
   * construction and never grows, so without headroom reserved here a governed
   * mesh can only ever be shrunk below the budget it was built with. That is
   * the whole reason a hand-split `pool / N` mesh stays coarse near the
   * camera - every mesh's ceiling was fixed at a quarter of the pool.
   *
   * It is not free: the pool costs its *ceiling* in memory whether or not the
   * budget ever reaches it (~64 B of GPU pool plus ~56 B of CPU backing per
   * splat, 1.5× for capacity slack). Price it with `estimateSplatPoolBytes`
   * before choosing - for several additional meshes the
   * sum of the ceilings is what has to fit, not the shared budget. A ceiling
   * around 1.5–2× a member's fair share is usually the right trade.
   *
   * @throws {RangeError} at load if below `budget`, or not a positive finite
   * number.
   */
  maxBudget?: number;
  /**
   * Lets a host that pins {@link budget} and/or {@link maxBudget} still take the
   * finest-level lift for `.rad` strategy selection and pool sizing. Without it,
   * pinning either option disables the lift and a capture whose leaf count sits
   * between the host ceiling and {@link FOVEATION_LEAF_THRESHOLD} incorrectly
   * lands on the foveated page-table path instead of the prefix reader.
   *
   * {@link budgetCap} still vetoes the lift when set. Mobile and fill-constrained
   * desktops remain exempt inside {@link liftBudgetToFinestLevel}.
   */
  allowFinestLevelLift?: boolean;
  /**
   * Multiplier on this mesh's LOD detail, matching Spark's per-mesh `lodScale`:
   * `> 1` refines further (finer cut, more splats drawn), `< 1` coarsens.
   * Default `1`.
   *
   * **`.rad` `foveationMode: 'page-table'` only** - it scales the frontier cut
   * the page-table traversal is given (`pixel_scale × lodScale ≤ limit`, exactly
   * Spark's formula). It does nothing on a mesh with no per-splat cut to scale:
   * a moderate `.rad` read as a chunk prefix, or a Streamed SOG / LCC scene. For
   * the GPU cut modes (`'band'` / `'frontier'`) the equivalent is
   * {@link SplatMeshOptions.foveationTargetPx} at `1 / lodScale`.
   *
   * The draw budget still bounds the result, so raising this past the point
   * where the budget binds sharpens nothing - give the mesh budget as well.
   */
  lodScale?: number;
  /** Explicit format; by default the manifest's extension decides. */
  format?: StreamedSplatFormat;
  /** Serializable fetch settings for the manifest and its chunks. */
  request?: SplatRequestOptions;
  /**
   * Cancels the load: the manifest fetch aborts, and {@link StreamedSplatMesh.load}
   * rejects with a `DOMException` named `AbortError`. A mesh partially built
   * when the signal fires is disposed - nothing leaks. Only read during load;
   * later streaming is stopped by {@link SplatMesh.dispose}.
   */
  signal?: AbortSignal;
  /** Base URL a relative manifest URL resolves against (like {@link loadSplatData}). */
  baseUrl?: string | URL;
  /** World-unit distance inside which the finest LOD is used. Default 10. */
  lodBaseDistance?: number;
  /** Distance ratio between successive LOD levels. Default 2. */
  lodMultiplier?: number;
  /** Cap on decoded chunk arrays cached on the CPU. Default by device memory. */
  cpuCacheBytes?: number;
  /**
   * Foveation ramp for the `.rad` page-table frontier: detail is full inside
   * `coneFov0` degrees of the view direction, falls off to `coneFoveate` by
   * `coneFov`, and to `behindFoveate` directly behind the camera. Off-cone
   * content is kept **coarse**, never dropped, so turning or zooming out never
   * exposes an unpainted region. Defaults match Spark
   * ({@link FRONTIER_FOVEATION_DEFAULTS}).
   */
  frontierFoveation?: Partial<FrontierFoveation>;
  /**
   * Keeps a complete multi-run replacement hidden while its uploads are
   * spread over frames, then switches the region atomically. Enabled by
   * default; set `false` only for legacy A/B comparison.
   */
  experimentalStagedSwaps?: boolean;
  /**
   * Maximum splats copied into the pool per LOD mutation tick. Defaults to
   * 32,000; lower debug values trade refinement latency for shorter frames.
   */
  maxSplatsPerSwap?: number;
  /**
   * First-frame reveal policy for streamed formats that can hide empty cells.
   *
   * - `'progressive'`: cells become visible as each swap group commits — can
   *   show sparse near-detail (classic `.lcc`) or empty octree squares
   *   (`.lcc2`) while siblings load.
   * - `'hold-near-l0'` (opt-in): hide the mesh until the camera's home coverage
   *   group is resident (L0 when it fits; otherwise coarsen via the leaf ladder
   *   L1→L2). Neighbours are not part of the hold - they compete via
   *   screenImportance and would steal the first fetch slots. Home selection
   *   uses distance within `lodBaseDistance` and does not require frustum
   *   intersection (HiRes tiles often fail `inView` when the camera stands
   *   inside looking out). Coarser rungs come from `LodSource.runsAtLevelFor`.
   *   Only home files are fetched during the hold. A one-minute watchdog also
   *   degrades if the cut cannot finish. Classic `.lcc` uses the **resolved**
   *   cut from the first schedule (after camera + format transform), not
   *   distance ambition alone.
   * - `'hold-coverage'` (the default for classic `.lcc` and `.lcc2` when
   *   unset): hide the mesh until every in-view finest cell has covering
   *   coverage resident, and until the always-resident environment tile is in
   *   the pool when the scene ships one and it starts enabled. Classic `.lcc`
   *   freezes nearby cells (within `lodBaseDistance · lodMultiplier`) at
   *   finest+1 (L1, never L0) and farther in-view cells at coarsest. A cell
   *   counts as in-view when the camera stands inside it, or when the unpadded
   *   AABB hits the frustum and pokes in front of the camera plane (support
   *   vertex — centres behind the look still count), **or** the cell is within
   *   `lodBaseDistance` and pokes forward (30 m neighbours that fill the
   *   frame while the look is off-axis). `.lcc2` still waits on
   *   coarsest root-children. Does not wait for finest tiles or the rest of
   *   the stream. An empty frustum falls back to the nearest cell. Requires
   *   `LodSource.coverageRunsFor`; other formats treat this as disabled.
   *
   * A one-minute watchdog degrades to progressive if the frozen set cannot
   * finish. Does not make detail downloads instantaneous. Other streamed
   * formats default to `'progressive'`.
   */
  initialReveal?: 'progressive' | 'hold-near-l0' | 'hold-coverage';
  /** Receives lightweight LOD mutation events for performance attribution. */
  onPerformanceEvent?: (event: StreamedSplatPerformanceEvent) => void;
  /**
   * View-dependent color (higher-order SH). This is the streaming counterpart
   * of {@link SplatMeshOptions.shBands}: besides sizing the pool it decides
   * whether SH is fetched/decoded at all. Two sources feed it - a `Quality` LCC
   * `Quality` LCC (`.lcc`) capture, which stores SH per splat, and a Streamed SOG scene,
   * whose per-file palette shN is converted to that same packed form at decode
   * (M11; see `docs/formats/streamed-shn-notes.md`).
   *
   * **For LCC, unset (the default) means every band the capture carries** - so
   * a Quality scene shows its real view-dependent color without the caller
   * having to know the format. The exception is a `smooth` performance profile
   * (the default on mobile), which defaults this to 0: SH roughly triples
   * per-chunk bandwidth (`shcoef.bin` is 64 B/splat against `data.bin`'s 32) and
   * adds up to 64 B/splat of pool textures (~384 MB over a 6M-splat pool at 3
   * bands) - precisely the costs that profile avoids.
   *
   * **For Streamed SOG it is strictly opt-in** (unset = off): the manifest does
   * not declare whether the tiles carry shN, so enabling the conversion - and
   * the pool textures it needs - must be a deliberate choice, not a default.
   *
   * Set it explicitly to override either way: 0 forces SH off, and 1, 2 or 3
   * keep 3, 8 or 15 coefficients per channel. For LCC the value is clamped to
   * what the scene actually has (a `Portable` capture fetches and allocates
   * nothing regardless); for SOG a scene with fewer bands zero-pads and one with
   * no shN simply renders DC color, wasting the allocated textures.
   *
   * Only read at load: the pool's SH textures are allocated once, so a later
   * {@link SplatMesh.setPerformanceProfile} does not change this.
   */
  shBands?: 0 | 1 | 2 | 3;
  /**
   * Whether the scene's always-resident environment/background tile (the
   * `.lcc2` sky) starts visible. Default `true`. Toggle it live afterwards with
   * {@link StreamedSplatMesh.setEnvironmentEnabled}. No effect on a scene that
   * ships no environment tile.
   */
  environmentEnabled?: boolean;
  /**
   * This mesh's share of the scene's fetch bandwidth, as a camera-projected
   * weight - normally `() => governor.weightOf(mesh) ?? 0`, so fetching is
   * ordered by the same measure that already orders drawing.
   *
   * Read on demand, so it always reflects the current camera. Zero means hidden
   * or suspended, and has one effect on its own: the background sweep that
   * pre-warms the whole capture into the page-table cache stops. That sweep is
   * pure speculation about a camera move that has not happened, and on a
   * multi-mesh scene it is most of the traffic competing with the mesh the
   * viewer is actually looking at.
   *
   * Unset (the default) leaves fetching exactly as it was: every mesh sweeps.
   * Supply a {@link fetchScheduler} as well to also bound the total.
   */
  fetchWeight?: () => number;
  /**
   * Scene-wide fetch arbitration, shared by every streamed mesh the way a
   * {@link SplatMeshOptions.pool} is - see {@link ChunkFetchScheduler}. Without
   * one, each mesh fetches toward its own in-flight cap and a near mesh's
   * detail queues behind a dozen far meshes' background traffic.
   *
   * The scheduler is *not* owned by the mesh: dispose unregisters this mesh and
   * leaves the scheduler running for its siblings. Weights come from
   * {@link fetchWeight}; without that every mesh weighs the same and the
   * scheduler only bounds the total.
   */
  fetchScheduler?: ChunkFetchScheduler;
  /**
   * Scene-wide decoded-chunk cache ceiling, shared exactly as
   * {@link fetchScheduler} and {@link SplatMeshOptions.pool} are - see
   * {@link ChunkCacheBudget}.
   *
   * Without one, each `.rad` page-table mesh caps its own cache at
   * `max(cpuCacheBytes, min(2 GiB, this capture's decoded size))`: the right
   * number for a lone streamed scene, and no bound at all across a scene of
   * additional meshes, because every mesh gets its own and each is sized to its own
   * capture. With one, that figure becomes this mesh's *ceiling* and the budget
   * splits a scene total across every registered mesh by camera weight.
   *
   * This bounds retention, not prefetching: the background sweep still runs and
   * still warms the cache, it just stops at the scene's allowance instead of at
   * the size of the capture.
   *
   * The budget is *not* owned by the mesh: dispose unregisters this mesh and
   * leaves it running for its siblings. Weights come from {@link fetchWeight}.
   */
  cacheBudget?: ChunkCacheBudget;
}

/** One streamed-LOD mutation tick, measured on the main thread. */
export interface StreamedSplatPerformanceEvent {
  /** Timestamp after the tick, on the same clock as requestAnimationFrame. */
  timestamp: number;
  /** Main-thread time spent rescheduling and applying this tick. */
  cpuMs: number;
  /** Same-frame packed active-index rebuild time, after the LOD mutation. */
  activeListMs: number;
  /** Same-frame partial texture upload submission time. */
  uploadMs: number;
  /** CPU submission time for the depth-sort passes. */
  sortSubmitMs: number;
  /** Exact-height staging textures allocated during this update. */
  stagingTextureAllocations: number;
  /** WebGPU source-index ranges queued for upload before this tick's sort. */
  activeListUpdateRanges: number;
  appendedCount: number;
  removedCount: number;
  stagedCount: number;
  uploadCount: number;
  activeCount: number;
  forcedSort: boolean;
  compacted: boolean;
}

interface CachedChunk {
  data: SplatData;
  bytes: number;
  lastUsed: number;
}

/** Options for {@link StreamedSplatMesh.definePersistentChannel}. */
export interface PersistentChannelOptions extends SplatChannelOptions {
  /**
   * Cap on the number of `(chunk, splat)` edits stored for this channel.
   * Editing past the cap is dropped with a one-time warning. Default 1,000,000.
   */
  maxEdits?: number;
}

/** A per-channel sparse edit store, keyed by `(chunk file, local index)`. */
interface PersistentChannel {
  readonly type: SplatChannelType;
  /** The channel's default value - unedited splats must reload at this, not 0. */
  readonly fill: number;
  readonly maxEdits: number;
  /** file → (local splat index within that chunk → value). */
  readonly edits: Map<number, Map<number, number>>;
  total: number;
  warned: boolean;
}

/**
 * Streams a large splat scene - a Streamed SOG dataset (`lod-meta.json`), or
 * an XGRIDS `.lcc2` or `.lcc` (manifest v3–v5) dataset - into the pool of a
 * dynamic-capacity {@link SplatMesh}, keeping the resident splat count within
 * a per-device budget.
 *
 * Each frame it asks the scene's {@link LodSource} which spatial regions
 * should be resident for the current camera, fetches and decodes the chunk
 * files that back them (off the main thread, via {@link ChunkLoader}), and
 * appends/removes pool ranges to match - loading coarse first so the scene
 * appears quickly and refining near the camera. A coarse full-scene shell
 * always fits the budget, so the view is never blank and the budget is
 * never exceeded.
 *
 * WebGPU only (inherited from the dynamic-capacity pool). View-dependent color
 * (higher-order SH) works for every streamed format: LCC `Quality` captures store it per
 * splat, and a SOG scene's per-file palette shN is converted to that same
 * per-splat packed form at decode so it too survives the shared pool (M11, opt
 * in via {@link StreamedSplatMeshOptions.shBands}; see
 * `docs/formats/streamed-shn-notes.md`).
 */
export class StreamedSplatMesh extends SplatMesh {
  private readonly scene: StreamedScene;
  private readonly loader = new ChunkLoader();
  /**
   * Cap the *classic* (non-page-table) chunk cache evicts against.
   *
   * Mutable because a shared {@link ChunkCacheBudget} re-splits it as the camera
   * moves; without a budget it stays at the value `options.cpuCacheBytes` or the
   * device default set at construction.
   */
  private cpuCacheBytes: number;
  private budgetValue: number;
  private readonly maximumBudget: number;
  /** Spark's per-mesh `lodScale`; divides the page-table cut limit. */
  private lodScaleValue: number;
  /** Set once the governed budget has been reported as exceeding an explicit
   * `foveationDrawBudget`, so the warning is issued at most once. */
  private warnedDrawTargetCap = false;
  private readonly stagedSwapsEnabled: boolean;
  /** Classic LCC must keep old cell coverage while a replacement is pending. */
  private readonly neverRetireCoverageEarly: boolean;
  private readonly appendCap: number;
  private readonly onPerformanceEvent: ((event: StreamedSplatPerformanceEvent) => void) | undefined;
  private compactionCount = 0;

  private readonly cache = new Map<number, CachedChunk>();
  /** Running byte total of {@link cache}; maintained by {@link cacheChunk}, eviction and dispose. */
  private cacheBytesTotal = 0;
  /** In-flight chunk fetches. The kind is kept so a weight change can shed the
   * speculative ones without touching the detail that is actually on screen. */
  private readonly fetching = new Map<
    number,
    { controller: AbortController; kind: ChunkFetchKind; classicWant?: ClassicFetchWant }
  >();
  /** This mesh's camera-projected share of the scene's fetch bandwidth. */
  private fetchWeight: (() => number) | undefined;
  /** Scene-wide fetch arbitration, when the host shares one; see `requestChunk`. */
  private readonly fetchScheduler: ChunkFetchScheduler | undefined;
  private readonly fetchHandle: ChunkFetchHandle | undefined;
  /**
   * Blob-URL dataset from {@link loadLocal}, owned by this mesh so its object
   * URLs are revoked on {@link dispose} rather than leaking for the document's
   * lifetime. Undefined for every network-loaded mesh.
   */
  private localSource: SplatDatasetSource | undefined;
  /** Scene-wide chunk-cache ceiling, when the host shares one. */
  private readonly cacheBudget: ChunkCacheBudget | undefined;
  private cacheBudgetHandle: ChunkCacheHandle | undefined;
  /**
   * The cap this mesh's frontier worker is currently evicting against.
   *
   * Mirrored on the main thread so `applyCacheAllowance` can skip no-op posts
   * and so `fetchCounts.cacheLimitBytes` stays truthful between plans.
   */
  private cacheLimitBytes = 0;
  private readonly resident = new Map<string, { run: LodRun; handle: SplatRange }>();
  /** Replacement runs hidden while their pool data is uploaded in bounded segments. */
  private readonly staged = new Map<
    string,
    {
      run: LodRun;
      handle: SplatRange;
      uploadedCount: number;
    }
  >();
  /** Files awaiting a backoff retry after a transient fetch/decode error. */
  private readonly retrying = new Map<number, { attempts: number; readyAt: number }>();
  /** Files given up on after {@link MAX_CHUNK_ATTEMPTS} failures. */
  private readonly failedFiles = new Set<number>();

  /**
   * When true, each resident run writes its LOD `level` into the `lodLevel`
   * float channel for false-color debug modifiers.
   */
  private lodLevelDebug = false;
  private lodLevelChannelReady = false;
  private lodLevelScratch: Float32Array | undefined;

  /** Desired-but-not-resident files this tick; protected from cache eviction. */
  private readonly neededFiles = new Set<number>();

  /** Non-null in `foveationMode: 'page-table'`: the worker that owns the chunk
   * cache + traversal + pager off the main thread, and the always-active slab it
   * pages the returned frontier into. */
  private readonly frontierWorker: Worker | null;
  /**
   * The frontier's slots, as a list of equally sized pages rather than one
   * contiguous run.
   *
   * Slot `i` lives in page `i / slabPageSplats` at offset `i %
   * slabPageSplats`. The pager only ever addresses slots, so where those
   * pages sit in the pool is the mesh's business - which is what lets a mesh
   * hold non-contiguous storage, and ultimately lets several meshes interleave
   * in one pool instead of each reserving its whole ceiling as one block.
   * (Spark's pager does the same thing one level down, binding fixed pages to
   * `(source, chunk)` pairs.)
   */
  private readonly slabPages: SplatRange[] = [];
  /** Most slots the slab may ever hold - the construction capacity. */
  private slabCeiling = 0;
  /** Slot count the worker's pager was last told about. */
  private pagerSlots = 0;
  /** Consecutive ticks the wave gate has held retirements back. */
  private retireHeldTicks = 0;
  /**
   * Latest drawable cut for {@link applyRadWave}. Prefix-reader discovery
   * deepens every tick; the published picture waits until the pipe is idle so
   * intermediate depths (including chunk 0's overview) never become the frame.
   */
  /** True after the prefix-reader wave has presented a cut. */
  private waveHasPublished = false;
  /** Backing store for {@link planTimings}. */
  private readonly planTimingsValue = {
    applyMs: 0,
    worstApplyMs: 0,
    writeMs: 0,
    residentMs: 0,
    moves: 0,
    appends: 0,
    worstSplats: 0,
  };
  /**
   * Backing store for {@link fetchCounts}. Lifetime totals, because the question
   * they answer is about a *steady state* - "this keeps streaming after the view
   * settled" - which a per-frame or windowed number cannot express.
   */
  private readonly fetchCountsValue = {
    priority: 0,
    base: 0,
    sweep: 0,
    evicted: 0,
    uncovered: 0,
    retiredEarly: 0,
    cacheFull: false,
    cacheBytes: 0,
    cacheLimitBytes: 0,
  };
  /**
   * The screen-radius band the scene asked for, kept so the band can be scaled
   * with the solved frontier cut and always relative to the original - scaling
   * the live values repeatedly would drift. Null when the scene has no band.
   */
  private readonly frontierBandBase: { min: number; max: number } | null = null;
  /**
   * Splats per slab page for this mesh: {@link SLAB_PAGE_SPLATS}, or the whole
   * capacity when that is smaller. Spark can use one fixed page size because
   * its pool is a single large arena; here a mesh may be smaller than a page,
   * and rounding it up to one would waste most of the reservation.
   */
  private readonly slabPageSplats: number = SLAB_PAGE_SPLATS;
  /** Target drawn-splat count for the page-table frontier; see the constructor. */
  private pageTableDrawBudget = 0;
  /**
   * Slab slots to reserve: the draw budget plus 50% staging tail, capped at
   * the pool ceiling. Refinement appends replacements into that undrawn tail
   * so the previous complete prefix can keep drawing until the commit.
   */
  private get pageTableStagingSlots(): number {
    const draw = this.pageTableDrawBudget;
    if (draw <= 0) return 0;
    return Math.min(this.slabCeiling, draw + Math.ceil(draw / 2));
  }
  /** The unclamped draw target (`foveationDrawBudget` or the default), kept so
   * `setBudget` can re-derive the effective draw budget when the pool budget
   * moves (e.g. under a `BudgetGovernor`). */
  private pageTableDrawTarget = 0;
  /** Whether {@link pageTableDrawTarget} came from an explicit
   * `foveationDrawBudget` - a caller-chosen hard cap worth warning about when a
   * governed budget outgrows it, rather than the library's own default. */
  private pageTableDrawTargetExplicit = false;
  /** Last frontier's drawn (non-degenerate) splat count - the true on-screen size
   * in `page-table` mode, where the slab is fully "active" but mostly degenerate. */
  private pageTableDrawn = 0;
  private pageTableDisplayGeneration = -1;
  private frontierConverged = true;
  private pendingFrontierSplats = 0;
  private staleResidentSplats = 0;
  private lastPlanAppends = 0;
  private lastPlanMoves = 0;
  private lastPlanGeneration = 0;
  private lastPlanBudget = 0;
  private lastPlanCamera: readonly [number, number, number] | null = null;
  private firstFrontierCamera: readonly [number, number, number] | null = null;
  /** Monotonic reschedule id; a stale plan (superseded by a newer request) is
   * dropped. `pageTableInFlight` coalesces to one outstanding traversal. */
  private pageTableSeq = 0;
  private pageTableInFlight = false;
  private pageTableDisposed = false;
  /** Files whose data has been forwarded to the worker (so we don't refetch). */
  private readonly pageTableCachedFiles = new Set<number>();
  /** Chunks the last frontier wanted but did not have, biggest-on-screen first.
   * These outrank the background sweep - they are the detail actually on screen. */
  private pageTableFetchPriority: readonly number[] = [];
  /** Frontier-cut target node size (px) and foveation ramp; see `frontierView`. */
  private pageTableTargetPx = DEFAULT_FOVEATION_TARGET_PX;
  private pageTableFoveation: FrontierFoveation = FRONTIER_FOVEATION_DEFAULTS;
  /** Drawing-buffer height, sampled in `update` so `reschedule` can derive the
   * cut limit the same way the material does (`targetPx / focalY`). */
  private pageTableViewportY = 0;
  /** Frontier cut on foveated `size / distance`. Re-derived each reschedule once
   * the drawing buffer is known; the initial value only covers the first frame. */
  private pageTableLimit = 0.02;
  /**
   * Whether the worker's cache is sitting at its cap: sweeping past that point
   * only evicts what the frontier is using.
   *
   * Re-derived from every plan rather than latched. It used to latch on the
   * first eviction, which was safe only while the cap was sized to the capture
   * and evictions therefore meant "this will never fit". Under a scene-wide
   * {@link ChunkCacheBudget} evictions are routine - a far mesh gives bytes back
   * and is trimmed - and latching would kill its sweep for the session, so a
   * mesh that went cold could never re-warm when the camera returned.
   */
  private pageTableCacheAtLimit = false;

  /** Per-splat channels whose edits survive chunk eviction/reload (M7.6). */
  private readonly persistentChannels = new Map<string, PersistentChannel>();

  /** Chunk-file index of the always-resident environment tile, if the scene ships one. */
  private readonly envFile: number | undefined;
  /** Whether the environment tile should be visible; toggled live. */
  private envEnabled: boolean;
  /** Pool handle of the environment tile once it has loaded (kept for toggling). */
  private envHandle: SplatRange | undefined;
  /** Env splat count, measured when the tile decodes; 0 until then. */
  private envSplatCount = 0;
  /** Set when the env tile is larger than the whole pool - terminal, warned once. */
  private envUnfit = false;

  /**
   * Startup hold. `'capture'` waits for the first schedule after the host
   * applies the final camera; `'holding'` freezes that coverage set.
   */
  private initialRevealPhase: 'off' | 'capture' | 'holding' | 'released' = 'off';
  /** Which hold, if any, was armed at construction. Survives release for recapture. */
  private readonly initialRevealHold: 'off' | 'hold-near-l0' | 'hold-coverage' = 'off';
  /** Frozen nearby-detail / in-view coverage runs for {@link initialRevealPhase} `'holding'`. */
  private frozenCriticalRuns: LodRun[] | null = null;
  /** Timestamp of the final-camera capture that began the current hold. */
  private initialRevealStartedAt: number | undefined;
  private initialRevealStateValue: InitialRevealState = { status: 'disabled' };

  /** Fetch settings this mesh was loaded with, reused for collision meshes. */
  private readonly requestOptions: SplatRequestOptions | undefined;
  /** In-flight or settled collision load; see {@link loadCollisionMeshes}. */
  private collisionTiles: Promise<readonly CollisionMeshTile[]> | undefined;
  private collisionAbort: AbortController | undefined;

  private pendingWork = true;
  private lastScheduleTime = -Infinity;
  /** Reused leaf-coverage bitmap for {@link substituteCoverage}; grows only. */
  private coverageScratch: Uint8Array | undefined;
  private readonly lastCameraPos = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly lastCameraQuat = new THREE.Quaternion();

  /**
   * Fetches a scene manifest and prepares a mesh sized to the budget.
   * Accepts a Streamed SOG manifest (`lod-meta.json`) or an XGRIDS `.lcc2` or
   * `.lcc` (manifest v3–v5) dataset - all stream through the same machinery. Both LCC
   * generations are normalized to the established XGRIDS/Spark Three.js
   * coordinate frame; streamed SOG orientation is unchanged.
   *
   * A `.lcc` dataset needs a server that answers HTTP range requests: its
   * splats live in one large `data.bin` that is never fetched whole.
   *
   * @param manifestUrl - URL of the scene's `lod-meta.json`, `.lcc2` or `.lcc`
   * file; relative URLs resolve against `options.baseUrl` (or the page).
   * @throws Rejects with {@link SplatLoadError} on any resolve/fetch/parse
   * failure, or a `DOMException` named `AbortError` when `options.signal` fires.
   */
  static async load(
    manifestUrl: string | URL,
    options: StreamedSplatMeshOptions = {},
  ): Promise<StreamedSplatMesh> {
    const absoluteUrl = resolveSplatUrl(manifestUrl, options.baseUrl).href;
    const lower = absoluteUrl.toLowerCase();
    const format: Exclude<StreamedSplatFormat, 'auto'> =
      options.format !== undefined && options.format !== 'auto'
        ? options.format
        : lower.endsWith('.lcc2')
          ? 'lcc2'
          : lower.endsWith('.lcc')
            ? 'lcc'
            : lower.endsWith('.rad')
              ? 'rad'
              : 'streamed-sog';
    return StreamedSplatMesh.fromSource(
      httpDatasetSource(absoluteUrl, options.request),
      format,
      options,
    );
  }

  /**
   * Prepares a mesh from a folder dropped into the page - the same streamed
   * formats, read straight off the user's disk with no server and no upload.
   *
   * Every file becomes a `blob:` URL, which answers range requests exactly as
   * an HTTP origin does, so a multi-hundred-megabyte `.lcc` `data.bin` streams
   * chunk-by-chunk rather than being read whole.
   *
   * @param files - The folder's files, keyed by path relative to its root
   * (as the demo drop-zone `readDirectory` walk produces).
   * @throws Rejects with {@link SplatLoadError} - phase `'manifest'` when the
   * folder holds no (or more than one) recognizable scene manifest - or a
   * `DOMException` named `AbortError` when `options.signal` fires.
   */
  static async loadLocal(
    files: ReadonlyMap<string, File>,
    options: StreamedSplatMeshOptions = {},
  ): Promise<StreamedSplatMesh> {
    let dataset: ReturnType<typeof createLocalDataset>;
    try {
      dataset = createLocalDataset(files);
    } catch (error) {
      // Not `toSplatLoadError`: a folder without a manifest is not retryable.
      throw error instanceof SplatLoadError
        ? error
        : new SplatLoadError(error instanceof Error ? error.message : String(error), {
            phase: 'manifest',
            url: 'local-folder',
            retryable: false,
            cause: error,
          });
    }
    try {
      const mesh = await StreamedSplatMesh.fromSource(dataset.source, dataset.format, options);
      // Hand ownership to the mesh rather than disposing here: a streamed mesh
      // keeps fetching chunk URLs for its whole life, so revoking now would
      // break it. Without this the blob URLs (and the `File` blobs they pin)
      // stayed registered for the document's lifetime - `dispose` was reachable
      // only from the catch below, i.e. only when the load *failed*.
      mesh.localSource = dataset.source;
      return mesh;
    } catch (error) {
      dataset.source.dispose(); // release the blob URLs this drop created
      throw error;
    }
  }

  /** Shared load path: fetch the manifest from a source, then build the scene. */
  private static async fromSource(
    source: SplatDatasetSource,
    format: Exclude<StreamedSplatFormat, 'auto'>,
    options: StreamedSplatMeshOptions,
  ): Promise<StreamedSplatMesh> {
    // `format` is what makes this per-scene rather than per-device: an LCC-class
    // capture's splats grow as its budget tightens, so the two classes want
    // different ceilings on the same phone. An explicit `budget` still wins;
    // `budgetCap` tightens the resolved default without replacing it.
    const deviceProfile = options.deviceProfile;
    const deviceBudget = resolveSplatBudget(options.budget, deviceProfile, {
      format,
      ...(options.budgetCap === undefined ? {} : { cap: options.budgetCap }),
    });
    // `maxBudget` separates two things the budget used to conflate: what the
    // mesh renders now, and the most it could ever be asked to render. The pool
    // is sized from the ceiling (it cannot grow later), so a governed mesh has
    // somewhere to grow into; without one the two are equal and every existing
    // caller behaves exactly as before.
    const ceilingBudget =
      options.maxBudget === undefined
        ? deviceBudget
        : resolveSplatBudget(options.maxBudget, deviceProfile);
    if (ceilingBudget < deviceBudget) {
      throw new RangeError(
        `StreamedSplatMesh: maxBudget (${ceilingBudget}) must be >= budget (${deviceBudget}).`,
      );
    }
    // `.rad` now defaults to the `page-table` selected-index pager, which pages only
    // the *selected* frontier (Spark's model) and wants the full device budget -
    // Spark runs this scene at ~4M. (The old 2.5M `RAD_PREFIX_DEFAULT_BUDGET` cap
    // was a fallback for the whole-scene prefix reader before the pager landed;
    // capping the frontier at 2.5M starves it and it stays coarse near the camera.)
    //
    // The scene is built against the *ceiling*: a foveated `.rad` reports
    // `maxResidentSplats: options.budget`, and that number caps the pool below -
    // so seeding it with the initial budget would undo the headroom. The source's
    // live budget is overwritten with the initial value once the scene exists.
    const sourceOptions = {
      budget: ceilingBudget,
      lodBaseDistance: options.lodBaseDistance ?? 10,
      lodMultiplier: options.lodMultiplier ?? 2,
    };
    // Unset means "every band the capture carries", so a Quality scene shows
    // its real colors without the caller knowing the format - except on a
    // `smooth` profile (the default on mobile), where the bandwidth and the
    // ~64 B/splat of extra pool textures are exactly what that profile exists
    // to avoid. The scene then clamps this to what the file actually has.
    const shBands =
      options.shBands ??
      (resolveSplatPerformanceProfile(options.performanceProfile, deviceProfile) === 'smooth'
        ? 0
        : MAX_SH_BANDS);
    // Resolved once here rather than at the options bag below, so the device is
    // probed a single time per load.
    const radMaxStdDev = recommendedRadMaxStdDev(deviceProfile);
    // Whether the finest-level lift below may raise this mesh's budget. A caller
    // that named a size gets that size - see the `ceiling` computation. `.rad`
    // needs to know up front, because the lift decides whether its leaves fit
    // the budget and therefore whether it reads as a prefix or foveates.
    //
    // `budgetCap` counts as naming a size for this purpose even though it is
    // only a ceiling: the lift raises the budget to hold a finest level whole,
    // which is exactly what a caller asking for "no more than N" has ruled out.
    // Without this a desktop performance mode would lift straight back over its
    // own cap, to as much as `FINEST_LEVEL_BUDGET_MAX`.
    const budgetLifts =
      options.allowFinestLevelLift === true
        ? options.budgetCap === undefined
        : options.budget === undefined &&
          options.maxBudget === undefined &&
          options.budgetCap === undefined;

    // A `.rad` "manifest" is the file's own binary header, read by range - it
    // must not be fetched whole (it is the multi-hundred-megabyte scene) or
    // JSON-parsed like the other formats' manifests.
    const signal = options.signal;
    signal?.throwIfAborted();
    let scene: StreamedScene;
    if (format === 'rad') {
      // The manifest here is the `.rad` file's own header (ranged reads).
      // Contract: only SplatLoadError or AbortError leaves this path.
      try {
        const { buildRadScene } = await import('../formats/rad');
        // `shBands` is a *cap* here: a `.rad` declares its own `maxSh`, so the
        // resolved value decides how much of it to keep. Passing it is what lets
        // the `smooth` profile (and an explicit `shBands: 0`) decline SH on a
        // `.rad` at all - without it the file's bands were adopted wholesale.
        scene = await buildRadScene(source, sourceOptions, options.request, shBands, budgetLifts);
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw toSplatLoadError(error, { phase: 'manifest', url: source.manifestUrl });
      }
    } else {
      let response: Response;
      try {
        response = await fetch(source.manifestUrl, toRequestInit(options.request, signal));
      } catch (error) {
        // A raw fetch TypeError (network/CORS) must not escape unwrapped.
        if (isAbortError(error)) throw error;
        throw toSplatLoadError(error, { phase: 'fetch', url: source.manifestUrl });
      }
      if (!response.ok) {
        throw toSplatLoadError(
          new Error(`Failed to load manifest ${source.manifestUrl}: HTTP ${response.status}`),
          { phase: 'manifest', url: source.manifestUrl, status: response.status },
        );
      }
      try {
        // `response.json()` is typed `any`; the parsers below validate it.
        const json: unknown = await response.json();
        if (format === 'lcc2') {
          // Import the public format entry rather than an internal chunk. Rollup may
          // represent internal chunks through synthetic namespace exports, which a
          // consuming production build can incorrectly tree-shake while rebundling.
          const { buildLcc2Scene } = await import('../formats/lcc');
          // LCC2 tiles are SOG v2; SH is opt-in like Streamed SOG (tiles may be DC-only).
          scene = buildLcc2Scene(json, source, sourceOptions, options.shBands ?? 0);
        } else if (format === 'lcc') {
          const { buildLccScene } = await import('../formats/lcc');
          scene = await buildLccScene(json, source, { ...sourceOptions, shBands });
        } else {
          // Streamed SOG SH is strictly opt-in: unlike LCC (whose manifest
          // states its band count), a SOG manifest never says whether the
          // tiles carry shN, so the "every band the capture carries" default
          // cannot apply - an explicit `shBands` turns it on.
          scene = buildSogScene(json, source, sourceOptions, options.shBands ?? 0);
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw toSplatLoadError(error, { phase: 'manifest', url: source.manifestUrl });
      }
    }
    // Aborted while the manifest was in flight or parsing: nothing built yet.
    signal?.throwIfAborted();

    // An LCC capture offers only its finest level (see `buildLccScene`),
    // so a budget below it does not soften the scene - it deletes whole 30 m
    // cells. Take the level whole when it is small enough to be worth it. A
    // `.rad` refines uniformly (no camera foveation - its chunk DAG is too
    // entangled for a chunk-cut, see `docs/formats/rad-notes.md`), so a budget below the
    // leaf count leaves coarse blobs *everywhere*, worst up close; lifting to the
    // full leaf set when it fits makes a moderate scene sharp. An explicit budget
    // is a hard cap for A/B runs and always wins.
    //
    // The lift raises the *ceiling*, since that is what sizes the pool, and with
    // nothing pinned the initial budget rides up with it - the established
    // behavior. A host that pinned `maxBudget` gets exactly that ceiling and no
    // more: it asked for a specific memory envelope, and silently allocating
    // past it would be the one surprise this option must not spring.
    // `budgetLifts` is the same predicate `buildRadScene` was handed above, so
    // the path it chose and the budget applied here cannot disagree.
    const ceiling =
      (format === 'lcc' || format === 'rad') && budgetLifts
        ? liftBudgetToFinestLevel(ceilingBudget, scene.maxResidentSplats, deviceProfile)
        : ceilingBudget;
    const budget = options.maxBudget === undefined ? ceiling : Math.min(deviceBudget, ceiling);
    scene.source.budget = budget;

    // Pool capacity: 40% over whatever can actually be resident - the ceiling,
    // or the finest level if the whole scene is smaller than it. The
    // slack absorbs per-run row-alignment waste (hundreds of runs each waste
    // up to a row) and the append-before-remove window during LOD swaps;
    // too little slack makes small-budget swaps converge slowly under
    // capacity pre-check pressure. ~64 B/splat of GPU memory.
    const residentCeiling = Math.min(ceiling, scene.maxResidentSplats);
    // Inactive staging must temporarily hold both sides of a large atomic
    // replacement. Ten extra percentage points avoid full-pool compaction on
    // the measured 1.6M-splat restaurant swap (~22 MB at a 3.5M budget).
    const capacityFactor = options.experimentalStagedSwaps !== false ? 1.5 : 1.4;
    const capacityRows = Math.max(
      1,
      Math.ceil((residentCeiling * capacityFactor) / DATA_TEXTURE_WIDTH),
    );

    // Resolve page-table worker before construction (constructors cannot await).
    // SOG/LCC hosts never pay for the frontier worker blob.
    const resolvedFoveationMode = scene.foveation
      ? resolveSplatFoveationMode(
          options.foveationMode,
          format === 'rad' ? 'page-table' : 'frontier',
        )
      : options.foveationMode === undefined
        ? undefined
        : resolveSplatFoveationMode(options.foveationMode);
    let FrontierWorkerCtor: InlineWorkerCtor | undefined;
    if (isPageTableFoveation(resolvedFoveationMode)) {
      const mod = await import('../formats/rad/frontier-worker?worker&inline');
      FrontierWorkerCtor = mod.default;
      signal?.throwIfAborted();
      // The worker cuts the tree itself; per-splat `parent_size` (a GPU-cut input)
      // would be computed for every chunk and never read. See `needsParentSizes`.
      const source = scene.source as { needsParentSizes?: boolean };
      if (source.needsParentSizes !== undefined) source.needsParentSizes = false;
    }

    // The scene decides the effective bands: asking for SH on a capture that
    // has none must not allocate SH textures for it.
    const mesh = new StreamedSplatMesh(
      scene,
      budget,
      capacityRows * DATA_TEXTURE_WIDTH,
      {
        ...options,
        // Classic `.lcc` and `.lcc2` wait for in-view coverage so first paint
        // has no empty cells (classic nearby cells at L1, farther at coarsest).
        // Keep every other format progressive, and let a caller explicitly
        // request progressive or hold-near-l0.
        ...((format === 'lcc' || format === 'lcc2') && options.initialReveal === undefined
          ? { initialReveal: 'hold-coverage' as const }
          : {}),
        // The resolved ceiling, not the caller's raw option: it may have been
        // lifted to a moderate capture's leaf count above.
        maxBudget: ceiling,
        // This line overrides `...options` above, so a declined request has to
        // survive it - that is how `.rad` came to ignore both the `smooth`
        // profile and an explicit `shBands: 0`. Only *zero* is re-applied here,
        // never a partial reduction: the builders already honour partial
        // requests by generating that many bands, whereas forcing a smaller
        // count past one would mismatch the decoded chunk and degrade to
        // neutral SH (see `SplatMesh.writePackedSh`).
        shBands: shBands === 0 ? 0 : (scene.shBands ?? 0),
        // Spark ships Mip-Splatting antialiasing ON (blurAmount 0.3 *with* opacity
        // compensation `α·√(detRaw/detBlur)`). Match that default for `.rad`: the
        // 0.3 low-pass without the compensation makes splats too opaque (uniform
        // blur) and leaves anisotropic splats bright (needle spikes).
        antialias: options.antialias ?? (format === 'rad' ? true : undefined),
        // Older XGRIDS LCC uses a smaller, compensated projected low-pass.
        ...(format === 'lcc' ? { projectedFilterProfile: 'lcc' as const } : {}),
        // Match Spark's `.rad` render exactly: the LOD alpha encoding + merged-node
        // σ-cutoff/super-Gaussian, and the √8 (≈2.83σ) base cutoff Spark defaults to.
        // An explicit `lodAlpha` (e.g. `?lodAlpha=0`) wins for A/B.
        //
        // The √8 cutoff is *desktop only* - see `recommendedRadMaxStdDev`, which
        // returns undefined on mobile so the `SplatMesh` constructor applies the
        // same 4 ceiling `.rad` was the only format escaping. An explicit
        // `maxStdDev` still wins, through `...options` above.
        ...(format === 'rad'
          ? {
              lodAlpha: options.lodAlpha ?? true,
              ...(options.maxStdDev === undefined && radMaxStdDev !== undefined
                ? { maxStdDev: radMaxStdDev }
                : {}),
            }
          : {}),
        // A foveated scene renders whole chunks and picks the LOD cut per splat.
        // `.rad` defaults to Spark's selected-index page table (only the frontier is
        // paged to the GPU, so the whole device budget buys on-screen detail); other
        // foveated formats keep the GPU `frontier` cut. `foveationMode: 'band'` (or
        // `'frontier'`) forces the legacy paths for A/B. Overrides any caller blob cull.
        ...(scene.foveation
          ? {
              foveationMode: resolvedFoveationMode,
              minSplatScreenRadius: scene.foveation.minScreenRadiusPx,
              maxSplatScreenRadius: scene.foveation.maxScreenRadiusPx,
            }
          : {}),
      },
      FrontierWorkerCtor,
      format === 'lcc',
    );
    // LCC carries its Z-up→Y-up matrix in both orientation modes (format
    // semantics); streamed SOG and Spark `.rad` get the cosmetic 180°-X flip in
    // 'y-up', matching Spark's documented OpenCV→OpenGL scene correction.
    const correction =
      scene.formatTransform ?? (mesh.orientation === 'y-up' ? yUpTransformForFormat(format) : null);
    if (correction) {
      mesh.matrix.copy(correction);
      mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.matrixWorldNeedsUpdate = true;
    }
    // A last-instant abort must not leak the mesh (its loader worker, frontier
    // worker, and pool textures) - dispose it and reject like every other abort.
    if (signal?.aborted) {
      mesh.dispose();
      signal.throwIfAborted();
    }
    return mesh;
  }

  private constructor(
    scene: StreamedScene,
    budget: number,
    capacity: number,
    options: StreamedSplatMeshOptions,
    FrontierWorkerCtor?: InlineWorkerCtor,
    neverRetireCoverageEarly = false,
  ) {
    super({ capacity }, options);
    this.scene = scene;
    this.budgetValue = budget;
    // The pool was allocated for the ceiling, so `setBudget` may climb to it.
    // Never below `budget` - that would make the mesh's own starting budget
    // unreachable.
    this.maximumBudget =
      options.maxBudget === undefined
        ? budget
        : Math.max(budget, resolveSplatBudget(options.maxBudget));
    this.lodScaleValue = validateLodScale(options.lodScale);
    this.stagedSwapsEnabled = options.experimentalStagedSwaps !== false;
    this.neverRetireCoverageEarly = neverRetireCoverageEarly;
    this.appendCap = validateAppendCap(options.maxSplatsPerSwap);
    const holdCoverage =
      options.initialReveal === 'hold-coverage' && this.scene.source.coverageRunsFor !== undefined;
    const holdNearL0 = options.initialReveal === 'hold-near-l0' && neverRetireCoverageEarly;
    if (holdCoverage || holdNearL0) {
      this.initialRevealHold = holdCoverage ? 'hold-coverage' : 'hold-near-l0';
      this.initialRevealPhase = 'capture';
      this.initialRevealStateValue = {
        status: 'pending',
        stagedSplats: 0,
        totalSplats: 0,
        readyGroups: 0,
        totalGroups: 0,
      };
    } else {
      this.initialRevealHold = 'off';
      this.initialRevealPhase = 'off';
      this.initialRevealStateValue = { status: 'disabled' };
    }
    this.onPerformanceEvent = options.onPerformanceEvent;
    this.cpuCacheBytes = options.cpuCacheBytes ?? defaultCpuCacheBytes();
    this.requestOptions = options.request;
    this.envFile = scene.environment?.file;
    this.envEnabled = options.environmentEnabled !== false;
    this.fetchWeight = options.fetchWeight;
    this.fetchScheduler = options.fetchScheduler;
    this.cacheBudget = options.cacheBudget;
    // Registered from the constructor so the very first reschedule is already
    // arbitrated - on a multi-mesh scene the load-time burst is the whole
    // problem, and a mesh that joins late has already taken its slots.
    this.fetchHandle = this.fetchScheduler?.register({
      // No weight supplied: claim an equal share rather than none, so a partly
      // wired host degrades to round-robin instead of silently starving.
      weight: () => this.fetchWeight?.() ?? 1,
      onSlotAvailable: () => {
        this.pendingWork = true;
      },
      shedFetches: (kind) => this.abortFetches(kind),
    });

    // Join the scene's cache envelope, if the host shares one. Registered here
    // rather than beside `fetchScheduler` because the ceiling needs `scene`, and
    // *before* the page-table branch because every streamed mesh has a chunk
    // cache - a scene of `.lcc2` additional meshes would otherwise sit outside the one
    // number that is supposed to bound the whole scene.
    //
    // The ceiling is the most this mesh could put to use. A `.rad` mesh
    // (prefix or page-table) needs more than the host's 256 MiB default: its
    // frontier can only refine into chunks that are resident *together*, so a
    // whole view spans many chunks (cest_ca: ~249 x ~6.5 MB decoded ~ 1.6 GB)
    // and a cache holding a fraction of them leaves the near frontier
    // thrashing and the scene oscillating between a sharp cut and a noisy
    // one. Hence a ceiling above the host's per-mesh figure, bounded by what
    // this capture could even hold.
    //
    // That figure used to be the *cap*, at a flat 2 GiB: right for one big scene
    // and wrong for a wall of additional meshes, where 13 meshes were each allowed 2 GiB
    // against a 4 GiB tab heap. Bounding it by the capture helped and did not
    // fix it - thirteen 500 MB captures still allow 6.5 GB, because nothing
    // related the meshes to each other. The budget is that missing relation.
    const isPageTable = isPageTableFoveation(options.foveationMode);
    const cacheCeilingBytes =
      isPageTable || scene.chunkSize !== undefined
        ? Math.max(
            this.cpuCacheBytes,
            Math.min(PAGETABLE_CACHE_FLOOR_BYTES, estimateSceneDecodedBytes(scene)),
          )
        : this.cpuCacheBytes;
    this.cacheBudgetHandle = this.cacheBudget?.register({
      // The governor weight `fetchWeight` already carries, so cache and network
      // follow the same camera-projected measure. The `1` fallback matches
      // `requestChunk`: a host that never wired weights gives every mesh an
      // equal claim rather than none.
      weight: () => this.fetchWeight?.() ?? 1,
      ceilingBytes: cacheCeilingBytes,
      onAllowanceChanged: (bytes) => this.applyCacheAllowance(bytes),
    });
    this.cacheLimitBytes =
      this.cacheBudget && this.cacheBudgetHandle
        ? this.cacheBudget.allowanceFor(this.cacheBudgetHandle)
        : cacheCeilingBytes;
    // The classic path evicts against `cpuCacheBytes` directly; the page-table
    // path evicts inside its worker, which is told the number in `init` below.
    if (!isPageTable) this.cpuCacheBytes = this.cacheLimitBytes;
    this.fetchCountsValue.cacheLimitBytes = this.cacheLimitBytes;

    // Page-table mode: reserve the whole pool as one always-active slab (all-zeros
    // → degenerate/invisible until paged) and spin up the worker that owns the
    // chunk cache + traversal + pager. Spark's selected-index model, off-thread.
    if (isPageTableFoveation(options.foveationMode)) {
      if (!FrontierWorkerCtor) {
        throw new Error('StreamedSplatMesh: page-table foveation requires the frontier worker.');
      }
      // Frontier draw target: an explicit `foveationDrawBudget` (`?foveationDraw=`)
      // wins for A/B; otherwise Spark's default. Never above the pool budget.
      this.pageTableDrawTarget = options.foveationDrawBudget ?? PAGETABLE_DRAW_BUDGET;
      this.pageTableDrawTargetExplicit = options.foveationDrawBudget !== undefined;
      this.pageTableDrawBudget = Math.min(budget, this.pageTableDrawTarget);
      this.pageTableTargetPx = options.foveationTargetPx ?? DEFAULT_FOVEATION_TARGET_PX;
      this.pageTableFoveation = { ...FRONTIER_FOVEATION_DEFAULTS, ...options.frontierFoveation };
      if (
        options.minSplatScreenRadius !== undefined ||
        options.maxSplatScreenRadius !== undefined
      ) {
        this.frontierBandBase = {
          min: options.minSplatScreenRadius ?? 0,
          max: options.maxSplatScreenRadius ?? 0,
        };
      }
      // The slab starts empty: only the used prefix is ever active (drawn and
      // sorted) - each plan advances it to the resident count. Activating the
      // whole pool-sized slab would sort and vertex-process millions of
      // degenerate tail slots every frame.
      //
      // Reserved as pages rather than one block: the pager addresses slots, so
      // the storage behind them need not be contiguous, and page-sized
      // reservations are what let this mesh later grow and release storage with
      // its budget instead of holding its ceiling for the whole session.
      this.slabPageSplats = Math.min(SLAB_PAGE_SPLATS, capacity);
      // Draw budget plus a staging tail so refinement can append replacements
      // without overwriting the drawn prefix. The ceiling stays a permission
      // to grow, not an up-front claim, so distant meshes still share the pool.
      this.slabCeiling = capacity;
      this.syncSlabPages(this.pageTableStagingSlots);
      this.frontierWorker = new FrontierWorkerCtor();
      this.frontierWorker.onmessage = (e: MessageEvent<FrontierPlanMessage>) =>
        this.applyFrontierPlan(e.data);
      this.pagerSlots = this.slabSlots;
      // The frontier can only refine into chunks that are resident *together*.
      // A whole `.rad` view spans many chunks (cest_ca: ~249 × ~6.5 MB decoded ≈
      // 1.6 GB); a 512 MB cache holds only ~80, so the near frontier thrashes
      // and the scene "stays coarse forever". Hence a floor above the host's
      // per-mesh share - but bounded by what this capture could even hold, and
      // never below what the host asked for.
      //
      // The floor used to be a flat 2 GiB, which is right for one big scene and
      // wrong for a wall of additional meshes: 13 of them were each *allowed* 2 GiB
      // against a 4 GiB tab heap, so the one number that was supposed to stop
      // thrashing became the largest single memory risk in the viewer. Bounding
      // it by the capture helped and did not fix it - thirteen 500 MB captures
      // still allow 6.5 GB, because nothing relates the meshes to each other.
      //
      // So with a scene-wide `cacheBudget` this figure stops being the cap and
      // becomes this mesh's *ceiling*: the most it could put to use, which the
      // budget hands out from a scene total by camera weight.
      this.postToWorker({
        type: 'init',
        capacity: this.pagerSlots,
        chunkSize: scene.chunkSize ?? 65536,
        cpuCacheBytes: this.cacheLimitBytes,
      });
      // Seed the worker with the chunk the scene builder already decoded. The
      // tree roots are derived from chunk 0, so without this every traversal up
      // to the (redundant) refetch of chunk 0 returns an empty frontier.
      const bootstrap = scene.bootstrapChunk;
      if (bootstrap) this.forwardChunkToWorker(bootstrap.file, bootstrap.data);
    } else {
      this.frontierWorker = null;
    }
  }

  /** Slots the currently reserved pages can hold. */
  private get slabSlots(): number {
    let slots = 0;
    for (const page of this.slabPages) slots += page.count;
    return slots;
  }

  /**
   * Reserves or releases slab pages so the slab can hold `wanted` slots, and
   * tells the worker's pager the new slot count.
   *
   * This is the mechanism that makes a shared pool worth having: storage follows
   * the governed budget, so approaching a mesh grows its pages while the ones
   * behind you hand theirs back, instead of every mesh holding its ceiling for
   * the whole session. Growth stops at the construction ceiling and at whatever
   * the pool can actually spare - a mesh that cannot grow simply stays coarse
   * rather than throwing.
   */
  private syncSlabPages(wanted: number): void {
    if (this.slabCeiling === 0) return;
    const target = Math.max(this.slabPageSplats, Math.min(this.slabCeiling, wanted));
    let slots = this.slabSlots;

    while (slots < target) {
      const size = Math.min(this.slabPageSplats, this.slabCeiling - slots);
      if (size <= 0) break;
      try {
        this.slabPages.push(this.reserveInactiveRange(size));
      } catch {
        // The pool has no room right now (a nearer mesh holds it). Keep what we
        // have; the next budget change retries.
        break;
      }
      slots += size;
    }

    while (this.slabPages.length > 1) {
      const last = this.slabPages[this.slabPages.length - 1] as SplatRange;
      if (slots - last.count < target) break;
      this.slabPages.pop();
      slots -= last.count;
      this.removeRange(last);
    }

    if (slots !== this.pagerSlots) {
      this.pagerSlots = slots;
      this.postToWorker({ type: 'resize', capacity: slots });
      // Slots beyond the new count are gone from the pager, so stop drawing
      // them; the next plan re-establishes the resident prefix.
      if (this.pageTableDrawn > slots) this.setSlabResident(slots);
      this.pendingWork = true;
      this.lastScheduleTime = -Infinity;
    }
  }

  /**
   * Writes `data` at slot `slot`, splitting the write where it crosses a page
   * boundary. The pager's runs are contiguous in *slot* space, which page
   * storage no longer guarantees is contiguous in the pool.
   */
  private writeSlabSlots(data: SplatData, slot: number, count: number): void {
    let written = 0;
    while (written < count) {
      const at = slot + written;
      const page = this.slabPages[Math.floor(at / this.slabPageSplats)];
      if (!page) return; // beyond reserved storage; `dropped` already warns
      const offset = at % this.slabPageSplats;
      const run = Math.min(count - written, this.slabPageSplats - offset);
      this.overwriteRangeData(page, sliceSplatData(data, written, run), offset);
      written += run;
    }
  }

  /** Zeros slots `[slot, slot + count)`, splitting at page boundaries like
   * {@link writeSlabSlots}, so freed slots hold nothing drawable. */
  private degenerateSlabSlots(slot: number, count: number): void {
    let done = 0;
    while (done < count) {
      const at = slot + done;
      const page = this.slabPages[Math.floor(at / this.slabPageSplats)];
      if (!page) return; // beyond reserved storage
      const offset = at % this.slabPageSplats;
      const run = Math.min(count - done, this.slabPageSplats - offset);
      this.degenerateRange(page, offset, run);
      done += run;
    }
  }

  /**
   * Draws exactly the first `resident` slots: pages below the boundary are
   * fully active, the page containing it is partially active, the rest are
   * inactive. Freed tail slots simply leave the active list; they are also
   * degenerated (see {@link degenerateSlabSlots}) so that even a slot drawn by
   * mistake shows nothing.
   */
  private setSlabResident(resident: number): void {
    for (let page = 0; page < this.slabPages.length; page++) {
      const prefix = Math.min(
        this.slabPageSplats,
        Math.max(0, resident - page * this.slabPageSplats),
      );
      this.setRangeActivePrefix(this.slabPages[page] as SplatRange, prefix);
    }
  }

  /** Typed post to the frontier worker. */
  private postToWorker(msg: FrontierRequest, transfer: Transferable[] = []): void {
    this.frontierWorker?.postMessage(msg, transfer);
  }

  /**
   * Applies a new decoded-chunk allowance from the scene's shared
   * {@link ChunkCacheBudget}.
   *
   * Only the cap moves; nothing is dropped here. Both cache implementations
   * evict lazily against it - the page-table worker inside its next
   * `reschedule`, against a frontier that is still current, and the classic
   * path in `evictChunks` on the next tick. Dropping chunks synchronously would
   * pull them out from under resident splats.
   *
   * `pageTableCacheAtLimit` is recomputed here rather than waiting for the next
   * plan, so a *raised* allowance re-arms the background sweep on this tick
   * instead of one idle interval later.
   */
  private applyCacheAllowance(bytes: number): void {
    if (this.disposed) return;
    if (bytes === this.cacheLimitBytes) return;
    this.cacheLimitBytes = bytes;
    if (this.frontierWorker) {
      this.postToWorker({ type: 'cacheBudget', cpuCacheBytes: bytes });
    } else {
      // The classic cache lives on this thread and `evictChunks` reads this
      // field directly, so moving it is the whole update.
      this.cpuCacheBytes = bytes;
    }
    this.fetchCountsValue.cacheLimitBytes = bytes;
    this.pageTableCacheAtLimit = this.fetchCountsValue.cacheBytes >= bytes;
    // Land the new cap on the next tick rather than at the idle interval: a
    // shrink should stop the sweep now, and a grow should resume it now.
    this.pendingWork = true;
  }

  /**
   * Whether this scene ships collision meshes - true for an XGRIDS `.lcc` /
   * `.lcc2` dataset that carries them, false for a Streamed SOG scene, which
   * has none.
   */
  get hasCollisionMeshes(): boolean {
    return (this.scene.collision?.meshes.length ?? 0) > 0;
  }

  /**
   * Fetches and parses this scene's collision geometry: the triangle meshes an
   * XGRIDS `.lcc` (`collision.lci`) or `.lcc2` (`data/mesh/*.ply`) capture
   * ships beside its splats, for hosts that want collision, ground probes or
   * other spatial queries.
   *
   * The geometry is source-local, like {@link StreamedScene.bounds} - apply
   * this mesh's `matrixWorld` to put it in the frame the splats render in.
   * VLAM! builds no acceleration structure over it and never consults it.
   *
   * Tiles are fetched once and cached; concurrent callers share one load, and
   * a failed load can be retried by calling again. Resolves `[]` for a scene
   * without collision.
   *
   * @throws a `DOMException` named `AbortError` if cancelled, or if
   * {@link dispose} is called while the load is in flight.
   */
  async loadCollisionMeshes(
    options: { signal?: AbortSignal } = {},
  ): Promise<readonly CollisionMeshTile[]> {
    options.signal?.throwIfAborted();
    const collision = this.scene.collision;
    if (!collision || collision.meshes.length === 0) return [];

    if (!this.collisionTiles) {
      // Disposing the mesh cancels the load; a caller's own signal is honored
      // per call, so one caller giving up cannot cancel it for the others.
      const controller = new AbortController();
      this.collisionAbort = controller;
      this.collisionTiles = import('../formats/lcc')
        .then(({ loadCollisionMeshTiles }) =>
          loadCollisionMeshTiles(collision, {
            ...(this.requestOptions ? { request: this.requestOptions } : {}),
            signal: controller.signal,
          }),
        )
        .catch((error: unknown) => {
          this.collisionTiles = undefined; // let a retry try again
          throw error;
        });
    }

    const { signal } = options;
    if (!signal) return this.collisionTiles;
    // One caller giving up must not cancel the shared load, so its signal
    // races the load rather than aborting it.
    //
    // The listener is removed in `finally` rather than left to `{ once: true }`:
    // when the load wins the race the abort never fires, so `once` never
    // collects it. A host that passes one long-lived signal and calls this
    // repeatedly (a viewer re-loading collision per scene) would otherwise
    // accumulate listeners on that signal, each closing over this mesh.
    let abortListener: (() => void) | undefined;
    try {
      return await Promise.race([
        this.collisionTiles,
        new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(abortReason(signal));
          signal.addEventListener('abort', abortListener, { once: true });
        }),
      ]);
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener);
    }
  }

  /**
   * Whether this scene ships an always-resident environment/background tile -
   * true for an XGRIDS `.lcc2` capture that carries one (its `env.sog` sky),
   * false for Streamed SOG, `.lcc`, `.rad`, or an `.lcc2` without one.
   */
  get hasEnvironment(): boolean {
    return this.envFile !== undefined;
  }

  /** Whether the environment tile is currently set to render. */
  get environmentEnabled(): boolean {
    return this.envEnabled;
  }

  /**
   * Splats in the environment tile, measured when it decoded - the manifest
   * does not carry the count. 0 until the tile has loaded (or if the scene
   * ships none). These sit outside the LOD budget, drawing from the pool's
   * capacity headroom.
   */
  get environmentSplatCount(): number {
    return this.envSplatCount;
  }

  /**
   * Shows or hides the scene's environment/background tile. The switch is
   * instant and never refetches: once loaded, the tile stays in the pool and
   * only its active flag flips. Enabling before the tile has loaded triggers
   * its (one-time) load on the next update. No-op on a scene without one.
   */
  setEnvironmentEnabled(enabled: boolean): void {
    if (this.envFile === undefined || enabled === this.envEnabled) return;
    this.envEnabled = enabled;
    if (this.envHandle !== undefined) {
      this.setRangeActive(this.envHandle, enabled);
    } else if (enabled) {
      // Not loaded yet - kick a reschedule so updateEnvironment fetches it.
      this.pendingWork = true;
      this.lastScheduleTime = -Infinity;
    }
  }

  /** The active-splat budget this mesh keeps within. */
  get budget(): number {
    return this.budgetValue;
  }

  /**
   * The ceiling {@link setBudget} clamps to - {@link StreamedSplatMeshOptions.maxBudget}
   * when one was given, otherwise the construction budget.
   *
   * The pool was allocated for this number and cannot grow, so it is a hard
   * limit on what any governor can hand this mesh. Read it to check that a
   * shared-budget setup can actually deliver the share it is computing.
   */
  get maxBudget(): number {
    return this.maximumBudget;
  }

  /** Alias used by hosts that manage static and streamed auto-LOD uniformly. */
  get budgetCeiling(): number {
    return this.maximumBudget;
  }

  /**
   * The capture's real content size, when the format declares it (`.rad` reports
   * its leaf count) - the splat count needed to hold this mesh at full
   * resolution, independent of the budget it was constructed with.
   *
   * A host splitting one budget across several streamed meshes should clamp each
   * share to this: a mesh cannot spend more than it contains, so budget handed
   * past it buys nothing and is better given to a mesh that can use it. Note it
   * is *not* `maxBudget`: a foveated `.rad` reports `maxResidentSplats` as the
   * requested budget, because its pool holds a camera-directed resident set
   * rather than the whole tree.
   *
   * `undefined` when the format does not declare a content size.
   */
  get contentSplatCount(): number | undefined {
    return this.scene.contentSplatCount;
  }

  /**
   * Which `.rad` streaming strategy this mesh selected at load, or `null` when
   * the scene is not a Spark `.rad` capture.
   */
  get radStrategy(): 'prefix' | 'page-table' | null {
    if (this.scene.chunkOptions?.[0]?.format !== 'rad-chunk') return null;
    return this.frontierWorker ? 'page-table' : 'prefix';
  }

  /**
   * The drawn-splat target currently driving the `.rad` page-table frontier -
   * the governed budget, capped by
   * {@link SplatMeshOptions.foveationDrawBudget}. `0` on a mesh that is not in
   * `foveationMode: 'page-table'`, which has no frontier to target.
   *
   * This is the number that decides how deep the traversal descends, so it is
   * what to watch when checking that a near mesh really did receive more
   * detail: {@link budget} is the pool's allowance, this is what is spent.
   */
  get drawBudget(): number {
    return this.frontierWorker ? this.pageTableDrawBudget : 0;
  }

  /**
   * Page-table frontier coherence for hosts that gate preload/transitions.
   * `undefined` fields stay 0 when this mesh is not in page-table mode.
   */
  get frontierState(): Readonly<{
    frontierConverged: boolean;
    pendingFrontierSplats: number;
    staleResidentSplats: number;
    lastPlanAppends: number;
    lastPlanMoves: number;
    planGeneration: number;
    planBudget: number;
    lastPlanCamera: readonly [number, number, number] | null;
    firstFrontierCamera: readonly [number, number, number] | null;
  }> {
    return {
      frontierConverged: this.frontierWorker ? this.frontierConverged : true,
      pendingFrontierSplats: this.pendingFrontierSplats,
      staleResidentSplats: this.staleResidentSplats,
      lastPlanAppends: this.lastPlanAppends,
      lastPlanMoves: this.lastPlanMoves,
      planGeneration: this.lastPlanGeneration,
      planBudget: this.lastPlanBudget,
      lastPlanCamera: this.lastPlanCamera,
      firstFrontierCamera: this.firstFrontierCamera,
    };
  }

  /**
   * Spark's per-mesh `lodScale` (see {@link StreamedSplatMeshOptions.lodScale}).
   * Mutable: raise it to sharpen a focused mesh, lower it to coarsen a
   * background one. Page-table `.rad` only.
   *
   * @throws {RangeError} if set to a value that is not positive and finite.
   */
  get lodScale(): number {
    return this.lodScaleValue;
  }
  set lodScale(value: number) {
    const next = validateLodScale(value);
    if (next === this.lodScaleValue) return;
    this.lodScaleValue = next;
    this.pendingWork = true;
    this.lastScheduleTime = -Infinity;
  }

  /** In `page-table` mode the slab is fully active but mostly degenerate, so the
   * base `activeSplatCount` (slab size) is not the on-screen count - report the
   * frontier's drawn size instead. */
  override get activeSplatCount(): number {
    return this.frontierWorker ? this.pageTableDrawn : super.activeSplatCount;
  }

  /**
   * Updates the LOD budget used for future scheduling within allocated capacity.
   *
   * @returns the budget actually in effect, which is `budget` clamped to
   * {@link maxBudget}. A `BudgetGovernor` reads this return value to detect a
   * capped member and hand the remainder to the others, so the clamp is
   * reported rather than hidden.
   */
  setBudget(budget: number): number {
    const next = Math.min(resolveSplatBudget(budget), this.maximumBudget);
    if (next === this.budgetValue) return this.budgetValue;
    this.budgetValue = next;
    this.scene.source.budget = next;
    if (this.frontierWorker) {
      // Page-table mode draws the frontier, not the LOD schedule - keep its
      // draw target under the (possibly shared/governed) pool budget too.
      this.pageTableDrawBudget = Math.min(next, this.pageTableDrawTarget);
      // Storage follows the draw budget plus staging tail.
      this.syncSlabPages(this.pageTableStagingSlots);
      // A caller-pinned `foveationDrawBudget` outranks the budget, so a governor
      // that grows this mesh past it buys nothing and the mesh stays coarse for
      // a reason nothing on screen explains. Say so once.
      if (
        this.pageTableDrawTargetExplicit &&
        this.pageTableDrawTarget < next &&
        !this.warnedDrawTargetCap
      ) {
        this.warnedDrawTargetCap = true;
        warn(
          `StreamedSplatMesh: budget raised to ${next} but foveationDrawBudget caps the drawn ` +
            `frontier at ${this.pageTableDrawTarget}; the extra budget cannot buy detail. ` +
            `Raise or drop foveationDrawBudget to let the shared budget through.`,
        );
      }
    }
    this.pendingWork = true;
    this.lastScheduleTime = -Infinity;
    return next;
  }

  /**
   * What the LOD scheduler last decided, or `undefined` on sources that do not
   * schedule by leaf (the `.rad` page table, prefix readers).
   *
   * Distinct from {@link activeSplatCount}, and the distinction is the whole
   * point: `desired` is what the scheduler asked for, `activeSplatCount` is
   * what the pool ended up drawing. Equal means the cut is applied; `desired`
   * far below the budget means the *scheduler* declined to spend it, which is a
   * different bug from the mesh failing to apply what it was given.
   */
  get lodStats():
    Readonly<{ inFrustum: number; leaves: number; desired: number; filled: number }> | undefined {
    const source = this.scene.source as { stats?: LodScheduler['stats'] };
    return source.stats;
  }

  /** Number of chunk files currently decoded and held. In page-table mode the
   * worker owns the cache - the main-thread map is always empty there, so report
   * what has been forwarded to it instead of a permanent zero. */
  get residentChunkCount(): number {
    return this.frontierWorker ? this.pageTableCachedFiles.size : this.cache.size;
  }

  /** Chunk fetches currently in flight. */
  get pendingChunkCount(): number {
    return this.fetching.size;
  }

  /**
   * Main-thread cost of applying paging plans in `foveationMode: 'page-table'`.
   *
   * A plan is applied whole, off the render loop's own timing, so its cost does
   * not appear in {@link getUpdateTimings} - but it lands on the same thread and
   * a churning frontier can make it the largest stall in a frame. `worst*`
   * accumulate over the mesh's lifetime; the rest describe the most recent plan.
   */
  get planTimings(): Readonly<{
    applyMs: number;
    worstApplyMs: number;
    writeMs: number;
    residentMs: number;
    moves: number;
    appends: number;
    worstSplats: number;
  }> {
    return this.planTimingsValue;
  }

  /**
   * Lifetime chunk-fetch totals by kind, plus page-table cache state.
   *
   * Diagnostic for the question "why is this still streaming after the view
   * settled?", which the three fetch sources answer differently and which no
   * other reading distinguishes:
   *
   * - **`sweep` climbing** - speculative file-order pre-warming of the whole
   *   capture. Declined by the `smooth` profile; see `sweepAllowed`.
   * - **`priority` / `base` climbing while `evicted` climbs too** - the
   *   frontier's touched set does not fit the worker cache, so chunks are
   *   evicted and immediately refetched. Streaming never ends because it cannot.
   * - **`priority` / `base` climbing with `evicted` flat** - ordinary refinement
   *   still converging on the cut; it should stop on its own.
   *
   * `uncovered` and `retiredEarly` answer a different question - "why are there
   * holes?" - and between them cover both ways this class can render nothing
   * where it should render something:
   *
   * - **`uncovered` climbing after the scene settles** - `substituteCoverage`
   *   wanted a leaf's coarsest level as a stand-in and its chunk was not
   *   cached. Expected briefly during initial load; afterwards it should not
   *   move, because the coarsest files are pinned against eviction.
   * - **`retiredEarly` climbing** - coverage was retired before its replacement
   *   landed, under pool pressure or past the retirement hold bound. This is
   *   the swap path rather than the substitute path, and it is the one that
   *   scales with the budget.
   *
   * Both are counted in whole leaves/groups, monotonically: they answer "did
   * this happen, and is it still happening", not "how much is missing now".
   */
  get fetchCounts(): Readonly<{
    priority: number;
    base: number;
    sweep: number;
    evicted: number;
    uncovered: number;
    retiredEarly: number;
    cacheFull: boolean;
    cacheBytes: number;
    cacheLimitBytes: number;
  }> {
    return this.fetchCountsValue;
  }

  /** Chunk files given up on after repeated fetch/decode failures. */
  get failedChunkCount(): number {
    return this.failedFiles.size;
  }

  /**
   * Forgets all permanent chunk failures so their regions are fetched again.
   * Failures are otherwise terminal for the mesh's lifetime - call this when
   * the cause was transient (e.g. connectivity restored, `online` event).
   */
  retryFailedChunks(): void {
    if (this.failedFiles.size === 0) return;
    this.failedFiles.clear();
    this.retrying.clear();
    this.pendingWork = true;
  }

  /**
   * Whether the scene is still resolving toward its target detail - chunks
   * are fetching, or a retry/append is pending. Goes false once the view
   * has settled (useful to drive a loading indicator).
   */
  get isStreaming(): boolean {
    return this.pendingWork || this.fetching.size > 0 || this.retrying.size > 0;
  }

  /** The LOD distance model (mutable; e.g. raise to force the finest level). */
  get lodBaseDistance(): number {
    return this.scene.source.lodBaseDistance;
  }
  set lodBaseDistance(value: number) {
    this.scene.source.lodBaseDistance = value;
    this.pendingWork = true;
  }

  override update(
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGPURenderer,
    options: SplatUpdateOptions = {},
  ): void {
    const now = performance.now();
    camera.updateMatrixWorld();
    this.updateWorldMatrix(true, false);
    // The page-table cut limit is `targetPx / focalY`, and focalY needs the
    // drawing-buffer height - sample it here, before rescheduling, since the
    // base class only writes its view uniforms afterwards. In XR use the
    // per-eye height, not the stereo framebuffer (which is twice as wide and
    // would throw the cut off).
    //
    // LOD must follow the *head*, not the application camera. While an XR
    // session presents, three drives an internal array camera and the app
    // camera stops moving - scheduling from it would hold detail wherever that
    // camera was left and frustum-cull whatever the user turns to face, so a
    // scene stays blurry however far you walk into it. The head's union
    // projection is also the correct frustum here: it spans both eyes.
    // (`super.update` resolves the view again; that is idempotent and costs a
    // handful of matrix products.)
    const xrView = resolveXrView(camera, renderer);
    if (this.frontierWorker) {
      if (xrView) {
        this.pageTableViewportY = xrView.height;
      } else {
        renderer.getDrawingBufferSize(_drawSize);
        this.pageTableViewportY = _drawSize.y;
      }
    }
    const lodCamera = xrView?.head ?? camera;
    this.noteRenderer(renderer);
    const performanceEvent = this.shouldReschedule(lodCamera, now)
      ? this.reschedule(lodCamera, now)
      : null;
    super.update(camera, renderer, options);
    if (performanceEvent && this.onPerformanceEvent) {
      const timings = this.getUpdateTimings();
      performanceEvent.cpuMs += performance.now() - performanceEvent.timestamp;
      performanceEvent.activeListMs = timings.activeListMs;
      performanceEvent.uploadMs = timings.uploadMs;
      performanceEvent.sortSubmitMs = timings.sortSubmitMs;
      performanceEvent.stagingTextureAllocations = timings.stagingTextureAllocations;
      performanceEvent.activeListUpdateRanges = timings.activeListUpdateRanges;
      this.onPerformanceEvent(performanceEvent);
    }
  }

  /** Root bounds of the whole scene, valid before any chunk has loaded. */
  override computeSplatBounds(): THREE.Box3 {
    return this.scene.bounds.clone();
  }

  /**
   * Keep counting-sort quantization anchored to the complete capture bounds.
   * Streaming writes arrive in cache-dependent order, so an incrementally
   * accumulated bound can describe only the staged cut when the first sort
   * runs. Centers outside that temporary range then clamp into an end bucket
   * and look exactly like an unsorted patch.
   */
  protected override refreshSortBounds(): void {
    if (!this.boundsDirty) return;
    this.scene.bounds.getBoundingSphere(this.boundingSphereLocal);
    this.boundsDirty = false;
  }

  /**
   * Enables or disables writing each resident run's **resolved** LOD level into
   * the `lodLevel` float channel (for a false-color debug modifier: 0 = finest).
   * Values come from applied desired runs after budget resolution - not from
   * distance ambition alone. Call before assigning a modifier that reads the channel.
   */
  setLodLevelDebug(enabled: boolean): void {
    if (enabled) {
      if (!this.lodLevelChannelReady) {
        this.defineChannel('lodLevel', { type: 'float', fill: -1 });
        this.lodLevelChannelReady = true;
      }
      this.lodLevelDebug = true;
      for (const { run, handle } of this.resident.values()) {
        this.writeLodLevelChannel(handle, run.level);
      }
      for (const { run, handle, uploadedCount } of this.staged.values()) {
        if (uploadedCount === run.count) this.writeLodLevelChannel(handle, run.level);
      }
      return;
    }
    this.lodLevelDebug = false;
  }

  /** Whether {@link setLodLevelDebug} is currently writing levels. */
  get isLodLevelDebug(): boolean {
    return this.lodLevelDebug;
  }

  /**
   * Startup-hold progress for {@link StreamedSplatMeshOptions.initialReveal}.
   * Hosts using `'hold-near-l0'` or `'hold-coverage'` should keep the mesh
   * invisible while `status === 'pending'`, then reveal on `'ready'` or
   * `'degraded'`.
   */
  get initialRevealState(): InitialRevealState {
    return this.initialRevealStateValue;
  }

  /**
   * Captures a fresh startup-hold set on the next {@link update}. Hosts that
   * apply their final initial camera pose after the mesh first receives frames
   * should call this before lifting their loading cover. It is a no-op when
   * the hold was never armed (progressive startup, or a format without the
   * matching LodSource hook).
   */
  recaptureInitialReveal(): void {
    if (this.initialRevealHold === 'off') return;
    this.frozenCriticalRuns = null;
    this.initialRevealStartedAt = undefined;
    this.initialRevealPhase = 'capture';
    this.initialRevealStateValue = {
      status: 'pending',
      stagedSplats: 0,
      totalSplats: 0,
      readyGroups: 0,
      totalGroups: 0,
    };
    this.pendingWork = true;
  }

  private writeLodLevelChannel(handle: SplatRange, level: number): void {
    if (!this.lodLevelDebug || handle.count === 0) return;
    if (!this.lodLevelScratch || this.lodLevelScratch.length < handle.count) {
      this.lodLevelScratch = new Float32Array(handle.count);
    }
    this.lodLevelScratch.fill(level, 0, handle.count);
    this.writeChannel(handle, 'lodLevel', this.lodLevelScratch.subarray(0, handle.count));
  }

  /**
   * Declares a per-splat channel whose values **persist across LOD churn**:
   * edits are stored sparsely keyed by `(chunk file, local index)` - a stable
   * splat identity in the streaming design - and re-applied whenever a chunk
   * is (re)appended. Paint a region with {@link paintPersistent}, orbit away
   * until it is evicted, come back, and the values return. See M7.6.
   *
   * Wraps {@link SplatMesh.defineChannel}; read it from a modifier with
   * `ctx.channel(name)` as usual.
   */
  definePersistentChannel(name: string, options: PersistentChannelOptions = {}): void {
    this.defineChannel(name, options);
    this.persistentChannels.set(name, {
      type: options.type ?? 'float',
      fill: options.fill ?? 0,
      maxEdits: Math.max(1, Math.floor(options.maxEdits ?? 1_000_000)),
      edits: new Map(),
      total: 0,
      warned: false,
    });
  }

  /**
   * Sets a persistent channel to `value` for every currently-resident splat
   * within `radius` (world units) of `worldPoint`, and records the edit so it
   * survives eviction/reload. Splats whose chunk is not currently decoded on
   * the CPU cannot be located and are skipped (they are usually far from the
   * camera); their painted neighbours in resident chunks are unaffected.
   *
   * The radius assumes this mesh's world transform is rigid (rotation +
   * translation, as the built-in format transforms are); a scaled mesh would
   * distort the brush. Edit a persistent channel only through this method -
   * direct {@link SplatMesh.writeChannel} writes are not recorded and are
   * overwritten by the next re-apply.
   *
   * @returns the number of splats edited this call.
   * @throws {Error} if the channel was not declared with
   *   {@link definePersistentChannel}.
   */
  paintPersistent(name: string, worldPoint: THREE.Vector3, radius: number, value: number): number {
    const channel = this.persistentChannels.get(name);
    if (!channel) {
      throw new Error(
        `StreamedSplatMesh.paintPersistent: channel "${name}" is not a persistent channel. ` +
          `Call definePersistentChannel("${name}") first.`,
      );
    }
    _paintLocal.copy(worldPoint);
    this.worldToLocal(_paintLocal);
    const r2 = radius * radius;
    let edited = 0;
    const touchedFiles = new Set<number>();

    for (const { run } of this.resident.values()) {
      const chunk = this.cache.get(run.file);
      if (!chunk) continue; // positions evicted from the CPU cache
      const positions = chunk.data.positions;
      const fileEdits = channel.edits.get(run.file) ?? new Map<number, number>();
      let touched = false;
      for (let k = 0; k < run.count; k++) {
        const li = run.offset + k;
        const px = (positions[li * 3 + 0] as number) - _paintLocal.x;
        const py = (positions[li * 3 + 1] as number) - _paintLocal.y;
        const pz = (positions[li * 3 + 2] as number) - _paintLocal.z;
        if (px * px + py * py + pz * pz > r2) continue;
        // First paint wins - keep the stored color/index for already-edited splats.
        if (fileEdits.has(li)) continue;
        if (channel.total >= channel.maxEdits) {
          if (!channel.warned) {
            channel.warned = true;
            warn(
              `StreamedSplatMesh.paintPersistent: channel "${name}" hit its ` +
                `maxEdits cap (${channel.maxEdits}); further new edits are dropped.`,
            );
          }
          continue;
        }
        channel.total++;
        fileEdits.set(li, value);
        touched = true;
        edited++;
      }
      if (touched) {
        channel.edits.set(run.file, fileEdits);
        touchedFiles.add(run.file);
      }
    }

    // Re-derive and upload each touched resident run from the store, so the
    // paint shows immediately (not only after the next reload).
    if (touchedFiles.size > 0) {
      for (const { run, handle } of this.resident.values()) {
        if (touchedFiles.has(run.file)) this.applyPersistentRun(name, channel, run, handle);
      }
    }
    return edited;
  }

  /**
   * Clears every stored edit for a persistent channel and zeroes the value on
   * all currently-resident splats. Chunks that are not resident are covered by
   * the emptied store - they reload at the channel's fill value.
   *
   * @throws {Error} if the channel is not a persistent channel.
   */
  clearPersistentChannel(name: string): void {
    const channel = this.persistentChannels.get(name);
    if (!channel) {
      throw new Error(
        `StreamedSplatMesh.clearPersistentChannel: channel "${name}" is not a persistent channel.`,
      );
    }
    channel.edits.clear();
    channel.total = 0;
    for (const { run, handle } of this.resident.values()) {
      const data =
        channel.type === 'byte' ? new Uint8Array(run.count) : new Float32Array(run.count);
      this.writeChannel(handle, name, data);
    }
  }

  override dispose(): void {
    if (this.disposed) return;
    this.loader.dispose();
    // Terminating drops any in-flight traversal; clearing the handler also
    // frees the closure over this mesh for a message already dispatched.
    if (this.frontierWorker) {
      this.frontierWorker.onmessage = null;
      this.frontierWorker.terminate();
    }
    this.pageTableDisposed = true;
    this.collisionAbort?.abort();
    // A rejected cached promise is nobody's to handle once the mesh is gone.
    this.collisionTiles?.catch(() => {});
    this.collisionTiles = undefined;
    // Abort before unregistering: each abort settles through `requestChunk`'s
    // `finally`, which releases the slot back to the mesh's siblings.
    for (const { controller } of this.fetching.values()) controller.abort();
    this.fetching.clear();
    if (this.fetchHandle) this.fetchScheduler?.unregister(this.fetchHandle);
    // Hands this mesh's cache allowance back to its siblings. Cleared so a
    // reallocation triggered by the unregister itself cannot call back into a
    // disposed mesh and post to a terminated worker.
    if (this.cacheBudgetHandle) {
      const handle = this.cacheBudgetHandle;
      this.cacheBudgetHandle = undefined;
      this.cacheBudget?.unregister(handle);
    }
    // Revokes the object URLs a dropped local folder created, and releases the
    // `File` blobs they pin. No-op for a network-loaded mesh.
    this.localSource?.dispose();
    this.localSource = undefined;
    this.cache.clear();
    this.cacheBytesTotal = 0;
    this.retrying.clear();
    this.failedFiles.clear();
    this.neededFiles.clear();
    this.persistentChannels.clear();
    this.resident.clear();
    this.staged.clear();
    this.pageTableCachedFiles.clear();
    this.envHandle = undefined;
    this.envSplatCount = 0;
    super.dispose();
  }

  private shouldReschedule(camera: THREE.Camera, now: number): boolean {
    if (this.pendingWork) return true;
    if (now - this.lastScheduleTime > IDLE_RESCHEDULE_MS) return true;

    camera.getWorldPosition(_cameraWorldPos);
    const radius = this.scene.bounds.getBoundingSphere(_sphere).radius || 1;
    if (_cameraWorldPos.distanceTo(this.lastCameraPos) > radius * 0.0025) return true;

    camera.getWorldQuaternion(_cameraWorldQuat);
    return _cameraWorldQuat.angleTo(this.lastCameraQuat) > 0.0087; // ~0.5°
  }

  private reschedule(camera: THREE.Camera, now: number): StreamedSplatPerformanceEvent | null {
    const startedAt = performance.now();
    // The before-snapshots exist only to diff for the performance event; with
    // no listener installed this per-reschedule allocation work is skipped.
    let before: {
      resident: Map<string, number>;
      staged: Map<string, number>;
    } | null = null;
    if (this.onPerformanceEvent !== undefined) {
      before = { resident: new Map(), staged: new Map() };
      for (const [key, entry] of this.resident) before.resident.set(key, entry.run.count);
      for (const [key, entry] of this.staged) before.staged.set(key, entry.uploadedCount);
    }
    const compactionCountBefore = this.compactionCount;
    this.pendingWork = false;
    this.lastScheduleTime = now;
    camera.getWorldPosition(this.lastCameraPos);
    camera.getWorldQuaternion(this.lastCameraQuat);

    // Camera position and frustum in this mesh's local space.
    _cameraLocal.copy(this.lastCameraPos);
    this.worldToLocal(_cameraLocal);
    _projScreen
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(this.matrixWorld);
    _frustum.setFromProjectionMatrix(_projScreen);

    if (this.frontierWorker) {
      // Camera forward as a mesh-local direction: transform a point one unit
      // ahead and subtract the local eye, so any affine mesh transform is
      // handled without a separate normal matrix.
      camera.getWorldDirection(_cameraForward).add(this.lastCameraPos);
      this.worldToLocal(_cameraForward);
      _cameraForward.sub(_cameraLocal).normalize();
      // Cut limit, exactly as the material derives it: a node is fine enough
      // when `size / distance ≤ targetPx / focalY`.
      const focalY = (camera.projectionMatrix.elements[5] * this.pageTableViewportY) / 2;
      if (focalY > 0) this.pageTableLimit = this.pageTableTargetPx / focalY;
      this.reschedulePageTable(_cameraLocal, _cameraForward, _frustum, now);
      // The page-table path still reports its per-update CPU cost. Returning
      // null here made `onPerformanceEvent` silent on the one path a `.rad`
      // actually takes, so a host watching `cpuMs` / `uploadMs` / `sortSubmitMs`
      // saw nothing at all - and could not tell an upload stall from a sort
      // stall on the only format where the question comes up.
      //
      // The chunk-swap fields stay zero: this path pages slots through the
      // frontier plan rather than swapping LOD runs, so `swapped`/`appended`
      // and the resident/staged diffs have no meaning here. `applyFrontierPlan`
      // is timed separately, by `planTimings`.
      if (this.onPerformanceEvent === undefined) return null;
      // Same convention as the classic path below: `timestamp` marks the end of
      // the reschedule and `cpuMs` covers it, so the caller's
      // `cpuMs += now - timestamp` adds `super.update` rather than double-counting.
      const pageTableTimestamp = performance.now();
      return {
        timestamp: pageTableTimestamp,
        cpuMs: pageTableTimestamp - startedAt,
        activeListMs: 0,
        uploadMs: 0,
        sortSubmitMs: 0,
        stagingTextureAllocations: 0,
        activeListUpdateRanges: 0,
        appendedCount: 0,
        removedCount: 0,
        stagedCount: 0,
        uploadCount: 0,
        activeCount: this.pageTableDrawn,
        forcedSort: false,
        compacted: false,
      };
    }

    // Fetch ranking needs a more precise signal than LCC's broad-box frustum
    // bit. It must not influence the source's distance/budget LOD decision.
    camera.getWorldDirection(_cameraForward).add(this.lastCameraPos);
    this.worldToLocal(_cameraForward);
    _cameraForward.sub(_cameraLocal).normalize();
    const scheduledRuns = this.scene.source.computeDesiredRuns(
      _cameraLocal,
      _frustum,
      now,
      _cameraForward,
    );
    const holdingRuns = this.captureOrContinueInitialReveal(
      scheduledRuns,
      now,
      _cameraLocal,
      _frustum,
      _cameraForward,
    );
    const holding = holdingRuns !== null;
    // During the startup hold, ignore later camera cuts: only the frozen
    // coverage set is desired. After release, the normal swap transaction
    // keeps that coverage active while the live cut stages, then replaces it
    // atomically rather than drawing coarse and fine runs together.
    const liveRuns = holdingRuns ?? scheduledRuns;
    const classicSource =
      !holding && liveRuns.length > 0 && liveRuns.every((run) => run.coverageGroup !== undefined);
    const swapRuns = !classicSource && !holding ? this.captureWaveRuns(liveRuns) : liveRuns;
    const desired = new Map<string, LodRun>();
    const desiredFiles = new Set<number>();
    for (const run of liveRuns) {
      desiredFiles.add(run.file);
    }
    for (const run of swapRuns) {
      desired.set(runKey(run), run);
      desiredFiles.add(run.file);
    }
    for (const [key, entry] of this.staged) {
      if (desired.has(key)) continue;
      // During hold, keep staging progress for frozen runs even if a bug drops
      // them from desired - the freeze list is authoritative.
      if (holding && this.frozenCriticalRuns?.some((run) => runKey(run) === key)) continue;
      this.removeRange(entry.handle);
      this.staged.delete(key);
    }

    // Cancel fetches whose file no longer backs any desired run. Pinned
    // (coarsest-level) files are never cancelled: they are the substitute
    // coverage every deferred swap relies on, and the environment tile is
    // pinned for the same reason. During hold, only critical coverage files
    // (and pins) stay - neighbours and far coarse lose their slots.
    for (const [file, { controller }] of this.fetching) {
      if (!desiredFiles.has(file) && !this.scene.pinnedFiles.has(file)) controller.abort();
    }
    // Drop retry state for files no longer wanted, for the same reason -
    // otherwise a chunk that failed once before the camera moved away keeps
    // `isStreaming` (and the demo's spinner) stuck true forever.
    for (const file of this.retrying.keys()) {
      if (!desiredFiles.has(file) && !this.scene.pinnedFiles.has(file)) this.retrying.delete(file);
    }
    // Chunks fetched for a still-deferred group have a stale `lastUsed`;
    // remember every desired-but-not-yet-resident file so eviction cannot
    // discard them before their swap group applies (fetch → evict → refetch
    // livelock under CPU-cache pressure). Fully staged runs may leave the CPU
    // cache: their GPU inactive range already holds the bytes.
    this.neededFiles.clear();
    for (const run of liveRuns) {
      const key = runKey(run);
      if (this.resident.has(key)) continue;
      const staged = this.staged.get(key);
      if (staged && staged.uploadedCount === run.count) continue;
      this.neededFiles.add(run.file);
    }
    for (const run of swapRuns) {
      const key = runKey(run);
      if (this.resident.has(key)) continue;
      const staged = this.staged.get(key);
      if (staged && staged.uploadedCount === run.count) continue;
      this.neededFiles.add(run.file);
    }
    if (
      this.envFile !== undefined &&
      this.envEnabled &&
      this.envHandle === undefined &&
      !this.envUnfit &&
      !this.failedFiles.has(this.envFile)
    ) {
      this.neededFiles.add(this.envFile);
    }

    const toAdd = swapRuns.filter((run) => !this.resident.has(runKey(run)));
    // During hold, never retire unrelated resident coverage - the viewer is
    // hidden and we only build the critical set.
    const toRemove = holding
      ? []
      : [...this.resident.entries()].filter(([key]) => !desired.has(key));

    // A region must never render twice (bright flash) or not at all (black
    // hole), so adds and their superseded removals apply together, within
    // one tick - one frame sees only complete before/after states. Groups
    // are connected components of (toAdd ∪ toRemove) by leaf-interval
    // overlap; a group that cannot fully apply this tick (chunk still
    // fetching, append cap, pool pressure) is deferred whole, its old runs
    // still rendering.
    const groups = holding
      ? // Mesh is invisible during the hold, so L0 cell-atomicity (no holes) is
        // irrelevant - commit each frozen slice as it lands so a partial home
        // cell cannot block reveal behind sibling subchunks still fetching.
        buildHoldSwapGroups(toAdd)
      : buildSwapGroups(toAdd, toRemove);
    const classicLccGroups = !holding && isClassicLccSwapSet(groups);
    // The generic RAD wave must land all replacement coverage before any
    // retirements. Classic LCC already has per-slice coverage transactions;
    // applying that global wave to it starves a ready visible L1+ slice behind
    // every coarse shell elsewhere in the scene.
    groups.sort((a, b) =>
      classicLccGroups ? compareClassicSwapGroups(a, b) : groupPriority(a) - groupPriority(b),
    );

    // Classic path used to `requestChunk` in leafStart / group order, so far
    // coarse pins filled the in-flight cap while the camera cell stayed on
    // discs. Collect every miss this tick and flush nearest/finest first -
    // same contract as the page-table `pageTableFetchPriority` path.
    const pendingFetches = new Map<number, ClassicFetchWant>();
    // Environment first: append it before coverage consumes pool rows, and
    // enqueue its fetch ahead of LOD wants so the sky is not last in the pipe.
    this.updateEnvironment(now, pendingFetches);

    // A `.rad` refinement splits across groups: leaf-interval overlap pairs an
    // octree parent with its children, but `.rad` keys runs by global splat
    // index and a node's children live in a later chunk, so they never share a
    // group. Prefetch fetch-intent runs for still-undecoded chunks are also
    // purely additive. The old wave gate treated *any* pending add as a reason
    // to hold every retirement, then committed ready children immediately - so
    // parents stayed drawn while children appeared, and prefetch kept that
    // mixed cut up for the whole stream.
    //
    // Spark publishes a refined cut only once every splat in it is drawable.
    // Do the same on this path: stage every cached replacement hidden, ignore
    // still-fetching prefetch, and activate adds together with their
    // retirements. Classic LCC keeps per-slice apply below - it already has
    // independent coverage for every cell.
    if (!classicLccGroups && !holding) {
      // Fetch-intent runs are excluded from the drawable cut so they cannot
      // delay it, but they still have to enter the pipe or discovery never
      // deepens past the first decoded prefix.
      for (const run of liveRuns) {
        if (this.cache.has(run.file) || this.failedFiles.has(run.file)) continue;
        enqueueClassicFetch(
          pendingFetches,
          run.file,
          classicFetchPhaseForDesired(run, this.scene.source.lodBaseDistance),
          run,
        );
        this.pendingWork = true;
      }
      this.applyRadWave(groups, liveRuns, now, pendingFetches);
    } else {
      let appended = 0;
      let addsPending = false;
      let poolPressure = false;
      let held = false;
      for (const group of groups) {
        if (!classicLccGroups && group.removes.length > 0 && addsPending) {
          // Bounded so the wait can never strand coverage: the replacements
          // normally land within a few ticks, and past that the pool matters more
          // than the seam.
          if (
            this.neverRetireCoverageEarly ||
            (!poolPressure && this.retireHeldTicks < MAX_RETIRE_HELD_TICKS)
          ) {
            this.pendingWork = true;
            held = true;
            continue;
          }
          // Falling through here retires coverage whose replacement has *not*
          // landed - the one deliberate hole in this path. Two causes, one
          // consequence: the pool needs the rows more than the seam needs hiding
          // (`poolPressure`), or the hold has run past MAX_RETIRE_HELD_TICKS. A
          // higher budget makes the first likelier - more and larger groups in
          // flight against a pool sized from the same budget - so this is the
          // first thing to read when holes appear only at a raised budget.
          this.fetchCountsValue.retiredEarly++;
        }
        if (group.adds.length === 0) {
          this.applyGroup(group, now); // dropped regions: just free them
          continue;
        }
        const missing = group.adds.filter((run) => !this.cache.has(run.file));
        // Resolved L0: skip coarse stand-in for empty gaps (keep prior coverage
        // on each sub-leaf until that slice's L0 commits). L1+: allow per-slice
        // coarsest substitute while that slice's target loads.
        // Startup hold never paints coarse for the critical set.
        const holdForTarget =
          holding || (isWaitingOnFinest(group) && this.initialRevealHold !== 'hold-coverage');
        if (missing.length > 0) {
          // Only keep re-scheduling if some missing chunk is still
          // recoverable (fetching or awaiting a retry); a group whose chunks
          // have all permanently failed settles on its coarse substitute.
          let recoverable = false;
          for (const run of missing) {
            if (this.failedFiles.has(run.file)) continue;
            enqueueClassicFetch(
              pendingFetches,
              run.file,
              classicFetchPhaseForDesired(run, this.scene.source.lodBaseDistance),
              run,
            );
            recoverable = true;
          }
          // Far / L1+ gaps: install coarsest shell. L0 hold: do not fetch or
          // paint that shell - only the resolved L0 target is requested.
          // Startup hold: still stage any siblings already in cache (below).
          if (!holding) {
            this.substituteCoverage(group, now, pendingFetches, holdForTarget);
          }
          if (recoverable) {
            this.pendingWork = true;
            addsPending = true;
          }
          // During startup, continue into staging so available chunks upload
          // before every sibling is cached.
          if (!holding) continue;
        }
        if (holding && this.environmentPendingForReveal()) {
          // Keep pool headroom for the env tile; coverage stays cached until it
          // lands. Fetches for the frozen set are already queued above.
          this.pendingWork = true;
          addsPending = true;
          continue;
        }
        const forceStage = holding || (this.stagedSwapsEnabled && group.addCount > this.appendCap);
        if (forceStage && this.canStageGroup(group)) {
          const stagedNow = this.stageGroup(group, now, Math.max(0, this.appendCap - appended));
          appended += stagedNow;
          if (
            !group.adds.every((run) => this.staged.get(runKey(run))?.uploadedCount === run.count)
          ) {
            this.pendingWork = true;
            addsPending = true;
            continue;
          }
          // Keep the old region for one additional frame when this tick wrote
          // the final hidden segment. The following tick performs only the
          // atomic active-list switch and forced sort, rather than combining
          // those costs with the last texture upload.
          if (stagedNow > 0 && !holding) {
            this.deferNextSortRequest();
            this.pendingWork = true;
            addsPending = true;
            continue;
          }
          this.commitStagedGroup(group);
          continue;
        }
        // The cap bounds per-tick upload work, but a group is indivisible
        // (splitting it would break region atomicity), so a single group larger
        // than the cap is deliberately let through when it comes first - the
        // one-frame hitch beats never applying it at all.
        if (!holding && appended > 0 && appended + group.addCount > this.appendCap) {
          this.pendingWork = true;
          addsPending = true;
          continue;
        }
        // Startup hold always stages (above); if staging could not start, keep
        // pending rather than applying visible coverage while the viewer is gated.
        if (holding) {
          this.pendingWork = true;
          addsPending = true;
          continue;
        }
        if (!this.applyGroup(group, now)) {
          this.pendingWork = true; // transient pool pressure; retry next tick
          // Rows are the scarce resource now, so stop holding retirements back.
          poolPressure = true;
          continue;
        }
        appended += group.addCount;
      }
      // Counts only ticks that actually held something back, so reaching the bound
      // releases the retirement and starts the count over rather than latching the
      // gate off for the rest of the session.
      this.retireHeldTicks = held ? this.retireHeldTicks + 1 : 0;
    }

    this.flushClassicFetches(pendingFetches, this.scene.source.lodBaseDistance, holding);

    if (holding) {
      this.finishInitialRevealIfComplete();
      // Recheck failure after this tick's fetch outcomes land next frame; keep
      // streaming until release.
      if (this.initialRevealPhase === 'holding') this.pendingWork = true;
    }
    // Publish the CPU cache state before evicting, so `cacheBytes` reports the
    // peak the tick actually reached rather than the post-eviction figure - the
    // latter always sits at or under the limit and so can never show pressure.
    // These three were previously written only by the page-table plan, leaving
    // the streamed path reporting a permanent 0/0 that looked like "no cache in
    // use" when it meant "not measured" - the same blind spot `evicted` had.
    this.fetchCountsValue.cacheBytes = this.cacheBytesTotal;
    this.fetchCountsValue.cacheLimitBytes = this.cpuCacheBytes;
    if (this.cacheBytesTotal > this.cpuCacheBytes) this.fetchCountsValue.cacheFull = true;
    this.evictChunks(now);
    if (before === null) return null;
    return this.createPerformanceEvent(
      before.resident,
      before.staged,
      compactionCountBefore,
      startedAt,
    );
  }

  private rowAlignedSplats(count: number): number {
    return Math.ceil(count / DATA_TEXTURE_WIDTH) * DATA_TEXTURE_WIDTH;
  }

  /**
   * Startup hold seeds: the coverage group containing (or nearest to) the
   * camera within {@link LodSource.lodBaseDistance}. HiRes tiles often fail the
   * frustum test when most of the cell sits behind the camera - do **not**
   * require `inView`, or the hold seeds a screen-facing neighbour instead.
   * Coarser home levels come from {@link LodSource.runsAtLevelFor}.
   */
  private selectHomeSeedRuns(desiredRuns: readonly LodRun[]): LodRun[] {
    const base = this.scene.source.lodBaseDistance;
    const nearestCandidates = desiredRuns
      .filter(
        (run) =>
          run.coverageGroup !== undefined && (run.distance ?? Number.POSITIVE_INFINITY) <= base,
      )
      .sort(
        (a, b) =>
          (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY) ||
          // Same distance: prefer in-view, then finer.
          (a.inView === true ? 0 : 1) - (b.inView === true ? 0 : 1) ||
          a.level - b.level ||
          a.leafStart - b.leafStart,
      );
    const homeGroup = nearestCandidates[0]?.coverageGroup;
    if (homeGroup === undefined) return [];
    return nearestCandidates.filter((run) => run.coverageGroup === homeGroup);
  }

  private coarsenHomeRuns(seeds: readonly LodRun[], nearLevel: number): LodRun[] {
    const out: LodRun[] = [];
    const source = this.scene.source;
    for (const seed of seeds) {
      if (seed.level === nearLevel) {
        out.push(seed);
        continue;
      }
      const alt = source.runsAtLevelFor?.(seed.leafStart, seed.leafEnd, nearLevel) ?? [];
      if (alt.length === 0) continue;
      for (const run of alt) {
        out.push({
          ...run,
          distance: seed.distance,
          inView: seed.inView,
          ...(seed.coverageGroup === undefined ? {} : { coverageGroup: seed.coverageGroup }),
          ...(seed.screenImportance === undefined
            ? {}
            : { screenImportance: seed.screenImportance }),
        });
      }
    }
    return out;
  }

  private criticalRunsFitCapacity(runs: readonly LodRun[]): boolean {
    let neededRows = 0;
    for (const run of runs) neededRows += this.rowAlignedSplats(run.count);
    return neededRows <= this.freeSplatCapacity;
  }

  private publishInitialRevealProgress(runs: readonly LodRun[]): void {
    const groups = new Map<string, LodRun[]>();
    for (const run of runs) {
      const g = run.coverageGroup !== undefined ? `g:${run.coverageGroup}` : runKey(run);
      let list = groups.get(g);
      if (!list) {
        list = [];
        groups.set(g, list);
      }
      list.push(run);
    }
    let stagedSplats = 0;
    let totalSplats = 0;
    let readyGroups = 0;
    for (const groupRuns of groups.values()) {
      let groupReady = true;
      for (const run of groupRuns) {
        totalSplats += run.count;
        const key = runKey(run);
        if (this.resident.has(key)) {
          stagedSplats += run.count;
          continue;
        }
        const staged = this.staged.get(key);
        stagedSplats += staged?.uploadedCount ?? 0;
        if (!staged || staged.uploadedCount !== run.count) groupReady = false;
      }
      if (groupReady) readyGroups++;
    }
    const prev = this.initialRevealStateValue;
    if (prev.status === 'degraded') {
      this.initialRevealStateValue = {
        status: 'degraded',
        reason: prev.reason,
        stagedSplats,
        totalSplats,
        readyGroups,
        totalGroups: groups.size,
      };
      return;
    }
    this.initialRevealStateValue = {
      status: 'pending',
      stagedSplats,
      totalSplats,
      readyGroups,
      totalGroups: groups.size,
    };
  }

  private releaseInitialReveal(
    status: 'ready' | 'degraded',
    reason?: 'capacity' | 'fetch-failed' | 'timeout',
  ): void {
    const runs = this.frozenCriticalRuns ?? [];
    this.publishInitialRevealProgress(runs);
    const progress = this.initialRevealStateValue;
    const stagedSplats =
      progress.status === 'pending' || progress.status === 'degraded' ? progress.stagedSplats : 0;
    const totalSplats =
      progress.status === 'pending' || progress.status === 'degraded' ? progress.totalSplats : 0;
    const readyGroups =
      progress.status === 'pending' || progress.status === 'degraded' ? progress.readyGroups : 0;
    const totalGroups =
      progress.status === 'pending' || progress.status === 'degraded' ? progress.totalGroups : 0;
    if (status === 'ready') {
      this.initialRevealStateValue = { status: 'ready' };
    } else {
      this.initialRevealStateValue = {
        status: 'degraded',
        reason: reason ?? 'fetch-failed',
        stagedSplats,
        totalSplats,
        readyGroups,
        totalGroups,
      };
    }
    this.frozenCriticalRuns = null;
    this.initialRevealPhase = 'released';
    this.pendingWork = true;
  }

  /**
   * Coverage hold: freeze covering runs for in-view cells (classic `.lcc`
   * physical cells at L1 near / coarsest far, `.lcc2` octree root-children).
   * Missing `coverageRunsFor` (or an empty result after fallback) releases
   * immediately so the mesh does not stay hidden with nothing to fetch.
   * If the mixed set overflows the pool, coarsen only the near (non-coarsest)
   * groups one more rung before degrading to progressive.
   */
  private captureCoverageHold(
    cameraLocal: THREE.Vector3,
    frustum: THREE.Frustum,
    now: number,
    cameraForward: THREE.Vector3,
  ): void {
    let coverage = this.scene.source.coverageRunsFor?.(cameraLocal, frustum, cameraForward) ?? [];
    if (coverage.length === 0) {
      if (this.environmentPendingForReveal()) {
        this.frozenCriticalRuns = [];
        this.initialRevealStartedAt = now;
        this.initialRevealPhase = 'holding';
        this.publishInitialRevealProgress([]);
        return;
      }
      this.initialRevealStateValue = { status: 'ready' };
      this.initialRevealPhase = 'released';
      return;
    }
    if (!this.criticalRunsFitCapacity(coverage)) {
      const coarsened = this.coarsenCoverageNearRuns(coverage);
      if (this.criticalRunsFitCapacity(coarsened)) {
        coverage = coarsened;
      } else {
        this.frozenCriticalRuns = coverage;
        this.releaseInitialReveal('degraded', 'capacity');
        return;
      }
    }
    this.frozenCriticalRuns = coverage;
    this.initialRevealStartedAt = now;
    this.initialRevealPhase = 'holding';
    this.publishInitialRevealProgress(coverage);
  }

  /**
   * Bump each coverage run one coarser rung when the source has one. Already-
   * coarsest (far) runs stay put so a tight pool only drops near L1 → L2.
   */
  private coarsenCoverageNearRuns(runs: readonly LodRun[]): LodRun[] {
    const out: LodRun[] = [];
    const source = this.scene.source;
    for (const run of runs) {
      const alt = source.runsAtLevelFor?.(run.leafStart, run.leafEnd, run.level + 1) ?? [];
      if (alt.length === 0 || alt.every((next) => next.level <= run.level)) {
        out.push(run);
        continue;
      }
      for (const next of alt) {
        out.push({
          ...next,
          distance: run.distance,
          inView: run.inView,
          ...(run.coverageGroup === undefined ? {} : { coverageGroup: run.coverageGroup }),
          ...(run.screenImportance === undefined ? {} : { screenImportance: run.screenImportance }),
        });
      }
    }
    return out;
  }

  private captureOrContinueInitialReveal(
    scheduledRuns: LodRun[],
    now: number,
    cameraLocal: THREE.Vector3,
    frustum: THREE.Frustum,
    cameraForward: THREE.Vector3,
  ): LodRun[] | null {
    if (this.initialRevealPhase === 'off' || this.initialRevealPhase === 'released') return null;

    if (this.initialRevealPhase === 'capture') {
      if (this.initialRevealHold === 'hold-coverage') {
        this.captureCoverageHold(cameraLocal, frustum, now, cameraForward);
      } else {
        // Prefer a full nearby L0 hold of the camera cell only. Tight pools
        // coarsen via the leaf ladder (L1, then L2) before degrading. Neighbours
        // are left for progressive streaming - they often beat home on
        // screenImportance. `desiredRuns` only has the *resolved* rung, so coarser
        // home cuts come from `runsAtLevelFor`.
        const seeds = this.selectHomeSeedRuns(scheduledRuns);
        let critical: LodRun[] = [];
        if (seeds.length === 0) {
          // Cold camera: nothing inside lodBaseDistance. Hold the nearest
          // coverage group in the near band (distance first, not screenImportance).
          const horizon =
            this.scene.source.lodBaseDistance *
            this.scene.source.lodMultiplier *
            this.scene.source.lodMultiplier;
          const fallback = scheduledRuns.filter(
            (run) =>
              run.level <= 2 &&
              run.coverageGroup !== undefined &&
              (run.distance ?? Number.POSITIVE_INFINITY) <= horizon,
          );
          const nearest = [...fallback].sort(
            (a, b) =>
              (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY) ||
              (a.inView === true ? 0 : 1) - (b.inView === true ? 0 : 1) ||
              (a.screenImportance ?? Number.POSITIVE_INFINITY) -
                (b.screenImportance ?? Number.POSITIVE_INFINITY) ||
              a.leafStart - b.leafStart,
          )[0];
          if (!nearest) {
            this.initialRevealStateValue = { status: 'ready' };
            this.initialRevealPhase = 'released';
            return null;
          }
          critical =
            nearest.coverageGroup !== undefined
              ? fallback.filter((run) => run.coverageGroup === nearest.coverageGroup)
              : [nearest];
          if (!this.criticalRunsFitCapacity(critical)) {
            // Prefer a single fitting run over degrading the whole hold.
            critical =
              nearest.coverageGroup !== undefined
                ? fallback
                    .filter(
                      (run) =>
                        run.coverageGroup === nearest.coverageGroup &&
                        this.criticalRunsFitCapacity([run]),
                    )
                    .slice(0, 1)
                : fallback.filter((run) => this.criticalRunsFitCapacity([run])).slice(0, 1);
          }
          if (critical.length === 0 || !this.criticalRunsFitCapacity(critical)) {
            this.frozenCriticalRuns = critical.length > 0 ? critical : [nearest];
            this.releaseInitialReveal('degraded', 'capacity');
            return null;
          }
          this.frozenCriticalRuns = critical;
          this.initialRevealStartedAt = now;
          this.initialRevealPhase = 'holding';
          this.publishInitialRevealProgress(critical);
        } else {
          for (const nearLevel of [0, 1, 2] as const) {
            const home = this.coarsenHomeRuns(seeds, nearLevel);
            if (home.length === 0) continue;
            if (this.criticalRunsFitCapacity(home)) {
              critical = home;
              break;
            }
            critical = home;
          }
          if (critical.length === 0) {
            this.initialRevealStateValue = { status: 'ready' };
            this.initialRevealPhase = 'released';
            return null;
          }
          if (!this.criticalRunsFitCapacity(critical)) {
            this.frozenCriticalRuns = critical;
            this.releaseInitialReveal('degraded', 'capacity');
            return null;
          }
          this.frozenCriticalRuns = critical;
          this.initialRevealStartedAt = now;
          this.initialRevealPhase = 'holding';
          this.publishInitialRevealProgress(critical);
        }
      }
    }

    if (this.initialRevealPhase !== 'holding' || !this.frozenCriticalRuns) return null;

    if (
      this.initialRevealStartedAt !== undefined &&
      now - this.initialRevealStartedAt >= INITIAL_REVEAL_TIMEOUT_MS
    ) {
      this.releaseInitialReveal('degraded', 'timeout');
      return null;
    }

    for (const run of this.frozenCriticalRuns) {
      if (this.failedFiles.has(run.file) && !this.resident.has(runKey(run))) {
        const staged = this.staged.get(runKey(run));
        if (!staged || staged.uploadedCount !== run.count) {
          this.releaseInitialReveal('degraded', 'fetch-failed');
          return null;
        }
      }
    }

    this.publishInitialRevealProgress(this.frozenCriticalRuns);
    return this.frozenCriticalRuns;
  }

  /** After staging/commits, release the hold when every frozen run is resident. */
  private finishInitialRevealIfComplete(): void {
    if (this.initialRevealPhase !== 'holding' || !this.frozenCriticalRuns) return;
    this.publishInitialRevealProgress(this.frozenCriticalRuns);
    if (this.environmentPendingForReveal()) return;
    if (this.frozenCriticalRuns.every((run) => this.resident.has(runKey(run)))) {
      this.releaseInitialReveal('ready');
    }
  }

  /**
   * Startup hold still needs the environment tile when the scene ships one
   * and it starts enabled. Failed / unfit / disabled tiles do not block reveal.
   */
  private environmentPendingForReveal(): boolean {
    return (
      this.envFile !== undefined &&
      this.envEnabled &&
      !this.envUnfit &&
      this.envHandle === undefined &&
      !this.failedFiles.has(this.envFile)
    );
  }

  /** Creates a performance event for a changed streamed-LOD tick, if any. */
  private createPerformanceEvent(
    residentBefore: ReadonlyMap<string, number>,
    stagedBefore: ReadonlyMap<string, number>,
    compactionCountBefore: number,
    startedAt: number,
  ): StreamedSplatPerformanceEvent | null {
    let appendedCount = 0;
    let activeCount = 0;
    for (const [key, entry] of this.resident) {
      activeCount += entry.run.count;
      if (!residentBefore.has(key)) appendedCount += entry.run.count;
    }
    let removedCount = 0;
    for (const [key, count] of residentBefore) {
      if (!this.resident.has(key)) removedCount += count;
    }
    let stagedCount = 0;
    for (const [key, entry] of this.staged) {
      stagedCount += Math.max(0, entry.uploadedCount - (stagedBefore.get(key) ?? 0));
    }
    const compacted = this.compactionCount !== compactionCountBefore;
    if (appendedCount === 0 && removedCount === 0 && stagedCount === 0 && !compacted) return null;
    const timestamp = performance.now();
    return {
      timestamp,
      cpuMs: timestamp - startedAt,
      activeListMs: 0,
      uploadMs: 0,
      sortSubmitMs: 0,
      stagingTextureAllocations: 0,
      activeListUpdateRanges: 0,
      appendedCount,
      removedCount,
      stagedCount,
      uploadCount: appendedCount + stagedCount,
      activeCount,
      forcedSort:
        activeCount === 0 || appendedCount + removedCount >= activeCount * CONTENT_FORCE_FRACTION,
      compacted,
    };
  }

  /**
   * Snapshot the latest drawable desired runs. Live discovery still drives
   * fetches; nothing in this list is presented until {@link radWaveShouldPublish}.
   */
  private captureWaveRuns(live: readonly LodRun[]): LodRun[] {
    const drawable = live.filter((run) => !run.fetchIntent);
    if (drawable.length === 0) return [...live];
    return drawable;
  }

  /**
   * Page-table `publish` equivalent for the prefix reader.
   *
   * First paint waits until prefetch is cached or the CPU cache cannot hold
   * more. After that the presented cut is sticky: cache-full and pool
   * pressure must not swap in a coarser/partial replacement (that is the
   * sharp↔noisy flicker once the scene has appeared). A later cut publishes
   * only when it is fully staged, the pipe is idle, and it is not coarser
   * than what is already on screen.
   */
  private radWaveShouldPublish(live: readonly LodRun[], poolPressure: boolean): boolean {
    const drawable = live.filter((run) => !run.fetchIntent);
    if (this.waveHasPublished && this.radWaveIsRegression(drawable)) return false;
    if (!this.waveHasPublished) {
      if (poolPressure) return true;
      if (this.cacheBytesTotal >= this.cpuCacheBytes) return true;
    }
    return !live.some(
      (run) =>
        run.fetchIntent === true && !this.cache.has(run.file) && !this.failedFiles.has(run.file),
    );
  }

  /** True when `incoming` would put a coarser prefix on screen than the resident cut. */
  private radWaveIsRegression(incoming: readonly LodRun[]): boolean {
    if (this.resident.size === 0) return false;
    const next = this.radWaveCutQuality(incoming);
    const prev = this.radWaveCutQuality([...this.resident.values()].map((entry) => entry.run));
    return next.fine < prev.fine || (next.fine === prev.fine && next.count < prev.count);
  }

  /**
   * Prefix quality: lower `level` is finer, and a deeper prefix usually draws
   * more splats. Weighted so a same-count finer cut still outranks a coarser one.
   */
  private radWaveCutQuality(runs: readonly LodRun[]): { count: number; fine: number } {
    let count = 0;
    let fine = 0;
    for (const run of runs) {
      count += run.count;
      fine += run.count * (32 - run.level);
    }
    return { count, fine };
  }

  /**
   * Two-phase commit for hierarchical sources that cannot pair a parent with
   * its children in one swap group (prefix-reader `.rad`).
   *
   * Cached replacements upload into inactive ranges; still-fetching prefetch
   * does not participate. Adds stay hidden until {@link radWaveShouldPublish},
   * so the first presented cut is the one the stream has actually caught up
   * to. A tick bound still force-applies if the hold would otherwise last the
   * whole session.
   */
  private applyRadWave(
    groups: readonly SwapGroup[],
    live: readonly LodRun[],
    now: number,
    pendingFetches: Map<number, ClassicFetchWant>,
  ): void {
    let appended = 0;
    let stagedNow = 0;
    let poolPressure = false;
    let awaitingFetch = false;
    const ready: SwapGroup[] = [];

    for (const group of groups) {
      if (group.adds.length === 0) {
        ready.push(group);
        continue;
      }
      const missing = group.adds.filter((run) => {
        if (this.staged.get(runKey(run))?.uploadedCount === run.count) return false;
        return !this.cache.has(run.file);
      });
      if (missing.length > 0) {
        awaitingFetch = true;
        let recoverable = false;
        for (const run of missing) {
          if (this.failedFiles.has(run.file)) continue;
          enqueueClassicFetch(
            pendingFetches,
            run.file,
            classicFetchPhaseForDesired(run, this.scene.source.lodBaseDistance),
            run,
          );
          recoverable = true;
        }
        if (recoverable) this.pendingWork = true;
        continue;
      }
      ready.push(group);
      if (this.groupFullyStaged(group)) continue;
      if (!this.canStageGroup(group)) {
        this.pendingWork = true;
        poolPressure = true;
        continue;
      }
      const allowance = Math.max(0, this.appendCap - appended);
      if (allowance <= 0) {
        this.pendingWork = true;
        continue;
      }
      const uploaded = this.stageGroup(group, now, allowance);
      appended += uploaded;
      stagedNow += uploaded;
      if (!this.groupFullyStaged(group)) this.pendingWork = true;
    }

    const shouldPublish = this.radWaveShouldPublish(live, poolPressure);
    const readyComplete =
      !poolPressure &&
      (!awaitingFetch || (!this.waveHasPublished && shouldPublish)) &&
      ready.every((group) => group.adds.length === 0 || this.groupFullyStaged(group));
    const holdingRetires = ready.some((group) => group.removes.length > 0);

    if (!readyComplete) {
      this.pendingWork = true;
      if (!holdingRetires) {
        this.retireHeldTicks = 0;
        return;
      }
      // The published cover is the picture until a later cut is allowed to
      // swap. Do not bulk-retire it just because discovery is still deepening
      // or the CPU cache is thrashing.
      if (this.waveHasPublished && (!shouldPublish || awaitingFetch)) {
        this.retireHeldTicks = 0;
        return;
      }
      if (
        this.neverRetireCoverageEarly ||
        (!poolPressure && this.retireHeldTicks < MAX_RETIRE_HELD_TICKS)
      ) {
        this.retireHeldTicks++;
        return;
      }
      this.fetchCountsValue.retiredEarly++;
      this.commitRadWave(ready, now, true);
      this.retireHeldTicks = 0;
      return;
    }

    // Same split as the per-group staged path: do not combine the last upload
    // of an oversized group with the active-list switch. Only skip a sort on
    // that drain frame when the next tick will actually commit — hidden
    // staging after a published cut must not starve camera sorts, or orbiting
    // while the stream is still warming looks like the unsorted (noisy) view.
    if (stagedNow > 0 && ready.some((group) => group.addCount > this.appendCap)) {
      if (shouldPublish) this.deferNextSortRequest();
      this.pendingWork = true;
      this.retireHeldTicks = 0;
      return;
    }

    if (!shouldPublish) {
      this.pendingWork = true;
      this.retireHeldTicks = 0;
      return;
    }

    this.commitRadWave(ready, now, false);
    this.retireHeldTicks = 0;
  }

  private groupFullyStaged(group: SwapGroup): boolean {
    return group.adds.every((run) => this.staged.get(runKey(run))?.uploadedCount === run.count);
  }

  /**
   * Activates every fully staged group in `ready` and applies pure removals.
   * `force` also applyGroups leftovers (after dropping partial staging) so a
   * stuck wave can still make progress - that is the retiredEarly hole.
   */
  private commitRadWave(ready: readonly SwapGroup[], now: number, force: boolean): void {
    this.waveHasPublished = true;
    for (const group of ready) {
      if (group.adds.length === 0) {
        this.applyGroup(group, now);
        continue;
      }
      if (this.groupFullyStaged(group)) {
        this.commitStagedGroup(group);
        continue;
      }
      if (!force) continue;
      for (const run of group.adds) {
        const key = runKey(run);
        const entry = this.staged.get(key);
        if (!entry || entry.uploadedCount === run.count) continue;
        this.removeRange(entry.handle);
        this.staged.delete(key);
      }
      if (!this.applyGroup(group, now)) this.pendingWork = true;
    }
  }

  /** Returns whether all new rows can coexist with the currently visible region. */
  private canStageGroup(group: SwapGroup): boolean {
    const unstaged = group.adds
      .filter((run) => !this.staged.has(runKey(run)))
      .reduce((sum, run) => sum + this.rowAlignedSplats(run.count), 0);
    return unstaged <= this.freeSplatCapacity;
  }

  /**
   * Uploads a bounded part of a replacement without rendering it.
   * Skips runs whose chunks are not yet cached so siblings can stage out of order.
   */
  private stageGroup(group: SwapGroup, now: number, allowance: number): number {
    if (allowance <= 0) return 0;
    let appended = 0;
    for (const run of group.adds) {
      const key = runKey(run);
      const chunk = this.cache.get(run.file);
      if (!chunk) continue;
      let entry = this.staged.get(key);
      if (!entry) {
        let handle: SplatRange;
        try {
          handle = this.reserveInactiveRange(run.count);
        } catch {
          this.compactionCount++;
          this.compact();
          try {
            handle = this.reserveInactiveRange(run.count);
          } catch {
            this.pendingWork = true;
            break;
          }
        }
        entry = { run, handle, uploadedCount: 0 };
        this.staged.set(key, entry);
      }
      // A swap group can contain several replacement runs. Once one run is
      // fully staged, advance to the next one instead of treating its zero
      // remaining count as an exhausted per-frame allowance.
      if (entry.uploadedCount === run.count) continue;
      const count = Math.min(run.count - entry.uploadedCount, allowance - appended);
      if (count <= 0) break;
      this.writeInactiveRange(
        entry.handle,
        sliceSplatData(chunk.data, run.offset + entry.uploadedCount, count),
        entry.uploadedCount,
      );
      entry.uploadedCount += count;
      chunk.lastUsed = now;
      appended += count;
      if (entry.uploadedCount === run.count) {
        this.writeLodLevelChannel(entry.handle, run.level);
        for (const [name, channel] of this.persistentChannels) {
          this.applyPersistentRun(name, channel, run, entry.handle);
        }
      }
      if (appended >= allowance) break;
    }
    return appended;
  }

  /** Switches a fully staged region from old to new visibility in one tick. */
  private commitStagedGroup(group: SwapGroup): void {
    for (const run of group.adds) {
      const entry = this.staged.get(runKey(run));
      if (!entry || entry.uploadedCount !== run.count) {
        throw new Error('StreamedSplatMesh: incomplete staged group commit.');
      }
    }

    for (const [key, entry] of group.removes) {
      if (!this.resident.has(key)) continue;
      this.removeRange(entry.handle);
      this.resident.delete(key);
    }
    for (const run of group.adds) {
      const key = runKey(run);
      const entry = this.staged.get(key) as {
        run: LodRun;
        handle: SplatRange;
        uploadedCount: number;
      };
      this.setRangeActive(entry.handle, true);
      this.resident.set(key, entry);
      this.staged.delete(key);
    }
  }

  /**
   * Applies one swap group atomically within this tick: removals first
   * (freeing pool rows for the replacements), then all adds. Returns false
   * without touching anything when the group cannot fit even after its own
   * removals - the caller defers it and the old runs keep rendering.
   */
  private applyGroup(group: SwapGroup, now: number): boolean {
    const rowSplats = (count: number): number =>
      Math.ceil(count / DATA_TEXTURE_WIDTH) * DATA_TEXTURE_WIDTH;
    const needed = group.adds.reduce((sum, run) => sum + rowSplats(run.count), 0);
    const freed = group.removes.reduce((sum, [, entry]) => sum + rowSplats(entry.run.count), 0);
    if (needed > this.freeSplatCapacity + freed) return false;

    for (const [key, entry] of group.removes) {
      if (!this.resident.has(key)) continue;
      this.removeRange(entry.handle);
      this.resident.delete(key);
    }
    for (const run of group.adds) {
      this.appendRun(run, now);
    }
    return true;
  }

  /** Appends one run from the cache, compacting the pool on fragmentation. */
  private appendRun(run: LodRun, now: number): void {
    const chunk = this.cache.get(run.file);
    if (!chunk) return; // caller pre-checked; only reachable on races
    const slice = sliceSplatData(chunk.data, run.offset, run.count);
    let handle: SplatRange;
    try {
      handle = this.appendRange(slice);
    } catch {
      this.compactionCount++;
      this.compact();
      try {
        handle = this.appendRange(slice);
      } catch {
        this.pendingWork = true; // retry next tick
        return;
      }
    }
    this.resident.set(runKey(run), { run, handle });
    chunk.lastUsed = now;
    this.writeLodLevelChannel(handle, run.level);
    // Re-apply any persistent channel edits for this file's splats - this is
    // what makes a painted mask survive the chunk being evicted and reloaded
    // (the pool row is fresh, but `(file, local index)` is a stable identity).
    for (const [name, channel] of this.persistentChannels) {
      this.applyPersistentRun(name, channel, run, handle);
    }
  }

  /**
   * Writes the stored edits for one run's `[offset, offset + count)` splats
   * into its freshly appended pool range. No-op when the file has no edits.
   */
  private applyPersistentRun(
    name: string,
    channel: PersistentChannel,
    run: LodRun,
    handle: SplatRange,
  ): void {
    const fileEdits = channel.edits.get(run.file);
    if (!fileEdits || fileEdits.size === 0) return;
    const data = channel.type === 'byte' ? new Uint8Array(run.count) : new Float32Array(run.count);
    // Seed with the channel's fill: this whole-run write must leave unedited
    // splats at their default, not clobber them to 0.
    if (channel.fill) data.fill(channel.fill);
    let any = false;
    for (let k = 0; k < run.count; k++) {
      const value = fileEdits.get(run.offset + k);
      if (value !== undefined) {
        data[k] = value;
        any = true;
      }
    }
    if (any) this.writeChannel(handle, name, data);
  }

  /**
   * Covers a deferred group's leaves that no resident run covers with each
   * leaf's coarsest (pinned, hence cached) level, so a region waiting on a
   * fetch shows coarse detail instead of nothing. The substitutes are
   * intentionally not "desired": the next reschedule swaps them for the
   * real level once its chunk has arrived.
   *
   * Near-camera refinements (`distance <= lodBaseDistance`) skip the coarse
   * paint and its pin fetch entirely - cold load requests only the target cut
   * for that cell. Far gaps keep the shell.
   */
  private substituteCoverage(
    group: SwapGroup,
    now: number,
    pendingFetches: Map<number, ClassicFetchWant>,
    holdForFinest: boolean,
  ): void {
    const span = group.leafEnd - group.leafStart;
    // Reused across calls: this runs for every deferred group of every streamed
    // mesh, every reschedule - ~800 times a second on a multi-mesh scene, at
    // a measured mean span of 60k leaves. Allocating the bitmap each time threw
    // away half a gigabyte in ten seconds and made this the single most
    // expensive function in the frame. The scratch only grows.
    if (this.coverageScratch === undefined || this.coverageScratch.length < span) {
      this.coverageScratch = new Uint8Array(span);
    }
    const covered = this.coverageScratch;
    covered.fill(0, 0, span);
    for (const { run } of this.resident.values()) {
      const from = Math.max(run.leafStart, group.leafStart);
      const to = Math.min(run.leafEnd, group.leafEnd);
      // `fill` over the overlap rather than a per-leaf loop: same marking, but
      // one memset instead of ~18k interpreted iterations per call.
      if (to > from) covered.fill(1, from - group.leafStart, to - group.leafStart);
    }

    // Walk the gaps with native scans rather than leaf-by-leaf in JS: the span
    // averages 60k leaves and is mostly covered, so the old loop spent its time
    // stepping over ones. `indexOf` on the bitmap does the same walk in memchr.
    // The scratch is oversized, hence the exact-length view to bound the search.
    const view = covered.subarray(0, span);
    let offset = 0;
    while (offset < span) {
      const gapStart = view.indexOf(0, offset);
      if (gapStart < 0) break;
      const nextCovered = view.indexOf(1, gapStart);
      const gapEnd = nextCovered < 0 ? span : nextCovered;
      const cursor = group.leafStart + gapStart;
      const end = group.leafStart + gapEnd;
      for (const run of this.scene.source.coarsestRunsFor(cursor, end)) {
        if (this.resident.has(runKey(run))) continue;
        if (holdForFinest) {
          // Do not paint coarsest discs while finest downloads. Do not enqueue
          // the pin - those slots belong to the group's finest fetches.
          this.fetchCountsValue.uncovered +=
            Math.min(run.leafEnd, end) - Math.max(run.leafStart, cursor);
          continue;
        }
        if (!this.cache.has(run.file)) {
          enqueueClassicFetch(
            pendingFetches,
            run.file,
            classicFetchPhaseForCoverage(run, this.scene.source.lodBaseDistance),
            run,
          );
          // This is the one path in the substitute that gives up: the gap keeps
          // no coverage at all until the chunk lands, so those leaves render as
          // nothing. Expected once during initial load (the coarsest level has
          // not arrived yet) and *not* expected afterwards, because the coarsest
          // files are pinned against eviction - so a count that climbs after the
          // scene has settled localizes a hole to here rather than to the swap
          // path. Counted in leaves, clipped to the gap, since a coarsest run
          // may span past it.
          this.fetchCountsValue.uncovered +=
            Math.min(run.leafEnd, end) - Math.max(run.leafStart, cursor);
          continue;
        }
        // A coarsest run may span beyond `[cursor, end)` - LCC2 root children
        // cover whole subtrees and cannot be clipped to a leaf sub-interval.
        // Octree intervals nest, so every resident run overlapping it lies
        // fully inside it: remove those first (the whole region temporarily
        // shows coarse), or their leaves would render twice - a bright flash
        // for the fetch window, permanent if the missing chunk never loads.
        for (const [key, entry] of this.resident) {
          if (entry.run.leafStart < run.leafEnd && entry.run.leafEnd > run.leafStart) {
            this.removeRange(entry.handle);
            this.resident.delete(key);
          }
        }
        this.appendRun(run, now);
      }
      offset = gapEnd;
    }
  }

  /** Issues pending classic-path chunk wants in group-priority order. */
  private flushClassicFetches(
    pending: Map<number, ClassicFetchWant>,
    lodBaseDistance: number,
    holdingNearL0 = false,
  ): void {
    if (pending.size === 0) return;
    stampClassicFetchGroups(pending, lodBaseDistance, holdingNearL0);
    const ordered = [...pending.entries()].sort((a, b) =>
      compareClassicFetches(a[1], b[1], a[0], b[0]),
    );
    this.preemptClassicFetches(ordered);
    for (const [file, want] of ordered) this.requestChunk(file, want.kind, want);
  }

  /**
   * A camera turn must not wait for all eight old visible requests to finish.
   * Only classic requests carry a precise rank; page-table work retains its
   * own scheduler and is never cancelled here.
   */
  private preemptClassicFetches(ordered: readonly [number, ClassicFetchWant][]): void {
    for (const [file, want] of ordered) {
      if (this.cache.has(file) || this.fetching.has(file)) continue;
      let worstFile: number | undefined;
      let worstWant: ClassicFetchWant | undefined;
      for (const [activeFile, active] of this.fetching) {
        if (!active.classicWant) continue;
        if (
          !worstWant ||
          compareClassicFetches(active.classicWant, worstWant, activeFile, worstFile as number) > 0
        ) {
          worstFile = activeFile;
          worstWant = active.classicWant;
        }
      }
      if (
        worstWant &&
        worstFile !== undefined &&
        compareClassicFetches(want, worstWant, file, worstFile) < 0
      ) {
        this.fetching.get(worstFile)?.controller.abort();
      }
      // The current request waits for the abort's finally callback to release
      // its slot; do not churn through every queued request in one tick.
      if (this.fetching.size >= this.maxInflight) return;
    }
  }

  /**
   * Loads the always-resident environment tile once, on the first update after
   * it is wanted. The tile has no LOD ladder and no manifest count, so it is
   * appended whole (measuring its splat count at decode) and thereafter toggled
   * by flipping its pool range active - never scheduled, refetched, or evicted.
   * When `pending` is supplied, a miss is ranked as an `'environment'` want so
   * it issues ahead of LOD coverage.
   */
  private updateEnvironment(now: number, pending?: Map<number, ClassicFetchWant>): void {
    const file = this.envFile;
    if (file === undefined || this.envHandle !== undefined || !this.envEnabled || this.envUnfit) {
      return;
    }
    const chunk = this.cache.get(file);
    if (!chunk) {
      if (!this.failedFiles.has(file)) {
        // The environment tile is always-resident coverage, never speculation:
        // a mesh that cannot fetch it renders no background at all.
        if (pending) this.enqueueEnvironmentFetch(pending, file);
        else this.requestChunk(file, 'priority');
        this.pendingWork = true;
      }
      return;
    }
    // The env sits outside the LOD budget, in the pool's capacity headroom -
    // which nothing guarantees is free (`maxResidentSplats` cannot include a
    // count only known at decode). Pre-check before touching the pool: without
    // this, an env that never fits would pay a full-pool compact() every
    // reschedule tick, forever.
    const rowAligned = Math.ceil(chunk.data.count / DATA_TEXTURE_WIDTH) * DATA_TEXTURE_WIDTH;
    if (rowAligned > this.capacity) {
      this.envUnfit = true; // could never fit even an empty pool
      warn(
        `the environment tile (${chunk.data.count} splats) exceeds the ` +
          `pool capacity (${this.capacity}); it will not be shown. Raise the ` +
          `splat budget to fit it.`,
      );
      return;
    }
    if (rowAligned > this.freeSplatCapacity) {
      // No free rows yet - compaction only defragments, it cannot create
      // them. Retry cheaply once LOD churn frees room.
      this.pendingWork = true;
      return;
    }
    let handle: SplatRange;
    try {
      handle = this.appendRange(chunk.data);
    } catch {
      // Enough rows exist but no contiguous span does; defragment once.
      this.compactionCount++;
      this.compact();
      try {
        handle = this.appendRange(chunk.data);
      } catch {
        this.pendingWork = true; // no room this tick; retry next
        return;
      }
    }
    this.envHandle = handle;
    this.envSplatCount = chunk.data.count;
    chunk.lastUsed = now;
  }

  /** Ranks the env tile ahead of every LOD want in {@link flushClassicFetches}. */
  private enqueueEnvironmentFetch(pending: Map<number, ClassicFetchWant>, file: number): void {
    if (pending.has(file)) return;
    pending.set(file, {
      kind: 'priority',
      phase: 'environment',
      distance: 0,
      level: 0,
      inView: true,
      coverageGroup: -1,
      leafStart: 0,
      leafEnd: 0,
      screenImportance: Number.NEGATIVE_INFINITY,
      groupDistance: 0,
      groupPending: 1,
      groupInView: true,
      groupScreenImportance: Number.NEGATIVE_INFINITY,
      groupFinest: true,
      groupId: 'environment',
      groupClass: 0,
    });
  }

  /**
   * Page-table reschedule (`foveationMode: 'page-table'`): posts the camera to the
   * worker, which owns the cache + traversal + pager and replies asynchronously
   * with a paging plan. Coalesced to one outstanding request so the main thread
   * never blocks. Also drives chunk fetching, in priority order.
   */
  private reschedulePageTable(
    cameraLocal: THREE.Vector3,
    forwardLocal: THREE.Vector3,
    frustum: THREE.Frustum,
    now: number,
  ): void {
    // 1. What the last frontier wanted and did not have, biggest-on-screen
    //    first. This is the detail the camera is pointed at, so it takes the
    //    fetch slots before anything else - issued *after* the sweep below it
    //    was silently dropped by the in-flight cap on every tick, and the whole
    //    capture downloaded in file order while the view stayed coarse.
    for (const file of this.pageTableFetchPriority) this.requestChunk(file, 'priority');
    // 2. The source's camera-directed coarse base, for far coverage.
    const desiredFiles = new Set(this.pageTableFetchPriority);
    for (const run of this.scene.source.computeDesiredRuns(cameraLocal, frustum, now)) {
      desiredFiles.add(run.file);
      this.requestChunk(run.file, 'base');
    }
    // Cancel detail this mesh no longer wants, so its slots go back to the
    // scene now rather than when a superseded request happens to finish. The
    // classic path has always done this; the page-table path never did, which
    // on a shared pipe means a camera cut kept paying for the old view.
    // Sweep fetches are exempt: they are file-order pre-warming that no
    // frontier plan ever names, so matching them against `desiredFiles` would
    // abort every one of them on the very next reschedule.
    for (const [file, entry] of this.fetching) {
      if (entry.kind === 'sweep') continue;
      if (!desiredFiles.has(file) && !this.scene.pinnedFiles.has(file)) entry.controller.abort();
    }
    // 3. Background sweep over the slots that remain: pull the lowest uncached
    //    chunk (file order is coarse → fine). Once the cache holds the scene,
    //    turning the camera is served from RAM in one traversal instead of a
    //    level-by-level network ladder. It keeps a reserve free so (1) is never
    //    starved, and pauses whenever the worker cache is at its cap - past that
    //    point sweeping only evicts what the frontier is using. It resumes on
    //    its own when the cap rises, which under a scene-wide `ChunkCacheBudget`
    //    is what happens as the camera approaches this mesh.
    //
    //    Only a mesh with weight sweeps. This is speculation about a camera
    //    move that has not happened, and it is unbounded - it wants the entire
    //    capture. On a scene of streamed additional meshes, every hidden and distant one
    //    speculating at once is the traffic that delays the mesh the viewer
    //    is looking at. The cost of gating it is that re-focusing a mesh that
    //    went cold refetches instead of hitting a warm cache.
    if (!this.pageTableCacheAtLimit && this.sweepAllowed()) {
      const sweepCap = Math.max(1, this.maxInflight - PAGETABLE_PRIORITY_SLOTS);
      const files = this.scene.chunkUrls.length;
      for (let f = 0; f < files && this.fetching.size < sweepCap; f++) {
        if (!this.pageTableCachedFiles.has(f)) this.requestChunk(f, 'sweep');
      }
    }
    if (this.pageTableInFlight) return; // one traversal outstanding - coalesce

    this.pageTableInFlight = true;
    this.postToWorker({
      type: 'reschedule',
      seq: ++this.pageTableSeq,
      cameraLocal: [cameraLocal.x, cameraLocal.y, cameraLocal.z],
      cameraForward: [forwardLocal.x, forwardLocal.y, forwardLocal.z],
      ...this.pageTableFoveation,
      // Spark's cut is `pixel_scale × lodScale ≤ limit`, and the traversal only
      // ever sees one side of that - so scaling the limit down by `lodScale` is
      // the same comparison, with no protocol change.
      limit: this.pageTableLimit / this.lodScaleValue,
      budget: this.pageTableDrawBudget,
    });
  }

  /**
   * Applies a paging plan from the worker to the slab - fast memcpy writes only,
   * no traversal or gather on the main thread - then fetches the chunks the
   * frontier wants next, and reschedules again if chunks are still streaming.
   */
  private applyFrontierPlan(plan: FrontierPlanMessage): void {
    this.pageTableInFlight = false;
    if (this.pageTableDisposed || this.slabPages.length === 0) return;
    // Storage may have moved since this plan was built (a reschedule answered
    // from the old capacity, then a resize landed). Such a plan must still be
    // applied, clamped to the slots that exist: the worker's pager has already
    // mutated itself as if the whole plan ran, so dropping it desynchronizes the
    // two permanently - later plans only carry deltas, and the un-applied slots
    // keep stale (or never-written) content underneath a live resident count.
    //
    // Clamping is exact rather than approximate because a resize never remaps
    // the slots below the boundary: `syncSlabPages` only pushes or pops tail
    // pages, and `FrontierPager.resize` keeps `[0, keep)` untouched. So "the
    // plan, truncated at the new capacity" is precisely the pager's own state.
    const limit = this.pagerSlots;
    if (plan.capacity !== limit) {
      // The worker will re-traverse at the new capacity; make sure it does.
      this.pendingWork = true;
      this.lastScheduleTime = -Infinity;
    }
    // The pager emits moves in ascending slot order, and a swap-remove of a
    // contiguous block of leavers produces long runs of consecutive slots. Write
    // them a run at a time: one call per moved splat meant a `Box3` pass, a
    // bounds union and a row-range mark for every one of them, which stalled the
    // main thread for seconds whenever a camera move churned the frontier.
    const applyStartedAt = performance.now();
    const slots = plan.moveSlots;
    for (let i = 0; i < slots.length;) {
      let run = 1;
      while (i + run < slots.length && (slots[i + run] as number) === (slots[i] as number) + run) {
        run++;
      }
      const start = slots[i] as number;
      const clamped = Math.min(run, limit - start);
      if (clamped > 0) this.writeSlabSlots(slicePlanRun(plan.moves, i, clamped), start, clamped);
      i += run;
    }
    if (plan.appends.count > 0) {
      const clamped = Math.min(plan.appends.count, limit - plan.appendStart);
      if (clamped > 0) this.writeSlabSlots(plan.appends, plan.appendStart, clamped);
    }
    const writeFinishedAt = performance.now();
    const drawn = Math.min(plan.displayCount ?? plan.residentCount, limit);
    // Freed tail slots leave the active list, so their data is not drawn - but
    // zero it anyway. It costs a fill over the freed range only, and it means a
    // slot that somehow ends up drawn without being written renders nothing
    // instead of whichever coarse node used to own it (one enormous splat).
    const degenerateStart = Math.min(plan.degenerateStart, limit);
    const degenerateCount = Math.min(plan.degenerateCount, limit - degenerateStart);
    if (degenerateCount > 0) this.degenerateSlabSlots(degenerateStart, degenerateCount);
    const residentFinishedAt = performance.now();
    // Spark holds `display` until the new mapping is fully paged. The pager
    // freezes `displayCount` at the last published cut while replacements
    // stage onto the tail, and only advances it when the worker publishes
    // (wanted chunks cached, cache full, or camera moved).
    const presented =
      plan.displayGeneration !== undefined
        ? plan.displayGeneration !== this.pageTableDisplayGeneration
        : drawn !== this.pageTableDrawn;
    if (presented) {
      this.setSlabResident(drawn);
      this.pageTableDrawn = drawn;
      this.pageTableDisplayGeneration =
        plan.displayGeneration ?? this.pageTableDisplayGeneration + 1;
      this.invalidateSort();
    }
    this.frontierConverged = plan.converged;
    this.pendingFrontierSplats = plan.pendingFrontierSplats ?? 0;
    this.staleResidentSplats = plan.staleResidentSplats ?? 0;
    this.lastPlanAppends = plan.lastPlanAppends ?? plan.appends.count;
    this.lastPlanMoves = plan.lastPlanMoves ?? plan.moveSlots.length;
    this.lastPlanGeneration = plan.planGeneration ?? this.lastPlanGeneration + 1;
    this.lastPlanBudget = plan.planBudget ?? this.pageTableDrawBudget;
    if (plan.cameraLocal) {
      this.lastPlanCamera = plan.cameraLocal;
      this.firstFrontierCamera ??= plan.cameraLocal;
    }
    if (plan.gatherMissing > 0) {
      // Splats whose chunk was evicted under them were written as zeros into
      // slots that are still drawn - holes in the coverage. Eviction protects
      // every chunk with resident splats, so this should be unreachable.
      warn(
        `StreamedSplatMesh: page-table plan gathered ${plan.gatherMissing} splats from ` +
          `evicted chunks; they render as holes.`,
      );
    }
    // Applying a plan runs off the render loop's own timing, so its cost is
    // invisible to `getUpdateTimings` even though it lands on the same thread.
    // Recorded because a churning frontier can make this the largest stall in a
    // frame, and a cap has to be aimed at whichever half dominates.
    const planTimings = this.planTimingsValue;
    planTimings.applyMs = residentFinishedAt - applyStartedAt;
    planTimings.writeMs = writeFinishedAt - applyStartedAt;
    planTimings.residentMs = residentFinishedAt - writeFinishedAt;
    planTimings.moves = plan.moveSlots.length;
    planTimings.appends = plan.appends.count;
    if (planTimings.applyMs > planTimings.worstApplyMs) {
      planTimings.worstApplyMs = planTimings.applyMs;
      planTimings.worstSplats = planTimings.moves + planTimings.appends;
    }
    // Follow the cut with the screen-radius band. The worker refines below the
    // quality target to spend the draw budget, and those finer nodes project
    // smaller - a band still sized for the target cut would cull them, so the
    // extra budget would buy nothing visible. Scaling by the same ratio keeps
    // the band spanning one LOD level.
    if (
      presented &&
      this.frontierBandBase !== null &&
      plan.solvedLimit > 0 &&
      this.pageTableLimit > 0
    ) {
      const ratio = Math.min(1, plan.solvedLimit / this.pageTableLimit);
      this.setScreenRadiusBand(
        this.frontierBandBase.min * ratio,
        this.frontierBandBase.max * ratio,
      );
    }
    if (plan.dropped > 0) {
      // The traversal is budget-bounded, so the slab always has room. If it does
      // not, the pool is smaller than the draw budget and part of the frontier is
      // silently missing - say so rather than render a hole.
      warn(
        `StreamedSplatMesh: page-table slab full, dropped ${plan.dropped} frontier splats ` +
          `(draw budget ${this.pageTableDrawBudget} exceeds the pool).`,
      );
    }
    // Worker-evicted chunks must be forgotten here too, or they can never refetch.
    for (let i = 0; i < plan.evicted.length; i++) {
      this.pageTableCachedFiles.delete(plan.evicted[i] as number);
    }
    this.fetchCountsValue.cacheBytes = plan.cacheBytes;
    this.fetchCountsValue.cacheLimitBytes = plan.cacheLimitBytes;
    // Recomputed every plan, not latched: the sweep must resume when the scene
    // budget raises this mesh's allowance. `cacheFull`/`evicted` stay monotonic
    // - they are diagnostics answering "did this happen", not live state.
    this.pageTableCacheAtLimit = plan.cacheBytes >= plan.cacheLimitBytes;
    if (plan.evicted.length > 0) {
      this.fetchCountsValue.cacheFull = true;
      this.fetchCountsValue.evicted += plan.evicted.length;
    }
    // The chunks the frontier wants next, biggest-on-screen first - requested now
    // and kept as the priority list the next reschedule fetches before anything.
    this.pageTableFetchPriority = Array.from(plan.touched);
    for (const file of this.pageTableFetchPriority) this.requestChunk(file, 'priority');
    // Keep refining while chunks stream in (the frontier keeps changing), and
    // while the worker is still ramping its budget up to the governed one - that
    // ramp is what keeps a hard camera cut from arriving as one ~100 ms plan, so
    // the next pass must follow immediately or detail stalls where it stopped.
    if (this.fetching.size > 0 || !plan.converged) {
      this.pendingWork = true;
      if (!plan.converged) this.lastScheduleTime = -Infinity;
    }
  }

  /** Forwards a decoded chunk's arrays to the worker (buffers transferred) so the
   * worker's cache/traversal/gather can use it. */
  private forwardChunkToWorker(file: number, data: SplatData): void {
    const tree = data.radTree;
    if (!tree) return;
    this.pageTableCachedFiles.add(file);
    // Only forward SH the pool will actually render. A `.rad` chunk decodes
    // whatever bands the file carries regardless of what was asked for, and the
    // worker charges its cache for every byte it is handed - 15 coefficients is
    // 60 B/splat against 40 B for position, colour and covariance combined, so
    // SH the mesh has declined was **60% of the chunk cache**.
    //
    // Measured on the reference capture with SH declined: the worker counted
    // 100 B/splat where the cache-floor estimate assumes 40, so the cache filled
    // at ~52 chunks' worth of its limit instead of the 132 the estimate predicts
    // and the frontier thrashed - one eviction and one refetch every couple of
    // seconds, forever, with resident chunks oscillating in the low 70s.
    //
    // Dropping it here also makes `estimateSceneDecodedBytes` correct rather
    // than merely larger: both sides then agree on 40 B/splat.
    //
    // `shBands` rather than the pool's `packedShBands` (which is private, and
    // protected would put it in the published `.d.ts`): they agree here, because
    // the only way they differ is palette SH, and a streamed mesh never has it -
    // the slicer drops `chunk.sh` before a chunk ever reaches the pool.
    const sh = this.shBands > 0 ? data.shPacked : undefined;
    this.postToWorker(
      {
        type: 'chunk',
        file,
        count: data.count,
        positions: data.positions,
        colors: data.colors,
        covariances: data.covariances,
        childCount: tree.childCount,
        childStart: tree.childStart,
        size: tree.size,
        shBands: sh?.bands ?? 0,
        ...(sh ? { shPacked: sh.packed, shRange: sh.range } : {}),
      },
      [
        data.positions.buffer,
        data.colors.buffer,
        data.covariances.buffer,
        tree.childCount.buffer,
        tree.childStart.buffer,
        tree.size.buffer,
        ...(sh ? [sh.packed.buffer] : []),
      ],
    );
  }

  /** Parallel chunk fetches. HTTP/2 multiplexes them; on HTTP/1.1 the browser's
   * per-host cap simply queues. Same cap for classic and page-table so near
   * detail is not structurally starved on the non-page-table path. */
  private get maxInflight(): number {
    return MAX_INFLIGHT;
  }

  /**
   * Whether this mesh may run its speculative background sweep. A mesh with no
   * weight is hidden or suspended; a mesh with no `fetchWeight` at all is a
   * host that never asked for arbitration, and keeps the old behaviour.
   */
  /**
   * Sets this mesh's share of the scene's fetch bandwidth, as
   * {@link StreamedSplatMeshOptions.fetchWeight} does at load.
   *
   * The weight normally closes over the mesh itself (`() =>
   * governor.weightOf(mesh)`), which a host cannot express until `load`
   * resolves - hence a setter as well as an option. Pass `undefined` to go back
   * to unarbitrated sweeping.
   */
  setFetchWeight(weight: (() => number) | undefined): void {
    this.fetchWeight = weight;
  }

  private sweepAllowed(): boolean {
    // The `smooth` profile (the default on mobile) declines the sweep outright.
    //
    // The sweep is speculative pre-warming of the *whole capture*, and without a
    // scene-wide `cacheBudget` it does not stop until every chunk is cached: the
    // cap is sized from the capture itself (`min(PAGETABLE_CACHE_FLOOR_BYTES,
    // estimateSceneDecodedBytes)`), so on any capture that fits there is never
    // an eviction to reach it. Measured on the 5.9M-leaf reference `.rad` with
    // SH declined: a 235 MB cache floor against a 235 MB decoded capture, i.e. a
    // steady ~1 chunk/second drip pulling all 447 MB down and decoding it, long
    // after the view had settled at full detail. Multiply that by the meshes in
    // a multi-mesh scene and it is the largest memory risk in a viewer - which is
    // what `cacheBudget` bounds, without stopping the sweep itself.
    //
    // On a desktop that is a good trade - RAM is cheap and turning the camera is
    // then served from memory instead of a level-by-level network ladder. On a
    // phone it is the wrong one in every currency at once: hundreds of MB of
    // possibly-metered download, a decoded cache that rivals the splat pool on a
    // device that gets its tab killed for exactly that, and continuous decode
    // CPU (and therefore heat) spent on a camera move that may never happen.
    // What it costs to decline: refinement after a turn fetches on demand.
    if (this.performanceProfile === 'smooth') return false;
    if (this.fetchWeight === undefined) return true;
    const weight = this.fetchWeight();
    return Number.isFinite(weight) && weight > 0;
  }

  /** Aborts in-flight fetches of one kind; their slots return through `finally`. */
  private abortFetches(kind: ChunkFetchKind): void {
    for (const entry of this.fetching.values()) {
      if (entry.kind === kind) entry.controller.abort();
    }
  }

  private requestChunk(file: number, kind: ChunkFetchKind, classicWant?: ClassicFetchWant): void {
    if (
      this.cache.has(file) ||
      this.pageTableCachedFiles.has(file) ||
      this.fetching.has(file) ||
      this.fetching.size >= this.maxInflight
    ) {
      return;
    }
    if (this.failedFiles.has(file)) return; // given up
    const backoff = this.retrying.get(file);
    if (backoff && performance.now() < backoff.readyAt) return; // waiting to retry

    // Counted here, past every "already have it / already fetching / capped"
    // guard, so the totals mean "requests that became real network work".
    this.fetchCountsValue[kind]++;
    const url = this.scene.chunkUrls[file];
    if (url === undefined) {
      // A manifest referencing an out-of-range file index can never load;
      // fail it terminally so its groups settle on their coarse substitutes
      // instead of rescheduling (and spinning the indicator) forever.
      warn(`StreamedSplatMesh: manifest references unknown chunk file #${file}.`);
      this.failedFiles.add(file);
      return;
    }
    // Scene-wide arbitration, after every local reason not to fetch: a slot
    // taken here is a slot denied to a sibling, so it must not be spent on a
    // request the mesh would have skipped anyway. A denial is not a failure and
    // deliberately leaves `retrying` alone - the mesh simply did not fetch this
    // tick, and the scheduler wakes it when the pipe frees up.
    if (this.fetchHandle && !this.fetchScheduler?.tryAcquire(this.fetchHandle, kind)) return;
    const controller = new AbortController();
    this.fetching.set(file, { controller, kind, classicWant });
    this.loader
      .load(url, {
        kind: this.scene.chunkKind,
        signal: controller.signal,
        ...this.scene.chunkOptions?.[file],
      })
      .then((data) => {
        // A chunk that resolved just before dispose still lands here one
        // microtask later; keeping it would repopulate the cleared cache (or
        // post to a terminated frontier worker).
        if (this.disposed) return;
        this.retrying.delete(file);
        // Formats whose LOD structure lives in the chunks (a `.rad` tree) learn
        // it here - the source uses it for its coarse-base ranking. Read it before
        // any transfer.
        this.scene.source.onChunkDecoded?.(file, data);
        if (this.frontierWorker) {
          // Page-table mode: the worker owns the cache. Forward the chunk (its
          // buffers are transferred, so the main thread does not keep it).
          this.forwardChunkToWorker(file, data);
          this.pendingWork = true; // a new chunk changes the frontier
        } else {
          this.cacheChunk(file, data);
        }
      })
      .catch((error: unknown) => {
        // Aborts (the camera moved on, or the mesh was disposed) are not
        // failures: a later reschedule re-requests the file if it is still
        // wanted. `isAbortError` also matches the non-DOMException AbortError
        // `ChunkLoader.dispose` raises where DOMException is unavailable -
        // treating that as a failure would log and retry against a dead worker.
        if (isAbortError(error)) return;
        const attempts = (this.retrying.get(file)?.attempts ?? 0) + 1;
        if (attempts >= MAX_CHUNK_ATTEMPTS) {
          this.retrying.delete(file);
          this.failedFiles.add(file);
          // Terminal: the region silently settles on its coarse substitute
          // forever, so say why once - otherwise a scene that is simply
          // missing detail looks like a renderer bug.
          warn(
            `StreamedSplatMesh: gave up on chunk #${file} (${url}) after ${attempts} attempts.`,
            error,
          );
        } else {
          // Exponential backoff; the idle reschedule (≤250 ms) picks it up.
          const delay = RETRY_BASE_MS * 2 ** (attempts - 1);
          this.retrying.set(file, { attempts, readyAt: performance.now() + delay });
        }
      })
      .finally(() => {
        this.fetching.delete(file);
        // Released here rather than on success, so an aborted or failed fetch
        // hands its slot back too - a leak here silently shrinks the scene's
        // whole pipe until the pool is torn down.
        if (this.fetchHandle) this.fetchScheduler?.release(this.fetchHandle);
        this.pendingWork = true;
      });
  }

  /**
   * Stores a decoded chunk while keeping {@link cacheBytesTotal} in step. The
   * counter replaces a full-cache re-sum on every reschedule; every mutation
   * of {@link cache} (this method, eviction, dispose's clear) maintains it.
   */
  private cacheChunk(file: number, data: SplatData): void {
    const previous = this.cache.get(file);
    if (previous !== undefined) this.cacheBytesTotal -= previous.bytes;
    const bytes = chunkBytes(data);
    this.cache.set(file, { data, bytes, lastUsed: performance.now() });
    this.cacheBytesTotal += bytes;
  }

  private evictChunks(now: number): void {
    let total = this.cacheBytesTotal;
    if (total <= this.cpuCacheBytes) return;

    // Evict least-recently-used chunks first; never a chunk touched this
    // tick, and never a pinned (coarsest-level) chunk - those are the
    // substitute coverage and must stay sliceable. Evicting a chunk that
    // still backs a resident run is safe - its splats already live in the
    // pool; only future re-slicing would refetch.
    const candidates = [...this.cache.entries()]
      .filter(
        ([file, chunk]) =>
          chunk.lastUsed !== now &&
          !this.scene.pinnedFiles.has(file) &&
          !this.neededFiles.has(file),
      )
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [file, chunk] of candidates) {
      if (total <= this.cpuCacheBytes) break;
      this.cache.delete(file);
      this.cacheBytesTotal -= chunk.bytes;
      total -= chunk.bytes;
      // Counted for the same reason the page-table path counts its worker's
      // evictions: `base` climbing with this flat is refinement converging,
      // while `base` climbing *with* this is a cache too small for the cut, and
      // the two look identical from outside. Until this existed the streamed
      // path reported a constant `evicted: 0`, which read as "no thrashing"
      // when it only ever meant "not measured".
      this.fetchCountsValue.evicted++;
    }
  }
}

const _paintLocal = new THREE.Vector3();
const _cameraWorldPos = new THREE.Vector3();
const _cameraWorldQuat = new THREE.Quaternion();
const _cameraLocal = new THREE.Vector3();
const _projScreen = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();
/** Camera forward in mesh-local space, for the page-table traversal's foveation. */
const _cameraForward = new THREE.Vector3();
const _drawSize = new THREE.Vector2();

/** A `SplatData` view over a contiguous run `[j, j + count)` of a plan's packed
 * splats, so one pool write covers a whole run of slots. Zero-copy subarrays. */
function shWordsPerSplat(bands: 1 | 2 | 3): number {
  return Math.ceil((3 * shCoefficientCount(bands)) / 4);
}

function slicePlanRun(splats: PlanSplats, j: number, count: number): SplatData {
  const sh = splats.shPacked;
  return {
    count,
    positions: splats.positions.subarray(j * 3, (j + count) * 3),
    colors: splats.colors.subarray(j * 4, (j + count) * 4),
    covariances: splats.covariances.subarray(j * 6, (j + count) * 6),
    ...(sh
      ? {
          shPacked: {
            ...sh,
            packed: sh.packed.subarray(
              j * shWordsPerSplat(sh.bands),
              (j + count) * shWordsPerSplat(sh.bands),
            ),
          },
        }
      : {}),
  };
}
