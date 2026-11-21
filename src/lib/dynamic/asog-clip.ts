/**
 * `.asog` (Animated SOG) clip loading: fetches the file and decodes it in a
 * per-clip worker (`asog-decode-worker.ts`) that keeps it and evaluates
 * frames on request, so neither the inflate nor the motion evaluation runs
 * on the page's main thread.
 */
import * as THREE from 'three/webgpu';
import type { SplatPackedShData } from '../core/splat-data';
import AsogWorker from './asog-decode-worker?worker&inline';
import { asogClipDriver } from './asog-gpu-playback';
import type {
  AsogClipInfo,
  AsogGpuData,
  AsogWorkerReply,
  AsogWorkerRequest,
} from './asog-worker-protocol';
import type { SplatClip, SplatClipLoadOptions } from './splat-clip';
import type { SplatClipFrame, SplatFrameBuffers } from './splat-clip-playback';

/**
 * A decoded `.asog` clip: a {@link SplatClip} plus what only this format has.
 *
 * The clip is in the file's own frame: TRiGS/COLMAP orientation, **y down**.
 * A `SplatClipMesh` does not reorient it; turn the mesh 180° about X
 * (`mesh.rotation.x = Math.PI`, as VLAM orients SOG and PLY captures) to
 * stand it up.
 *
 * @experimental
 */
export interface AsogClip extends SplatClip {
  readonly format: 'asog';
  /** Clips sharing the file's timeline (each splat belongs to one). */
  readonly clipCount: number;
  /**
   * The file's soundtrack (`manifest.audio`), or null. VLAM does not play
   * it: an app that wants sound decodes `bytes` (e.g. through
   * `AudioContext.decodeAudioData`) and keeps it at `mesh.time`.
   */
  readonly audio: { readonly mime: string; readonly bytes: Uint8Array } | null;
  /** `manifest.source.format` (what the clip was encoded from), when given. */
  readonly sourceFormat: string | null;
  /**
   * Worker decode time, in ms.
   *
   * @internal
   */
  readonly decodeMs: number;
}

/**
 * Options of {@link loadAsogClip}: progress counts bytes fetched, then the
 * decode.
 *
 * @experimental
 */
export interface LoadAsogClipOptions extends SplatClipLoadOptions {
  /**
   * The file's bytes, already fetched (a dropped file). They are transferred
   * to the clip's worker, which detaches the buffer: pass a copy
   * (`bytes.slice(0)`) of one you keep.
   */
  bytes?: ArrayBuffer;
}

/**
 * Workers the frame path evaluates with. Each holds its own decoded copy of
 * the clip (about 75 MB for 400k splats with SH); the second starts only when
 * the frame path asks for its first frame, so the GPU path never pays for it.
 */
const FRAME_WORKERS = 2;

type DecodedReply = Extract<AsogWorkerReply, { type: 'decoded' }>;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The .asog load was aborted.', 'AbortError');
}

