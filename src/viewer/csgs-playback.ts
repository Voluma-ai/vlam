/**
 * `.csgs` (Faltwerk 4DGS) clip loading and playback, shared by the playback
 * harness (`csgs-harness.ts`) and the demo viewer's `4dgs` effect.
 *
 * Each clip has its own worker (`csgs-decode-worker.ts`) that decodes the
 * sections once, keeps them, and evaluates frames on request. The page only
 * swaps a finished frame into a dynamic-capacity {@link CsgsPlaybackMesh}
 * whole (remove + append), so nothing in the renderer knows about time and
 * the main thread never runs the curve evaluation.
 */
import * as THREE from 'three/webgpu';
import {
  SplatMesh,
  type SplatData,
  type SplatMeshOptions,
  type SplatPackedShData,
  type SplatRange,
} from '../lib/core';
import type { CsgsFrameBuffers } from '../lib/formats/csgs';
import type { CsgsGpuSection } from './csgs-gpu-layout';
import type { CsgsSectionInfo, CsgsWorkerReply, CsgsWorkerRequest } from './csgs-decode-worker';

export interface CsgsSceneSection {
  url: string;
  g0: number;
  nframes: number;
}

export interface CsgsTestCamera {
  name: string;
  /** World → camera rotation, OpenCV axes (x right, y down, z forward). */
  R: number[][];
  t: number[];
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** A Faltwerk `scene_*.json`: the clip's sections, frame rate and cameras. */
export interface CsgsSceneFile {
  fps: number;
  sections: CsgsSceneSection[];
  orbit: { center: number[]; up: number[]; front: number[]; dist: number; fovy_deg: number };
  testcams: CsgsTestCamera[];
}

export type { CsgsSectionInfo };

/**
 * One evaluated frame, whose `data` views `buffers`: every splat of its
 * section in its own slot, the dead ones drawing nothing.
 */
export interface CsgsClipFrame {
  readonly frame: number;
  /** Index of the section the frame belongs to. */
  readonly section: number;
  /** Splats alive at the frame. */
  readonly alive: number;
  /** `data.shPacked` is present only when the evaluation asked for SH. */
  readonly data: SplatData;
  /** Hand these back through {@link CsgsClip.evaluate} once `data` is consumed. */
  readonly buffers: CsgsFrameBuffers;
  /** Curve evaluation time in the worker. */
  readonly evalMs: number;
}

/** A decoded clip, its sections held by its worker. */
export interface CsgsClip {
  /** Clip name from the section path (`female`, `male_1`, …). */
  readonly name: string;
  readonly scene: CsgsSceneFile;
  readonly sections: readonly CsgsSectionInfo[];
  readonly totalFrames: number;
  /** Splats of the largest section: what a frame can hold at most. */
  readonly maxCount: number;
  readonly sectionBytes: number;
  readonly decodeMs: readonly number[];
  /**
   * Evaluates integer frame `frame` in the worker. `recycle` hands back a
   * previous frame's buffers (transferred) so the worker allocates nothing;
   * `sh: false` skips the section's static SH, which only a section change
   * needs.
   */
  evaluate(frame: number, recycle?: CsgsFrameBuffers, sh?: boolean): Promise<CsgsClipFrame>;
  /** Packs section `index` for GPU playback in the worker (`csgs-gpu-layout.ts`). */
  gpuSection(index: number): Promise<CsgsGpuSection>;
  /** Terminates the worker; pending evaluations reject. */
  dispose(): void;
}

/**
 * The default clip of the harness and the demo's `4dgs` effect, linked from
 * the public Faltwerk demo (GitHub Pages serves it with CORS `*`). The clips
 * have no stated license, so they are linked, not copied, until permission
 * is granted.
 */
export const CSGS_DEMO_SCENE = 'https://jameskane05.github.io/faltwerk-demo/scene_female.json';

/** Pool rows are 2048 splats wide; a range rounds up to whole rows. */
const POOL_ROW = 2048;

/** Fetches a Faltwerk `scene_*.json`. */
export async function fetchCsgsScene(sceneUrl: URL): Promise<CsgsSceneFile> {
  const response = await fetch(sceneUrl);
  if (!response.ok) throw new Error(`${sceneUrl.href}: HTTP ${response.status}`);
  return (await response.json()) as CsgsSceneFile;
}

/**
 * Fetches a Faltwerk `scene_*.json` (unless already given) and its sections,
 * and decodes them in the clip's worker, which keeps them for
 * {@link CsgsClip.evaluate}. `onProgress` reports each step for a status line.
 */
export async function loadCsgsClip(
  sceneUrl: URL,
  onProgress?: (message: string) => void,
  sceneFile?: CsgsSceneFile,
): Promise<CsgsClip> {
  const scene = sceneFile ?? (await fetchCsgsScene(sceneUrl));
  onProgress?.(`Fetching ${scene.sections.length} sections…`);
  const buffers = await Promise.all(
    scene.sections.map(async (section) => {
      const url = new URL(section.url, sceneUrl);
      const sectionResponse = await fetch(url);
      if (!sectionResponse.ok) throw new Error(`${url.href}: HTTP ${sectionResponse.status}`);
      return sectionResponse.arrayBuffer();
    }),
  );
  const sectionBytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  onProgress?.(`Decoding ${(sectionBytes / 1e6).toFixed(1)} MB in a worker…`);

  const worker = new Worker(new URL('./csgs-decode-worker.ts', import.meta.url), {
    type: 'module',
  });
  const sections: CsgsSectionInfo[] = [];
  const decodeMs: number[] = [];
  /** Requests awaiting their reply, by id; each resolves with its reply's payload. */
  const pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (error: Error) => void }
  >();
  const ask = <T>(message: CsgsWorkerRequest, transfer: Transferable[] = []): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pending.set(message.type === 'decode' ? 0 : message.id, {
        resolve: resolve,
        reject,
      });
      worker.postMessage(message, transfer);
    });
  let nextId = 1;
  let shRange: SplatPackedShData['range'] | null = null;
  let failDecode: ((error: Error) => void) | null = null;
  const fail = (error: Error): void => {
    failDecode?.(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const decoded = new Promise<void>((resolve, reject) => {
    failDecode = reject;
    worker.onmessage = (event: MessageEvent<CsgsWorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'section') {
        sections[reply.index] = reply.info;
        decodeMs[reply.index] = reply.decodeMs;
        onProgress?.(
          `Decoded section ${reply.index + 1}/${buffers.length}: ` +
            `${reply.info.count} splats in ${reply.decodeMs.toFixed(0)} ms`,
        );
      } else if (reply.type === 'decoded') {
        shRange = reply.shRange;
        failDecode = null;
        resolve();
      } else if (reply.type === 'frame') {
        const request = pending.get(reply.id);
        pending.delete(reply.id);
        request?.resolve(frameFromReply(reply, shRange!) as never);
      } else if (reply.type === 'gpuSection') {
        const request = pending.get(reply.id);
        pending.delete(reply.id);
        request?.resolve(reply.section as never);
      } else if (reply.id !== undefined) {
        const request = pending.get(reply.id);
        pending.delete(reply.id);
        request?.reject(new Error(reply.error));
      } else {
        worker.terminate();
        fail(new Error(reply.error));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      fail(new Error(event.message));
    };
  });
  const request: CsgsWorkerRequest = { type: 'decode', sections: buffers };
  worker.postMessage(request, buffers);
  await decoded;

  return {
    name: scene.sections[0]!.url.split('/').slice(-2, -1)[0]!.replace(/_p44$/, ''),
    scene,
    sections,
    totalFrames: Math.max(...scene.sections.map((s) => s.g0 + s.nframes)),
    maxCount: Math.max(...sections.map((s) => s.count)),
    sectionBytes,
    decodeMs,
    evaluate(frame, recycle, sh = true) {
      return ask<CsgsClipFrame>(
        { type: 'frame', id: nextId++, frame, sh, buffers: recycle },
        recycle
          ? [
              recycle.positions.buffer,
              recycle.colors.buffer,
              recycle.covariances.buffer,
              recycle.shPacked.buffer,
            ]
          : [],
      );
    },
    gpuSection(index) {
      return ask<CsgsGpuSection>({ type: 'gpuSection', id: nextId++, index });
    },
    dispose() {
      worker.terminate();
      fail(new Error('CSGS: the clip was disposed.'));
    },
  };
}

/** Views a frame reply's buffers as `SplatData` of its section's slots. */
function frameFromReply(
  reply: Extract<CsgsWorkerReply, { type: 'frame' }>,
  range: SplatPackedShData['range'],
): CsgsClipFrame {
  const { count, buffers } = reply;
  // Packed SH words per splat, as the worker sized the buffers.
  const shWords = buffers.shPacked.length / (buffers.positions.length / 3);
  return {
    frame: reply.frame,
    section: reply.section,
    alive: reply.alive,
    buffers,
    evalMs: reply.evalMs,
    data: {
      count,
      positions: buffers.positions.subarray(0, count * 3),
      colors: buffers.colors.subarray(0, count * 4),
      covariances: buffers.covariances.subarray(0, count * 6),
      ...(reply.sh
        ? {
            shPacked: {
              bands: 3 as const,
              packed: buffers.shPacked.subarray(0, count * shWords),
              range,
            },
          }
        : {}),
    },
  };
}

/**
 * Local bounds of a frame, ignoring the 1 % most outlying splats per axis
 * (stray floaters would otherwise set the floor).
 */
export function csgsFrameBounds(data: SplatData): THREE.Box3 {
  const box = new THREE.Box3();
  if (data.count === 0) return box;
  for (let axis = 0; axis < 3; axis++) {
    const values = new Float32Array(data.count);
    for (let i = 0; i < data.count; i++) values[i] = data.positions[i * 3 + axis]!;
    values.sort();
    const low = values[Math.floor(data.count * 0.01)]!;
    const high = values[Math.min(data.count - 1, Math.floor(data.count * 0.99))]!;
    box.min.setComponent(axis, low);
    box.max.setComponent(axis, high);
  }
  return box;
}

/**
 * A dynamic-capacity {@link SplatMesh} that shows one frame of a clip at a
 * time. Frames are evaluated in the clip's worker one ahead of the shown
 * frame; {@link advance} swaps a frame in once it has arrived and is due.
 *
 * One pool range, sized for the clip's largest section, holds every splat of
 * the current section in a fixed slot (dead splats draw nothing). Within a
 * section a swap rewrites only the moving attributes in place and leaves the
 * static SH where it is; a section change writes everything once and resizes
 * the active prefix to the new section.
 *
 * A swap waits while the previous frame's GPU sort is in flight: the mesh
 * keeps drawing that sort's order until it completes, and the swap rewrites
 * the pool rows the order indexes, so the frame in between would draw the new
 * splats in the old order. `StreamedSplatMesh` holds its swaps on the same
 * gate.
 */
export class CsgsPlaybackMesh extends SplatMesh {
  readonly clip: CsgsClip;
  /** Splats alive in the shown frame. */
  alive = 0;
  /** Integer frame shown, or -1 before the first swap. */
  shownFrame = -1;
  /** Worker curve evaluation of the shown frame. */
  evalMs = 0;
  /** The pool write of the last swap: the main thread's share. */
  swapMs = 0;
  /** Swaps deferred because the previous frame's sort was still in flight. */
  heldSwaps = 0;
  private readonly range: SplatRange;
  /** Section whose splats (and SH) the range holds, or -1 before the first swap. */
  private slotSection = -1;
  /** Section of the last requested frame: a new one asks the worker for SH. */
  private requestedSection = -1;
  /** An evaluated frame waiting for its turn. */
  private ready: CsgsClipFrame | null = null;
  private requesting = false;
  /** Buffers of swapped-out frames, handed back with the next request. */
  private readonly spare: CsgsFrameBuffers[] = [];
  private released = false;

  constructor(clip: CsgsClip, options: SplatMeshOptions = {}) {
    // One spare row: a range rounds up to whole rows.
    super({ capacity: Math.ceil(clip.maxCount / POOL_ROW) * POOL_ROW + POOL_ROW }, options);
    this.clip = clip;
    this.range = this.reserveInactiveRange(clip.maxCount);
  }

  /** Whether a GPU sort still owns the draw order (a swap now would flash). */
  get sortInFlight(): boolean {
    return this.hasInFlightSortSubmission();
  }

  /**
   * Moves playback toward integer frame `target`; call once per rendered
   * frame. Swaps in the evaluated frame if it is due and the last sort has
   * landed, then asks the worker for the next one. While playing, a late
   * frame still shows (the worker catches up); `exact` shows only `target`
   * itself, for seeking. Returns whether `target` is the shown frame.
   */
  advance(target: number, exact = false): boolean {
    const total = this.clip.totalFrames;
    const ready = this.ready;
    if (ready) {
      // How far the evaluated frame trails the target (0 = on time); half a
      // loop or more means it is ahead (a prefetch) and waits.
      const behind = (target - ready.frame + total) % total;
      if (exact && ready.frame !== target) {
        this.discard(ready);
      } else if (ready.section !== this.slotSection && !ready.data.shPacked) {
        // A new section needs its SH, which this evaluation skipped (the
        // frame that carried it was discarded by a seek): ask again.
        this.discard(ready);
        this.requestedSection = -1;
      } else if (behind < total / 2) {
        if (this.sortInFlight) this.heldSwaps++;
        else this.swap(ready);
      }
    }
    if (!this.ready && !this.requesting) {
      if (this.shownFrame !== target) this.request(target);
      else if (!exact) this.request((target + 1) % total);
    }
    return this.shownFrame === target;
  }

  private request(frame: number): void {
    const section = this.clip.sections.findIndex((s) => frame >= s.g0 && frame < s.g0 + s.nframes);
    const sh = section !== this.requestedSection;
    this.requestedSection = section;
    this.requesting = true;
    this.clip.evaluate(frame, this.spare.pop(), sh).then(
      (evaluated) => {
        this.requesting = false;
        if (!this.released) this.ready = evaluated;
      },
      (error: unknown) => {
        this.requesting = false;
        if (!this.released) console.error('CSGS frame evaluation failed', error);
      },
    );
  }

  private discard(frame: CsgsClipFrame): void {
    this.spare.push(frame.buffers);
    this.ready = null;
  }

  private swap(frame: CsgsClipFrame): void {
    const started = performance.now();
    if (frame.section !== this.slotSection) {
      // Another section: other splats in the slots, with their own SH.
      this.overwriteRangeData(this.range, frame.data, 0);
      this.setRangeActivePrefix(this.range, frame.data.count);
      this.slotSection = frame.section;
    } else {
      // Same splats, moved: the static SH stays as uploaded.
      this.overwriteRangeCore(this.range, frame.data, 0);
    }
    this.invalidateSort();
    this.swapMs = performance.now() - started;
    this.evalMs = frame.evalMs;
    this.alive = frame.alive;
    this.shownFrame = frame.frame;
    // The pool holds its own copy, so the buffers are free again.
    this.discard(frame);
  }

  override dispose(): void {
    this.released = true;
    super.dispose();
  }
}
