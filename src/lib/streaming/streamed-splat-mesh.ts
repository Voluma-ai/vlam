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
import { DEFAULT_PAGE_TABLE_WRITES_PER_PLAN } from './streaming-defaults';
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
import { splatMeshSourceLabel } from '../core/splat-mesh-types';
import type { SplatData } from '../core/splat-data';
import { runKey, type LodRun, type LodScheduler } from './lod-scheduler';
import { buildSogScene, type StreamedScene } from './lod-source';
import type { CollisionMeshTile } from '../formats/lcc/collision-mesh';
import { createLocalDataset, httpDatasetSource, type SplatDatasetSource } from './dataset-source';
import {
  isAbortError,
  resolveSplatUrl,
  splatUrlExtension,
  SplatLoadError,
  toRequestInit,
  toSplatLoadError,
  type SplatRequestOptions,
  type StreamedSplatFormat,
} from '../loaders/loading';
import {
  liftBudgetToFinestLevel,
  estimateSplatPoolBytes,
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
  type FrontierDemandReply,
  type FrontierDemandWant,
  type FrontierRequest,
  type FrontierResizeSafeMessage,
  type FrontierPlanReason,
  type FrontierCutDiagnostic,
  type FrontierSkipSample,
  type FrontierSnapshotReply,
  type FrontierTraversalCancelledReply,
  type PlanSplats,
} from '../formats/rad/frontier-worker-protocol';
import { RadChunkPageAllocator } from '../formats/rad/rad-chunk-page-allocator';
import { compareDemand } from '../formats/rad/frontier-demand';
import { experiments } from '../internal/experiments';
import { shCoefficientCount } from '../core/sh-pack';
import { warn } from '../core/logging';
import type {
  ChunkFetchHandle,
  ChunkFetchKind,
  ChunkFetchScheduler,
} from './chunk-fetch-scheduler';
import type { ChunkCacheBudget, ChunkCacheHandle } from './chunk-cache-budget';
import {
  selectBrushStrokeInData,
  selectBrushStrokeInPoolBacking,
  type BrushStroke,
  type BrushStrokeSelectionOptions,
} from '../selection/brush-stroke';

type FrontierGenerationTraceEvent = {
  at: number;
  event:
    | 'next-reschedule'
    | 'traversal-complete'
    | 'staging-start'
    | 'staging-complete'
    | 'active-list-replacement'
    | 'sort-ready'
    | 'rendered'
    | 'gather-sort-publication'
    | 'worker-ack';
  generation: number | null;
  candidateSize?: number;
  candidateNewSlots?: number;
  candidateReusedSlots?: number;
  writes?: number;
  activeCount?: number;
  planReason?: FrontierPlanReason | null;
  traversalId?: number;
  revealReady?: boolean;
  maxCentralProjectedRatio?: number;
  maxVisibleProjectedRatio?: number;
};

type RadPublicationDiagnostic = {
  frameApplied: number;
  candidateCreatedFrame: number;
  stagingCompleteFrame: number | null;
  frameSortReady: number | null;
  frameRendered: number | null;
  frameRejected: number | null;
  candidateCreatedAt: number;
  stagingCompleteAt: number | null;
  renderedAt: number | null;
  rejectedAt: number | null;
  generation: number;
  revision: number | null;
  cameraKey: string | null;
  candidateSize: number;
  candidateGlobals: number[];
  slotToNode: Array<{ slot: number; global: number }>;
  activeListVersion: number | null;
  sortedIndices: number[];
  sortedIndicesSource: 'gpu-readback' | 'cpu-mirror' | 'unavailable';
  drawCount: number | null;
  phase: 'pending' | 'rendered' | 'rejected';
  rejection?: string;
  currentRevision?: number;
  currentRevisionPending?: boolean;
  cut?: FrontierCutDiagnostic;
  slotChecks: {
    duplicate: boolean;
    outOfRange: boolean;
    displayedMutation: boolean;
  };
};

const RAD_DIAGNOSTIC_RING_SIZE = 32;
const RAD_DIAGNOSTIC_SAMPLE_SIZE = 4096;

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
/** Default drawn-splat target for the page-table frontier (Spark's `maxSplats`)
 * when the caller gives no `foveationDrawBudget`. Sized to the approved desktop
 * huge-RAD allowance (7.5M). Device budgets and explicit caps still win via
 * `min(budget, target)`. Overridable via `foveationDrawBudget` (`?foveationDraw=`). */
const PAGETABLE_DRAW_BUDGET = 7_500_000;
/**
 * Timeline/crossover incoming captures wait for a frontier at least this full
 * relative to the granted draw allocation before replacing the outgoing scene.
 * Single-scene loading is progressive and does not use this gate.
 */
const DEFAULT_RAD_INITIAL_DISPLAY_FRACTION = 0.5;

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
/** Spark's desktop RAD residency target, bounded by the capture and device. */
const RAD_CHUNK_PAGE_TARGET = 256;

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

