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
import type { SplatClip, SplatClipLoadOptions, SplatClipLoadProgress } from './splat-clip';
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
 * Options of {@link loadAsogClip}: progress counts bytes fetched and, as
 * they arrive, the file's streams decoded.
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

/**
 * Fetches `url` and posts its body to `target`'s worker chunk by chunk
 * (`chunk`, then `end`), reporting bytes as they arrive. `onChunks` gets
 * every chunk once the body is complete. Stops early once `isFailed`.
 */
async function streamToWorker(
  url: URL,
  signal: AbortSignal | undefined,
  target: { readonly worker: Worker },
  hooks: {
    isFailed(): boolean;
    onChunks(chunks: readonly Uint8Array[], length: number): void;
    report(event: SplatClipLoadProgress): void;
  },
): Promise<void> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`${url.href}: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const mb = (bytes: number): string => (bytes / 1e6).toFixed(1);
  const post = (chunk: Uint8Array): void => {
    // A copy goes to the worker: the chunk itself stays for the second copy.
    const bytes = chunk.slice().buffer;
    const request: AsogWorkerRequest = { type: 'chunk', bytes };
    target.worker.postMessage(request, [bytes]);
  };
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (hooks.isFailed()) return;
        chunks.push(value);
        loaded += value.length;
        post(value);
        hooks.report({
          stage: 'fetch',
          loaded,
          total: Math.max(total, loaded),
          message: total
            ? `Fetching ${mb(loaded)} / ${mb(total)} MB…`
            : `Fetching ${mb(loaded)} MB…`,
        });
      }
    } finally {
      if (hooks.isFailed()) await reader.cancel().catch(() => undefined);
    }
  } else {
    const whole = new Uint8Array(await response.arrayBuffer());
    chunks.push(whole);
    loaded = whole.length;
    post(whole);
  }
  if (hooks.isFailed()) return;
  hooks.onChunks(chunks, loaded);
  const end: AsogWorkerRequest = { type: 'end' };
  target.worker.postMessage(end);
}

/** `chunks` joined into one buffer of `length` bytes. */
function joinChunks(chunks: readonly Uint8Array[], length: number): ArrayBuffer {
  const bytes = new Uint8Array(length);
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
  const mb = (bytes: number): string => (bytes / 1e6).toFixed(1);

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
  // request; the GPU path never needs it and drops it. A download keeps its
  // chunks until it ends, then joins them.
  let secondCopy: ArrayBuffer | null =
    FRAME_WORKERS > 1 && options.bytes ? options.bytes.slice(0) : null;
  const fail = (error: Error): void => {
    if (failure !== null) return;
    failure = error;
    secondCopy = null;
    for (const { worker } of workers) worker.terminate();
    failDecode?.(error);
    failDecode = null;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  /** Calls the app's progress handler; one that throws fails the load. */
  const report = (event: Parameters<NonNullable<typeof onProgress>>[0]): void => {
    try {
      onProgress?.(event);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const settle = (id: number) => {
    const request = pending.get(id);
    pending.delete(id);
    if (request) request.owner.busy--;
    return request;
  };
  /**
   * Starts a worker decoding `file`, or, without one, the chunks posted to it
   * next; `onDecoded` runs when it is ready.
   */
  const startWorker = (
    file: ArrayBuffer | null,
    onDecoded: (reply: DecodedReply) => void,
  ): ClipWorker => {
    const entry: ClipWorker = { worker: new AsogWorker(), decoded: false, busy: 0 };
    entry.worker.onmessage = (event: MessageEvent<AsogWorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'decoded') {
        entry.decoded = true;
        onDecoded(reply);
      } else if (reply.type === 'progress') {
        if (entry === workers[0])
          report({
            stage: 'decode',
            loaded: reply.done,
            total: reply.total,
            message: `Decoded ${reply.stream} (${reply.done} of ${reply.total} streams)…`,
          });
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
    if (file) {
      const request: AsogWorkerRequest = { type: 'decode', bytes: file };
      entry.worker.postMessage(request, [file]);
    }
    return entry;
  };
  /** Sends `message` to `owner`, or for a frame to the least busy decoded worker. */
  const ask = <T>(
    message: Extract<AsogWorkerRequest, { id: number }>,
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

  let resolveDecoded!: () => void;
  const decoded = new Promise<void>((resolve, reject) => {
    resolveDecoded = resolve;
    failDecode = reject;
  });
  decoded.catch(() => undefined); // awaited below; a failure mid-download is handled there
  const onDecoded = (reply: DecodedReply): void => {
    info = reply.info;
    shRange = reply.shRange;
    audio = reply.audio;
    failDecode = null;
    resolveDecoded();
  };
  try {
    if (options.bytes) {
      report({
        stage: 'decode',
        loaded: 0,
        total: 1,
        message: `Decoding ${mb(options.bytes.byteLength)} MB in a worker…`,
      });
      if (failure === null) startWorker(options.bytes, onDecoded);
    } else {
      // The download goes to the worker chunk by chunk, which decodes each
      // stream as soon as its bytes have arrived.
      await streamToWorker(resolved, signal, startWorker(null, onDecoded), {
        isFailed: () => failure !== null,
        onChunks: (chunks, length) => {
          if (FRAME_WORKERS > 1) secondCopy = joinChunks(chunks, length);
        },
        report,
      });
    }
    await decoded;
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    throw failure ?? error;
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
