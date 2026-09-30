/**
 * The message loop both loading workers run.
 *
 * `load-worker.ts` (streaming formats) and `one-shot-worker.ts` (whole-file
 * `.spz` / `.splat` / `.ksplat`) speak the same protocol and differ only in
 * which parsers they embed - which is the whole point of the split, since the
 * streaming worker is inlined into `@voluma/vlam/loaders` and the one-shot one is not.
 * Request tracking, cancellation and the transfer list live here so the two
 * cannot drift apart; in particular the transfer list must stay in step with
 * `SplatData`'s shape, and one copy of that is enough.
 */
import type { SplatData } from '../core/splat-data';
import type { RemotePlyResult } from '../formats/ply/parse-splat-ply-remote';
import type { LoadWorkerRequest, LoadWorkerResponse } from './load-worker-protocol';
import {
  createProgressThrottle,
  isAbortError,
  serializeSplatLoadError,
  toSplatLoadError,
  type SplatProgressCallback,
  type SplatLoadStatus,
} from './loading';

/** Decodes one request. Rejections are serialized back to the client. */
export type LoadHandler = (
  message: Extract<LoadWorkerRequest, { type: 'load' }>,
  signal: AbortSignal,
  onProgress: SplatProgressCallback | undefined,
  onStatus: ((status: SplatLoadStatus) => void) | undefined,
) => Promise<SplatData | RemotePlyResult>;

/**
 * Installs `self.onmessage`. Multiple requests may be in flight (fetches
 * overlap; decodes serialize within the worker); each carries an id and can be
 * cancelled, which aborts its in-flight fetches. Decoded arrays are transferred
 * back, not copied.
 */
export function serveLoadRequests(load: LoadHandler): void {
  const controllers = new Map<number, AbortController>();

  self.onmessage = async (event: MessageEvent<LoadWorkerRequest>) => {
    const worker = self as unknown as Worker;
    const message = event.data;

    if (message.type === 'cancel') {
      controllers.get(message.id)?.abort();
      return;
    }

    const controller = new AbortController();
    controllers.set(message.id, controller);
    // Names the input in any failure: the URL for a fetch, the file name for a
    // local file (which has no URL to report).
    const label = message.source.from === 'url' ? message.source.url : message.source.file.name;
    let latestProgress: readonly [number, number] | undefined;
    let sentProgress: readonly [number, number] | undefined;
    const reportProgress = (loaded: number, total: number): void => {
      if (controller.signal.aborted || !controllers.has(message.id)) return;
      sentProgress = [loaded, total];
      const update: LoadWorkerResponse = { type: 'progress', id: message.id, loaded, total };
      worker.postMessage(update);
    };
    const throttledProgress = createProgressThrottle(reportProgress);
    const onProgress = message.progress
      ? (loaded: number, total: number) => {
          latestProgress = [loaded, total];
          throttledProgress(loaded, total);
        }
      : undefined;
    const flushProgress = (): void => {
      if (
        latestProgress &&
        (latestProgress[0] !== sentProgress?.[0] || latestProgress[1] !== sentProgress?.[1])
      ) {
        reportProgress(...latestProgress);
      }
    };
    const onStatus = (status: SplatLoadStatus): void => {
      if (status === 'decoding') flushProgress();
      if (!message.status) return;
      if (controller.signal.aborted || !controllers.has(message.id)) return;
      const update: LoadWorkerResponse = { type: 'status', id: message.id, status };
      worker.postMessage(update);
    };
    try {
      const output = await load(message, controller.signal, onProgress, onStatus);
      controller.signal.throwIfAborted();
      flushProgress();
      const data = 'data' in output ? output.data : output;
      const metrics = 'data' in output ? output.metrics : undefined;
      const transfers = [data.positions.buffer, data.colors.buffer, data.covariances.buffer];
      if (data.sh) transfers.push(data.sh.labels.buffer, data.sh.palette.buffer);
      if (data.shPacked) transfers.push(data.shPacked.packed.buffer);
      if (data.radTree)
        transfers.push(
          data.radTree.childCount.buffer,
          data.radTree.childStart.buffer,
          data.radTree.size.buffer,
        );
      const reply: LoadWorkerResponse = {
        type: 'result',
        id: message.id,
        ok: true,
        data,
        ...(metrics ? { metrics } : {}),
      };
      worker.postMessage(reply, transfers as Transferable[]);
    } catch (error) {
      const reply: LoadWorkerResponse = {
        type: 'result',
        id: message.id,
        ok: false,
        error: serializeSplatLoadError(toSplatLoadError(error, { phase: 'worker', url: label })),
        cancelled: controller.signal.aborted || isAbortError(error),
      };
      worker.postMessage(reply);
    } finally {
      controllers.delete(message.id);
    }
  };
}
