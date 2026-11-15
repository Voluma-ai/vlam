/**
 * The format-neutral clip a {@link SplatClipMesh} plays. A loader
 * ({@link loadSplatClip}, or a format's own such as {@link loadCsgsClip})
 * produces one; the mesh only reads what is declared here, so a new format
 * changes neither the mesh nor the app.
 */
import type * as THREE from 'three/webgpu';
import type { SplatData } from '../core/splat-data';
import type { SplatClipDriver } from './splat-clip-playback';

/**
 * The clip formats {@link loadSplatClip} reads:
 *
 * - `'csgs'`: a Faltwerk CurveStream-GS clip, given by its `scene_*.json`
 *   (the `.csgs` sections sit next to it).
 *
 * @experimental
 */
export const SPLAT_CLIP_FORMATS = ['csgs'] as const;

/**
 * A clip format {@link loadSplatClip} reads (see {@link SPLAT_CLIP_FORMATS}).
 *
 * @experimental
 */
export type SplatClipFormat = (typeof SPLAT_CLIP_FORMATS)[number];

/**
 * A time-varying (4D) splat clip: a capture that moves, every splat following
 * its own path over the clip's frames. Play it with a {@link SplatClipMesh}.
 *
 * An app can implement this interface for a format vlam does not read: give
 * {@link frame} and the metadata, and the mesh plays it on its frame path
 * (each frame evaluated by the clip and written into the pool). Formats
 * vlam ships may add a faster GPU path behind the same interface.
 *
 * @experimental The API may change in a minor release.
 */
export interface SplatClip {
  /**
   * Format of the source: one of {@link SPLAT_CLIP_FORMATS} for a clip vlam
   * loaded, or any name an app gives its own.
   */
  readonly format: SplatClipFormat | (string & {});
  /** Clip name, for labels and the {@link SplatClipMesh.animation} clip. */
  readonly name: string;
  /** Frames per second the clip was captured at. */
  readonly fps: number;
  /** Frames of the whole clip; playback wraps after the last. */
  readonly totalFrames: number;
  /** `totalFrames / fps`, in seconds. */
  readonly duration: number;
  /** Most splats any one frame holds: what the mesh's pool is sized for. */
  readonly maxCount: number;
  /**
   * Clip-local box every splat center of every frame stays inside. A
   * `SplatClipMesh` copies it into its `displacementBounds` when constructed,
   * so a later change reaches only meshes built after it.
   */
  readonly bounds: THREE.Box3;
  /**
   * View-dependent SH bands the frames carry (0 for none). When it is not 0,
   * every {@link frame} must bring its SH (`sh` or `shPacked`); one without
   * fails playback with an `error` event.
   */
  readonly shBands: 0 | 1 | 2 | 3;
  /**
   * Evaluates integer frame `index` (`0 ≤ index < totalFrames`) into fresh
   * `SplatData` the caller owns: the alive splats only, in clip-local space.
   * For placement, thumbnails and export; playback does not go through it
   * when the clip has a faster path.
   */
  frame(index: number): Promise<SplatData>;
  /** Releases the clip (a worker, decoded sections); later calls reject. */
  dispose(): void;
  /**
   * The format's playback strategy; a clip without one plays on the generic
   * frame path over {@link frame}.
   *
   * @internal
   */
  readonly driver?: SplatClipDriver;
}

/**
 * Progress of a clip load: files fetched, then sections decoded.
 *
 * @experimental
 */
export interface SplatClipLoadProgress {
  readonly stage: 'fetch' | 'decode';
  /** Items done in this stage. */
  readonly loaded: number;
  /** Items of this stage. */
  readonly total: number;
  /** A one-line status for a progress label. */
  readonly message: string;
}

/**
 * Options every clip loader takes.
 *
 * @experimental
 */
export interface SplatClipLoadOptions {
  onProgress?: (event: SplatClipLoadProgress) => void;
  /** Aborts the fetches and any decode worker; the load rejects with an `AbortError`. */
  signal?: AbortSignal;
}
