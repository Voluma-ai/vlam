/**
 * Byte-fetching helpers shared by the loading workers.
 *
 * These live outside `load-worker.ts` because there are two workers - the
 * streaming one and the one-shot one (see `one-shot-worker.ts`) - built as
 * separate bundles. Each bundle gets its own copy of this module; the point is
 * one source of truth for range semantics and progress accounting, not shared
 * bytes at runtime.
 */
import {
  isAbortError,
  toRequestInit,
  toSplatLoadError,
  type SplatProgressCallback,
  type SplatRequestOptions,
} from './loading';

/** Chunk URLs carry a `#cell-level` label for debugging; servers never see it. */
export function stripFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

/**
 * Fetches exactly `[start, start + length)` of a file.
 *
 * A server that ignores `Range` answers 200 with the whole body - for a 300 MB
 * `data.bin` that would be a catastrophic download that still "works", so an
 * unranged response is rejected outright rather than decoded.
 */
export async function fetchRange(
  url: string,
  start: number,
  length: number,
  request: SplatRequestOptions | undefined,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const init = toRequestInit(request, signal);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...(request?.headers ?? {}), Range: `bytes=${start}-${start + length - 1}` },
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw toSplatLoadError(error, { phase: 'fetch', url });
  }
  if (!response.ok) {
    throw toSplatLoadError(new Error(`Failed to load ${url}: HTTP ${response.status}`), {
      phase: 'fetch',
      url,
      status: response.status,
    });
  }
  if (response.status !== 206) {
    throw toSplatLoadError(
      new Error(
        `${url} ignored a Range request (HTTP ${response.status}); LCC streaming needs a server that ` +
          'answers 206 Partial Content.',
      ),
      { phase: 'fetch', url, status: response.status },
    );
  }
  const range = response.headers.get('Content-Range');
  const expectedEnd = start + length - 1;
  const match = range?.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) {
    throw toSplatLoadError(
      new Error(
        `${url} returned a partial response without an exposed valid Content-Range header. ` +
          'For cross-origin streaming, expose Content-Range with Access-Control-Expose-Headers.',
      ),
      { phase: 'fetch', url, status: response.status },
    );
  }
  const returnedStart = Number(match[1]);
  const returnedEnd = Number(match[2]);
  if (returnedStart !== start || returnedEnd !== expectedEnd) {
    throw toSplatLoadError(
      new Error(
        `${url} returned Content-Range bytes ${returnedStart}-${returnedEnd}, expected bytes ` +
          `${start}-${expectedEnd}.`,
      ),
      { phase: 'fetch', url, status: response.status },
    );
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw toSplatLoadError(error, { phase: 'fetch', url });
  }
  if (buffer.byteLength !== length) {
    throw toSplatLoadError(
      new Error(`${url} returned ${buffer.byteLength} bytes for a ${length}-byte range.`),
      { phase: 'fetch', url },
    );
  }
  return buffer;
}

export async function fetchBuffer(
  url: string,
  request: SplatRequestOptions | undefined,
  signal: AbortSignal,
  onProgress?: SplatProgressCallback,
): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(url, toRequestInit(request, signal));
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw toSplatLoadError(error, { phase: 'fetch', url });
  }
  if (!response.ok) {
    throw toSplatLoadError(new Error(`Failed to load ${url}: HTTP ${response.status}`), {
      phase: 'fetch',
      url,
      status: response.status,
    });
  }
  try {
    // `arrayBuffer()` reports nothing until it is done, so a caller that wants
    // progress reads the body itself.
    if (!onProgress || !response.body) return await response.arrayBuffer();
    return await readBodyWithProgress(response, onProgress);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw toSplatLoadError(error, { phase: 'fetch', url });
  }
}

/**
 * Reads a response body, reporting bytes as they arrive.
 *
 * With a `Content-Length` the buffer is allocated once and filled in place;
 * joining chunks afterwards would copy a multi-hundred-megabyte scene twice.
 * Without one, progress still counts up but `total` stays 0 - "working", not
 * "nearly done".
 */
async function readBodyWithProgress(
  response: Response,
  onProgress: SplatProgressCallback,
): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('Content-Length'));
  // Content-Length is the encoded representation's length. It cannot size a
  // decoded stream when an intermediary applies gzip or Brotli, so use it only
  // for identity bodies. The accumulation path keeps progress truthful instead
  // of rejecting a perfectly valid compressed transfer as "short".
  const encoding = response.headers.get('Content-Encoding');
  const hasIdentityEncoding = encoding === null || /^identity$/i.test(encoding.trim());
  const total =
    hasIdentityEncoding && Number.isSafeInteger(declared) && declared > 0 ? declared : 0;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  const out = total > 0 ? new Uint8Array(total) : null;
  let loaded = 0;

  onProgress(0, total);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (out) {
        // A body longer than its own Content-Length would overrun the buffer.
        if (loaded + value.byteLength > total) {
          throw new Error(`Response body is longer than its Content-Length of ${total} bytes.`);
        }
        out.set(value, loaded);
      } else {
        chunks.push(value);
      }
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  } finally {
    reader.releaseLock();
  }

  if (out) {
    if (loaded !== total) {
      throw new Error(`Response body ended at ${loaded} bytes, short of its ${total}-byte length.`);
    }
    return out.buffer;
  }
  const joined = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return joined.buffer;
}
