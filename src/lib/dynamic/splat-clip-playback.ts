/**
 * The internal contract between {@link SplatClipMesh} and a clip format's
 * playback. Not exported from `@voluma/vlam/dynamic`: formats ship inside
 * vlam, and this interface may change freely as new ones show what they need.
 *
 * The mesh asks the clip's {@link SplatClipDriver} for a {@link SplatClipPlan}
 * before it exists (the plan fixes the pool capacity), then hands the plan's
 * `create` a {@link ClipHost} once it does. From then on it only calls the
 * returned {@link ClipPlayback}: `apply` with the wanted frame every update,
 * and `stageWithin` when the shared staging budget comes round.
 */
import type * as THREE from 'three/webgpu';
import type { SplatData } from '../core/splat-data';
import type { SplatModifier } from '../core/splat-modifier';
import type { SplatMeshOptions, SplatRange } from '../core/splat-mesh-types';
import type { SplatClip } from './splat-clip';
import type { SplatClipStager } from './splat-clip-staging-budget';

/** Reusable output buffers of a frame evaluation, handed back to avoid allocation. */
export interface SplatFrameBuffers {
  positions: Float32Array;
  colors: Uint8Array;
  covariances: Float32Array;
  shPacked: Uint32Array;
}

/**
 * One evaluated frame for the frame path. `data` may view `buffers`, which
 * the playback hands back with a later request once the pool holds a copy.
 */
export interface SplatClipFrame {
  readonly frame: number;
  /**
   * Run of frames sharing one set of splats in fixed slots (and one SH). A
   * frame of the shown section rewrites only the moving attributes.
   */
  readonly section: number;
  /** Splats alive at the frame. */
  readonly alive: number;
  readonly data: SplatData;
  readonly buffers?: SplatFrameBuffers;
  /** Evaluation time (in the clip's worker, when it has one), in ms. */
  readonly evalMs: number;
}

/** Where the frame path gets its frames. */
export interface SplatClipFrameSource {
  /**
   * Evaluates integer frame `frame`. `sh: false` may skip the section's
   * static SH, which only a section change needs.
   */
  evaluate(frame: number, recycle?: SplatFrameBuffers, sh?: boolean): Promise<SplatClipFrame>;
  /** {@link SplatClipFrame.section} of integer frame `frame`. */
  sectionOf(frame: number): number;
}

/** What a format's playback may do to its mesh (bound protected members). */
export interface ClipHost {
  readonly clip: SplatClip;
  readonly renderer: THREE.WebGPURenderer;
  reserveInactiveRange(count: number): SplatRange;
  overwriteRangeData(range: SplatRange, data: SplatData, offset: number): void;
  overwriteRangeCore(range: SplatRange, data: SplatData, offset: number): void;
  setRangeActivePrefix(range: SplatRange, prefix: number): void;
  defineChannel(name: string): void;
  writeChannel(range: SplatRange, name: string, data: ArrayLike<number>): void;
  /** Sets the mesh's modifier stack and its sort-displacement stand-ins. */
  setModifiers(
    modifiers: readonly SplatModifier[],
    sortDisplacement: readonly SplatModifier[],
  ): void;
  invalidateSort(): void;
  invalidateSortDisplacement(): void;
  sortInFlight(): boolean;
  /** Reports a failure; the playback keeps showing its last good frame. */
  fail(error: unknown): void;
}

/** One playback path. `frame` is the fractional, wrapped clip frame. */
export interface ClipPlayback extends SplatClipStager {
  readonly alive: number;
  readonly shownFrame: number;
  /** Moves toward `frame`; `exact` (paused or after a jump) shows only that frame. */
  apply(frame: number, direction: 1 | -1, exact: boolean): void;
  /** Whether the drawn content is exactly `frame`. */
  shows(frame: number): boolean;
  /** Whether `frame` failed and will not show until the clip is reloaded. */
  failedAt(frame: number): boolean;
  /** Debug counters for harnesses. */
  stats(): Record<string, number>;
  dispose(): void;
}

/** What a driver needs to plan: the mesh options that pick a path. */
export interface SplatClipPlanRequest {
  readonly renderer: THREE.WebGPURenderer;
  readonly playback: 'auto' | 'gpu' | 'frames';
  readonly residentSections: number | 'all' | 'auto';
  readonly sortStrategy: SplatMeshOptions['sortStrategy'];
}

/** A chosen path: the pool it needs and how to start it. */
export interface SplatClipPlan {
  readonly path: 'gpu' | 'frames';
  /** Pool capacity the mesh reserves (whole rows). */
  readonly capacity: number;
  create(host: ClipHost): ClipPlayback;
}

/** A clip format's playback strategy (see the module comment). */
export interface SplatClipDriver {
  /** Picks the path and the pool capacity; throws for an impossible `playback: 'gpu'`. */
  plan(request: SplatClipPlanRequest): SplatClipPlan;
}
