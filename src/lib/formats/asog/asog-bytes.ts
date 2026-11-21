/**
 * The bytes of an `.asog` file as they arrive (a download's chunks), for
 * {@link parseAsogFrom}: one growing buffer, and waits for its first `end`
 * bytes. Three-free and worker-safe.
 *
 * @internal
 */
import type { AsogBytesUntil } from './parse-asog';

/** @internal */
export interface AsogByteSink {
  /** Appends the next chunk of the file. */
  push(chunk: Uint8Array): void;
  /** The file is complete: a wait beyond its bytes rejects as truncated. */
  end(): void;
  /** Rejects every wait, now and later, with `error`. */
  fail(error: Error): void;
  /** Waits for the first `end` bytes (see {@link AsogBytesUntil}). */
  readonly until: AsogBytesUntil;
  /** Bytes received so far. */
  readonly length: number;
  /** Milliseconds spent waiting for bytes, so a decode can report its own time. */
  readonly waitedMs: number;
}

/**
 * A sink that grows its buffer by doubling as bytes arrive, so a header that
 * names a huge file allocates no more than about twice what really came.
 *
 * @internal
 */
export function createAsogByteSink(): AsogByteSink {
  let buffer = new Uint8Array(1 << 16);
  let length = 0;
  let ended = false;
  let failure: Error | null = null;
  let waitedMs = 0;
  let waiter: {
    end: number;
    since: number;
    resolve: (bytes: Uint8Array) => void;
    reject: (error: Error) => void;
  } | null = null;

  const truncated = (end: number): Error =>
    new Error(`ASOG: the file is truncated (${length} bytes, the header names ${end}).`);
  const settle = (): void => {
    if (!waiter) return;
    const { end, since, resolve, reject } = waiter;
    if (failure) reject(failure);
    else if (length >= end) resolve(buffer.subarray(0, length));
    else if (ended) reject(truncated(end));
    else return;
    waitedMs += performance.now() - since;
    waiter = null;
  };

  return {
    push(chunk: Uint8Array): void {
      if (ended || failure) return;
      if (length + chunk.length > buffer.length) {
        let size = buffer.length;
        while (size < length + chunk.length) size *= 2;
        const grown = new Uint8Array(size);
        grown.set(buffer.subarray(0, length));
        buffer = grown;
      }
      buffer.set(chunk, length);
      length += chunk.length;
      settle();
    },
    end(): void {
      ended = true;
      settle();
    },
    fail(error: Error): void {
      failure ??= error;
      settle();
    },
    until(end: number): Promise<Uint8Array> {
      if (failure) return Promise.reject(failure);
      if (length >= end) return Promise.resolve(buffer.subarray(0, length));
      if (ended) return Promise.reject(truncated(end));
      if (waiter) return Promise.reject(new Error('ASOG: one wait for bytes at a time.'));
      return new Promise((resolve, reject) => {
        waiter = { end, since: performance.now(), resolve, reject };
      });
    },
    get length() {
      return length;
    },
    get waitedMs() {
      return waitedMs;
    },
  };
}
