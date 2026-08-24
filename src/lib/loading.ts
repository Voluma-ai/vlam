/**
 * The self-contained scene formats - files (or bundles) that decode to a whole
 * scene on their own, with no external manifest. This is the value set of
 * {@link SplatData.sourceFormat} and the non-`auto` half of {@link SplatFormat}.
 */
export type SplatSourceFormat = 'ply' | 'sog' | 'spz' | 'splat' | 'ksplat' | 'rad';

/** Explicit formats accepted by {@link loadScene}. */
export type SplatFormat = 'auto' | SplatSourceFormat;

/** Explicit formats accepted by {@link StreamedSplatMesh.load}. */
export type StreamedSplatFormat = 'auto' | 'streamed-sog' | 'lcc2' | 'lcc' | 'rad';

/**
 * Parsers the loading worker can run on a chunk. This extends {@link SplatFormat}
 * with formats that are only ever reached as a streamed chunk, never as a
 * standalone scene handed to {@link loadScene}: `lcc-bin` is a byte range of an
 * LCC (`.lcc`) `data.bin`, and `rad-chunk` a byte range of a single-file `.rad` -
 * both meaningless without their manifest/header.
 */
export type ChunkFileFormat = Exclude<SplatFormat, 'auto'> | 'lcc-bin' | 'rad-chunk';

/** Serializable fetch settings that can cross the loading-worker boundary. */
export interface SplatRequestOptions {
  headers?: Readonly<Record<string, string>>;
  credentials?: RequestCredentials;
  mode?: RequestMode;
  cache?: RequestCache;
}

/**
 * Reports load progress in bytes, for a determinate progress indicator.
 *
 * `total` is 0 when the size is not known ahead of time (a response with no
 * `Content-Length`), which means "still working" rather than "finished".
 */
export type SplatProgressCallback = (loaded: number, total: number) => void;

/** Shortest gap between two progress reports, in milliseconds (~10/s). */
const PROGRESS_INTERVAL_MS = 100;

/**
 * Rate-limits progress reports to ~10/s.
 *
 * A body arrives in ~64 KB chunks, so an unthrottled report would post
 * thousands of messages no indicator can render. The final report is exempt -
 * it is what leaves a determinate bar exactly full rather than at 97%.
 *
 * Identifying that final report needs a known size, so the exemption requires
 * `total > 0`. When the size is unknown there is no bar to fill (the caller
 * shows a spinner) and every report is throttled alike - without the `total`
 * check, `loaded < total` would be false for all of them and the throttle
 * would never engage at all.
 */
export function createProgressThrottle(
  report: SplatProgressCallback,
  intervalMs: number = PROGRESS_INTERVAL_MS,
): SplatProgressCallback {
  let lastReportAt = -Infinity;
  return (loaded: number, total: number): void => {
    const isFinal = total > 0 && loaded >= total;
    const now = monotonicNow();
    if (!isFinal && now - lastReportAt < intervalMs) return;
    lastReportAt = now;
    report(loaded, total);
  };
}

/**
 * Options for decoding a local file.
 *
 * Shared by {@link loadSceneFile} and `ChunkLoader.loadFile`. There is no
 * `baseUrl`/`request` counterpart to {@link SplatInputOptions} here: a file has
 * no URL to resolve and no request to configure.
 */
export interface SplatFileLoadOptions {
  signal?: AbortSignal;
  /** Parser selection; the file name's extension is used only for `auto`. */
  format?: SplatFormat;
  /**
   * Called as the file is read, for a determinate progress bar. A multi-
   * gigabyte PLY takes tens of seconds, so the streamed PLY path reports as it
   * goes; the whole-buffer formats have nothing to report until they are done.
   */
  onProgress?: SplatProgressCallback;
}

/** Shared URL, cancellation, and request options for package loaders. */
export interface SplatInputOptions {
  signal?: AbortSignal;
  baseUrl?: string | URL;
  request?: SplatRequestOptions;
  /**
   * Called as bytes are read. Fires from the loading worker, so it is
   * throttled to whole read windows rather than every byte.
   */
  onProgress?: SplatProgressCallback;
}

/** The stage at which a splat load failed. */
export type SplatLoadPhase = 'resolve' | 'manifest' | 'fetch' | 'decode' | 'worker';

/** Serializable error details returned by the loading worker. */
export interface SerializedSplatLoadError {
  name: string;
  message: string;
  phase: SplatLoadPhase;
  url: string;
  status?: number;
  retryable: boolean;
}

