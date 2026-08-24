import type { SplatData } from './splat-data';
import type {
  LoadWorkerRequest,
  LoadWorkerResponse,
  LoadWorkerSource,
  RadChunkRangeRequest,
} from './load-worker-protocol';
import type { LccChunkParams } from './formats/lcc/parse-lcc';
import {
  createAbortError,
  deserializeSplatLoadError,
  resolveSplatUrl,
  SplatLoadError,
  splatFormatForExtension,
  splatNameExtension,
  splatUrlExtension,
  type ChunkFileFormat,
  type SplatFileLoadOptions,
  type SplatFormat,
  type SplatInputOptions,
  type SplatSourceFormat,
  type SplatProgressCallback,
} from './loading';
// Inlined worker (blob URL): survives library bundling in any consumer
// setup, unlike an asset file referenced via `new URL(...)`.
import LoadWorker from './load-worker?worker&inline';

/**
 * Formats served by the one-shot worker rather than the streaming one.
 *
 * Both workers are inlined, so their parsers are string literals no bundler can
 * tree-shake. Keeping these three behind a dynamic import is what moves SPZ's
 * ~39 KB ZSTD wasm blob out of the main entry and into a chunk that loads only
 * when one of these formats is actually opened.
 */
const ONE_SHOT_FORMATS = new Set<ChunkFileFormat>(['spz', 'splat', 'ksplat']);

/**
 * One worker plus the requests in flight on it.
 *
 * `ChunkLoader` runs two of these - see {@link ChunkLoader} - so the request
 * bookkeeping, cancellation and terminal-failure handling live here once.
 */