/** Fetches `url` whole, reporting bytes as they arrive. */
async function fetchBytes(url: URL, options: SplatClipLoadOptions): Promise<ArrayBuffer> {
  const { onProgress, signal } = options;
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`${url.href}: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
  if (!response.body || !onProgress) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress({
      stage: 'fetch',
      loaded,
      total: Math.max(total, loaded),
      message: total ? `Fetching ${mb(loaded)} / ${mb(total)} MB…` : `Fetching ${mb(loaded)} MB…`,
    });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}

/** Clip name: the file name without `.asog`. */
function clipName(url: URL): string {
  const raw = url.pathname.split('/').pop() ?? '';
  let file = raw;
  try {
    file = decodeURIComponent(raw);
  } catch {
    // A stray `%` (a file name passed as a URL): keep the name as written.
  }
  return file.replace(/\.asog$/i, '') || 'clip';
}

/**
 * The `.asog` loader behind the public {@link loadAsogClip} (`load-asog-clip.ts`),
 * which imports this module on first use.
 *
 * @internal
 */
export async function loadAsogClip(
  url: URL | string,
  options: LoadAsogClipOptions = {},
): Promise<AsogClip> {
  const { onProgress, signal } = options;
  signal?.throwIfAborted();
  const resolved = new URL(url, globalThis.location?.href);
  const bytes = options.bytes ?? (await fetchBytes(resolved, options));
  signal?.throwIfAborted();
  onProgress?.({
    stage: 'decode',
    loaded: 0,
    total: 1,
    message: `Decoding ${(bytes.byteLength / 1e6).toFixed(1)} MB in a worker…`,
  });

  /** One clip worker: it decodes the file, then evaluates on request. */
  interface ClipWorker {
    readonly worker: Worker;
    decoded: boolean;
    /** Requests sent and not answered yet. */
    busy: number;
  }
  const workers: ClipWorker[] = [];
  const pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (error: Error) => void; owner: ClipWorker }
  >();
  let failure: Error | null = null;
  let failDecode: ((error: Error) => void) | null = null;
  let disposed = false;
  let nextId = 1;
  let shRange: SplatPackedShData['range'] | null = null;
  let info!: AsogClipInfo;
  let audio: AsogClip['audio'] = null;
  // A copy for the frame path's second worker, started on its first frame
  // request; the GPU path never needs it and drops it.
  let secondCopy: ArrayBuffer | null = FRAME_WORKERS > 1 ? bytes.slice(0) : null;
  const fail = (error: Error): void => {
    failure = error;
    secondCopy = null;
    for (const { worker } of workers) worker.terminate();
    failDecode?.(error);
    failDecode = null;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const settle = (id: number) => {
    const request = pending.get(id);
    pending.delete(id);
    if (request) request.owner.busy--;
    return request;
  };
  /** Starts a worker decoding `file`; `onDecoded` runs when it is ready. */
  const startWorker = (file: ArrayBuffer, onDecoded: (reply: DecodedReply) => void): ClipWorker => {
    const entry: ClipWorker = { worker: new AsogWorker(), decoded: false, busy: 0 };
    entry.worker.onmessage = (event: MessageEvent<AsogWorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'decoded') {
        entry.decoded = true;
        onDecoded(reply);
      } else if (reply.type === 'frame') {
        settle(reply.id)?.resolve(frameFromReply(reply, info.shBands, shRange!) as never);
      } else if (reply.type === 'gpu') {
        settle(reply.id)?.resolve(reply.data as never);
      } else if (reply.id !== undefined) {
        settle(reply.id)?.reject(new Error(reply.error));
      } else {
        fail(new Error(`${resolved.href}: ${reply.error}`));
      }
    };
    entry.worker.onerror = (event) =>
      fail(new Error(event.message || 'ASOG: the clip worker failed.'));
    workers.push(entry);
    const request: AsogWorkerRequest = { type: 'decode', bytes: file };
    entry.worker.postMessage(request, [file]);
    return entry;
  };
  /** Sends `message` to `owner`, or for a frame to the least busy decoded worker. */
  const ask = <T>(
    message: Exclude<AsogWorkerRequest, { type: 'decode' }>,
    transfer: Transferable[] = [],
    owner: ClipWorker = workers[0]!,
  ): Promise<T> => {
    if (failure !== null) return Promise.reject(failure);
    return new Promise<T>((resolve, reject) => {
      pending.set(message.id, { resolve, reject, owner });
      owner.busy++;
      owner.worker.postMessage(message, transfer);
    });
  };
  const leastBusy = (): ClipWorker =>
    workers
      .filter((entry) => entry.decoded)
      .reduce((best, entry) => (entry.busy < best.busy ? entry : best));
  const onAbort = (): void => fail(abortReason(signal!));
  signal?.addEventListener('abort', onAbort, { once: true });

  const decoded = new Promise<void>((resolve, reject) => {
    failDecode = reject;
    startWorker(bytes, (reply) => {
      info = reply.info;
      shRange = reply.shRange;
      audio = reply.audio;
      failDecode = null;
      resolve();
    });
  });
  try {
    await decoded;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  try {
    onProgress?.({
      stage: 'decode',
      loaded: 1,
      total: 1,
      message: `Decoded ${info.count} splats in ${info.decodeMs.toFixed(0)} ms`,
    });
  } catch (error) {
    // No clip reaches the caller to dispose: release the workers here.
    fail(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  const { fps, count } = info;
  const totalFrames = Math.max(1, Math.round(info.durationSeconds * fps));
  const source = {
    count,
    fps,
    clips: info.clips,
    parallel: FRAME_WORKERS,
    evaluate(frame: number, recycle?: SplatFrameBuffers, sh = true) {
      if (secondCopy && failure === null) {
        // The frame path is playing: decode a second copy to evaluate alongside.
        startWorker(secondCopy, () => undefined);
        secondCopy = null;
      }
      return ask<SplatClipFrame>(
        { type: 'frame', id: nextId++, frame, sh, ...(recycle ? { buffers: recycle } : {}) },
        recycle
          ? [
              recycle.positions.buffer,
              recycle.colors.buffer,
              recycle.covariances.buffer,
              recycle.shPacked.buffer,
            ]
          : [],
        leastBusy(),
      );
    },
    gpuData() {
      secondCopy = null;
      return ask<AsogGpuData>({ type: 'gpu', id: nextId++ });
    },
  };
  const bounds = new THREE.Box3(
    new THREE.Vector3().fromArray(info.bounds.min),
    new THREE.Vector3().fromArray(info.bounds.max),
  );
  return {
    format: 'asog',
    name: clipName(resolved),
    fps,
    totalFrames,
    duration: totalFrames / fps,
    maxCount: count,
    bounds,
    shBands: info.shBands,
    clipCount: info.clipCount,
    audio,
    sourceFormat: info.sourceFormat,
    decodeMs: info.decodeMs,
    driver: asogClipDriver({ maxCount: count }, source),
    async frame(index) {
      if (!Number.isInteger(index) || index < 0 || index >= totalFrames) {
        throw new RangeError(`ASOG: frame ${index} is outside 0..${totalFrames - 1}.`);
      }
      const evaluated = await ask<SplatClipFrame>({
        type: 'frame',
        id: nextId++,
        frame: index,
        sh: true,
        compact: true,
      });
      return evaluated.data;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      fail(new Error('ASOG: the clip was disposed.'));
    },
  };
}

/** Views a frame reply's buffers as `SplatData`. */
function frameFromReply(
  reply: Extract<AsogWorkerReply, { type: 'frame' }>,
  shBands: 0 | 1 | 2 | 3,
  range: SplatPackedShData['range'],
): SplatClipFrame {
  const { count, buffers } = reply;
  const shWords = buffers.shPacked.length / Math.max(buffers.positions.length / 3, 1);
  return {
    frame: reply.frame,
    section: 0,
    alive: reply.alive,
    buffers,
    evalMs: reply.evalMs,
    data: {
      count,
      positions: buffers.positions.subarray(0, count * 3),
      colors: buffers.colors.subarray(0, count * 4),
      covariances: buffers.covariances.subarray(0, count * 6),
      ...(reply.sh && shBands > 0
        ? {
            shPacked: {
              bands: shBands as 1 | 2 | 3,
              packed: buffers.shPacked.subarray(0, count * shWords),
              range,
            },
          }
        : {}),
    },
  };
}