/** Structured error thrown for non-cancellation loading failures. */
export class SplatLoadError extends Error {
  readonly phase: SplatLoadPhase;
  readonly url: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      phase: SplatLoadPhase;
      url: string;
      status?: number;
      retryable: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'SplatLoadError';
    this.phase = options.phase;
    this.url = options.url;
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

/** Resolves a loader input without assuming that a browser location exists. */
export function resolveSplatUrl(input: string | URL, baseUrl?: string | URL): URL {
  if (input instanceof URL) return new URL(input.href);
  try {
    const fallbackBase = baseUrl ?? globalThis.location?.href;
    if (fallbackBase === undefined) return new URL(input);
    return new URL(input, fallbackBase);
  } catch (cause) {
    throw new SplatLoadError(`Unable to resolve splat URL "${input}".`, {
      phase: 'resolve',
      url: input,
      retryable: false,
      cause,
    });
  }
}

/** Returns the lower-case pathname extension, excluding query/hash text. */
export function splatUrlExtension(url: URL): string {
  return splatNameExtension(url.pathname);
}

/** Returns the lower-case extension of a plain file name or path. */
export function splatNameExtension(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot < 0 ? '' : lower.slice(dot);
}

/**
 * Maps a file extension to its parser. `label` names the input in the
 * failure message - a URL for a fetched scene, a file name for a local one.
 *
 * @throws {SplatLoadError} (phase `'resolve'`, not retryable) for an unknown
 * extension, keeping the loader contract uniform: callers of the loading
 * pipeline only ever see `SplatLoadError` or `AbortError`.
 */
export function splatFormatForExtension(extension: string, label: string): SplatSourceFormat {
  switch (extension) {
    case '.ply':
      return 'ply';
    case '.spz':
      return 'spz';
    case '.splat':
      return 'splat';
    case '.ksplat':
      return 'ksplat';
    case '.sog':
      return 'sog';
    case '.rad':
      return 'rad';
    default:
      throw new SplatLoadError(`Unsupported splat file extension in ${label}.`, {
        phase: 'resolve',
        url: label,
        retryable: false,
      });
  }
}

/** Creates a fetch init object without sharing mutable header state. */
export function toRequestInit(options?: SplatRequestOptions, signal?: AbortSignal): RequestInit {
  return {
    ...(options?.headers ? { headers: { ...options.headers } } : {}),
    ...(options?.credentials ? { credentials: options.credentials } : {}),
    ...(options?.mode ? { mode: options.mode } : {}),
    ...(options?.cache ? { cache: options.cache } : {}),
    ...(signal ? { signal } : {}),
  };
}

/**
 * The largest `ArrayBuffer` a browser will allocate: 2 GiB, in every current
 * engine. A file bigger than this cannot be read in one piece at all - the
 * read fails rather than the decode.
 */
export const MAX_ARRAY_BUFFER_BYTES = 2 ** 31;

/** Bytes as a short "1.7 GB" for a message. */
function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * Reads a whole local file, turning the browser's two unhelpful failure modes
 * into messages that name the real cause.
 *
 * Chrome reports an over-2 GiB read as `NotReadableError`, whose stock text
 * blames file permissions - so a perfectly good 4 GB capture reads as "your
 * file is broken". Check the size up front instead.
 *
 * Formats with a streaming parser (see `parseSplatPlyFile`) never come here.
 */
export async function readWholeFile(file: File): Promise<ArrayBuffer> {
  if (file.size > MAX_ARRAY_BUFFER_BYTES) {
    throw new Error(
      `${file.name} is ${gigabytes(file.size)}. A browser cannot read more than 2 GB of a file ` +
        'at once, and this format has to be decoded in one piece. Convert it to SOG ' +
        '(npx @playcanvas/splat-transform in.ply out.sog) or a compressed .ply.',
    );
  }
  try {
    return await file.arrayBuffer();
  } catch (error) {
    if (isAbortError(error)) throw error;
    // NotReadableError also covers a file that moved or changed since the drop
    // - the reference is a snapshot, and reading revalidates it.
    if (error instanceof Error && error.name === 'NotReadableError') {
      throw new Error(
        `${file.name} could not be read. It may have been moved, renamed or changed since it ` +
          'was dropped, or it may be on a drive the browser cannot reach.',
        { cause: error },
      );
    }
    throw error;
  }
}

/** Creates an AbortError even where DOMException is unavailable. */
export function createAbortError(message: string): Error {
  if (typeof DOMException !== 'undefined') return new DOMException(message, 'AbortError');
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Whether an unknown failure represents cancellation. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Maps an arbitrary failure to the package's structured loading error. */
export function toSplatLoadError(
  error: unknown,
  options: { phase: SplatLoadPhase; url: string; status?: number },
): SplatLoadError {
  if (error instanceof SplatLoadError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SplatLoadError(message, {
    ...options,
    retryable: isRetryableFailure(options.status, options.phase),
    cause: error,
  });
}

/** Converts a structured load failure into worker-safe data. */
export function serializeSplatLoadError(error: SplatLoadError): SerializedSplatLoadError {
  return {
    name: error.name,
    message: error.message,
    phase: error.phase,
    url: error.url,
    ...(error.status === undefined ? {} : { status: error.status }),
    retryable: error.retryable,
  };
}

/** Reconstructs a package error received from a loading worker. */
export function deserializeSplatLoadError(error: SerializedSplatLoadError): SplatLoadError {
  return new SplatLoadError(error.message, error);
}

/** Monotonic time where available, with an SSR-safe fallback. */
export function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function isRetryableFailure(status: number | undefined, phase: SplatLoadPhase): boolean {
  if (status !== undefined)
    return status === 408 || status === 425 || status === 429 || status >= 500;
  return phase === 'fetch' || phase === 'manifest' || phase === 'worker';
}