class WorkerClient {
  private nextRequestId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (data: SplatData) => void;
      reject: (error: Error) => void;
      removeAbortListener?: () => void;
      onProgress?: SplatProgressCallback;
    }
  >();
  private disposed = false;
  /** Terminal worker failure; subsequent loads reject instead of hanging. */
  private workerFailure: SplatLoadError | null = null;

  constructor(private readonly worker: Worker) {
    this.worker.onmessage = (event: MessageEvent<LoadWorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      if (event.data.type === 'progress') {
        // Progress does not settle the request; the result still follows.
        request.onProgress?.(event.data.loaded, event.data.total);
        return;
      }
      this.pending.delete(event.data.id);
      request.removeAbortListener?.();
      if (event.data.ok) {
        request.resolve(event.data.data);
      } else if (event.data.cancelled) {
        request.reject(createAbortError('Chunk load was cancelled.'));
      } else {
        request.reject(deserializeSplatLoadError(event.data.error));
      }
    };
    // A worker-level failure (a CSP that blocks blob: workers is the common
    // one in real deployments) must still honour the documented contract:
    // every rejection is a SplatLoadError or an AbortError, never a bare Error.
    // There is no per-request URL here - the worker itself died - so `url` is
    // empty and the failure is not retryable: retrying constructs the same
    // worker under the same policy.
    this.worker.onerror = (event?: ErrorEvent | Event) => {
      if (this.workerFailure) return;
      const detail =
        event &&
        typeof event === 'object' &&
        'message' in event &&
        typeof event.message === 'string'
          ? event.message
          : '';
      const failure = new SplatLoadError(
        detail ? `Chunk loading worker failed. ${detail}` : 'Chunk loading worker failed.',
        { phase: 'worker', url: '', retryable: false },
      );
      this.workerFailure = failure;
      this.worker.terminate();
      this.rejectAll(failure);
    };
  }

  /** Posts one load to this worker and tracks its pending promise. */
  request(
    message: Omit<Extract<LoadWorkerRequest, { type: 'load' }>, 'id'>,
    signal: AbortSignal | undefined,
    onProgress?: SplatProgressCallback,
  ): Promise<SplatData> {
    if (this.disposed) return Promise.reject(createAbortError('ChunkLoader has been disposed.'));
    if (signal?.aborted) return Promise.reject(createAbortError('Chunk load was cancelled.'));
    if (this.workerFailure) return Promise.reject(this.workerFailure);

    const id = this.nextRequestId++;
    const promise = new Promise<SplatData>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...(onProgress ? { onProgress } : {}) });
    });
    if (signal) {
      // Settle immediately on abort rather than waiting for the worker's
      // acknowledgement: the worker may be deep in a decode (or may already
      // have posted a success that is still in the message queue), and a
      // caller that cancelled must neither receive that stale result nor see
      // further progress callbacks. The late reply finds no pending entry and
      // is dropped in `onmessage`.
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const cancel: LoadWorkerRequest = { type: 'cancel', id };
        if (!this.disposed) this.worker.postMessage(cancel);
        pending.reject(createAbortError('Chunk load was cancelled.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const pending = this.pending.get(id);
      if (pending) pending.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }

    const request: LoadWorkerRequest = { ...message, id };
    this.worker.postMessage(request);
    return promise;
  }

  /** Terminates this worker and rejects its in-flight requests. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.rejectAll(createAbortError('ChunkLoader has been disposed.'));
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      request.removeAbortListener?.();
      request.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Client for the persistent scene/chunk loading workers. Multiple requests
 * may be in flight; each can be cancelled through an `AbortSignal`, which
 * aborts the worker-side fetches (useful when the camera has moved on
 * before a chunk arrived).
 *
 * There are two workers behind this one class. The streaming worker is
 * constructed eagerly and handles everything the LOD paths need; the one-shot
 * worker ({@link ONE_SHOT_FORMATS}) is constructed the first time a `.spz`,
 * `.splat` or `.ksplat` is requested. Both decode off the main thread - the
 * split exists only to keep the one-shot parsers out of the published entry.
 *
 * @example
 * const loader = new ChunkLoader();
 * const chunk = await loader.load('/scene/0_0/', { kind: 'directory' });
 */
export class ChunkLoader {
  private readonly streaming = new WorkerClient(new LoadWorker());
  /** The in-flight construction; `null` until a one-shot format is requested. */
  private oneShot: Promise<WorkerClient> | null = null;
  /** The constructed one-shot client, so `dispose` does not have to await. */
  private oneShotClient: WorkerClient | null = null;
  private disposed = false;

  /**
   * Fetches and decodes one scene file or chunk directory.
   *
   * @param url - Scene URL, absolute or relative to the page.
   * @param options.kind - 'file' (default) selects a parser by extension;
   * 'directory' decodes an unbundled SOG chunk directory.
   * @param options.format - Explicit parser; `lcc-bin` additionally needs
   * `options.lcc` to say which byte range of the file to fetch.
   * @param options.signal - Abort signal for cancellation; the returned
   * promise then rejects with a `DOMException` named `AbortError`.
   * @param options.lcc - Byte-range plumbing for `lcc-bin`. This path exists
   * for {@link StreamedSplatMesh} and is **not** part of the stable surface;
   * the type is nameable as `LccChunkParams` on `@voluma/vlam/formats/lcc`.
   * @param options.rad - Byte-range plumbing for `rad-chunk`, on the same
   * footing; the type is `RadChunkRangeRequest` on `@voluma/vlam/formats/rad`.
   * @throws Rejects only with {@link SplatLoadError} (resolve, fetch, decode or
   * worker failures - `error.phase` says which; a worker that cannot start at
   * all, e.g. under a CSP that blocks `blob:` workers, reports
   * `phase: 'worker'`) or an `Error` named `AbortError` (cancellation or
   * {@link dispose}).
   */
  // `async` so a URL or format that will not resolve rejects the returned
  // promise rather than throwing synchronously into the caller.
  async load(
    url: string,
    options: SplatInputOptions & {
      kind?: 'file' | 'directory';
      format?: SplatFormat | 'lcc-bin' | 'rad-chunk';
      lcc?: LccChunkParams;
      rad?: RadChunkRangeRequest;
      sog?: { packShBands: 1 | 2 | 3 };
      files?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<SplatData> {
    const kind = options.kind ?? 'file';
    // The worker runs from an inlined blob/data URL, where relative and
    // root-relative URLs cannot be resolved - make the URL absolute here.
    const absoluteUrl = resolveSplatUrl(url, options.baseUrl).href;
    const format = resolveFileFormat(absoluteUrl, kind, options.format ?? 'auto');
    const data = await this.request(
      {
        from: 'url',
        url: absoluteUrl,
        kind,
        ...(options.request ? { request: options.request } : {}),
      },
      format,
      options.signal,
      options.lcc,
      options.rad,
      options.files,
      options.sog,
      options.onProgress,
    );
    return withSourceFormat(data, format);
  }

  /**
   * Decodes a local file (from a file input or a drop) in the worker - the
   * bytes are read worker-side, so a multi-million-splat decode still never
   * blocks the main thread.
   *
   * Only self-contained files are supported: `.ply`, `.spz`, `.splat`,
   * `.ksplat` and bundled `.sog`. An unbundled SOG directory needs sibling
   * fetches and so requires {@link load} with `kind: 'directory'`.
   *
   * @param file - The file; its name selects the parser unless `format` is given.
   * @throws Rejects only with {@link SplatLoadError} (unknown extension, read
   * or decode failures) or an `Error` named `AbortError` (cancellation or
   * {@link dispose}).
   */
  // `async` so an unknown extension rejects the returned promise rather than
  // throwing synchronously into the caller.
  async loadFile(file: File, options: SplatFileLoadOptions = {}): Promise<SplatData> {
    const requested = options.format ?? 'auto';
    const format: Exclude<SplatFormat, 'auto'> =
      requested === 'auto'
        ? splatFormatForExtension(splatNameExtension(file.name), file.name)
        : requested;
    const data = await this.request(
      { from: 'file', file },
      format,
      options.signal,
      undefined,
      undefined,
      undefined,
      undefined,
      options.onProgress,
    );
    return withSourceFormat(data, format);
  }

  /** Routes one load to the worker that owns its format. */
  private request(
    source: LoadWorkerSource,
    format: ChunkFileFormat,
    signal: AbortSignal | undefined,
    lcc?: LccChunkParams,
    rad?: RadChunkRangeRequest,
    files?: Readonly<Record<string, string>>,
    sog?: { packShBands: 1 | 2 | 3 },
    onProgress?: SplatProgressCallback,
  ): Promise<SplatData> {
    if (this.disposed) return Promise.reject(createAbortError('ChunkLoader has been disposed.'));
    if (signal?.aborted) return Promise.reject(createAbortError('Chunk load was cancelled.'));

    const message: Omit<Extract<LoadWorkerRequest, { type: 'load' }>, 'id'> = {
      type: 'load',
      source,
      format,
      ...(lcc ? { lcc } : {}),
      ...(rad ? { rad } : {}),
      ...(sog ? { sog } : {}),
      ...(files ? { files } : {}),
      ...(onProgress ? { progress: true } : {}),
    };

    const client = this.clientFor(format);
    // Deliberately not `async`: for a streaming format the client is already
    // there, and the request must reach the worker in the same task the caller
    // made it - a chunk scheduler that posts and then aborts within one frame
    // depends on that ordering. Only the one-shot path, which cannot avoid
    // awaiting its chunk, defers.
    if (!(client instanceof Promise)) return client.request(message, signal, onProgress);
    return client.then((resolved) => {
      // Re-checked because disposal or abort may have happened while the
      // one-shot chunk was in flight, before any listener was registered.
      if (this.disposed) throw createAbortError('ChunkLoader has been disposed.');
      return resolved.request(message, signal, onProgress);
    });
  }

  /**
   * The worker for `format`, constructing the one-shot worker on first need.
   *
   * The in-flight promise is cached, not just the resolved client, so two
   * concurrent `.spz` loads share one worker instead of racing to build two.
   */
  private clientFor(format: ChunkFileFormat): WorkerClient | Promise<WorkerClient> {
    if (!ONE_SHOT_FORMATS.has(format)) return this.streaming;
    if (this.oneShotClient) return this.oneShotClient;
    this.oneShot ??= import('./one-shot-worker?worker&inline').then(
      ({ default: OneShotWorker }) => {
        const client = new WorkerClient(new OneShotWorker());
        this.oneShotClient = client;
        // `dispose()` may have run while the chunk was in flight; it could not
        // terminate a worker that did not exist yet, so honour it here.
        if (this.disposed) client.dispose();
        return client;
      },
    );
    return this.oneShot;
  }

  /** Terminates both workers and rejects all in-flight requests. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.streaming.dispose();
    // A one-shot worker still being imported is terminated in `clientFor`,
    // which sees `disposed` when it finally constructs it.
    this.oneShotClient?.dispose();
  }
}

/** Self-contained scene formats {@link SplatData.sourceFormat} can hold. */
const SOURCE_FORMATS: readonly SplatSourceFormat[] = [
  'ply',
  'spz',
  'splat',
  'ksplat',
  'sog',
  'rad',
];

/**
 * Stamps the resolved format onto decoded scene data so {@link SplatMesh} can
 * pick its `orientation: 'y-up'` correction. Chunk-only formats (`lcc-bin`,
 * `rad-chunk`) carry no self-contained frame, so they are left unstamped.
 */
function withSourceFormat(data: SplatData, format: ChunkFileFormat): SplatData {
  return (SOURCE_FORMATS as readonly string[]).includes(format)
    ? { ...data, sourceFormat: format as SplatSourceFormat }
    : data;
}

function resolveFileFormat(
  url: string,
  kind: 'file' | 'directory',
  format: SplatFormat | 'lcc-bin' | 'rad-chunk',
): ChunkFileFormat {
  // An LCC or RAD chunk is a byte range of a shared file, so its extension says
  // nothing about the parser - the caller's choice is authoritative.
  if (format === 'lcc-bin' || format === 'rad-chunk') return format;
  if (kind === 'directory') return 'sog';
  if (format !== 'auto') return format;
  return splatFormatForExtension(splatUrlExtension(new URL(url)), url);
}
