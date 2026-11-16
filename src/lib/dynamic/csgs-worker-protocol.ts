/**
 * Wire protocol of the `.csgs` clip worker (`csgs-decode-worker.ts`).
 *
 * Split from the worker module so the clip loader can be typed against it
 * without pulling worker source into the published declarations: the worker
 * is reached only through `?worker&inline`.
 */
import type { SplatPackedShData } from '../core/splat-data';
import type { CsgsFrameBuffers } from '../formats/csgs/csgs-frame';
import type { CsgsGpuSection } from '../formats/csgs/csgs-gpu-layout';
import type { CsgsSectionInfo } from './csgs-gpu-playback';

export type CsgsWorkerRequest =
  /** Decode every section of one clip, in stream order. */
  | { readonly type: 'decode'; readonly sections: readonly ArrayBuffer[] }
  /**
   * Evaluate integer frame `frame`, every splat of its section in its own
   * slot; `buffers` are a previous reply's buffers handed back for reuse
   * (transferred), or absent to allocate. `sh` asks for the section's packed
   * SH too (a 6 MB copy for 110k splats), which only a section change needs.
   * `compact` packs only the alive splats (a snapshot, not playback slots).
   */
  | {
      readonly type: 'frame';
      readonly id: number;
      readonly frame: number;
      readonly sh: boolean;
      readonly compact?: boolean;
      readonly buffers?: CsgsFrameBuffers;
    }
  /** Pack section `index` for GPU playback (`formats/csgs/csgs-gpu-layout.ts`). */
  | { readonly type: 'gpuSection'; readonly id: number; readonly index: number };

export type CsgsWorkerReply =
  | {
      readonly type: 'section';
      readonly index: number;
      readonly info: CsgsSectionInfo;
      readonly decodeMs: number;
    }
  | {
      readonly type: 'decoded';
      /** The stream's one packed-SH range, which every frame's SH uses. */
      readonly shRange: SplatPackedShData['range'];
    }
  | {
      readonly type: 'frame';
      readonly id: number;
      readonly frame: number;
      /** Index of the section the frame belongs to. */
      readonly section: number;
      /** Slots (the section's splats): the prefix of each buffer that holds the frame. */
      readonly count: number;
      /** Splats alive at the frame; the other slots draw nothing. */
      readonly alive: number;
      /** Whether `buffers.shPacked` holds the section's SH. */
      readonly sh: boolean;
      readonly buffers: CsgsFrameBuffers;
      readonly evalMs: number;
    }
  | { readonly type: 'gpuSection'; readonly id: number; readonly section: CsgsGpuSection }
  | { readonly type: 'error'; readonly id?: number; readonly error: string };