function radChunkResidencyPages(
  scene: StreamedScene,
  profile: SplatDeviceProfile | undefined,
  options: StreamedSplatMeshOptions,
  budget: number,
): { pages: number; chunkSize: number } | { fallback: string } {
  const chunkSize = scene.chunkSize ?? SLAB_PAGE_SPLATS;
  const chunkCount = scene.chunkUrls.length;
  if (chunkSize !== SLAB_PAGE_SPLATS) return { fallback: 'non-authored-page-size' };
  if (profile?.isMobile) return { fallback: 'mobile-device' };
  const drawTarget = Math.min(budget, options.foveationDrawBudget ?? PAGETABLE_DRAW_BUDGET);
  const minimumPages = Math.ceil(drawTarget / chunkSize);
  let pages = Math.min(RAD_CHUNK_PAGE_TARGET, chunkCount);
  if (pages < minimumPages) return { fallback: 'residency-below-draw-budget' };

  const memoryBudget =
    profile?.deviceMemoryGb !== undefined ? profile.deviceMemoryGb * 1024 ** 3 * 0.45 : Infinity;
  const poolOptions = {
    capacityFactor: 1,
    floatTextures: options.poolFloatTextures,
    shBands: scene.shBands ?? options.shBands ?? 0,
    sortStrategy: options.sortStrategy,
  } as const;
  while (pages > minimumPages) {
    const bytes = estimateSplatPoolBytes(pages * chunkSize, poolOptions);
    if (bytes <= memoryBudget) break;
    pages--;
  }
  if (estimateSplatPoolBytes(pages * chunkSize, poolOptions) > memoryBudget) {
    return { fallback: 'device-memory' };
  }
  return { pages, chunkSize };
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
   * Maximum splats copied into the pool per LOD mutation tick. Classic
   * streaming defaults to 32,000; RAD page-table delivery defaults to 16,000.
   * An explicit value controls either path. Lower debug values trade refinement
   * latency for shorter frames.
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
  /**
   * First-reveal policy for page-table `.rad`. Display correctness is independent
   * of this gate: every published cover is a complete hierarchy selection with a
   * matching sort.
   *
   * - `progressive` (default): publish the first complete staged cover as soon as
   *   it exists, including early coarse coverage while descendants are still
   *   loading. The main single-scene loader selects this explicitly.
   * - `allocation-fraction`: hold the first publication until the complete cover
   *   reaches {@link radInitialDisplayFraction} of the granted draw allocation.
   *   Incoming captures in a multi-splat crossover select this with `0.5`. RAD
   *   storage chunks and hierarchy nodes are not separate captures.
   * - `projected-quality`: keep complete rendered generations hidden until
   *   selected internal nodes are within the projected-pixel reveal thresholds.
   *
   * An explicit policy takes precedence. If no policy is supplied, a numeric
   * {@link radInitialDisplayFraction} still selects `allocation-fraction` so
   * existing callers keep their hold. Unsupported strings throw rather than
   * silently enabling an allocation hold.
   */
  radInitialRevealPolicy?: 'progressive' | 'allocation-fraction' | 'projected-quality';
  /**
   * Crossover first-image target, as a fraction of the granted draw allocation.
   * Used with `radInitialRevealPolicy: 'allocation-fraction'`. Default `0.5`.
   * This is a splat-count threshold, not a fraction of downloaded bytes or of
   * nearby projected quality. `0` restores the older target-detail hold.
   */
  radInitialDisplayFraction?: number;
  /** Receives lightweight LOD mutation events for performance attribution. */
  onPerformanceEvent?: (event: StreamedSplatPerformanceEvent) => void;
  /**
   * View-dependent color (higher-order SH). This is the streaming counterpart
   * of {@link SplatMeshOptions.shBands}: besides sizing the pool it decides
   * whether SH is fetched/decoded at all. Sources that carry SH are a `Quality`
   * LCC (`.lcc`) capture, which stores coefficients per splat, and Streamed
   * SOG / `.lcc2` tiles, whose per-file palette shN is converted to that same
   * packed form at decode (see `docs/formats/streamed-shn-notes.md`).
   *
   * **Unset (the default) means every band the capture carries**, so a Quality
   * LCC scene and a Streamed SOG / `.lcc2` tile with `shN` in `meta.json` show
   * view-dependent color without the caller knowing the format. Those SOG
   * manifests never declare bands, so the loader peeks one tile (a small JSON
   * GET, or a ranged ZIP tail plus `meta.json`) and stays at 0 when the tile
   * has no `shN` or the server ignores Range. The exception is a `smooth`
   * performance profile (the default on mobile), which defaults this to 0: SH
   * adds up to 64 B/splat of pool textures (~384 MB over a 6M-splat pool at 3
   * bands) and extra per-chunk bytes - precisely the costs that profile avoids.
   *
   * Set it explicitly to override either way: 0 forces SH off, and 1, 2 or 3
   * keep 3, 8 or 15 coefficients per channel. For LCC the value is clamped to
   * what the scene actually has (a `Portable` capture fetches and allocates
   * nothing regardless); for SOG / `.lcc2` a scene with fewer bands zero-pads
   * and one with no shN simply renders DC color, wasting the allocated
   * textures if you asked for bands the file does not have.
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

/** One streamed-mesh update frame, measured on the main thread. */
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
  /** Texture copies submitted this update (core, SH and custom channels). */
  textureCopyCount: number;
  /** Live destination bytes copied, excluding padded staging rows. */
  textureCopyBytes: number;
  /** WebGPU source-index ranges queued for upload before this tick's sort. */
  activeListUpdateRanges: number;
  /** Accepted sort submissions and implementation stages for this update. */
  sortSubmissions?: number;
  sortPasses?: number;
  /** Projection submissions and stages for this update, when enabled. */
  projectionSubmissions?: number;
  projectionPasses?: number;
  appendedCount: number;
  removedCount: number;
  stagedCount: number;
  uploadCount: number;
  activeCount: number;
  forcedSort: boolean;
  compacted: boolean;
  sortReadyGeneration?: number | null;
  renderedGeneration?: number | null;
  workerAcknowledgedGeneration?: number | null;
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
  /** Geometric edits replayed onto later coarse/fine representations. */
  readonly strokes: Array<{
    readonly stroke: BrushStroke;
    readonly options: BrushStrokeSelectionOptions;
    readonly value: number;
  }>;
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
 * per-splat packed form at decode so it too survives the shared pool (opt
 * in via {@link StreamedSplatMeshOptions.shBands}; see
 * `docs/formats/streamed-shn-notes.md`).
 */
export class StreamedSplatMesh extends SplatMesh {
  private readonly scene: StreamedScene;
  /** Only RAD prefixes need a global publish wave; manifest cuts are region-atomic. */
  private readonly usesRadWave: boolean;
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
  /** Worker-side RAD plan cap; separate default, shared explicit override. */
  private readonly pageTableWriteCap: number;
  private readonly onPerformanceEvent: ((event: StreamedSplatPerformanceEvent) => void) | undefined;
  private compactionCount = 0;

  private readonly cache = new Map<number, CachedChunk>();
  /** Running byte total of {@link cache}; maintained by {@link cacheChunk}, eviction and dispose. */
  private cacheBytesTotal = 0;
  /** In-flight chunk fetches. The kind is kept so a weight change can shed the
   * speculative ones without touching the detail that is actually on screen. */
  private readonly fetching = new Map<
    number,
    {
      controller: AbortController;
      kind: ChunkFetchKind;
      classicWant?: ClassicFetchWant;
      demandGeneration: number;
      cameraEpoch: number;
      demandKey: string;
      requestedCameraPosition: readonly [number, number, number] | null;
    }
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
  /** Whole RAD chunks backed by stable inactive pool ranges in chunk-page mode. */
  private readonly radChunkPages = new Map<
    number,
    { readonly range: SplatRange; readonly count: number; lastUsed: number }
  >();
  private readonly radChunkAllocator: RadChunkPageAllocator | null;
  private readonly radChunkPageLookup = new Map<number, number>();
  private radChunkPageLookupRevision = -1;
  private readonly radChunkResidency: boolean;
  private readonly radResidencyRequestedValue: 'indexed' | 'chunk-pages';
  private readonly radResidencyFallbackReasonValue: string | null;
  private radChunkDisplayedGlobals: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
  private readonly radChunkDisplayedFiles = new Set<number>();
  private radChunkDisplayedSelectionHashA: number | null = null;
  private radChunkDisplayedSelectionHashB: number | null = null;
  private radChunkPendingGlobals: Uint32Array | null = null;
  private radChunkPendingFiles: Set<number> | null = null;
  private radChunkPendingSelectionHashA: number | null = null;
  private radChunkPendingSelectionHashB: number | null = null;
  private radChunkPendingBudgetSettled = false;
  private radChunkMappedSlots = new Uint32Array(0);
  private radChunkPublishGeneration: number | null = null;
  private radChunkPublishRevision: number | null = null;
  private radChunkPublishActiveListVersion: number | null = null;
  private radChunkSelectionIdValue = 0;
  private radChunkCommittedSelectionIdValue = 0;
  private radChunkPendingSelectionIdValue: number | null = null;
  private radChunkHardValidityRevisionValue = 0;
  private radChunkPendingHardValidityRevisionValue = 0;
  private radChunkPendingPageIdentity: Map<number, number> | null = null;
  private radChunkSelectionCompletedAtValue: number | null = null;
  private radChunkSortSubmittedAtValue: number | null = null;
  private radChunkRenderedAtValue: number | null = null;
  private radChunkCameraObsoleteValue = false;
  private radChunkLastInvalidationReasonValue: string | null = null;
  private radChunkPendingRevealQuality: {
    revealReady: boolean;
    maxCentralProjectedRatio: number;
    maxVisibleProjectedRatio: number;
  } | null = null;
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
    handlerMs: 0,
    worstApplyMs: 0,
    writeMs: 0,
    residentMs: 0,
    mappingMs: 0,
    pageIdentityMs: 0,
    activeListMs: 0,
    installMs: 0,
    protectionMs: 0,
    unifiedGatherMs: 0,
    sortMs: 0,
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
    pageInstalls: 0,
    pageInstallMs: 0,
    uncovered: 0,
    retiredEarly: 0,
    cacheFull: false,
    cacheBytes: 0,
    cacheLimitBytes: 0,
    activePageTableFetches: 0,
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
   * Slab slots to reserve for the current draw grant. Indexed page-table
   * staging may use up to 2× that grant (capped at the pool ceiling) so
   * newcomers land in unused slots until the matching sort is published.
   */
  private get pageTableStagingSlots(): number {
    const draw = this.pageTableDrawBudget;
    if (draw <= 0) return 0;
    if (this.indexedPageTable) {
      const doubled = Math.max(this.slabPageSplats, 2 * draw);
      return Math.min(
        this.slabCeiling,
        Math.ceil(doubled / this.slabPageSplats) * this.slabPageSplats,
      );
    }
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
  /** Occupied page-table slots, including a replacement staged behind the drawn prefix. */
  private pageTableResident = 0;
  /** Page-table slot → stable `.rad` global splat ID. */
  private pageTableGlobals = new Uint32Array(0);
  private pageTableDisplayGeneration = -1;
  private indexedPageTable = false;
  private indexedPublishGeneration: number | null = null;
  private indexedPublishActiveListVersion: number | null = null;
  private indexedPublishRevision: number | null = null;
  private indexedPublishedGeneration = -1;
  private sortReadyGenerationValue: number | null = null;
  private renderedGenerationValue: number | null = null;
  private workerAcknowledgedGenerationValue: number | null = null;
  private indexedDisplayedSlots = new Uint32Array(0);
  private indexedPendingDisplaySlots: Uint32Array | null = null;
  private indexedStagingGeneration: number | null = null;
  private indexedResizeAwaiting: number | null = null;
  private radRevealPolicy: 'progressive' | 'allocation-fraction' | 'projected-quality' =
    'progressive';
  private radDisplayFraction: number | undefined;
  /** Draw grant the host asked for, before storage reservation clamps it. */
  private pageTableRequestedDraw = 0;
  private frontierConverged = true;
  private pendingFrontierSplats = 0;
  private staleResidentSplats = 0;
  private lastPlanAppends = 0;
  private lastPlanMoves = 0;
  private lastPlanGeneration = 0;
  private lastPlanBudget = 0;
  private lastPlanCamera: readonly [number, number, number] | null = null;
  private firstFrontierCamera: readonly [number, number, number] | null = null;
  private frontierTraversal = {
    strategy: 'one-pass' as 'one-pass' | 'heap' | 'bounded-threshold',
    fallback: false,
    fallbackCount: 0,
    rootCoverInfeasible: false,
    traversalMs: 0,
    traversalId: 0,
  };
  private lastPlanReason: FrontierPlanReason | null = null;
  private candidateCancellationCount = 0;
  private boundedCutRefusalReason: FrontierPlanMessage['boundedCutRefusalReason'] = undefined;
  private protectedCacheBytesValue = 0;
  private lastSkipSamples: readonly FrontierSkipSample[] = [];
  private readonly frontierGenerationTrace: FrontierGenerationTraceEvent[] = [];
  private readonly radPublicationDiagnostics: RadPublicationDiagnostic[] = [];
  private indexedPendingDiagnostic: RadPublicationDiagnostic | null = null;
  private radDiagnosticRenderer: THREE.WebGPURenderer | null = null;
  private revealReadyValue = false;
  private maxCentralProjectedRatioValue = 0;
  private maxVisibleProjectedRatioValue = 0;
  private firstRevealCentralProjectedRatioValue: number | null = null;
  private firstRevealVisibleProjectedRatioValue: number | null = null;
  private firstRevealGenerationValue: number | null = null;
  private indexedPendingRevealQuality: {
    revealReady: boolean;
    maxCentralProjectedRatio: number;
    maxVisibleProjectedRatio: number;
  } | null = null;
  private frontierTraceStagingGeneration: number | null = null;
  private lastWorkerSnapshot: FrontierSnapshotReply | null = null;
  private nextSnapshotRequestId = 0;
  private pageTableHostCacheRevision = 0;
  private readonly snapshotWaiters = new Map<
    number,
    (snapshot: FrontierSnapshotReply | null) => void
  >();
  private lastPostedCamera: readonly [number, number, number] | null = null;
  private lastPostedForward: readonly [number, number, number] | null = null;
  private lastPostedProjection: readonly number[] = [];
  private lastPostedLimit = 0;
  private lastCountedTraversalId = 0;
  /** Monotonic reschedule id; a stale plan (superseded by a newer request) is
   * dropped. `pageTableInFlight` coalesces to one outstanding traversal. */
  private pageTableSeq = 0;
  private pageTableInFlight = false;
  /** Sequence currently allowed to clear the in-flight traversal state. */
  private pageTableActiveSeq = 0;
  /** Replacement walk waiting for its first partial or complete demand. */
  private replacementAwaitingFirstDemandSeq: number | null = null;
  /** Replacement allowed to finish while subsequent movement coalesces. */
  private pageTableReplacementSeq: number | null = null;
  /** Finish the worker's current bounded cut before solving the latest camera. */
  private pageTableContinuePending = false;
  private pageTableDisposed = false;
  private startupMainRadLodHold:
    | {
        camera: THREE.Camera;
        settledPosition?: THREE.Vector3;
      }
    | undefined;
  private lastLiveCamera: THREE.Camera | null = null;
  /** Terminal page-table worker fault; retained for hosts to present recovery UI. */
  private streamingErrorValue: SplatLoadError | null = null;
  /** Files whose data has been forwarded to the worker (so we don't refetch). */
  private readonly pageTableCachedFiles = new Set<number>();
  /** Chunks the last frontier wanted but did not have, biggest-on-screen first.
   * These outrank the background sweep - they are the detail actually on screen. */
  private pageTableFetchPriority: readonly number[] = [];
  private demandGeneration = 0;
  /** Current camera revision whose unchanged, budget-full cut needs no more pages. */
  private radChunkDemandSettledRevision = -1;
  private radChunkDemandSettledCamera: readonly [number, number, number] | null = null;
  private radChunkDemandSettledForward: readonly [number, number, number] | null = null;
  private radChunkDemandSettledLimit = 0;
  private radChunkDemandSettledConfig = '';
  /** Changes with each queued camera/configuration identity, before posting. */
  private cameraEpoch = 0;
  private demandKey = '';
  private latestDemandCamera: readonly [number, number, number] | null = null;
  /** True when the latest camera/config has not yet been posted to the worker. */
  private demandNeedsNewRevision = false;
  private radFrame = 0;
  private demandWants: readonly FrontierDemandWant[] = [];
  private readonly demandFirstSeen = new Map<number, number>();
  private demandReadyGeneration = -1;
  /** Prevents repeated reclamation while one hard relocation is still queued. */
  private hardRelocationPending = false;
  /** Internal benchmark counters; never part of the exported mesh interface. */
  private readonly demandDiagnostics = {
    generation: 0,
    cameraEpoch: 0,
    demandKey: '',
    requestedCameraPosition: null as readonly [number, number, number] | null,
    replies: 0,
    staleReplies: 0,
    cancellations: 0,
    staleRequestsCancelled: 0,
    protectedFilesRetained: [] as number[],
    staleCancellationReason: null as string | null,
    activeRequestsBeforeReclamation: 0,
    activeRequestsAfterReclamation: 0,
    hardRelocations: 0,
    requests: 0,
    completed: 0,
    knownRequestedBytes: 0,
    knownCompletedBytes: 0,
    requestToDecodeMs: 0,
    hardRelocationDetectedAt: null as number | null,
    replacementTraversalPostedAt: null as number | null,
    oldTraversalCancelledAt: null as number | null,
    firstReplacementSliceAt: null as number | null,
    firstCurrentRevisionDemandAt: null as number | null,
    firstCurrentRevisionFetchAt: null as number | null,
    completedTraversalAt: null as number | null,
    firstPublicationAt: null as number | null,
    cameraToFirstFetchMs: null as number | null,
  };
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
  /** @internal */
  pageTableCacheAtLimit = false;

  /** Per-splat channels whose edits survive chunk eviction/reload. */
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
    const extension = splatUrlExtension(new URL(absoluteUrl));
    const format: Exclude<StreamedSplatFormat, 'auto'> =
      options.format !== undefined && options.format !== 'auto'
        ? options.format
        : extension === '.lcc2'
          ? 'lcc2'
          : extension === '.lcc'
            ? 'lcc'
            : extension === '.rad'
              ? 'rad'
              : 'streamed-sog';
    return StreamedSplatMesh.fromSource(
      httpDatasetSource(absoluteUrl, options.request),
      format,
      options,
      absoluteUrl,
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
      const mesh = await StreamedSplatMesh.fromSource(
        dataset.source,
        dataset.format,
        options,
        dataset.name,
      );
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
    sourceLabel = source.manifestUrl,
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
    // Spark runs this scene at ~7.5M drawn splats on desktop. (The old 2.5M
    // `RAD_PREFIX_DEFAULT_BUDGET` cap was a fallback for the whole-scene prefix
    // reader before the pager landed; capping the frontier at 2.5M starves it
    // and it stays coarse near the camera.)
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
    // to avoid. Classic `.lcc` / `.rad` read the count from the file; Streamed
    // SOG / `.lcc2` peek one tile's `meta.json` (those manifests omit shN).
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
          const { resolvePaletteShBands } = await import('../formats/sog/peek-sog-sh');
          // LCC2 tiles are SOG v2. The manifest never states shN, so peek one
          // tile unless the caller or the `smooth` profile already decided.
          scene = buildLcc2Scene(
            json,
            source,
            sourceOptions,
            await resolvePaletteShBands('lcc2', json, source, options.shBands, shBands !== 0, {
              request: options.request,
              signal,
            }),
          );
        } else if (format === 'lcc') {
          const { buildLccScene } = await import('../formats/lcc');
          scene = await buildLccScene(json, source, { ...sourceOptions, shBands });
        } else {
          const { resolvePaletteShBands } = await import('../formats/sog/peek-sog-sh');
          // Streamed SOG's lod-meta.json also omits shN. Peek the first chunk's
          // meta.json so a capture that carries bands gets them without an
          // explicit `shBands` (still declined on `smooth`, and by `shBands: 0`).
          scene = buildSogScene(
            json,
            source,
            sourceOptions,
            await resolvePaletteShBands(
              'streamed-sog',
              json,
              source,
              options.shBands,
              shBands !== 0,
              { request: options.request, signal },
            ),
          );
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
    // Indexed page-table needs two complete selections in reserved storage.
    // Other formats keep the 1.5× staged-swap slack (1.4× when swaps are off).
    const capacityFactor = isPageTableFoveation(resolvedFoveationMode)
      ? 2
      : options.experimentalStagedSwaps !== false
        ? 1.5
        : 1.4;
    const requestedRadChunkResidency =
      format === 'rad' && experiments.radResidency === 'chunk-pages';
    const radResidencyDecision = requestedRadChunkResidency
      ? isPageTableFoveation(resolvedFoveationMode)
        ? radChunkResidencyPages(scene, deviceProfile, options, budget)
        : { fallback: 'requires-page-table' }
      : null;
    const radChunkCapacitySplats =
      radResidencyDecision !== null && 'pages' in radResidencyDecision
        ? radResidencyDecision.pages * radResidencyDecision.chunkSize
        : 0;
    const useRadChunkResidency = radChunkCapacitySplats > 0;
    if (requestedRadChunkResidency && !useRadChunkResidency) {
      warn(
        `StreamedSplatMesh: RAD chunk residency fallback (${(radResidencyDecision as { fallback: string }).fallback}); ` +
          'retaining the indexed selected-splat path.',
      );
    }
    const capacityRows = Math.max(
      1,
      useRadChunkResidency
        ? Math.ceil(radChunkCapacitySplats / DATA_TEXTURE_WIDTH)
        : Math.ceil((residentCeiling * capacityFactor) / DATA_TEXTURE_WIDTH),
    );

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
    let mesh: StreamedSplatMesh;
    try {
      mesh = new StreamedSplatMesh(
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
        sourceLabel,
        useRadChunkResidency,
        requestedRadChunkResidency,
        requestedRadChunkResidency &&
          !useRadChunkResidency &&
          radResidencyDecision &&
          'fallback' in radResidencyDecision
          ? radResidencyDecision.fallback
          : null,
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw toSplatLoadError(error, { phase: 'worker', url: source.manifestUrl });
    }
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
    sourceLabel?: string,
    radChunkResidency = false,
    radResidencyRequested = false,
    radResidencyFallbackReason: string | null = null,
  ) {
    const meshOptions: SplatMeshOptions =
      sourceLabel === undefined
        ? options
        : ({ ...options, [splatMeshSourceLabel]: sourceLabel } as SplatMeshOptions);
    super({ capacity }, meshOptions);
    this.scene = scene;
    this.radChunkResidency = radChunkResidency;
    this.radResidencyRequestedValue = radResidencyRequested ? 'chunk-pages' : 'indexed';
    this.radResidencyFallbackReasonValue = radResidencyFallbackReason;
    this.radChunkAllocator = radChunkResidency
      ? new RadChunkPageAllocator(
          Math.floor(capacity / (scene.chunkSize ?? SLAB_PAGE_SPLATS)),
          scene.chunkSize ?? SLAB_PAGE_SPLATS,
        )
      : null;
    this.usesRadWave = scene.chunkOptions?.some((chunk) => chunk?.format === 'rad-chunk') ?? false;
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
    this.pageTableWriteCap =
      options.maxSplatsPerSwap === undefined ? DEFAULT_PAGE_TABLE_WRITES_PER_PLAN : this.appendCap;
    if (options.radInitialDisplayFraction !== undefined) {
      validateRadInitialDisplayFraction(options.radInitialDisplayFraction);
    }
    const initialRadRevealPolicy = resolveRadInitialRevealPolicy(options);
    this.radRevealPolicy = initialRadRevealPolicy;
    this.radDisplayFraction = options.radInitialDisplayFraction;
    this.revealReadyValue = initialRadRevealPolicy !== 'projected-quality';
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
    // Chunked formats need a ceiling based on their decoded chunks. Keep the
    // format check for custom RAD sources that do not expose `chunkSize`.
    const isChunkedRad = scene.chunkOptions?.[0]?.format === 'rad-chunk';
    const cacheCeilingBytes =
      isPageTable || scene.chunkSize !== undefined || isChunkedRad
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
      if (initialRadRevealPolicy === 'projected-quality') this.setRevealMultiplier(0);
      // Frontier draw target: an explicit `foveationDrawBudget` (`?foveationDraw=`)
      // wins for A/B; otherwise Spark's default. Never above the pool budget.
      this.pageTableDrawTarget = options.foveationDrawBudget ?? PAGETABLE_DRAW_BUDGET;
      this.pageTableDrawTargetExplicit = options.foveationDrawBudget !== undefined;
      this.pageTableRequestedDraw = Math.min(budget, this.pageTableDrawTarget);
      this.pageTableDrawBudget = this.pageTableRequestedDraw;
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
      this.indexedPageTable = true;
      if (!this.radChunkResidency) {
        this.slabPageSplats = Math.min(SLAB_PAGE_SPLATS, capacity);
        this.slabCeiling = capacity;
        this.syncSlabPages(this.pageTableStagingSlots);
        this.acceptDrawReservation();
      }
      this.frontierWorker = new FrontierWorkerCtor();
      this.frontierWorker.onmessage = (
        e: MessageEvent<
          | FrontierPlanMessage
          | FrontierDemandReply
          | FrontierTraversalCancelledReply
          | FrontierResizeSafeMessage
          | FrontierSnapshotReply
        >,
      ) => this.handleFrontierMessage(e.data);
      this.frontierWorker.onerror = (event: ErrorEvent) => this.failFrontierWorker(event);
      this.frontierWorker.onmessageerror = (event: MessageEvent) => this.failFrontierWorker(event);
      this.pagerSlots = this.slabSlots;
      this.postToWorker({
        type: 'init',
        pagerMode: this.radChunkResidency ? 'chunk-pages' : 'indexed',
        capacity: this.radChunkResidency ? capacity : this.pagerSlots,
        chunkSize: scene.chunkSize ?? 65536,
        cpuCacheBytes: this.cacheLimitBytes,
        maxPlanWrites: this.pageTableWriteCap,
        diagnostics: this.onPerformanceEvent !== undefined,
        initialPublishMinSplats: initialPublishMinSplats(
          initialRadRevealPolicy,
          options.radInitialDisplayFraction,
          this.pageTableDrawBudget,
        ),
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

    if (this.indexedPageTable && slots > target) {
      // Keep physical pages until the worker proves the tail is unused.
      if (this.indexedResizeAwaiting !== target) {
        this.indexedResizeAwaiting = target;
        this.postToWorker({ type: 'resize', capacity: target });
        this.pendingWork = true;
        this.lastScheduleTime = -Infinity;
      }
      return;
    }

    if (this.indexedPageTable) this.indexedResizeAwaiting = null;

    while (this.slabPages.length > 1) {
      const last = this.slabPages[this.slabPages.length - 1] as SplatRange;
      if (slots - last.count < target) break;
      this.slabPages.pop();
      slots -= last.count;
      this.removeRange(last);
    }

    if (slots !== this.pagerSlots) {
      const globals = new Uint32Array(slots);
      globals.fill(0xffffffff);
      globals.set(this.pageTableGlobals.subarray(0, Math.min(slots, this.pageTableGlobals.length)));
      this.pageTableGlobals = globals;
      this.pagerSlots = slots;
      this.postToWorker({ type: 'resize', capacity: slots });
      // Slots beyond the new count are gone from the pager, so stop drawing
      // them; the next plan re-establishes the resident prefix.
      this.pageTableResident = Math.min(this.pageTableResident, slots);
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
  private writeSlabSlots(data: PlanSplats, slot: number, count: number): void {
    let written = 0;
    while (written < count) {
      const at = slot + written;
      const page = this.slabPages[Math.floor(at / this.slabPageSplats)];
      if (!page) return; // beyond reserved storage; `dropped` already warns
      const offset = at % this.slabPageSplats;
      const run = Math.min(count - written, this.slabPageSplats - offset);
      const slice = slicePlanRun(data, written, run);
      this.overwriteRangeData(page, slice, offset);
      this.pageTableGlobals.set(slice.globals, at);
      this.applyPersistentSlabRun(page, offset, slice);
      written += run;
    }
  }

  /** Indexed candidates write stable, possibly sparse slots without relocation. */
  private writeIndexedSlabSlots(data: PlanSplats, slots: Uint32Array): void {
    let i = 0;
    while (i < slots.length) {
      const start = slots[i] as number;
      let run = 1;
      while (i + run < slots.length && (slots[i + run] as number) === start + run) run++;
      this.writeSlabSlots(slicePlanRun(data, i, run), start, run);
      i += run;
    }
  }

  /** Converts worker-local slab slots to the actual indices of shared pool pages. */
  private poolIndicesForSlabSlots(slots: Uint32Array): Uint32Array {
    const indices = new Uint32Array(slots.length);
    const pageStarts = new Uint32Array(this.slabPages.length);
    for (let page = 0; page < this.slabPages.length; page++) {
      pageStarts[page] = this.poolRangeBacking(this.slabPages[page] as SplatRange).start;
    }
    if (this.slabPageSplats === 65_536) {
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i] as number;
        const page = slot >>> 16;
        if (page >= pageStarts.length) {
          throw new RangeError('Indexed RAD publication references unavailable storage.');
        }
        indices[i] = (pageStarts[page] as number) + (slot & 0xffff);
      }
      return indices;
    }
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i] as number;
      const page = Math.floor(slot / this.slabPageSplats);
      if (page >= pageStarts.length) {
        throw new RangeError('Indexed RAD publication references unavailable storage.');
      }
      indices[i] = (pageStarts[page] as number) + slot - page * this.slabPageSplats;
    }
    return indices;
  }

  private filesForIndexedSlots(slots: Uint32Array): number[] {
    const chunkSize = this.scene.chunkSize ?? 65536;
    const files: number[] = [];
    for (const slot of slots) {
      const global = this.pageTableGlobals[slot];
      if (global === undefined || global === 0xffffffff) continue;
      files.push(Math.floor(global / chunkSize));
    }
    return files;
  }

  private resumeIndexedRefinementAfterPublication(): void {
    if (this.radChunkResidency && this.lastLiveCamera && !this.pageTableInFlight) {
      const now = performance.now();
      this.pendingWork = false;
      this.lastScheduleTime = now;
      this.reschedule(this.lastLiveCamera, now);
      return;
    }
    const camera = this.lastPostedCamera;
    const forward = this.lastPostedForward;
    if (!camera || !forward || this.pageTableInFlight) return;
    this.pendingWork = false;
    this.lastScheduleTime = performance.now();
    this.reschedulePageTable(
      new THREE.Vector3(...camera),
      new THREE.Vector3(...forward),
      new THREE.Frustum(),
      this.lastScheduleTime,
      this.lastPostedProjection ?? [],
    );
  }

  /** Chunk pages own stable slots and do not use the reverse active-slot map. */
  protected override tracksActivePoolSlots(): boolean {
    return !this.radChunkResidency;
  }

  private sampleRadDiagnosticValues(values: ArrayLike<number>, count = values.length): number[] {
    const size = Math.min(count, RAD_DIAGNOSTIC_SAMPLE_SIZE);
    if (size === 0) return [];
    const sample = new Array<number>(size);
    if (count <= size) {
      for (let i = 0; i < size; i++) sample[i] = values[i] as number;
      return sample;
    }
    const head = Math.floor(size / 2);
    for (let i = 0; i < head; i++) sample[i] = values[i] as number;
    for (let i = head; i < size; i++) sample[i] = values[count - size + i] as number;
    return sample;
  }

  private sortedRadDiagnosticIndices(count: number): number[] {
    const mesh = this as unknown as {
      splatIndexAttribute?: { array?: ArrayLike<number> };
    };
    const array = mesh.splatIndexAttribute?.array;
    return array ? this.sampleRadDiagnosticValues(array, count) : [];
  }

  private finishRadPublicationDiagnostic(
    diagnostic: RadPublicationDiagnostic,
    count: number,
  ): void {
    const renderer = this.radDiagnosticRenderer;
    const mesh = this as unknown as {
      splatIndexAttribute?: THREE.StorageInstancedBufferAttribute;
    };
    const attribute = mesh.splatIndexAttribute;
    const isWebGpu =
      (renderer?.backend as { isWebGPUBackend?: boolean } | undefined)?.isWebGPUBackend === true;
    if (!renderer || !attribute || !isWebGpu || count === 0) {
      diagnostic.sortedIndices = this.sortedRadDiagnosticIndices(count);
      diagnostic.sortedIndicesSource = attribute ? 'cpu-mirror' : 'unavailable';
      this.recordRadPublicationDiagnostic(diagnostic);
      return;
    }

    const sampleCount = Math.min(count, RAD_DIAGNOSTIC_SAMPLE_SIZE);
    const headCount = Math.ceil(sampleCount / 2);
    const tailCount = sampleCount - headCount;
    const read = (offset: number, length: number): Promise<number[]> =>
      renderer
        .getArrayBufferAsync(
          attribute,
          null,
          offset * Float32Array.BYTES_PER_ELEMENT,
          length * Float32Array.BYTES_PER_ELEMENT,
        )
        .then((buffer) => Array.from(new Float32Array(buffer)));
    void Promise.all([
      read(0, headCount),
      tailCount > 0 ? read(count - tailCount, tailCount) : Promise.resolve([]),
    ])
      .then(([head, tail]) => {
        diagnostic.sortedIndices = head.concat(tail);
        diagnostic.sortedIndicesSource = 'gpu-readback';
        this.recordRadPublicationDiagnostic(diagnostic);
      })
      .catch(() => {
        diagnostic.sortedIndices = this.sortedRadDiagnosticIndices(count);
        diagnostic.sortedIndicesSource = 'unavailable';
        this.recordRadPublicationDiagnostic(diagnostic);
      });
  }

  private beginRadPublicationDiagnostic(
    plan: FrontierPlanMessage,
  ): RadPublicationDiagnostic | null {
    if (
      !this.indexedPageTable ||
      this.onPerformanceEvent === undefined ||
      plan.candidateGeneration === undefined
    ) {
      return null;
    }
    const generation = plan.candidateGeneration;
    if (
      this.indexedPendingDiagnostic &&
      this.indexedPendingDiagnostic.generation !== generation &&
      this.indexedPublishGeneration !== this.indexedPendingDiagnostic.generation
    ) {
      const superseded = this.indexedPendingDiagnostic;
      superseded.phase = 'rejected';
      superseded.rejection = 'superseded-candidate';
      superseded.frameRejected = this.radFrame;
      superseded.rejectedAt = performance.now();
      this.recordRadPublicationDiagnostic(superseded);
      this.indexedPendingDiagnostic = null;
    }
    const now = performance.now();
    const candidateGlobals = Array.from(plan.diagnosticCandidateGlobals ?? []);
    let diagnostic = this.indexedPendingDiagnostic;
    if (!diagnostic || diagnostic.generation !== generation) {
      diagnostic = {
        frameApplied: this.radFrame,
        candidateCreatedFrame: this.radFrame,
        stagingCompleteFrame: null,
        frameSortReady: null,
        frameRendered: null,
        frameRejected: null,
        candidateCreatedAt: now,
        stagingCompleteAt: null,
        renderedAt: null,
        rejectedAt: null,
        generation,
        revision: plan.candidateRevision ?? null,
        cameraKey: plan.candidateCameraKey ?? null,
        candidateSize: plan.candidateSize ?? candidateGlobals.length,
        candidateGlobals,
        slotToNode: [],
        activeListVersion: null,
        sortedIndices: [],
        sortedIndicesSource: 'unavailable',
        drawCount: null,
        phase: 'pending',
        cut: plan.diagnosticCut,
        slotChecks: { duplicate: false, outOfRange: false, displayedMutation: false },
      };
      this.indexedPendingDiagnostic = diagnostic;
    } else {
      diagnostic.candidateSize = plan.candidateSize ?? diagnostic.candidateSize;
      if (candidateGlobals.length > 0) diagnostic.candidateGlobals = candidateGlobals;
      diagnostic.revision = plan.candidateRevision ?? diagnostic.revision;
      diagnostic.cameraKey = plan.candidateCameraKey ?? diagnostic.cameraKey;
      diagnostic.cut = plan.diagnosticCut ?? diagnostic.cut;
    }
    if (plan.candidateComplete && diagnostic.stagingCompleteFrame === null) {
      diagnostic.stagingCompleteFrame = this.radFrame;
      diagnostic.stagingCompleteAt = now;
    }
    return diagnostic;
  }

  private rejectRadPublicationDiagnostic(
    diagnostic: RadPublicationDiagnostic,
    reason: string,
    currentRevision?: number,
    currentRevisionPending?: boolean,
  ): void {
    diagnostic.phase = 'rejected';
    diagnostic.rejection = reason;
    diagnostic.frameRejected = this.radFrame;
    diagnostic.rejectedAt = performance.now();
    if (currentRevision !== undefined) diagnostic.currentRevision = currentRevision;
    if (currentRevisionPending !== undefined) {
      diagnostic.currentRevisionPending = currentRevisionPending;
    }
    this.recordRadPublicationDiagnostic(diagnostic);
    if (this.indexedPendingDiagnostic === diagnostic) this.indexedPendingDiagnostic = null;
  }

  private recordRadPublicationDiagnostic(diagnostic: RadPublicationDiagnostic): void {
    if (this.onPerformanceEvent === undefined) return;
    this.radPublicationDiagnostics.push(diagnostic);
    if (this.radPublicationDiagnostics.length > RAD_DIAGNOSTIC_RING_SIZE) {
      this.radPublicationDiagnostics.shift();
    }
    console.debug('[vlam:rad-publication]', JSON.stringify(diagnostic));
  }

  private indexedPublicationIsCurrent(): boolean {
    return (
      (this.indexedPublishRevision === null ||
        this.indexedPublishRevision === this.demandGeneration) &&
      !this.demandNeedsNewRevision
    );
  }

  /** Maps a complete selection once while retaining the page summary used by protection. */
  private mapRadChunkSelection(globals: ArrayLike<number>): {
    slots: Uint32Array;
    pageIdentity: Map<number, number>;
    mappingMs: number;
    selectionHashA: number;
    selectionHashB: number;
  } | null {
    const allocator = this.radChunkAllocator;
    if (!allocator) return null;
    const startedAt = performance.now();
    if (this.radChunkMappedSlots.length < globals.length) {
      this.radChunkMappedSlots = new Uint32Array(globals.length);
    }
    const slots = this.radChunkMappedSlots.subarray(0, globals.length);
    const pageIdentity = new Map<number, number>();
    const chunkSize = allocator.chunkSize;
    if (this.radChunkPageLookupRevision !== allocator.revision) {
      this.radChunkPageLookup.clear();
      this.radChunkPageLookupRevision = allocator.revision;
    }
    let previousFile = -1;
    let previousPage = -1;
    let selectionHashA = 2166136261;
    let selectionHashB = 3735928559;
    const now = performance.now();
    for (let i = 0; i < globals.length; i++) {
      const global = globals[i] as number;
      const file = Math.floor(global / chunkSize);
      if (file !== previousFile) {
        const cachedPage = this.radChunkPageLookup.get(file);
        const page = cachedPage === undefined ? allocator.pageOf(file) : cachedPage;
        if (page === undefined) return null;
        if (cachedPage === undefined) this.radChunkPageLookup.set(file, page);
        previousFile = file;
        previousPage = page;
        pageIdentity.set(file, page);
        const resident = this.radChunkPages.get(file);
        if (resident) resident.lastUsed = now;
      }
      slots[i] = previousPage * chunkSize + (global - file * chunkSize);
      selectionHashA = Math.imul(selectionHashA ^ global, 16777619) >>> 0;
      selectionHashB = Math.imul(selectionHashB ^ (global + i), 2246822519) >>> 0;
    }
    return {
      slots,
      pageIdentity,
      mappingMs: performance.now() - startedAt,
      selectionHashA,
      selectionHashB,
    };
  }

  /** A page may not be reused while its selection is being sorted or rendered. */
  private radChunkPendingPageIdentityIsCurrent(): boolean {
    if (!this.radChunkPendingPageIdentity || !this.radChunkAllocator) return false;
    for (const [file, page] of this.radChunkPendingPageIdentity) {
      if (this.radChunkAllocator.pageOf(file) !== page) return false;
    }
    return true;
  }

  private discardIndexedPublication(reason: string): void {
    if (this.radChunkResidency) {
      if (this.radChunkPendingGlobals === null && this.radChunkPublishGeneration === null) return;
      this.radChunkHardValidityRevisionValue++;
      this.radChunkLastInvalidationReasonValue = reason;
      const indices = this.poolIndicesForRadGlobals(this.radChunkDisplayedGlobals);
      if (indices) {
        this.replaceActiveIndices(indices);
        this.retainVisibleInstanceCount(this.radChunkDisplayedGlobals.length);
      }
      this.radChunkPendingGlobals = null;
      this.radChunkPublishGeneration = null;
      this.radChunkPublishRevision = null;
      this.radChunkPublishActiveListVersion = null;
      this.radChunkPendingSelectionIdValue = null;
      this.radChunkPendingHardValidityRevisionValue = this.radChunkHardValidityRevisionValue;
      this.radChunkPendingPageIdentity = null;
      this.radChunkPendingFiles = null;
      this.radChunkPendingSelectionHashA = null;
      this.radChunkPendingSelectionHashB = null;
      this.radChunkPendingBudgetSettled = false;
      this.radChunkPendingRevealQuality = null;
      if (this.indexedPendingDiagnostic) {
        this.rejectRadPublicationDiagnostic(this.indexedPendingDiagnostic, reason);
      }
      return;
    }
    const pending = this.indexedPendingDisplaySlots;
    const previous = this.indexedDisplayedSlots;
    if (!pending && this.indexedPublishGeneration === null) return;
    const previousSet = new Set(previous);
    if (pending) {
      for (const slot of pending) {
        if (!previousSet.has(slot) && slot < this.pageTableGlobals.length) {
          this.degenerateSlabSlots(slot, 1);
        }
      }
    }
    this.replaceActiveIndices(this.poolIndicesForSlabSlots(previous));
    this.retainVisibleInstanceCount(previous.length);
    this.indexedPendingDisplaySlots = null;
    this.indexedPublishGeneration = null;
    this.indexedPublishActiveListVersion = null;
    this.indexedPublishRevision = null;
    this.indexedPendingRevealQuality = null;
    if (this.indexedPendingDiagnostic) {
      this.rejectRadPublicationDiagnostic(this.indexedPendingDiagnostic, reason);
    }
  }

  protected override onActiveListReady(activeListVersion: number): void {
    if (this.radChunkResidency) {
      const generation = this.radChunkPublishGeneration;
      if (generation === null || this.pageTableDisposed) return;
      if (
        this.radChunkPendingHardValidityRevisionValue !== this.radChunkHardValidityRevisionValue
      ) {
        this.discardIndexedPublication('hard-validity-revision');
        this.pendingWork = true;
        this.lastScheduleTime = -Infinity;
        return;
      }
      if (!this.radChunkPendingPageIdentityIsCurrent()) {
        this.discardIndexedPublication('page-identity-changed');
        this.pendingWork = true;
        this.lastScheduleTime = -Infinity;
        return;
      }
      if ((this.radChunkPendingGlobals?.length ?? 0) > this.pageTableDrawBudget) {
        this.discardIndexedPublication('draw-budget-reduced');
        this.pendingWork = true;
        this.lastScheduleTime = -Infinity;
        return;
      }
      if (activeListVersion !== this.radChunkPublishActiveListVersion) return;
      this.sortReadyGenerationValue = generation;
      if (this.onPerformanceEvent !== undefined) {
        console.debug(
          '[vlam:rad-chunk-sort]',
          JSON.stringify({
            generation,
            selectionId: this.radChunkPendingSelectionIdValue,
            activeListVersion,
            count: this.radChunkPendingGlobals?.length ?? 0,
            cameraObsolete: this.radChunkCameraObsoleteValue,
            state: 'ready',
          }),
        );
      }
      this.retainVisibleInstanceCount(this.radChunkPendingGlobals?.length ?? 0);
      return;
    }
    const generation = this.indexedPublishGeneration;
    if (generation === null || this.pageTableDisposed) return;
    if (!this.indexedPublicationIsCurrent()) {
      this.discardIndexedPublication('stale-camera-or-configuration-revision');
      return;
    }
    if (activeListVersion !== this.indexedPublishActiveListVersion) return;
    const next = this.indexedPendingDisplaySlots;
    if (!next) return;
    this.sortReadyGenerationValue = generation;
    // The candidate order is now installed, so draw its exact visible count.
    // The old slot ownership remains protected until onActiveListRendered.
    this.retainVisibleInstanceCount(next.length);
    if (this.indexedPendingDiagnostic) {
      this.indexedPendingDiagnostic.frameSortReady = this.radFrame;
      this.indexedPendingDiagnostic.activeListVersion = activeListVersion;
      this.indexedPendingDiagnostic.drawCount = next.length;
    }
    this.recordFrontierTrace('sort-ready', {
      generation,
      activeCount: next.length,
    });
  }

  protected override onActiveListRendered(activeListVersion: number): void {
    if (this.radChunkResidency) {
      const generation = this.radChunkPublishGeneration;
      if (generation === null || this.pageTableDisposed) return;
      if (
        this.radChunkPendingHardValidityRevisionValue !== this.radChunkHardValidityRevisionValue
      ) {
        this.discardIndexedPublication('hard-validity-revision');
        this.pendingWork = true;
        this.lastScheduleTime = -Infinity;
        return;
      }
      if (!this.radChunkPendingPageIdentityIsCurrent()) {
        this.discardIndexedPublication('page-identity-changed');
        this.pendingWork = true;
        this.lastScheduleTime = -Infinity;
        return;
      }
      if ((this.radChunkPendingGlobals?.length ?? 0) > this.pageTableDrawBudget) {
        this.discardIndexedPublication('draw-budget-reduced');
        this.pendingWork = true;
        this.lastScheduleTime = -Infinity;
        return;
      }
      if (activeListVersion !== this.radChunkPublishActiveListVersion) return;
      const next = this.radChunkPendingGlobals;
      if (!next) return;
      const pendingSelectionId = this.radChunkPendingSelectionIdValue;
      const pendingDemandRevision = this.radChunkPublishRevision;
      this.renderedGenerationValue = generation;
      this.radChunkDisplayedGlobals = next;
      this.radChunkDisplayedSelectionHashA = this.radChunkPendingSelectionHashA;
      this.radChunkDisplayedSelectionHashB = this.radChunkPendingSelectionHashB;
      this.radChunkDisplayedFiles.clear();
      if (this.radChunkPendingFiles) {
        for (const file of this.radChunkPendingFiles) this.radChunkDisplayedFiles.add(file);
      }
      this.pageTableDrawn = next.length;
      this.pageTableDisplayGeneration = generation;
      this.retainVisibleInstanceCount(next.length);
      this.radChunkCommittedSelectionIdValue =
        pendingSelectionId ?? this.radChunkCommittedSelectionIdValue;
      this.radChunkRenderedAtValue = performance.now();
      if (
        this.demandDiagnostics.hardRelocationDetectedAt !== null &&
        pendingDemandRevision === this.demandGeneration &&
        this.demandDiagnostics.firstPublicationAt === null
      ) {
        this.demandDiagnostics.firstPublicationAt = this.radChunkRenderedAtValue;
      }
      this.radChunkCameraObsoleteValue =
        pendingDemandRevision !== null &&
        (pendingDemandRevision !== this.demandGeneration || this.demandNeedsNewRevision);
      this.radChunkPendingGlobals = null;
      this.radChunkPublishGeneration = null;
      this.radChunkPublishRevision = null;
      this.radChunkPublishActiveListVersion = null;
      this.radChunkPendingSelectionIdValue = null;
      this.radChunkPendingPageIdentity = null;
      this.radChunkPendingFiles = null;
      this.radChunkPendingSelectionHashA = null;
      this.radChunkPendingSelectionHashB = null;
      const budgetSettled = this.radChunkPendingBudgetSettled;
      this.radChunkPendingBudgetSettled = false;
      if (budgetSettled) this.settleRadChunkDemand();
      if (this.onPerformanceEvent !== undefined) {
        console.debug(
          '[vlam:rad-chunk-sort]',
          JSON.stringify({
            generation,
            selectionId: pendingSelectionId,
            activeListVersion,
            count: next.length,
            state: 'rendered',
          }),
        );
      }
      const revealQuality = this.radChunkPendingRevealQuality;
      this.radChunkPendingRevealQuality = null;
      if (
        this.radRevealPolicy === 'projected-quality' &&
        !this.revealReadyValue &&
        revealQuality?.revealReady
      ) {
        this.revealReadyValue = true;
        this.firstRevealGenerationValue = generation;
        this.firstRevealCentralProjectedRatioValue = revealQuality.maxCentralProjectedRatio;
        this.firstRevealVisibleProjectedRatioValue = revealQuality.maxVisibleProjectedRatio;
        this.setRevealMultiplier(1);
      }
      this.postToWorker({ type: 'published', generation, activeListVersion });
      this.workerAcknowledgedGenerationValue = generation;
      this.pendingWork = true;
      this.lastScheduleTime = -Infinity;
      this.resumeIndexedRefinementAfterPublication();
      return;
    }
    const generation = this.indexedPublishGeneration;
    if (generation === null || this.pageTableDisposed) return;
    if (!this.indexedPublicationIsCurrent()) {
      this.discardIndexedPublication('stale-camera-or-configuration-revision');
      return;
    }
    // Unified gather+sort and GPU/worker publication must describe the live
    // indices. A superseded snapshot (older `activeListVersion`) releases nothing.
    if (activeListVersion !== this.indexedPublishActiveListVersion) return;
    const next = this.indexedPendingDisplaySlots;
    if (!next) return;
    const revealQuality = this.indexedPendingRevealQuality;
    this.indexedPendingRevealQuality = null;
    this.renderedGenerationValue = generation;
    const retained = new Set(next);
    for (const slot of this.indexedDisplayedSlots) {
      if (!retained.has(slot)) this.pageTableGlobals[slot] = 0xffffffff;
    }
    this.indexedDisplayedSlots = Uint32Array.from(next);
    this.pageTableDrawn = next.length;
    this.pageTableDisplayGeneration = generation;
    this.retainVisibleInstanceCount(next.length);
    this.indexedPendingDisplaySlots = null;
    this.indexedPublishGeneration = null;
    this.indexedPublishActiveListVersion = null;
    this.indexedPublishRevision = null;
    this.indexedPublishedGeneration = generation;
    if (
      this.radRevealPolicy === 'projected-quality' &&
      !this.revealReadyValue &&
      revealQuality?.revealReady
    ) {
      this.revealReadyValue = true;
      this.firstRevealGenerationValue = generation;
      this.firstRevealCentralProjectedRatioValue = revealQuality.maxCentralProjectedRatio;
      this.firstRevealVisibleProjectedRatioValue = revealQuality.maxVisibleProjectedRatio;
      this.setRevealMultiplier(1);
    }
    this.recordFrontierTrace('rendered', {
      generation,
      activeCount: this.pageTableDrawn,
      ...(revealQuality
        ? {
            revealReady: revealQuality.revealReady,
            maxCentralProjectedRatio: revealQuality.maxCentralProjectedRatio,
            maxVisibleProjectedRatio: revealQuality.maxVisibleProjectedRatio,
          }
        : {}),
    });
    this.recordFrontierTrace('gather-sort-publication', {
      generation,
      activeCount: this.pageTableDrawn,
    });
    if (this.indexedPendingDiagnostic) {
      const diagnostic = this.indexedPendingDiagnostic;
      this.indexedPendingDiagnostic = null;
      diagnostic.frameRendered = this.radFrame;
      diagnostic.renderedAt = performance.now();
      diagnostic.drawCount = this.pageTableDrawn;
      diagnostic.phase = 'rendered';
      this.finishRadPublicationDiagnostic(diagnostic, this.pageTableDrawn);
    }
    this.postToWorker({ type: 'published', generation, activeListVersion });
    this.workerAcknowledgedGenerationValue = generation;
    this.indexedStagingGeneration = null;
    this.recordFrontierTrace('worker-ack', { generation, activeCount: this.pageTableDrawn });
    // Acknowledgement is the ownership boundary: the next bounded cut may
    // reuse the retired slots now, so do not wait for the idle reschedule
    // interval before asking the worker to continue toward its saved target.
    this.pendingWork = true;
    this.lastScheduleTime = -Infinity;
    this.resumeIndexedRefinementAfterPublication();
  }

  protected override rebuildActiveList(): void {
    if (this.radChunkResidency) {
      const globals = this.radChunkPendingGlobals ?? this.radChunkDisplayedGlobals;
      const indices = this.poolIndicesForRadGlobals(globals);
      if (!indices) return;
      const previousVisibleCount = this.pageTableDrawn;
      const version = this.replaceActiveIndices(indices);
      if (this.radChunkPendingGlobals) {
        this.radChunkPublishActiveListVersion = version;
        this.retainVisibleInstanceCount(previousVisibleCount);
      }
      return;
    }
    if (!this.indexedPageTable) {
      super.rebuildActiveList();
      return;
    }
    const slots = this.indexedPendingDisplaySlots ?? this.indexedDisplayedSlots;
    const previousVisibleCount = this.pageTableDrawn;
    const version = this.replaceActiveIndices(this.poolIndicesForSlabSlots(slots));
    if (this.indexedPendingDisplaySlots) {
      this.indexedPublishActiveListVersion = version;
      this.retainVisibleInstanceCount(previousVisibleCount);
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
      this.pageTableGlobals.fill(0xffffffff, at, at + run);
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
    if (!this.frontierWorker || this.pageTableDisposed) return;
    try {
      this.frontierWorker.postMessage(msg, transfer);
    } catch (error) {
      this.failFrontierWorker(error);
    }
  }

  private recordFrontierTrace(
    event: FrontierGenerationTraceEvent['event'],
    details: Omit<FrontierGenerationTraceEvent, 'at' | 'event'>,
  ): void {
    if (this.onPerformanceEvent === undefined) return;
    this.frontierGenerationTrace.push({ at: performance.now(), event, ...details });
    if (this.frontierGenerationTrace.length > 256) this.frontierGenerationTrace.shift();
  }

  /** Most recent terminal page-table worker failure, or `null` while healthy. */
  get streamingError(): SplatLoadError | null {
    return this.streamingErrorValue;
  }

  /** Applies a worker reply, turning malformed messages into a terminal fault. */
  private handleFrontierMessage(
    plan:
      | FrontierPlanMessage
      | FrontierDemandReply
      | FrontierTraversalCancelledReply
      | FrontierResizeSafeMessage
      | FrontierSnapshotReply,
  ): void {
    try {
      if (plan.type === 'demand') this.applyDemand(plan);
      else if (plan.type === 'traversalCancelled') {
        if (plan.seq < this.pageTableActiveSeq) {
          this.demandDiagnostics.oldTraversalCancelledAt = performance.now();
        }
      } else if (plan.type === 'resizeSafe') this.applyIndexedResizeSafe(plan.capacity);
      else if (plan.type === 'snapshot') this.applyFrontierSnapshot(plan);
      else this.applyFrontierPlan(plan);
    } catch (error) {
      this.failFrontierWorker(error);
    }
  }

  private applyFrontierSnapshot(snapshot: FrontierSnapshotReply): void {
    this.lastWorkerSnapshot = snapshot;
    this.snapshotWaiters.get(snapshot.requestId)?.(snapshot);
    this.snapshotWaiters.delete(snapshot.requestId);
  }

  private applyIndexedResizeSafe(capacity: number): void {
    if (!this.indexedPageTable || this.indexedResizeAwaiting !== capacity) return;
    let slots = this.slabSlots;
    while (this.slabPages.length > 1) {
      const last = this.slabPages[this.slabPages.length - 1] as SplatRange;
      if (slots - last.count < capacity) break;
      this.slabPages.pop();
      slots -= last.count;
      this.removeRange(last);
    }
    this.indexedResizeAwaiting = null;
    if (slots !== this.pagerSlots) {
      const globals = new Uint32Array(slots);
      globals.fill(0xffffffff);
      globals.set(this.pageTableGlobals.subarray(0, Math.min(slots, this.pageTableGlobals.length)));
      this.pageTableGlobals = globals;
      this.pagerSlots = slots;
      this.pageTableResident = Math.min(this.pageTableResident, slots);
      if (this.pageTableDrawn > slots) this.setSlabResident(slots);
    }
  }

  /** Clamps the accepted draw grant to what reserved storage can hold twice. */
  private acceptDrawReservation(): void {
    if (!this.indexedPageTable) return;
    const reserved = this.slabSlots;
    const accepted = Math.min(this.pageTableRequestedDraw, Math.floor(reserved / 2));
    if (accepted !== this.pageTableDrawBudget) this.pageTableDrawBudget = Math.max(0, accepted);
  }

  /** Page-table demand comes from the worker's authoritative walk, not a second scanner. */
  private get pageTableDemand(): boolean {
    return !!this.frontierWorker;
  }

  private applyDemand(reply: FrontierDemandReply): void {
    if (
      this.pageTableDisposed ||
      reply.revision < this.demandGeneration ||
      (reply.seq !== undefined && reply.seq < this.pageTableActiveSeq)
    ) {
      this.demandDiagnostics.staleReplies++;
      this.pendingWork = true;
      return;
    }
    if (this.radChunkResidency && reply.revision === this.radChunkDemandSettledRevision) {
      this.demandReadyGeneration = reply.revision;
      this.demandWants = [];
      this.demandFirstSeen.clear();
      return;
    }
    const currentSequence = reply.seq === undefined || reply.seq === this.pageTableActiveSeq;
    if (currentSequence && reply.revision === this.demandGeneration) {
      this.demandDiagnostics.firstCurrentRevisionDemandAt ??= performance.now();
      if (reply.firstSliceAt !== undefined) {
        this.demandDiagnostics.firstReplacementSliceAt ??= performance.now();
      }
    }
    if (this.onPerformanceEvent !== undefined) {
      console.debug(
        '[vlam:rad-demand-main]',
        JSON.stringify({
          revision: reply.revision,
          complete: reply.complete,
          reason: reply.reason ?? null,
          wants: reply.wants.length,
          wantFiles: reply.wants.slice(0, 16).map((want) => want.file),
        }),
      );
    }
    this.demandDiagnostics.replies++;
    this.demandReadyGeneration = reply.revision;
    if (reply.complete) {
      this.demandWants = this.radChunkResidency
        ? [...reply.wants]
        : [...reply.wants].sort(compareDemand);
    } else {
      const merged = new Map(this.demandWants.map((want) => [want.file, want]));
      for (const want of reply.wants) {
        const old = merged.get(want.file);
        if (!old || want.priority > old.priority) merged.set(want.file, want);
      }
      this.demandWants = this.radChunkResidency
        ? [...merged.values()]
        : [...merged.values()].sort(compareDemand);
    }
    const missing = new Set(this.demandWants.map((want) => want.file));
    for (const file of this.demandFirstSeen.keys()) {
      if (!missing.has(file) || this.pageTableCachedFiles.has(file))
        this.demandFirstSeen.delete(file);
    }
    for (const file of missing) {
      if (!this.pageTableCachedFiles.has(file) && !this.demandFirstSeen.has(file)) {
        this.demandFirstSeen.set(file, performance.now());
      }
    }
    this.reconcileDemand(reply.complete);
    if (currentSequence && this.replacementAwaitingFirstDemandSeq === this.pageTableActiveSeq) {
      this.replacementAwaitingFirstDemandSeq = null;
      if (this.demandNeedsNewRevision) {
        // Do not replace this walk again on every motion frame: that would
        // starve complete-cut publication until the camera stops. The latest
        // pose stays queued and runs immediately after this complete cut.
        this.pendingWork = true;
        this.lastScheduleTime = -Infinity;
      }
    }
    this.pendingWork = true;
  }

  /**
   * Incomplete replies may fill free slots. Only a complete reply for the
   * current camera/configuration may cancel unpinned downloads.
   */
  private reconcileDemand(complete = true): void {
    if (!this.pageTableDemand) return;
    if (
      !this.radChunkResidency &&
      complete &&
      this.demandReadyGeneration === this.demandGeneration &&
      !this.demandNeedsNewRevision
    ) {
      const wanted = new Set(this.demandWants.map((want) => want.file));
      wanted.add(0);
      for (const file of this.filesForIndexedSlots(this.indexedDisplayedSlots)) wanted.add(file);
      if (this.indexedPendingDisplaySlots) {
        for (const file of this.filesForIndexedSlots(this.indexedPendingDisplaySlots)) {
          wanted.add(file);
        }
      }
      for (const [file, entry] of this.fetching) {
        if (
          !wanted.has(file) &&
          !this.scene.pinnedFiles.has(file) &&
          !entry.controller.signal.aborted
        ) {
          this.demandDiagnostics.cancellations++;
          entry.controller.abort();
        }
      }
    }
    if (!this.pageTableCachedFiles.has(0)) this.requestChunk(0, 'priority');
    // A queued camera has superseded the worker's last demand. Its wants and
    // touched files describe the old view; re-requesting them here would refill
    // the slots that a hard relocation just reclaimed before the new walk can
    // answer.
    if (
      this.radChunkResidency &&
      (this.demandNeedsNewRevision || this.demandReadyGeneration !== this.demandGeneration)
    ) {
      return;
    }
    for (const want of this.demandWants) this.requestChunk(want.file, 'priority');
    if (this.radChunkResidency) return;
    if (this.demandReadyGeneration !== this.demandGeneration || this.demandNeedsNewRevision) {
      for (const file of this.pageTableFetchPriority) this.requestChunk(file, 'priority');
    }
  }

  /** Keeps the previous same-camera demand useful while the next cooperative
   * walk runs, without letting an obsolete full list churn a saturated pool. */
  private boundChunkPageCarryoverDemand(): void {
    const allocator = this.radChunkAllocator;
    if (!allocator) return;
    const freePages = Math.max(
      0,
      allocator.capacityPages - allocator.residentCount - this.pageTableActiveFetches(),
    );
    const limit = Math.max(3, freePages);
    this.demandWants = this.demandWants
      .filter((want) => !this.pageTableCachedFiles.has(want.file) && !this.fetching.has(want.file))
      .slice(0, limit);
  }

  /**
   * Stops page-table refinement after a worker fault while retaining the last
   * committed slab. Rendering therefore continues with the last drawable cut
   * instead of clearing the scene or continuously posting to a dead worker.
   */
  private failFrontierWorker(error: unknown): void {
    if (this.pageTableDisposed || this.streamingErrorValue) return;
    const detail =
      error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : error instanceof Error
          ? error.message
          : '';
    this.streamingErrorValue = new SplatLoadError(
      detail ? `Streaming worker failed. ${detail}` : 'Streaming worker failed.',
      { phase: 'worker', url: '', retryable: false, cause: error },
    );
    this.pageTableDisposed = true;
    this.pageTableInFlight = false;
    this.pendingWork = false;
    for (const { controller } of this.fetching.values()) controller.abort();
    this.frontierWorker?.terminate();
    if (this.frontierWorker) {
      this.frontierWorker.onmessage = null;
      this.frontierWorker.onerror = null;
      this.frontierWorker.onmessageerror = null;
    }
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

  /** Internal RAD residency decision surfaced to host diagnostics. */
  get radResidency(): Readonly<{
    requestedMode: 'indexed' | 'chunk-pages';
    effectiveMode: 'indexed' | 'chunk-pages';
    fallbackReason: string | null;
    residentPages: number;
    capacityPages: number;
  }> | null {
    if (this.scene.chunkOptions?.[0]?.format !== 'rad-chunk') return null;
    return {
      requestedMode: this.radResidencyRequestedValue,
      effectiveMode: this.radChunkResidency ? 'chunk-pages' : 'indexed',
      fallbackReason: this.radResidencyFallbackReasonValue,
      residentPages: this.radChunkAllocator?.residentCount ?? 0,
      capacityPages: this.radChunkAllocator?.capacityPages ?? 0,
    };
  }

  /** First-reveal policy selected for this streamed RAD mesh. */
  get radInitialRevealPolicy(): 'progressive' | 'allocation-fraction' | 'projected-quality' {
    return this.radRevealPolicy;
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

  /** Draw allowance the host requested before storage reservation. */
  get requestedDrawAllowance(): number {
    return this.frontierWorker ? this.pageTableRequestedDraw : 0;
  }

  /** Draw allowance actually granted after reserved storage and device caps. */
  get acceptedDrawAllowance(): number {
    return this.frontierWorker ? this.pageTableDrawBudget : 0;
  }

  /** Slots currently reserved for this mesh, including the unpublished staging copy. */
  get reservedSlots(): number {
    return this.frontierWorker
      ? this.radChunkResidency
        ? (this.radChunkAllocator?.capacityPages ?? 0) * SLAB_PAGE_SPLATS
        : this.slabSlots
      : 0;
  }

  /**
   * True once a complete generation has crossed the active rendering path.
   * Staging occupancy and nearby percentage are not publication.
   */
  get hasPublishedGeneration(): boolean {
    if (this.frontierWorker) {
      return this.radRevealPolicy === 'projected-quality'
        ? this.revealReadyValue
        : this.pageTableDisplayGeneration >= 0;
    }
    return this.activeSplatCount > 0;
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
    awaitingIndexedPublication: boolean;
    sortReadyGeneration: number | null;
    renderedGeneration: number | null;
    workerAcknowledgedGeneration: number | null;
    revealReady: boolean;
    maxCentralProjectedRatio: number;
    maxVisibleProjectedRatio: number;
    firstRevealGeneration: number | null;
    firstRevealCentralProjectedRatio: number | null;
    firstRevealVisibleProjectedRatio: number | null;
    planReason: FrontierPlanReason | null;
    candidateCancellationCount: number;
    boundedCutRefusalReason: FrontierPlanMessage['boundedCutRefusalReason'];
    protectedCacheBytes: number;
    activePageTableFetches: number;
    selectionId: number;
    committedSelectionId: number;
    demandRevision: number;
    cameraEpoch: number;
    demandKey: string;
    requestedCameraPosition: readonly [number, number, number] | null;
    staleCancellationReason: string | null;
    staleRequestsCancelled: number;
    protectedFilesRetained: readonly number[];
    activeRequestsBeforeReclamation: number;
    activeRequestsAfterReclamation: number;
    hardRelocationDetectedAt: number | null;
    replacementTraversalPostedAt: number | null;
    oldTraversalCancelledAt: number | null;
    firstReplacementSliceAt: number | null;
    firstCurrentRevisionDemandAt: number | null;
    firstCurrentRevisionFetchAt: number | null;
    completedTraversalAt: number | null;
    firstPublicationAt: number | null;
    cameraToFirstFetchMs: number | null;
    hardValidityRevision: number;
    selectionCompletedAt: number | null;
    sortSubmittedAt: number | null;
    renderedAt: number | null;
    cameraObsolete: boolean;
    lastInvalidationReason: string | null;
    skipSamples: readonly FrontierSkipSample[];
    generationTrace: readonly FrontierGenerationTraceEvent[];
    traversal: Readonly<{
      strategy: 'one-pass' | 'heap' | 'bounded-threshold';
      fallback: boolean;
      fallbackCount: number;
      rootCoverInfeasible: boolean;
      traversalMs: number;
      traversalId: number;
    }>;
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
      awaitingIndexedPublication: this.indexedPublishGeneration !== null,
      sortReadyGeneration: this.sortReadyGenerationValue,
      renderedGeneration: this.renderedGenerationValue,
      workerAcknowledgedGeneration: this.workerAcknowledgedGenerationValue,
      revealReady: this.revealReadyValue,
      maxCentralProjectedRatio: this.maxCentralProjectedRatioValue,
      maxVisibleProjectedRatio: this.maxVisibleProjectedRatioValue,
      firstRevealGeneration: this.firstRevealGenerationValue,
      firstRevealCentralProjectedRatio: this.firstRevealCentralProjectedRatioValue,
      firstRevealVisibleProjectedRatio: this.firstRevealVisibleProjectedRatioValue,
      planReason: this.lastPlanReason,
      candidateCancellationCount: this.candidateCancellationCount,
      boundedCutRefusalReason: this.boundedCutRefusalReason,
      protectedCacheBytes: this.protectedCacheBytesValue,
      activePageTableFetches: this.pageTableActiveFetches(),
      selectionId: this.radChunkSelectionIdValue,
      committedSelectionId: this.radChunkCommittedSelectionIdValue,
      demandRevision: this.demandGeneration,
      cameraEpoch: this.cameraEpoch,
      demandKey: this.demandKey,
      requestedCameraPosition: this.latestDemandCamera,
      staleCancellationReason: this.demandDiagnostics.staleCancellationReason,
      staleRequestsCancelled: this.demandDiagnostics.staleRequestsCancelled,
      protectedFilesRetained: this.demandDiagnostics.protectedFilesRetained,
      activeRequestsBeforeReclamation: this.demandDiagnostics.activeRequestsBeforeReclamation,
      activeRequestsAfterReclamation: this.demandDiagnostics.activeRequestsAfterReclamation,
      hardRelocationDetectedAt: this.demandDiagnostics.hardRelocationDetectedAt,
      replacementTraversalPostedAt: this.demandDiagnostics.replacementTraversalPostedAt,
      oldTraversalCancelledAt: this.demandDiagnostics.oldTraversalCancelledAt,
      firstReplacementSliceAt: this.demandDiagnostics.firstReplacementSliceAt,
      firstCurrentRevisionDemandAt: this.demandDiagnostics.firstCurrentRevisionDemandAt,
      firstCurrentRevisionFetchAt: this.demandDiagnostics.firstCurrentRevisionFetchAt,
      completedTraversalAt: this.demandDiagnostics.completedTraversalAt,
      firstPublicationAt: this.demandDiagnostics.firstPublicationAt,
      cameraToFirstFetchMs: this.demandDiagnostics.cameraToFirstFetchMs,
      hardValidityRevision: this.radChunkHardValidityRevisionValue,
      selectionCompletedAt: this.radChunkSelectionCompletedAtValue,
      sortSubmittedAt: this.radChunkSortSubmittedAtValue,
      renderedAt: this.radChunkRenderedAtValue,
      cameraObsolete: this.radChunkCameraObsoleteValue,
      lastInvalidationReason: this.radChunkLastInvalidationReasonValue,
      skipSamples: this.lastSkipSamples,
      generationTrace: this.frontierGenerationTrace.slice(),
      traversal: this.frontierTraversal,
    };
  }

  /** Holds RAD traversal on the authored startup pose while the viewer camera settles. */
  beginStartupMainRadLodHold(camera?: THREE.Camera): void {
    if (!this.frontierWorker || !this.usesRadWave) return;
    const source = camera ?? this.lastLiveCamera;
    if (!source) return;
    const held = source.clone();
    held.updateMatrixWorld(true);
    this.startupMainRadLodHold = { camera: held };
    this.pendingWork = true;
    this.lastScheduleTime = -Infinity;
  }

  /** Records the settled pose; live RAD traversal resumes after real translation. */
  completeStartupMainRadLodHold(camera?: THREE.Camera): void {
    const hold = this.startupMainRadLodHold;
    if (!hold) return;
    const source = camera ?? this.lastLiveCamera;
    if (!source) return;
    source.getWorldPosition(_startupSettledPosition);
    hold.settledPosition = _startupSettledPosition.clone();
    this.pendingWork = true;
    this.lastScheduleTime = -Infinity;
  }

  /** Refreshes the startup hold using Spark's translation-only release rule. */
  refreshStartupMainRadLodHold(camera?: THREE.Camera): void {
    const hold = this.startupMainRadLodHold;
    const source = camera ?? this.lastLiveCamera;
    if (!hold || !source || !hold.settledPosition) return;
    source.getWorldPosition(_startupSettledPosition);
    const moved = _startupSettledPosition.distanceToSquared(hold.settledPosition) > 1;
    if (moved) {
      this.startupMainRadLodHold = undefined;
      this.pendingWork = true;
      this.lastScheduleTime = -Infinity;
    }
  }

  /**
   * Exact page-table stall inputs: camera, projection, model, threshold, cached
   * chunks, and the generations at the last plan. Use with `skipSamples` to
   * re-run selection against the same state.
   */
  get pageTableStallSnapshot(): Readonly<{
    cameraLocal: readonly [number, number, number] | null;
    cameraForward: readonly [number, number, number] | null;
    projection: readonly number[];
    modelWorld: readonly number[];
    limit: number;
    lodScale: number;
    targetPx: number;
    drawBudget: number;
    cachedFiles: readonly number[];
    displayGeneration: number;
    publishedGeneration: number;
    publishedCount: number;
    candidateGeneration: number | null;
    publishGeneration: number | null;
    displayedCount: number;
    reservedSlots: number;
    planReason: FrontierPlanReason | null;
    skipSamples: readonly FrontierSkipSample[];
    traversalId: number;
    awaitingIndexedPublication: boolean;
    worker: FrontierSnapshotReply | null;
    hostNow: Readonly<{
      cameraLocal: readonly [number, number, number] | null;
      revision: number;
      cacheRevision: number;
      cachedFiles: readonly number[];
      pendingFetches: number;
    }>;
  }> {
    return {
      cameraLocal: this.lastPostedCamera ?? this.lastPlanCamera,
      cameraForward: this.lastPostedForward,
      projection: this.lastPostedProjection,
      modelWorld: Array.from(this.matrixWorld.elements),
      limit: this.lastPostedLimit,
      lodScale: this.lodScaleValue,
      targetPx: this.pageTableTargetPx,
      drawBudget: this.pageTableDrawBudget,
      cachedFiles: [...this.pageTableCachedFiles].sort((a, b) => a - b),
      displayGeneration: this.pageTableDisplayGeneration,
      publishedGeneration: this.indexedPageTable
        ? this.indexedPublishedGeneration
        : this.pageTableDisplayGeneration,
      publishedCount: this.indexedPageTable
        ? this.indexedDisplayedSlots.length
        : this.pageTableDrawn,
      candidateGeneration: this.indexedStagingGeneration,
      publishGeneration: this.indexedPublishGeneration,
      displayedCount: this.pageTableDrawn,
      reservedSlots: this.slabSlots,
      planReason: this.lastPlanReason,
      skipSamples: this.lastSkipSamples,
      traversalId: this.frontierTraversal.traversalId,
      awaitingIndexedPublication: this.indexedPublishGeneration !== null,
      worker: this.lastWorkerSnapshot,
      hostNow: {
        cameraLocal: this.lastPostedCamera,
        revision: this.demandGeneration,
        cacheRevision: this.pageTableHostCacheRevision,
        cachedFiles: [...this.pageTableCachedFiles].sort((a, b) => a - b),
        pendingFetches: this.fetching.size,
      },
    };
  }

  /** Requests one worker-owned page-table snapshot for an explicit diagnostic. */
  async requestPageTableSnapshot(): Promise<FrontierSnapshotReply | null> {
    if (!this.frontierWorker || this.pageTableDisposed) return null;
    const requestId = ++this.nextSnapshotRequestId;
    const snapshot = new Promise<FrontierSnapshotReply | null>((resolve) => {
      this.snapshotWaiters.set(requestId, resolve);
    });
    this.postToWorker({ type: 'snapshot', requestId });
    return snapshot;
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
      const previousDrawBudget = this.pageTableDrawBudget;
      // Page-table mode draws the frontier, not the LOD schedule - keep its
      // draw target under the (possibly shared/governed) pool budget too.
      this.pageTableRequestedDraw = Math.min(next, this.pageTableDrawTarget);
      this.pageTableDrawBudget = this.pageTableRequestedDraw;
      if (this.radChunkResidency && this.pageTableDrawBudget !== previousDrawBudget) {
        this.radChunkHardValidityRevisionValue++;
      }
      if (!this.radChunkResidency) {
        this.syncSlabPages(this.pageTableStagingSlots);
        this.acceptDrawReservation();
        if (this.pageTableDrawBudget < this.pageTableRequestedDraw) {
          this.syncSlabPages(this.pageTableStagingSlots);
          warn(
            `StreamedSplatMesh: accepted draw allowance ${this.pageTableDrawBudget} ` +
              `(requested ${this.pageTableRequestedDraw}); reserved slots ${this.slabSlots} cannot hold two complete cuts.`,
          );
        }
      }
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
    return this.frontierWorker && this.pageTableDrawBudget < next ? this.pageTableDrawBudget : next;
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
    handlerMs: number;
    worstApplyMs: number;
    writeMs: number;
    residentMs: number;
    mappingMs: number;
    pageIdentityMs: number;
    activeListMs: number;
    installMs: number;
    protectionMs: number;
    unifiedGatherMs: number;
    sortMs: number;
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
   *   capture. Declined by the `smooth` profile.
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
    pageInstalls: number;
    pageInstallMs: number;
    uncovered: number;
    retiredEarly: number;
    cacheFull: boolean;
    cacheBytes: number;
    cacheLimitBytes: number;
    activePageTableFetches: number;
  }> {
    this.fetchCountsValue.activePageTableFetches = this.pageTableActiveFetches();
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
    this.radFrame++;
    this.radDiagnosticRenderer = this.onPerformanceEvent ? renderer : null;
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
    this.lastLiveCamera = lodCamera.clone();
    this.noteRenderer(renderer);
    const performanceEvent = this.shouldReschedule(lodCamera, now)
      ? this.reschedule(lodCamera, now)
      : null;
    super.update(camera, renderer, options);
    if (this.onPerformanceEvent) {
      const timings = this.getUpdateTimings();
      const timestamp = performance.now();
      const event: StreamedSplatPerformanceEvent = performanceEvent ?? {
        timestamp,
        cpuMs: timestamp - now,
        activeListMs: 0,
        uploadMs: 0,
        sortSubmitMs: 0,
        stagingTextureAllocations: 0,
        textureCopyCount: 0,
        textureCopyBytes: 0,
        activeListUpdateRanges: 0,
        sortSubmissions: 0,
        sortPasses: 0,
        projectionSubmissions: 0,
        projectionPasses: 0,
        appendedCount: 0,
        removedCount: 0,
        stagedCount: 0,
        uploadCount: 0,
        activeCount: this.activeSplatCount,
        forcedSort: false,
        compacted: false,
        sortReadyGeneration: this.sortReadyGenerationValue,
        renderedGeneration: this.renderedGenerationValue,
        workerAcknowledgedGeneration: this.workerAcknowledgedGenerationValue,
      };
      if (performanceEvent) event.cpuMs += timestamp - performanceEvent.timestamp;
      event.timestamp = timestamp;
      event.activeListMs = timings.activeListMs;
      event.uploadMs = timings.uploadMs;
      event.sortSubmitMs = timings.sortSubmitMs;
      event.stagingTextureAllocations = timings.stagingTextureAllocations;
      event.textureCopyCount = timings.textureCopyCount;
      event.textureCopyBytes = timings.textureCopyBytes;
      event.activeListUpdateRanges = timings.activeListUpdateRanges;
      event.sortSubmissions = timings.sortSubmissions;
      event.sortPasses = timings.sortPasses;
      event.projectionSubmissions = timings.projectionSubmissions;
      event.projectionPasses = timings.projectionPasses;
      event.sortReadyGeneration = this.sortReadyGenerationValue;
      event.renderedGeneration = this.renderedGenerationValue;
      event.workerAcknowledgedGeneration = this.workerAcknowledgedGenerationValue;
      this.onPerformanceEvent(event);
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
   * Include decoded centers too: an LCC environment tile is outside the LOD
   * tree and can extend far beyond its root bounds. The accumulated bound is
   * grow-only, so unloading a range cannot shrink the quantization interval.
   */
  protected override refreshSortBounds(): void {
    if (!this.boundsDirty) return;
    this.localBounds.union(this.scene.bounds).getBoundingSphere(this.boundingSphereLocal);
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
   * edits are stored sparsely keyed by `(chunk file, local index)` and geometric
   * strokes are replayed whenever another coarse/fine run is appended. Paint a
   * region with {@link paintPersistent}, orbit away until it is evicted, come
   * back, and the same world-space region is painted on the new LOD cut.
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
      strokes: [],
      total: 0,
      warned: false,
    });
  }

  /**
   * Sets a persistent channel to `value` for every currently-resident splat
   * whose center is within `radius` (world units) of `worldPoint`. The
   * world-space sphere remains correct under non-uniform mesh scale. The
   * geometric edit is replayed on later resident LOD runs; direct
   * {@link SplatMesh.writeChannel} writes are not recorded.
   *
   * @returns the number of splats edited this call.
   * @throws {Error} if the channel was not declared with
   *   {@link definePersistentChannel}.
   */
  paintPersistent(name: string, worldPoint: THREE.Vector3, radius: number, value: number): number {
    return this.paintPersistentStroke(
      name,
      { paths: [[{ point: worldPoint.clone(), radius }]] },
      { depth: 'through', footprint: 'center' },
      value,
    );
  }

  /**
   * Applies and records a geometric brush stroke on a persistent channel.
   * The immutable operation is replayed when other LOD runs become resident,
   * so the painted region follows the surface rather than one transient cut.
   *
   * @returns the number of currently resident splats newly edited.
   */
  paintPersistentStroke(
    name: string,
    stroke: BrushStroke,
    options: BrushStrokeSelectionOptions,
    value: number,
  ): number {
    const channel = this.persistentChannels.get(name);
    if (!channel) {
      throw new Error(
        `StreamedSplatMesh.paintPersistentStroke: channel "${name}" is not a persistent channel. ` +
          `Call definePersistentChannel("${name}") first.`,
      );
    }
    const snapshot = cloneBrushStroke(stroke);
    channel.strokes.push({ stroke: snapshot, options: { ...options }, value });
    this.updateWorldMatrix(true, false);
    if (this.frontierWorker) {
      return this.paintPersistentPageTable(name, channel, snapshot, options, value);
    }
    let edited = 0;
    const touchedFiles = new Set<number>();

    for (const { run } of this.resident.values()) {
      const chunk = this.cache.get(run.file);
      if (!chunk) continue; // positions evicted from the CPU cache
      const selected = selectBrushStrokeInData(
        sliceSplatData(chunk.data, run.offset, run.count),
        snapshot,
        options,
        this.matrixWorld,
      );
      const fileEdits = channel.edits.get(run.file) ?? new Map<number, number>();
      let touched = false;
      for (const localIndex of selected) {
        const li = run.offset + localIndex;
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
    channel.strokes.length = 0;
    channel.total = 0;
    for (const { run, handle } of this.resident.values()) {
      const data =
        channel.type === 'byte' ? new Uint8Array(run.count) : new Float32Array(run.count);
      if (channel.fill) data.fill(channel.fill);
      this.writeChannel(handle, name, data);
    }
    let slot = 0;
    for (const page of this.slabPages) {
      this.writePersistentSlabValues(name, channel, page, 0, page.count, slot);
      slot += page.count;
    }
  }

  override dispose(): void {
    if (this.disposed) return;
    for (const resolve of this.snapshotWaiters.values()) resolve(null);
    this.snapshotWaiters.clear();
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
    this.lastLiveCamera = camera.clone();
    this.refreshStartupMainRadLodHold(camera);

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
      let traversalCamera = camera;
      if (this.startupMainRadLodHold) traversalCamera = this.startupMainRadLodHold.camera;
      traversalCamera.updateMatrixWorld(true);
      traversalCamera.getWorldPosition(_streamCameraWorld);
      _streamCameraLocal.copy(_streamCameraWorld);
      this.worldToLocal(_streamCameraLocal);
      traversalCamera.getWorldDirection(_streamCameraForward).add(_streamCameraWorld);
      this.worldToLocal(_streamCameraForward);
      _streamCameraForward.sub(_streamCameraLocal).normalize();
      _streamProjection
        .multiplyMatrices(traversalCamera.projectionMatrix, traversalCamera.matrixWorldInverse)
        .multiply(this.matrixWorld);
      // Cut limit, exactly as the material derives it: a node is fine enough
      // when `size / distance ≤ targetPx / focalY`.
      const focalY = (traversalCamera.projectionMatrix.elements[5] * this.pageTableViewportY) / 2;
      if (focalY > 0) this.pageTableLimit = this.pageTableTargetPx / focalY;
      this.reschedulePageTable(
        _streamCameraLocal,
        _streamCameraForward,
        _frustum,
        now,
        _streamProjection.elements,
      );
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
        textureCopyCount: 0,
        textureCopyBytes: 0,
        activeListUpdateRanges: 0,
        appendedCount: 0,
        removedCount: 0,
        stagedCount: 0,
        uploadCount: 0,
        activeCount: this.pageTableDrawn,
        forcedSort: false,
        compacted: false,
        sortReadyGeneration: this.sortReadyGenerationValue,
        renderedGeneration: this.renderedGenerationValue,
        workerAcknowledgedGeneration: this.workerAcknowledgedGenerationValue,
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
    const swapRuns = this.usesRadWave && !holding ? this.captureWaveRuns(liveRuns) : liveRuns;
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
    let groups = holding
      ? // Mesh is invisible during the hold, so L0 cell-atomicity (no holes) is
        // irrelevant - commit each frozen slice as it lands so a partial home
        // cell cannot block reveal behind sibling subchunks still fetching.
        buildHoldSwapGroups(toAdd)
      : buildSwapGroups(toAdd, toRemove);
    const classicLccGroups = !holding && isClassicLccSwapSet(groups);
    const pendingFetches = new Map<number, ClassicFetchWant>();
    this.updateEnvironment(now, pendingFetches);

    if (!this.usesRadWave && !classicLccGroups && !holding) {
      // An octree fallback spans a whole ancestor, including ready siblings in
      // other groups. Install coverage before committing any replacements, then
      // rebuild transactions against the resulting cut to avoid double-draw.
      for (const group of groups) {
        if (
          group.adds.some(
            (run) =>
              !this.cache.has(run.file) &&
              this.staged.get(runKey(run))?.uploadedCount !== run.count,
          )
        ) {
          this.substituteCoverage(group, now, pendingFetches, false);
        }
      }
      groups = buildSwapGroups(
        swapRuns.filter((run) => !this.resident.has(runKey(run))),
        [...this.resident.entries()].filter(([key]) => !desired.has(key)),
      );
    }
    groups.sort((a, b) =>
      classicLccGroups ? compareClassicSwapGroups(a, b) : groupPriority(a) - groupPriority(b),
    );

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
    if (this.usesRadWave && !holding) {
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
      // Leaf-interval overlap already joins every replacement to its old
      // coverage. Independent regions must never wait for a global wave.
      for (const group of groups) {
        if (group.adds.length === 0) {
          this.applyGroup(group, now); // dropped regions: just free them
          continue;
        }
        const missing = group.adds.filter(
          (run) =>
            !this.cache.has(run.file) && this.staged.get(runKey(run))?.uploadedCount !== run.count,
        );
        // Resolved L0: skip coarse stand-in for empty gaps (keep prior coverage
        // on each sub-leaf until that slice's L0 commits). L1+: allow per-slice
        // coarsest substitute while that slice's target loads.
        // Startup hold never paints coarse for the critical set.
        const holdForTarget =
          holding ||
          (classicLccGroups &&
            isWaitingOnFinest(group) &&
            this.initialRevealHold !== 'hold-coverage');
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
          if (!holding && classicLccGroups) {
            this.substituteCoverage(group, now, pendingFetches, holdForTarget);
          }
          if (recoverable) {
            this.pendingWork = true;
          }
          // During startup, continue into staging so available chunks upload
          // before every sibling is cached.
          if (!holding) continue;
        }
        if (holding && this.environmentPendingForReveal()) {
          // Keep pool headroom for the env tile; coverage stays cached until it
          // lands. Fetches for the frozen set are already queued above.
          this.pendingWork = true;
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
            continue;
          }
          // Keep the old region for one additional frame when this tick wrote
          // the final hidden segment. The following tick performs only the
          // atomic active-list switch and forced sort, rather than combining
          // those costs with the last texture upload.
          if (stagedNow > 0 && !holding) {
            this.deferNextSortRequest();
            this.pendingWork = true;
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
          continue;
        }
        // Startup hold always stages (above); if staging could not start, keep
        // pending rather than applying visible coverage while the viewer is gated.
        if (holding) {
          this.pendingWork = true;
          continue;
        }
        if (!this.applyGroup(group, now)) {
          this.pendingWork = true; // transient pool pressure; retry next tick
          continue;
        }
        appended += group.addCount;
      }
      this.retireHeldTicks = 0;
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
      textureCopyCount: 0,
      textureCopyBytes: 0,
      activeListUpdateRanges: 0,
      appendedCount,
      removedCount,
      stagedCount,
      uploadCount: appendedCount + stagedCount,
      activeCount,
      forcedSort:
        activeCount === 0 || appendedCount + removedCount >= activeCount * CONTENT_FORCE_FRACTION,
      compacted,
      sortReadyGeneration: this.sortReadyGenerationValue,
      renderedGeneration: this.renderedGenerationValue,
      workerAcknowledgedGeneration: this.workerAcknowledgedGenerationValue,
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
   * Speculative prefetch runs are not part of the presented cut and must not
   * hold it hostage. Cache-full and pool pressure provide a valve for both
   * first paint and refinement; the regression guard prevents a coarser
   * replacement from reaching the screen. Otherwise publish only when every
   * drawable run's file is cached or failed — staging completeness itself is
   * enforced by {@link applyRadWave}'s `readyComplete` check.
   */
  private radWaveShouldPublish(live: readonly LodRun[], poolPressure: boolean): boolean {
    const drawable = live.filter((run) => !run.fetchIntent);
    // Never publish a fetch-only wave: there is no drawable cover to present.
    if (drawable.length === 0) return false;
    if (this.waveHasPublished && this.radWaveIsRegression(drawable)) return false;
    // Fetch-intent runs are speculative and are excluded from `drawable`, so a
    // prefetch that never lands cannot hold the presented cut hostage. Pressure
    // still provides an escape hatch for both first paint and refinement; the
    // regression guard above prevents either hatch from swapping in a coarser
    // cut than the one already on screen.
    if (poolPressure || this.cacheBytesTotal >= this.cpuCacheBytes) return true;
    return drawable.every((run) => this.cache.has(run.file) || this.failedFiles.has(run.file));
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
   *
   * Level bases must clear the largest level a format assigns. Prefix `.rad`
   * uses `level = numChunks - chunkIndex`, which routinely exceeds 32 on real
   * captures; a too-small base makes every deep cut score *worse* than the
   * overview and permanently blocks refinement after first paint.
   */
  private radWaveCutQuality(runs: readonly LodRun[]): { count: number; fine: number } {
    let count = 0;
    let fine = 0;
    // 1024 clears RAD chunk-index levels with headroom; octree depths stay well
    // below it so the relative ordering among those cuts is unchanged.
    const levelBase = 1024;
    for (const run of runs) {
      count += run.count;
      fine += run.count * (levelBase - run.level);
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
    // Do not lead with `!poolPressure`: that made the pressure valve inside
    // `radWaveShouldPublish` unreachable. When the valve says publish, a
    // partially staged ready set is still allowed to commit. Likewise do not
    // restrict the `awaitingFetch` escape to first paint — refinement under
    // pressure must be able to present what is already staged.
    const readyComplete =
      (!awaitingFetch || shouldPublish) &&
      ready.every((group) => group.adds.length === 0 || this.groupFullyStaged(group));
    const holdingRetires = ready.some((group) => group.removes.length > 0);

    if (!readyComplete) {
      this.pendingWork = true;
      if (!holdingRetires) {
        this.retireHeldTicks = 0;
        return;
      }
      // The published cover is the picture until a later cut is allowed to
      // swap. Do not bulk-retire it just because discovery is still deepening.
      // When `shouldPublish` is true (pressure valve or drawable fully cached),
      // fall through so a staged refinement can commit even while later
      // drawable siblings are still fetching.
      if (this.waveHasPublished && !shouldPublish) {
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
    const ready = (run: LodRun): boolean =>
      this.staged.get(runKey(run))?.uploadedCount === run.count;
    const unstaged = group.adds.filter((run) => !ready(run));
    const partial = unstaged.flatMap((run) => {
      const key = runKey(run);
      const entry = this.staged.get(key);
      return entry ? [{ key, entry }] : [];
    });
    const needed = unstaged.reduce((sum, run) => sum + rowSplats(run.count), 0);
    const freed =
      group.removes.reduce((sum, [, entry]) => sum + rowSplats(entry.run.count), 0) +
      partial.reduce((sum, { entry }) => sum + rowSplats(entry.run.count), 0);
    if (needed > this.freeSplatCapacity + freed) return false;
    // A camera change can merge staged groups into a transaction that no
    // longer fits beside the old cut. Reclaim partial staging for the direct
    // swap, but retain completed GPU ranges whose CPU chunks may be evicted.
    if (unstaged.some((run) => !this.cache.has(run.file))) return false;
    for (const { key, entry } of partial) {
      this.removeRange(entry.handle);
      this.staged.delete(key);
    }

    for (const [key, entry] of group.removes) {
      if (!this.resident.has(key)) continue;
      this.removeRange(entry.handle);
      this.resident.delete(key);
    }
    for (const run of group.adds) {
      const key = runKey(run);
      const entry = this.staged.get(key);
      if (entry) {
        this.setRangeActive(entry.handle, true);
        this.resident.set(key, entry);
        this.staged.delete(key);
      } else {
        this.appendRun(run, now);
      }
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

  /** Applies a new stroke to the page-table slab already resident on the CPU. */
  private paintPersistentPageTable(
    name: string,
    channel: PersistentChannel,
    stroke: BrushStroke,
    options: BrushStrokeSelectionOptions,
    value: number,
  ): number {
    let edited = 0;
    let slot = 0;
    for (const page of this.slabPages) {
      const count = Math.min(page.count, Math.max(0, this.pageTableResident - slot));
      if (count <= 0) break;
      const { start, backing } = this.poolRangeBacking(page);
      const selected = selectBrushStrokeInPoolBacking(
        backing,
        start,
        count,
        stroke,
        options,
        this.matrixWorld,
      );
      let touched = false;
      for (const localIndex of selected) {
        const global = this.pageTableGlobals[slot + localIndex] as number;
        if (global === 0xffffffff) continue;
        if (this.recordPersistentGlobal(name, channel, global, value)) {
          edited++;
          touched = true;
        }
      }
      if (touched) this.writePersistentSlabValues(name, channel, page, 0, count, slot);
      slot += page.count;
    }
    return edited;
  }

  /** Replays stored geometry for newly written page-table slots, then uploads channels. */
  private applyPersistentSlabRun(page: SplatRange, offset: number, data: PlanSplats): void {
    if (this.persistentChannels.size === 0) return;
    this.updateWorldMatrix(true, false);
    const slot = this.slabPages.indexOf(page) * this.slabPageSplats + offset;
    for (const [name, channel] of this.persistentChannels) {
      for (const operation of channel.strokes) {
        const selected = selectBrushStrokeInData(
          data,
          operation.stroke,
          operation.options,
          this.matrixWorld,
        );
        for (const localIndex of selected) {
          this.recordPersistentGlobal(
            name,
            channel,
            data.globals[localIndex] as number,
            operation.value,
          );
        }
      }
      this.writePersistentSlabValues(name, channel, page, offset, data.count, slot);
    }
  }

  /** Writes stored values for a contiguous slab run, clearing stale slot occupants. */
  private writePersistentSlabValues(
    name: string,
    channel: PersistentChannel,
    page: SplatRange,
    offset: number,
    count: number,
    slot: number,
  ): void {
    const values = channel.type === 'byte' ? new Uint8Array(count) : new Float32Array(count);
    if (channel.fill) values.fill(channel.fill);
    const chunkSize = this.scene.chunkSize ?? 65536;
    for (let i = 0; i < count; i++) {
      const global = this.pageTableGlobals[slot + i] as number;
      if (global === 0xffffffff) continue;
      const file = Math.floor(global / chunkSize);
      const value = channel.edits.get(file)?.get(global - file * chunkSize);
      if (value !== undefined) values[i] = value;
    }
    this.writeChannel(page, name, values, offset);
  }

  /** Records one stable page-table identity while preserving first-paint-wins. */
  private recordPersistentGlobal(
    name: string,
    channel: PersistentChannel,
    global: number,
    value: number,
  ): boolean {
    const chunkSize = this.scene.chunkSize ?? 65536;
    const file = Math.floor(global / chunkSize);
    const local = global - file * chunkSize;
    const edits = channel.edits.get(file) ?? new Map<number, number>();
    if (edits.has(local)) return false;
    if (channel.total >= channel.maxEdits) {
      if (!channel.warned) {
        channel.warned = true;
        warn(
          `StreamedSplatMesh.paintPersistent: channel "${name}" hit its ` +
            `maxEdits cap (${channel.maxEdits}); further new edits are dropped.`,
        );
      }
      return false;
    }
    edits.set(local, value);
    channel.edits.set(file, edits);
    channel.total++;
    return true;
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
    const chunk = this.cache.get(run.file);
    if (chunk && channel.strokes.length > 0 && channel.total < channel.maxEdits) {
      this.updateWorldMatrix(true, false);
      const slice = sliceSplatData(chunk.data, run.offset, run.count);
      const replayEdits = channel.edits.get(run.file) ?? new Map<number, number>();
      for (const operation of channel.strokes) {
        const selected = selectBrushStrokeInData(
          slice,
          operation.stroke,
          operation.options,
          this.matrixWorld,
        );
        for (const localIndex of selected) {
          const fileIndex = run.offset + localIndex;
          if (replayEdits.has(fileIndex)) continue;
          if (channel.total >= channel.maxEdits) break;
          replayEdits.set(fileIndex, operation.value);
          channel.total++;
        }
        if (channel.total >= channel.maxEdits) break;
      }
      if (replayEdits.size > 0) channel.edits.set(run.file, replayEdits);
    }
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
   * Classic LCC may explicitly hold for finest detail. Manifest octrees always
   * fill gaps with coarse coverage, including near-camera regions.
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
          if (!this.failedFiles.has(run.file)) this.pendingWork = true;
          enqueueClassicFetch(
            pendingFetches,
            run.file,
            !this.usesRadWave && run.coverageGroup === undefined
              ? 'missing-coverage'
              : classicFetchPhaseForCoverage(run, this.scene.source.lodBaseDistance),
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
        // Shared ancestors cannot be clipped to a gap. Preflight their whole
        // replacement before removing any visible descendant. Staging in this
        // interval is obsolete once the ancestor covers it, and can free rows.
        const overlaps = (other: LodRun): boolean =>
          other.leafStart < run.leafEnd && other.leafEnd > run.leafStart;
        const removes = [...this.resident.entries()].filter(([, entry]) => overlaps(entry.run));
        const staged = [...this.staged.entries()].filter(([, entry]) => overlaps(entry.run));
        const freed = [...removes, ...staged].reduce(
          (sum, [, entry]) => sum + this.rowAlignedSplats(entry.run.count),
          0,
        );
        if (this.rowAlignedSplats(run.count) > this.freeSplatCapacity + freed) {
          this.pendingWork = true;
          continue;
        }
        for (const [key, entry] of staged) {
          this.removeRange(entry.handle);
          this.staged.delete(key);
        }
        this.applyGroup(
          {
            adds: [run],
            removes,
            leafStart: run.leafStart,
            leafEnd: run.leafEnd,
            addCount: run.count,
          },
          now,
        );
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
    projection: readonly number[] = [],
  ): void {
    if (this.pageTableDisposed) return;
    const camera: [number, number, number] = [cameraLocal.x, cameraLocal.y, cameraLocal.z];
    const forward: [number, number, number] = [forwardLocal.x, forwardLocal.y, forwardLocal.z];
    this.latestDemandCamera = camera;
    const limit = this.pageTableLimit / this.lodScaleValue;
    const fov = this.pageTableFoveation;
    const key = pageTableDemandKey(
      camera,
      forward,
      projection,
      limit,
      this.pageTableDrawBudget,
      fov,
    );
    const demandChanged = key !== this.demandKey;
    if (this.radChunkDemandSettledRevision >= 0) {
      if (this.radChunkDemandSettlementIsCurrent(camera, forward, limit)) {
        this.demandKey = key;
        this.pendingWork = false;
        return;
      }
      this.radChunkDemandSettledRevision = -1;
      this.radChunkDemandSettledCamera = null;
      this.radChunkDemandSettledForward = null;
    }
    const hardRelocation =
      this.lastPostedCamera !== null && squaredDistance3(camera, this.lastPostedCamera) > 1;
    const firstHardRelocation =
      hardRelocation && !this.hardRelocationPending && this.pageTableReplacementSeq === null;
    if (demandChanged) {
      this.demandKey = key;
      this.cameraEpoch++;
      this.demandNeedsNewRevision = true;
    }
    if (hardRelocation && !demandChanged && firstHardRelocation) {
      this.cameraEpoch++;
      this.demandNeedsNewRevision = true;
    }
    if (firstHardRelocation) {
      this.hardRelocationPending = true;
      this.demandDiagnostics.hardRelocationDetectedAt = performance.now();
      this.demandDiagnostics.replacementTraversalPostedAt = null;
      this.demandDiagnostics.oldTraversalCancelledAt = null;
      this.demandDiagnostics.firstReplacementSliceAt = null;
      this.demandDiagnostics.firstCurrentRevisionDemandAt = null;
      this.demandDiagnostics.firstCurrentRevisionFetchAt = null;
      this.demandDiagnostics.completedTraversalAt = null;
      this.demandDiagnostics.firstPublicationAt = null;
      this.demandDiagnostics.cameraToFirstFetchMs = null;
    }
    this.demandDiagnostics.cameraEpoch = this.cameraEpoch;
    this.demandDiagnostics.demandKey = key;
    this.demandDiagnostics.requestedCameraPosition = camera;
    if (firstHardRelocation) this.reclaimStalePriorityFetches();
    const supersedeInFlight = this.pageTableInFlight && firstHardRelocation;
    if (this.radChunkResidency && (this.demandNeedsNewRevision || supersedeInFlight)) {
      // A new walk owns queued priority from this point. Let requests already
      // on the wire finish, but do not let the previous cut refill their slots
      // while JavaScript computes the replacement demand.
      this.demandWants = [];
      this.demandFirstSeen.clear();
      this.demandReadyGeneration = -1;
    } else if (this.radChunkResidency && !this.pageTableInFlight) {
      this.boundChunkPageCarryoverDemand();
    }
    this.reconcileDemand(
      this.demandReadyGeneration === this.demandGeneration && !this.demandNeedsNewRevision,
    );
    if (!this.pageTableCachedFiles.has(0)) this.requestChunk(0, 'priority');
    void frustum;
    void now;
    if (this.pageTableInFlight && !supersedeInFlight) {
      if (this.demandNeedsNewRevision) {
        // The worker is finishing an older bounded walk. Keep the newest pose
        // queued so its reply immediately posts the latest revision.
        this.pendingWork = true;
        this.lastScheduleTime = -Infinity;
      }
      if (this.onPerformanceEvent !== undefined) {
        console.debug(
          '[vlam:rad-reschedule]',
          JSON.stringify({
            state: 'blocked-in-flight',
            demandGeneration: this.demandGeneration,
            cameraEpoch: this.cameraEpoch,
            cameraKey: this.demandKey,
            cameraPosition: camera,
            queuedRevision: this.demandNeedsNewRevision,
          }),
        );
      }
      return;
    }
    this.pendingWork = false;
    this.lastScheduleTime = now;

    if (this.demandNeedsNewRevision) {
      this.demandGeneration++;
      this.demandDiagnostics.generation = this.demandGeneration;
      this.demandReadyGeneration = -1;
      this.demandNeedsNewRevision = false;
      if (this.radChunkResidency) {
        this.demandWants = [];
        this.demandFirstSeen.clear();
      }
    }
    this.pageTableInFlight = true;
    this.lastPostedCamera = camera;
    this.hardRelocationPending = false;
    this.lastPostedForward = forward;
    this.lastPostedProjection = projection.length ? Array.from(projection) : [];
    this.lastPostedLimit = limit;
    const seq = ++this.pageTableSeq;
    this.pageTableActiveSeq = seq;
    if (firstHardRelocation) {
      this.replacementAwaitingFirstDemandSeq = seq;
      this.pageTableReplacementSeq = seq;
      this.demandDiagnostics.replacementTraversalPostedAt = performance.now();
    }
    this.postToWorker({
      type: 'reschedule',
      seq,
      ...(this.pageTableContinuePending ? { continuePendingPlan: true } : {}),
      cameraLocal: camera,
      cameraForward: forward,
      projection: Array.from(projection),
      ...this.pageTableFoveation,
      limit,
      budget: this.pageTableDrawBudget,
      revision: this.demandGeneration,
      diagnostics: this.onPerformanceEvent !== undefined,
      initialPublishMinSplats: initialPublishMinSplats(
        this.radRevealPolicy,
        this.radDisplayFraction,
        this.pageTableDrawBudget,
      ),
    });
    if (this.onPerformanceEvent !== undefined) {
      console.debug(
        '[vlam:rad-reschedule]',
        JSON.stringify({
          state: 'posted',
          seq: this.pageTableSeq,
          revision: this.demandGeneration,
          cameraEpoch: this.cameraEpoch,
          cameraKey: this.demandKey,
          cameraPosition: camera,
        }),
      );
    }
    this.recordFrontierTrace('next-reschedule', {
      generation: this.indexedStagingGeneration ?? this.pageTableDisplayGeneration,
      planReason: this.lastPlanReason,
    });
  }

  /**
   * Applies a paging plan from the worker to the slab - fast memcpy writes only,
   * no traversal or gather on the main thread - then fetches the chunks the
   * frontier wants next, and reschedules again if chunks are still streaming.
   */
  private applyFrontierPlan(plan: FrontierPlanMessage): void {
    if (this.pageTableDisposed || (!this.radChunkResidency && this.slabPages.length === 0)) {
      return;
    }
    if (plan.seq < this.pageTableSeq) {
      this.pendingWork = true;
      return;
    }
    if (plan.seq === this.pageTableActiveSeq) {
      this.pageTableInFlight = false;
      if (this.pageTableReplacementSeq === plan.seq) this.pageTableReplacementSeq = null;
      this.demandDiagnostics.completedTraversalAt = performance.now();
    }
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
    const limit = this.radChunkResidency ? this.capacity : this.pagerSlots;
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
    if (this.indexedPageTable && !this.radChunkResidency) {
      const writeSlots = plan.writeSlots ?? new Uint32Array(0);
      if (writeSlots.length !== plan.appends.count) {
        throw new Error('StreamedSplatMesh: indexed plan write slots do not match appends.');
      }
      const displayed = new Set(this.indexedDisplayedSlots);
      const seen = new Set<number>();
      let duplicate = false;
      let outOfRange = false;
      let displayedMutation = false;
      for (const slot of writeSlots) {
        if (seen.has(slot)) duplicate = true;
        seen.add(slot);
        if (slot >= limit) outOfRange = true;
        if (displayed.has(slot)) displayedMutation = true;
      }
      if (duplicate || outOfRange || displayedMutation) {
        this.discardIndexedPublication('invalid-indexed-slot-write');
        this.pendingWork = true;
        return;
      }
      this.writeIndexedSlabSlots(plan.appends, writeSlots);
    } else {
      const slots = plan.moveSlots;
      for (let i = 0; i < slots.length;) {
        let run = 1;
        while (
          i + run < slots.length &&
          (slots[i + run] as number) === (slots[i] as number) + run
        ) {
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
    }
    const writeFinishedAt = performance.now();
    const drawn = Math.min(plan.displayCount ?? plan.residentCount, limit);
    this.pageTableResident = this.indexedPageTable
      ? this.radChunkResidency
        ? (this.radChunkAllocator?.residentCount ?? 0) * SLAB_PAGE_SPLATS
        : this.pagerSlots
      : Math.min(plan.residentCount, limit);
    const degenerateStart = Math.min(plan.degenerateStart, limit);
    const degenerateCount = Math.min(plan.degenerateCount, limit - degenerateStart);
    if (!this.indexedPageTable && degenerateCount > 0) {
      this.degenerateSlabSlots(degenerateStart, degenerateCount);
    }
    const residentFinishedAt = performance.now();
    const candidateRevisionCurrent =
      (plan.candidateRevision === undefined || plan.candidateRevision === this.demandGeneration) &&
      !this.demandNeedsNewRevision;
    if (
      this.indexedPageTable &&
      plan.cancelledCandidateGeneration !== undefined &&
      plan.cancelledCandidateGeneration === this.indexedPublishGeneration
    ) {
      this.discardIndexedPublication('worker-cancelled-candidate');
    }
    if (
      this.indexedPageTable &&
      plan.cancelledCandidateGeneration !== undefined &&
      this.indexedPendingDiagnostic?.generation === plan.cancelledCandidateGeneration &&
      this.indexedPublishGeneration !== plan.cancelledCandidateGeneration
    ) {
      this.rejectRadPublicationDiagnostic(
        this.indexedPendingDiagnostic,
        'worker-cancelled-candidate',
      );
    }
    if (this.onPerformanceEvent !== undefined) {
      console.debug(
        '[vlam:rad-plan-main]',
        JSON.stringify({
          seq: plan.seq,
          candidateGeneration: plan.candidateGeneration ?? null,
          candidateComplete: plan.candidateComplete === true,
          candidateSize: plan.candidateSize ?? null,
          candidateNewSlots: plan.candidateNewSlots ?? null,
          planReason: plan.planReason ?? null,
          converged: plan.converged,
          pending: plan.pendingFrontierSplats ?? 0,
          touched: plan.touched.length,
          revision: plan.candidateRevision ?? null,
          cancelled: plan.cancelledCandidateGeneration ?? null,
        }),
      );
    }
    const cancelledCandidate =
      plan.cancelledCandidateGeneration !== undefined &&
      plan.cancelledCandidateGeneration === plan.candidateGeneration;
    const publicationDiagnostic =
      cancelledCandidate || this.radChunkResidency
        ? null
        : this.beginRadPublicationDiagnostic(plan);
    const indexedPublication =
      this.indexedPageTable &&
      !this.radChunkResidency &&
      plan.candidateComplete === true &&
      candidateRevisionCurrent
        ? plan.candidateSlots
        : undefined;
    const chunkCandidateGeneration = plan.candidateGeneration;
    const chunkPublicationBusy =
      this.radChunkPublishGeneration !== null || this.radChunkPendingGlobals !== null;
    const chunkCandidateOverBudget =
      this.radChunkResidency &&
      plan.candidateComplete === true &&
      plan.selectionGlobals !== undefined &&
      plan.selectionGlobals.length > this.pageTableDrawBudget;
    const chunkPublicationGlobals =
      this.radChunkResidency &&
      plan.candidateComplete === true &&
      !chunkPublicationBusy &&
      chunkCandidateGeneration !== undefined &&
      chunkCandidateGeneration > this.pageTableDisplayGeneration &&
      !chunkCandidateOverBudget &&
      plan.selectionGlobals
        ? plan.selectionGlobals
        : undefined;
    const chunkPublicationMapping = chunkPublicationGlobals
      ? this.mapRadChunkSelection(chunkPublicationGlobals)
      : undefined;
    const chunkPublicationSlots = chunkPublicationMapping?.slots;
    const chunkPublicationPageIdentity = chunkPublicationMapping?.pageIdentity;
    let activeListMs = 0;
    if (chunkCandidateOverBudget) {
      this.radChunkLastInvalidationReasonValue = 'draw-budget';
      this.pendingWork = true;
      this.lastScheduleTime = -Infinity;
    }
    if (chunkPublicationGlobals && (!chunkPublicationSlots || !chunkPublicationPageIdentity)) {
      if (this.onPerformanceEvent !== undefined) {
        console.debug(
          '[vlam:rad-chunk-publication]',
          JSON.stringify({
            seq: plan.seq,
            candidateGeneration: plan.candidateGeneration ?? null,
            candidateSize: chunkPublicationGlobals.length,
            residentPages: this.radChunkAllocator?.residentCount ?? 0,
            state: 'missing-page',
          }),
        );
      }
      this.pendingWork = true;
      this.lastScheduleTime = -Infinity;
      return;
    }
    if (this.indexedPageTable && plan.candidateGeneration !== undefined) {
      this.indexedStagingGeneration = plan.candidateGeneration;
    }
    // An indexed plan's candidate generation is staging state until the worker
    // supplies the complete candidate slot list. `displayGeneration` mirrors
    // that candidate on staging replies for diagnostics, but must not advance
    // the displayed generation: otherwise the later publication with the same
    // generation is mistaken for an unchanged display and never acknowledged.
    const presented = this.radChunkResidency
      ? chunkPublicationGlobals !== undefined &&
        chunkPublicationSlots !== null &&
        (chunkPublicationGlobals.length !== this.radChunkDisplayedGlobals.length ||
          this.radChunkDisplayedSelectionHashA === null ||
          chunkPublicationMapping?.selectionHashA !== this.radChunkDisplayedSelectionHashA ||
          chunkPublicationMapping?.selectionHashB !== this.radChunkDisplayedSelectionHashB)
      : this.indexedPageTable
        ? indexedPublication !== undefined &&
          plan.candidateGeneration !== this.pageTableDisplayGeneration &&
          plan.candidateGeneration !== this.indexedPublishGeneration
        : plan.displayGeneration !== undefined
          ? plan.displayGeneration !== this.pageTableDisplayGeneration
          : drawn !== this.pageTableDrawn;
    if (this.radChunkResidency && this.onPerformanceEvent !== undefined && presented) {
      console.debug(
        '[vlam:rad-chunk-publication]',
        JSON.stringify({
          seq: plan.seq,
          candidateGeneration: plan.candidateGeneration ?? null,
          candidateSize: chunkPublicationGlobals?.length ?? null,
          candidateRevision: plan.candidateRevision ?? null,
          demandGeneration: this.demandGeneration,
          demandNeedsNewRevision: this.demandNeedsNewRevision,
          selectionId: this.radChunkSelectionIdValue + 1,
          cameraObsolete:
            plan.candidateRevision !== undefined &&
            (plan.candidateRevision !== this.demandGeneration || this.demandNeedsNewRevision),
          selectionPresent: plan.selectionGlobals !== undefined,
          residentPages: this.radChunkAllocator?.residentCount ?? 0,
          displayed: this.radChunkDisplayedGlobals.length,
          presented,
          state: 'candidate',
        }),
      );
    }
    if (presented) {
      if (chunkPublicationGlobals && chunkPublicationSlots) {
        const previousVisibleCount = this.pageTableDrawn;
        const activeListStartedAt = performance.now();
        this.radChunkPublishActiveListVersion = this.replaceActiveIndices(chunkPublicationSlots);
        this.retainVisibleInstanceCount(previousVisibleCount);
        activeListMs = performance.now() - activeListStartedAt;
        this.radChunkPendingGlobals = chunkPublicationGlobals;
        this.radChunkPublishGeneration = plan.candidateGeneration as number;
        this.radChunkPublishRevision = plan.candidateRevision ?? null;
        this.radChunkSelectionIdValue++;
        this.radChunkPendingSelectionIdValue = this.radChunkSelectionIdValue;
        this.radChunkPendingHardValidityRevisionValue = this.radChunkHardValidityRevisionValue;
        this.radChunkPendingPageIdentity = chunkPublicationPageIdentity ?? null;
        this.radChunkPendingFiles = chunkPublicationPageIdentity
          ? new Set(chunkPublicationPageIdentity.keys())
          : null;
        this.radChunkPendingSelectionHashA = chunkPublicationMapping?.selectionHashA ?? null;
        this.radChunkPendingSelectionHashB = chunkPublicationMapping?.selectionHashB ?? null;
        this.radChunkPendingBudgetSettled =
          plan.budgetClamped === true &&
          this.radChunkDrawBudgetSaturated(chunkPublicationGlobals.length) &&
          (this.radChunkAllocator?.residentCount ?? 0) >=
            (this.radChunkAllocator?.capacityPages ?? Number.POSITIVE_INFINITY);
        this.radChunkSelectionCompletedAtValue = performance.now();
        this.radChunkSortSubmittedAtValue = this.radChunkSelectionCompletedAtValue;
        this.radChunkCameraObsoleteValue =
          this.radChunkPublishRevision !== null &&
          (this.radChunkPublishRevision !== this.demandGeneration || this.demandNeedsNewRevision);
        this.radChunkPendingRevealQuality = {
          revealReady: plan.revealReady === true,
          maxCentralProjectedRatio: plan.maxCentralProjectedRatio ?? 0,
          maxVisibleProjectedRatio: plan.maxVisibleProjectedRatio ?? 0,
        };
      } else if (indexedPublication) {
        const poolIndices = this.poolIndicesForSlabSlots(indexedPublication);
        const previousVisibleCount = this.pageTableDrawn;
        const activeListStartedAt = performance.now();
        this.indexedPublishActiveListVersion = this.replaceActiveIndices(poolIndices);
        this.retainVisibleInstanceCount(previousVisibleCount);
        activeListMs = performance.now() - activeListStartedAt;
        this.indexedPendingDisplaySlots = indexedPublication;
        this.indexedPublishGeneration = plan.candidateGeneration as number;
        this.indexedPublishRevision = plan.candidateRevision ?? null;
        const slotToNode = this.sampleRadDiagnosticValues(indexedPublication).map((slot) => ({
          slot,
          global: this.pageTableGlobals[slot] ?? 0xffffffff,
        }));
        const slotSet = new Set<number>();
        let duplicateSlots = false;
        let outOfRangeSlots = false;
        for (const slot of indexedPublication) {
          if (slotSet.has(slot)) duplicateSlots = true;
          slotSet.add(slot);
          if (slot >= limit) outOfRangeSlots = true;
        }
        const diagnostic = publicationDiagnostic;
        if (diagnostic) {
          diagnostic.slotToNode = slotToNode;
          diagnostic.slotChecks = {
            duplicate: duplicateSlots,
            outOfRange: outOfRangeSlots,
            displayedMutation: false,
          };
        }
        if (duplicateSlots || outOfRangeSlots || plan.diagnosticCut?.valid === false) {
          if (diagnostic) this.rejectRadPublicationDiagnostic(diagnostic, 'invalid-candidate');
          this.discardIndexedPublication('invalid-candidate');
          return;
        }
      } else {
        this.setSlabResident(drawn);
        this.pageTableDrawn = drawn;
        this.pageTableDisplayGeneration =
          plan.displayGeneration ?? this.pageTableDisplayGeneration + 1;
        this.invalidateSort();
      }
    }
    const budgetSettled =
      this.radChunkResidency &&
      plan.budgetClamped === true &&
      chunkPublicationGlobals !== undefined &&
      chunkPublicationSlots !== null &&
      !presented &&
      this.radChunkDrawBudgetSaturated(chunkPublicationGlobals.length) &&
      (this.radChunkAllocator?.residentCount ?? 0) >=
        (this.radChunkAllocator?.capacityPages ?? Number.POSITIVE_INFINITY);
    if (budgetSettled) this.settleRadChunkDemand();
    const converged = plan.converged || budgetSettled;
    const continuedOlderPlan = this.pageTableContinuePending;
    this.frontierConverged = converged;
    this.pageTableContinuePending = !converged;
    if (continuedOlderPlan && converged) {
      // The drain deliberately ignored the newer camera bundled with its
      // request. Re-solve that coalesced view immediately instead of waiting
      // for the idle timer or another movement threshold.
      this.pendingWork = true;
      this.lastScheduleTime = -Infinity;
    }
    this.pendingFrontierSplats = plan.pendingFrontierSplats ?? 0;
    this.staleResidentSplats = plan.staleResidentSplats ?? 0;
    this.lastPlanAppends = plan.lastPlanAppends ?? plan.appends.count;
    this.lastPlanMoves = plan.lastPlanMoves ?? plan.moveSlots.length;
    this.lastPlanGeneration = plan.planGeneration ?? this.lastPlanGeneration + 1;
    this.lastPlanBudget = plan.planBudget ?? this.pageTableDrawBudget;
    const traversalId = plan.traversalId ?? 0;
    const traversalMs =
      traversalId > 0 && traversalId !== this.lastCountedTraversalId ? (plan.traversalMs ?? 0) : 0;
    if (traversalId > 0) this.lastCountedTraversalId = traversalId;
    this.frontierTraversal = {
      strategy: plan.traversalStrategy ?? 'one-pass',
      fallback: plan.traversalFallback ?? false,
      fallbackCount: plan.traversalFallbackCount ?? 0,
      rootCoverInfeasible: plan.rootCoverInfeasible ?? false,
      traversalMs,
      traversalId,
    };
    this.lastPlanReason = plan.planReason ?? null;
    this.candidateCancellationCount =
      plan.candidateCancellationCount ?? this.candidateCancellationCount;
    this.boundedCutRefusalReason = plan.boundedCutRefusalReason;
    this.protectedCacheBytesValue = plan.protectedCacheBytes ?? this.protectedCacheBytesValue;
    this.lastSkipSamples = plan.skipSamples ?? [];
    if (plan.maxCentralProjectedRatio !== undefined) {
      this.maxCentralProjectedRatioValue = plan.maxCentralProjectedRatio;
    }
    if (plan.maxVisibleProjectedRatio !== undefined) {
      this.maxVisibleProjectedRatioValue = plan.maxVisibleProjectedRatio;
    }
    if (plan.candidateGeneration !== undefined) {
      if (this.frontierTraceStagingGeneration !== plan.candidateGeneration) {
        this.frontierTraceStagingGeneration = plan.candidateGeneration;
        this.recordFrontierTrace('staging-start', {
          generation: plan.candidateGeneration,
          candidateSize: plan.candidateSize,
          candidateNewSlots: plan.candidateNewSlots,
          candidateReusedSlots: plan.candidateReusedSlots,
          planReason: plan.planReason ?? null,
        });
      }
      this.recordFrontierTrace('traversal-complete', {
        generation: plan.candidateGeneration,
        candidateSize: plan.candidateSize,
        candidateNewSlots: plan.candidateNewSlots,
        candidateReusedSlots: plan.candidateReusedSlots,
        writes: plan.appends.count,
        planReason: plan.planReason ?? null,
        traversalId: plan.traversalId,
        revealReady: plan.revealReady,
        maxCentralProjectedRatio: plan.maxCentralProjectedRatio,
        maxVisibleProjectedRatio: plan.maxVisibleProjectedRatio,
      });
      if (!this.radChunkResidency && !candidateRevisionCurrent && plan.candidateComplete) {
        const diagnostic = publicationDiagnostic;
        if (diagnostic) {
          this.rejectRadPublicationDiagnostic(
            diagnostic,
            'stale-camera-or-configuration-revision',
            this.demandGeneration,
            this.demandNeedsNewRevision,
          );
        }
        // A complete candidate for an older camera/configuration revision may
        // already be awaiting the worker acknowledgement. Keep the displayed
        // cut, but immediately solve the current demand so the old publication
        // is cancelled and cannot leave refinement stalled at the coarse cut.
        this.pendingWork = true;
        this.lastScheduleTime = -Infinity;
        this.demandNeedsNewRevision = true;
      }
      if (plan.candidateComplete) {
        this.recordFrontierTrace('staging-complete', {
          generation: plan.candidateGeneration,
          candidateSize: plan.candidateSize,
          candidateNewSlots: plan.candidateNewSlots,
          candidateReusedSlots: plan.candidateReusedSlots,
          planReason: plan.planReason ?? null,
        });
      }
    }
    if (presented && indexedPublication) {
      // Keep quality attached to the exact candidate whose active-list version
      // is being rendered. A later worker plan may update the diagnostics while
      // this candidate is still waiting for sort/render acknowledgement; using
      // that newer plan could reveal an older coarse cut with the wrong verdict.
      this.indexedPendingRevealQuality = {
        revealReady: plan.revealReady === true,
        maxCentralProjectedRatio: plan.maxCentralProjectedRatio ?? 0,
        maxVisibleProjectedRatio: plan.maxVisibleProjectedRatio ?? 0,
      };
      this.recordFrontierTrace('active-list-replacement', {
        generation: plan.candidateGeneration ?? null,
        activeCount: indexedPublication.length,
        writes: plan.appends.count,
        planReason: plan.planReason ?? null,
        revealReady: plan.revealReady,
        maxCentralProjectedRatio: plan.maxCentralProjectedRatio,
        maxVisibleProjectedRatio: plan.maxVisibleProjectedRatio,
      });
    }
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
    if (plan.diagnosticGatherMissingFiles && plan.diagnosticGatherMissingFiles.length > 0) {
      console.debug(
        '[vlam:rad-gather-mismatch]',
        JSON.stringify({
          frameApplied: this.radFrame,
          generation: plan.candidateGeneration ?? null,
          revision: plan.candidateRevision ?? null,
          missingFiles: Array.from(plan.diagnosticGatherMissingFiles),
        }),
      );
    }
    // Applying a plan runs off the render loop's own timing, so its cost is
    // invisible to `getUpdateTimings` even though it lands on the same thread.
    // Recorded because a churning frontier can make this the largest stall in a
    // frame, and a cap has to be aimed at whichever half dominates.
    const planTimings = this.planTimingsValue;
    const handlerFinishedAt = performance.now();
    planTimings.applyMs = handlerFinishedAt - applyStartedAt;
    planTimings.handlerMs = planTimings.applyMs;
    planTimings.writeMs = writeFinishedAt - applyStartedAt;
    planTimings.residentMs = residentFinishedAt - writeFinishedAt;
    planTimings.mappingMs = chunkPublicationMapping?.mappingMs ?? 0;
    planTimings.pageIdentityMs = 0;
    planTimings.activeListMs = activeListMs;
    planTimings.moves = plan.moveSlots.length;
    planTimings.appends = plan.appends.count;
    if (planTimings.applyMs > planTimings.worstApplyMs) {
      planTimings.worstApplyMs = planTimings.applyMs;
      planTimings.worstSplats = planTimings.moves + planTimings.appends;
    }
    if (this.onPerformanceEvent !== undefined) {
      console.debug(
        '[vlam:rad-plan-timing]',
        JSON.stringify({
          seq: plan.seq,
          generation: plan.candidateGeneration ?? null,
          handlerMs: planTimings.handlerMs,
          installMs: planTimings.installMs,
          writeMs: planTimings.writeMs,
          residentMs: planTimings.residentMs,
          mappingMs: planTimings.mappingMs,
          pageIdentityMs: planTimings.pageIdentityMs,
          protectionMs: planTimings.protectionMs,
          activeListMs: planTimings.activeListMs,
          unifiedGatherMs: planTimings.unifiedGatherMs,
          sortMs: planTimings.sortMs,
        }),
      );
    }
    // Follow the cut with the screen-radius band. One-pass selection stops at
    // the configured pixel target; leftover draw budget is a ceiling, not a
    // reason to manufacture finer nodes. Scaling the band by solvedLimit keeps
    // it spanning one LOD level if a heap A/B walk does spend leftover budget.
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
    if (plan.evicted.length > 0) this.pageTableHostCacheRevision++;
    this.fetchCountsValue.cacheBytes = plan.cacheBytes;
    this.fetchCountsValue.cacheLimitBytes = plan.cacheLimitBytes;
    this.pageTableCacheAtLimit = plan.cacheBytes >= plan.cacheLimitBytes;
    // Recomputed every plan, not latched: the sweep must resume when the scene
    // budget raises this mesh's allowance. `cacheFull`/`evicted` stay monotonic
    // - they are diagnostics answering "did this happen", not live state.
    if (plan.evicted.length > 0) {
      this.fetchCountsValue.cacheFull = true;
      this.fetchCountsValue.evicted += plan.evicted.length;
    }
    // The chunks the frontier wants next, biggest-on-screen first - requested now
    // and kept as the priority list the next reschedule fetches before anything.
    this.pageTableFetchPriority = Array.from(plan.touched);
    this.reconcileDemand(this.demandReadyGeneration === this.demandGeneration);
    // Keep refining while chunks stream in (the frontier keeps changing), and
    // while the worker is still ramping its budget up to the governed one - that
    // ramp is what keeps a hard camera cut from arriving as one ~100 ms plan, so
    // the next pass must follow immediately or detail stalls where it stopped.
    if (this.fetching.size > 0 || !converged) {
      this.pendingWork = true;
      if (!converged) this.lastScheduleTime = -Infinity;
    }
    if (
      this.indexedPageTable &&
      plan.planReason === 'awaiting-publication' &&
      this.indexedPendingDisplaySlots === null &&
      this.indexedPublishGeneration === null
    ) {
      this.pendingWork = true;
      this.lastScheduleTime = -Infinity;
      this.resumeIndexedRefinementAfterPublication();
    }
  }

  /** Files that must keep their whole GPU page until the matching draw retires. */
  private protectedRadChunkFiles(): Set<number> {
    const protectedFiles = new Set<number>([0, ...this.radChunkDisplayedFiles]);
    if (this.radChunkPendingFiles) {
      for (const file of this.radChunkPendingFiles) protectedFiles.add(file);
    }
    for (const file of this.scene.pinnedFiles) protectedFiles.add(file);
    return protectedFiles;
  }

  /** Stops demand once a complete budget-full walk reproduces the displayed cut. */
  private settleRadChunkDemand(): void {
    this.radChunkDemandSettledRevision = this.demandGeneration;
    this.radChunkDemandSettledCamera = this.lastPostedCamera;
    this.radChunkDemandSettledForward = this.lastPostedForward;
    this.radChunkDemandSettledLimit = this.lastPostedLimit;
    this.radChunkDemandSettledConfig = this.radChunkDemandConfig();
    this.frontierConverged = true;
    this.pageTableContinuePending = false;
    this.demandWants = [];
    this.demandFirstSeen.clear();
    const protectedFiles = this.protectedRadChunkFiles();
    for (const [file, entry] of this.fetching) {
      if (
        entry.kind === 'priority' &&
        entry.classicWant === undefined &&
        !protectedFiles.has(file) &&
        !entry.controller.signal.aborted
      ) {
        entry.controller.abort();
      }
    }
  }

  private radChunkDrawBudgetSaturated(count: number): boolean {
    return this.pageTableDrawBudget > 0 && count >= this.pageTableDrawBudget * 0.99;
  }

  private radChunkDemandSettlementIsCurrent(
    camera: readonly [number, number, number],
    forward: readonly [number, number, number],
    limit: number,
  ): boolean {
    const settledCamera = this.radChunkDemandSettledCamera;
    const settledForward = this.radChunkDemandSettledForward;
    if (!settledCamera || !settledForward) return false;
    if (squaredDistance3(camera, settledCamera) > 1) return false;
    const forwardDot =
      forward[0] * settledForward[0] +
      forward[1] * settledForward[1] +
      forward[2] * settledForward[2];
    if (forwardDot < 0.999961923) return false;
    const scale = Math.max(Math.abs(limit), Math.abs(this.radChunkDemandSettledLimit), 1e-9);
    if (Math.abs(limit - this.radChunkDemandSettledLimit) / scale > 0.01) return false;
    return this.radChunkDemandSettledConfig === this.radChunkDemandConfig();
  }

  private radChunkDemandConfig(): string {
    const fov = this.pageTableFoveation;
    return `${this.pageTableDrawBudget}|${fov.coneFov0}|${fov.coneFov}|${fov.coneFoveate}|${fov.behindFoveate}`;
  }

  /** Releases the least-recently-used unprotected chunk page. */
  private evictRadChunkPage(): boolean {
    const protectionStartedAt = performance.now();
    const protectedFiles = this.protectedRadChunkFiles();
    this.planTimingsValue.protectionMs = performance.now() - protectionStartedAt;
    let oldestFile: number | undefined;
    let oldestTime = Infinity;
    for (const [file, page] of this.radChunkPages) {
      if (protectedFiles.has(file) || page.lastUsed >= oldestTime) continue;
      oldestFile = file;
      oldestTime = page.lastUsed;
    }
    if (oldestFile === undefined) return false;
    const page = this.radChunkPages.get(oldestFile);
    if (!page || !this.radChunkAllocator) return false;
    this.removeRange(page.range);
    this.radChunkPages.delete(oldestFile);
    this.radChunkAllocator.release(oldestFile);
    this.pageTableCachedFiles.delete(oldestFile);
    this.pageTableHostCacheRevision++;
    this.fetchCountsValue.evicted++;
    this.syncRadChunkPages();
    return true;
  }

  /** Uploads a decoded RAD chunk once into its stable page. */
  private installRadChunkPage(file: number, data: SplatData): boolean {
    const allocator = this.radChunkAllocator;
    if (!this.radChunkResidency || !allocator) return true;
    if (this.radChunkPages.has(file)) return true;
    const installStartedAt = performance.now();
    let page = allocator.allocate(file, data.count);
    while (page === undefined && this.evictRadChunkPage()) {
      page = allocator.allocate(file, data.count);
    }
    if (page === undefined) {
      const installMs = performance.now() - installStartedAt;
      this.planTimingsValue.installMs = installMs;
      this.fetchCountsValue.pageInstallMs += installMs;
      warn(
        `StreamedSplatMesh: RAD chunk ${file} could not obtain a stable GPU page; ` +
          'the chunk-page experiment remains on its previous complete selection.',
      );
      return false;
    }
    try {
      const range = this.appendInactivePage(data, allocator.chunkSize);
      this.radChunkPages.set(file, { range, count: data.count, lastUsed: performance.now() });
      this.pageTableCachedFiles.add(file);
      this.pageTableHostCacheRevision++;
      this.syncRadChunkPages();
      const installMs = performance.now() - installStartedAt;
      this.planTimingsValue.installMs = installMs;
      this.fetchCountsValue.pageInstalls++;
      this.fetchCountsValue.pageInstallMs += installMs;
      return true;
    } catch (error) {
      allocator.release(file);
      const installMs = performance.now() - installStartedAt;
      this.planTimingsValue.installMs = installMs;
      this.fetchCountsValue.pageInstallMs += installMs;
      warn(`StreamedSplatMesh: failed to upload RAD chunk ${file}; retaining the old cut.`, error);
      return false;
    }
  }

  /** Mirrors stable page presence to the traversal worker. */
  private syncRadChunkPages(): void {
    if (!this.radChunkResidency || !this.radChunkAllocator) return;
    this.postToWorker({
      type: 'chunkPages',
      files: Uint32Array.from(this.radChunkAllocator.residentFiles),
    });
  }

  /** Maps worker-selected RAD globals directly to pool indices. */
  private poolIndicesForRadGlobals(globals: ArrayLike<number>): Uint32Array | null {
    if (!this.radChunkAllocator) return null;
    const slots = this.radChunkAllocator.poolSlots(globals);
    if (!slots) return null;
    const now = performance.now();
    let previousFile = -1;
    for (let i = 0; i < globals.length; i++) {
      const file = Math.floor((globals[i] as number) / this.radChunkAllocator.chunkSize);
      // Selections are grouped by chunk. Page recency is shared by every
      // node in that chunk; millions of per-splat clock reads add no precision.
      if (file === previousFile) continue;
      previousFile = file;
      const page = this.radChunkPages.get(file);
      if (page) page.lastUsed = now;
    }
    return slots;
  }

  /** Forwards a decoded chunk's arrays to the worker (buffers transferred) so the
   * worker's cache/traversal/gather can use it. */
  private forwardChunkToWorker(file: number, data: SplatData): void {
    const tree = data.radTree;
    if (!tree) return;
    if (!this.installRadChunkPage(file, data)) return;
    this.pageTableCachedFiles.add(file);
    this.pageTableHostCacheRevision++;
    // Chunk arrivals do not obsolete camera demand. Incomplete replies from
    // waiter expansion must still merge into the current revision.
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
    const copy = this.radChunkResidency
      ? {
          positions: data.positions.slice(),
          colors: data.colors.slice(),
          covariances: data.covariances.slice(),
          childCount: tree.childCount.slice(),
          childStart: tree.childStart.slice(),
          size: tree.size.slice(),
          ...(sh ? { packed: sh.packed.slice() } : {}),
        }
      : null;
    this.postToWorker(
      {
        type: 'chunk',
        file,
        count: data.count,
        positions: copy?.positions ?? data.positions,
        colors: copy?.colors ?? data.colors,
        covariances: copy?.covariances ?? data.covariances,
        childCount: copy?.childCount ?? tree.childCount,
        childStart: copy?.childStart ?? tree.childStart,
        size: copy?.size ?? tree.size,
        shBands: sh?.bands ?? 0,
        ...(sh ? { shPacked: copy?.packed ?? sh.packed, shRange: sh.range } : {}),
      },
      [
        (copy?.positions ?? data.positions).buffer,
        (copy?.colors ?? data.colors).buffer,
        (copy?.covariances ?? data.covariances).buffer,
        (copy?.childCount ?? tree.childCount).buffer,
        (copy?.childStart ?? tree.childStart).buffer,
        (copy?.size ?? tree.size).buffer,
        ...(sh ? [(copy?.packed ?? sh.packed).buffer] : []),
      ],
    );
  }

  /** Parallel chunk fetches. HTTP/2 multiplexes them; on HTTP/1.1 the browser's
   * per-host cap simply queues. Same cap for classic and page-table so near
   * detail is not structurally starved on the non-page-table path. */
  private get maxInflight(): number {
    return MAX_INFLIGHT;
  }

  private pageTableActiveFetches(): number {
    let active = 0;
    for (const entry of this.fetching.values()) {
      if (
        entry.kind === 'priority' &&
        entry.classicWant === undefined &&
        !entry.controller.signal.aborted
      ) {
        active++;
      }
    }
    return active;
  }

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

  /**
   * Whether this mesh may run its speculative background sweep. A mesh with no
   * weight is hidden or suspended; a mesh with no `fetchWeight` at all is a
   * host that never asked for arbitration, and keeps the old behaviour.
   * @internal
   */
  sweepAllowed(): boolean {
    if (estimateSceneDecodedBytes(this.scene) > this.cacheLimitBytes) return false;
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

  /** Reclaims old-camera RAD priority slots after a translation-only cut. */
  private reclaimStalePriorityFetches(): void {
    if (!this.radChunkResidency) return;
    const protectedFiles = this.protectedRadChunkFiles();
    const activeBefore = this.pageTableActiveFetches();
    const retained = new Set<number>();
    let cancelled = 0;
    for (const [file, entry] of this.fetching) {
      if (entry.kind !== 'priority' || entry.classicWant !== undefined) continue;
      if (entry.cameraEpoch === this.cameraEpoch || entry.controller.signal.aborted) continue;
      if (protectedFiles.has(file)) {
        retained.add(file);
        continue;
      }
      entry.controller.abort();
      cancelled++;
      if (this.onPerformanceEvent !== undefined) {
        console.debug(
          '[vlam:rad-fetch-cancel]',
          JSON.stringify({
            file,
            reason: 'hard-relocation',
            demandGeneration: entry.demandGeneration,
            cameraEpoch: entry.cameraEpoch,
            cameraKey: entry.demandKey,
            cameraPosition: entry.requestedCameraPosition,
            currentCameraEpoch: this.cameraEpoch,
            currentCameraKey: this.demandKey,
            currentCameraPosition: this.latestDemandCamera,
          }),
        );
      }
    }
    this.demandDiagnostics.staleRequestsCancelled = cancelled;
    this.demandDiagnostics.protectedFilesRetained = [...retained].sort((a, b) => a - b);
    this.demandDiagnostics.staleCancellationReason = 'hard-relocation';
    this.demandDiagnostics.activeRequestsBeforeReclamation = activeBefore;
    this.demandDiagnostics.activeRequestsAfterReclamation = this.pageTableActiveFetches();
    this.demandDiagnostics.hardRelocations++;
    if (this.onPerformanceEvent !== undefined) {
      console.debug(
        '[vlam:rad-reclaim]',
        JSON.stringify({
          reason: 'hard-relocation',
          demandGeneration: this.demandGeneration,
          cameraEpoch: this.cameraEpoch,
          cameraKey: this.demandKey,
          cameraPosition: this.latestDemandCamera,
          staleRequestsCancelled: cancelled,
          protectedFilesRetained: [...retained].sort((a, b) => a - b),
          activeRequestsBeforeReclamation: activeBefore,
          activeRequestsAfterReclamation: this.pageTableActiveFetches(),
        }),
      );
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
    if (
      this.frontierWorker &&
      kind === 'priority' &&
      classicWant === undefined &&
      this.pageTableActiveFetches() >= 3
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
    const knownBytes = this.scene.chunkOptions?.[file]?.rad?.length ?? 0;
    const requestedAt = performance.now();
    if (this.frontierWorker) {
      this.demandDiagnostics.requests++;
      this.demandDiagnostics.knownRequestedBytes += knownBytes;
    }
    this.fetching.set(file, {
      controller,
      kind,
      classicWant,
      demandGeneration: this.demandGeneration,
      cameraEpoch: this.cameraEpoch,
      demandKey: this.demandKey,
      requestedCameraPosition: this.latestDemandCamera ?? this.lastPostedCamera,
    });
    if (
      this.demandDiagnostics.hardRelocationDetectedAt !== null &&
      this.demandDiagnostics.firstCurrentRevisionFetchAt === null &&
      this.demandReadyGeneration === this.demandGeneration
    ) {
      this.demandDiagnostics.firstCurrentRevisionFetchAt = requestedAt;
      this.demandDiagnostics.cameraToFirstFetchMs =
        requestedAt - this.demandDiagnostics.hardRelocationDetectedAt;
    }
    if (this.onPerformanceEvent !== undefined && this.frontierWorker) {
      console.debug(
        '[vlam:rad-fetch-start]',
        JSON.stringify({
          file,
          kind,
          active: this.pageTableActiveFetches(),
          demandGeneration: this.demandGeneration,
          cameraEpoch: this.cameraEpoch,
          cameraKey: this.demandKey,
          cameraPosition: this.latestDemandCamera ?? this.lastPostedCamera,
        }),
      );
    }
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
        // Abort can race a loader that has already resolved. Do not forward a
        // stale old-camera chunk after reclamation has handed the slot away.
        if (this.disposed || controller.signal.aborted) return;
        if (this.frontierWorker) {
          this.demandDiagnostics.completed++;
          this.demandDiagnostics.knownCompletedBytes += knownBytes;
          this.demandDiagnostics.requestToDecodeMs += performance.now() - requestedAt;
        }
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
        if (this.frontierWorker) this.reconcileDemand(false);
        this.pendingWork = !(
          this.radChunkResidency &&
          this.radChunkDemandSettledRevision === this.demandGeneration &&
          this.fetching.size === 0
        );
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

/** Owns every mutable object a queued/replayed stroke depends on. */
function cloneBrushStroke(stroke: BrushStroke): BrushStroke {
  return {
    paths: stroke.paths.map((path) =>
      path.map((sample) => ({
        point: sample.point.clone(),
        radius: sample.radius,
        ...(sample.viewDepth === undefined ? {} : { viewDepth: sample.viewDepth }),
      })),
    ),
    ...(stroke.viewMatrix ? { viewMatrix: stroke.viewMatrix.clone() } : {}),
  };
}
const _cameraWorldPos = new THREE.Vector3();
const _cameraWorldQuat = new THREE.Quaternion();
const _cameraLocal = new THREE.Vector3();
const _projScreen = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _streamCameraWorld = new THREE.Vector3();
const _streamCameraLocal = new THREE.Vector3();
const _streamCameraForward = new THREE.Vector3();
const _streamProjection = new THREE.Matrix4();
const _startupSettledPosition = new THREE.Vector3();
const _sphere = new THREE.Sphere();
/** Camera forward in mesh-local space, for the page-table traversal's foveation. */
const _cameraForward = new THREE.Vector3();
const _drawSize = new THREE.Vector2();

function squaredDistance3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/** Validates the page-table RAD first-image fraction; zero restores the old hold. */
function validateRadInitialDisplayFraction(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RAD_INITIAL_DISPLAY_FRACTION;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(
      `radInitialDisplayFraction must be a finite fraction in [0, 1], got ${value}.`,
    );
  }
  return value;
}

function resolveRadInitialRevealPolicy(
  options: StreamedSplatMeshOptions,
): 'progressive' | 'allocation-fraction' | 'projected-quality' {
  const named = options.radInitialRevealPolicy;
  if (named !== undefined) {
    if (
      named !== 'progressive' &&
      named !== 'allocation-fraction' &&
      named !== 'projected-quality'
    ) {
      throw new RangeError(
        `radInitialRevealPolicy must be 'progressive', 'allocation-fraction', or 'projected-quality', got ${JSON.stringify(named)}.`,
      );
    }
    return named;
  }
  // Legacy callers that named a fraction without a policy keep that hold.
  return options.radInitialDisplayFraction !== undefined ? 'allocation-fraction' : 'progressive';
}

/** Stable camera/config identity for demand revisions. Quantized so sub-ulp
 * matrix jitter does not mint a new revision every frame. */
function pageTableDemandKey(
  camera: readonly number[],
  forward: readonly number[],
  projection: readonly number[],
  limit: number,
  budget: number,
  fov: { coneFov0: number; coneFov: number; coneFoveate: number; behindFoveate: number },
): string {
  const q = (value: number, digits: number) => value.toFixed(digits);
  return [
    camera.map((value) => q(value, 4)).join(','),
    forward.map((value) => q(value, 5)).join(','),
    projection.map((value) => q(value, 6)).join(','),
    q(limit, 8),
    budget,
    fov.coneFov0,
    fov.coneFov,
    fov.coneFoveate,
    fov.behindFoveate,
  ].join('|');
}

function initialPublishMinSplats(
  policy: 'progressive' | 'allocation-fraction' | 'projected-quality',
  fraction: number | undefined,
  drawBudget: number,
): number {
  if (policy === 'progressive' || policy === 'projected-quality') return 0;
  const value = validateRadInitialDisplayFraction(fraction);
  // `0` is the target-detail hold: publish only once requested children exist.
  return value === 0 ? Number.MAX_SAFE_INTEGER : Math.ceil(drawBudget * value);
}

/** A `SplatData` view over a contiguous run `[j, j + count)` of a plan's packed
 * splats, so one pool write covers a whole run of slots. Zero-copy subarrays. */
function shWordsPerSplat(bands: 1 | 2 | 3): number {
  // Each packed uint stores one RGB coefficient. The RGBA texture groups
  // provide four words per *texel*, but the plan buffer has no group padding
  // between splats. Rounding here shifted every splat after the first for
  // band 2/3 page-table moves and appends.
  return shCoefficientCount(bands);
}

function slicePlanRun(splats: PlanSplats, j: number, count: number): PlanSplats {
  const sh = splats.shPacked;
  return {
    count,
    globals: splats.globals.subarray(j, j + count),
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
