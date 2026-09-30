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
  try {
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
    if (range !== null) {
      // Content-Range is not CORS-safelisted. Existing object-storage deployments
      // can return a correct 206 while hiding this header from JavaScript, so an
      // absent header must retain the established exact-body-length fallback.
      // When visible, validate it strictly to catch shifted proxy responses.
      const match = range.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
      if (!match) {
        throw toSplatLoadError(
          new Error(`${url} returned an invalid Content-Range header: ${range}.`),
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
    }
  } catch (error) {
    await discardResponseBody(response);
    throw error;
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
  const response = await fetchWholeResponse(url, request, signal);
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

/** Opens a whole-body fetch while preserving request and fetch-error policy. */
export async function fetchWholeResponse(
  url: string,
  request: SplatRequestOptions | undefined,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, toRequestInit(request, signal));
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw toSplatLoadError(error, { phase: 'fetch', url });
  }
  if (!response.ok) {
    await discardResponseBody(response);
    throw toSplatLoadError(new Error(`Failed to load ${url}: HTTP ${response.status}`), {
      phase: 'fetch',
      url,
      status: response.status,
    });
  }
  return response;
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
  const encoding = response.headers.get('Content-Encoding');
  // CORS exposes Content-Length but may hide the encoding of the wire body.
  const ambiguous = response.type === 'cors' && encoding === null;
  const identity = encoding === null || /^identity$/i.test(encoding.trim());
  const capacity = identity && Number.isSafeInteger(declared) && declared > 0 ? declared : 0;
  const total = ambiguous ? 0 : capacity;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let out = capacity > 0 ? new Uint8Array(capacity) : null;
  let loaded = 0;
  let finished = false;

  try {
    onProgress(0, total);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (out && loaded + value.byteLength > out.length) {
        if (!ambiguous)
          throw new Error(`Response body is longer than its Content-Length of ${total} bytes.`);
        if (loaded > 0) chunks.push(out.subarray(0, loaded));
        out = null;
      }
      if (out) out.set(value, loaded);
      else chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
    if (out) {
      if (!ambiguous && loaded !== total) {
        throw new Error(
          `Response body ended at ${loaded} bytes, short of its ${total}-byte length.`,
        );
      }
      return loaded === out.length ? out.buffer : out.buffer.slice(0, loaded);
    }
    const joined = new Uint8Array(loaded);
    let at = 0;
    for (const chunk of chunks) {
      joined.set(chunk, at);
      at += chunk.byteLength;
    }
    return joined.buffer;
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        /* Preserve the original read or callback error. */
      }
    }
    reader.releaseLock();
  }
}

/** Stops rejected downloads without replacing their original error. */
export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not obscure the status/range error.
  }
}
