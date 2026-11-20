/**
 * Wire protocol of the `.asog` clip worker (`asog-decode-worker.ts`).
 *
 * Split from the worker module so the clip loader can be typed against it
 * without pulling worker source into the published declarations: the worker
 * is reached only through `?worker&inline`.
 */
import type { SplatData, SplatPackedShData } from '../core/splat-data';
import type { SplatFrameBuffers } from './splat-clip-playback';

/** What the worker learns of a decoded file. */
export interface AsogClipInfo {
  readonly count: number;
  readonly shBands: 0 | 1 | 2 | 3;
  readonly fps: number;
  readonly durationSeconds: number;
  readonly clipCount: number;
  /** The clip table (see `formats/asog/parse-asog.ts`). */
  readonly clips: Float32Array;
  /** Box of every visible centre (`asogMotionBounds`). */
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] };
  /** `manifest.source.format`, when given. */
  readonly sourceFormat: string | null;
  readonly decodeMs: number;
}

/** What the GPU path uploads once: the canonical splats and their motion. */
export interface AsogGpuData {
  /** Canonical centres, colours (base opacity), covariances and packed SH. */
  readonly pool: SplatData;
  /** `ASOG_MOTION_FLOATS` per splat. */
  readonly motion: Float32Array;
}

export type AsogWorkerRequest =
  /** Decode one whole file (transferred). */
  | { readonly type: 'decode'; readonly bytes: ArrayBuffer }
  /**
   * Evaluate integer frame `frame`, splat `i` in slot `i`; `buffers` are a
   * previous reply's buffers handed back for reuse (transferred). `sh` asks
   * for the packed SH too, which only the first frame needs. `compact` packs
   * only the visible splats (a snapshot, not playback slots).
   */
  | {
      readonly type: 'frame';
      readonly id: number;
      readonly frame: number;
      readonly sh: boolean;
      readonly compact?: boolean;
      readonly buffers?: SplatFrameBuffers;
    }
  /** Pack the canonical splats and the motion for the GPU path. */
  | { readonly type: 'gpu'; readonly id: number };

export type AsogWorkerReply =
  | {
      readonly type: 'decoded';
      readonly info: AsogClipInfo;
      /** Range of the packed SH every frame uses. */
      readonly shRange: SplatPackedShData['range'];
      readonly audio: { readonly mime: string; readonly bytes: Uint8Array } | null;
    }
  | {
      readonly type: 'frame';
      readonly id: number;
      readonly frame: number;
      /** Slots written: the prefix of each buffer that holds the frame. */
      readonly count: number;
      /** Splats visible at the frame; the other slots draw nothing. */
      readonly alive: number;
      /** Whether `buffers.shPacked` holds the SH. */
      readonly sh: boolean;
      readonly buffers: SplatFrameBuffers;
      readonly evalMs: number;
    }
  | { readonly type: 'gpu'; readonly id: number; readonly data: AsogGpuData }
  | { readonly type: 'error'; readonly id?: number; readonly error: string };
