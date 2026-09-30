import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBuffer, fetchRange } from '../loaders/worker-fetch';
import { SplatLoadError } from '../loaders/loading';

const signal = new AbortController().signal;

describe('worker fetch validation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts an exact partial response when CORS does not expose Content-Range', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(4), { status: 206 })),
    );

    await expect(
      fetchRange('https://scene.test/data.bin', 4, 4, undefined, signal),
    ).resolves.toEqual(new Uint8Array(4).buffer);
  });

  it('rejects an exposed malformed Content-Range', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(4), {
            status: 206,
            headers: { 'Content-Range': 'invalid' },
          }),
      ),
    );

    await expect(
      fetchRange('https://scene.test/data.bin', 4, 4, undefined, signal),
    ).rejects.toMatchObject({
      name: 'SplatLoadError',
      phase: 'fetch',
      message: expect.stringMatching(/invalid Content-Range/),
    } satisfies Partial<SplatLoadError>);
  });

  it('rejects shifted Content-Range responses before decoding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(4), {
            status: 206,
            headers: { 'Content-Range': 'bytes 0-3/16' },
          }),
      ),
    );

    await expect(
      fetchRange('https://scene.test/data.bin', 4, 4, undefined, signal),
    ).rejects.toMatchObject({
      name: 'SplatLoadError',
      phase: 'fetch',
      message: expect.stringMatching(/expected bytes 4-7/),
    } satisfies Partial<SplatLoadError>);
  });

  it('accumulates encoded responses and reports an unknown decoded total', async () => {
    const progress = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { 'Content-Length': '3', 'Content-Encoding': 'br' },
          }),
      ),
    );

    await expect(
      fetchBuffer('https://scene.test/scene.ply', undefined, signal, progress),
    ).resolves.toEqual(Uint8Array.from([1, 2, 3, 4]).buffer);
    expect(progress).toHaveBeenLastCalledWith(4, 0);
  });
});

describe('decoded CORS body lengths', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([2, 4, 9])('treats a hidden encoding as a hint for a %i-byte body', async (length) => {
    const bytes = Uint8Array.from({ length }, (_, i) => i + 1);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      { headers: { 'Content-Length': '4' } },
    );
    Object.defineProperty(response, 'type', { value: 'cors' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    const progress = vi.fn();
    await expect(fetchBuffer('https://scene.test/a', undefined, signal, progress)).resolves.toEqual(
      bytes.buffer,
    );
    expect(progress.mock.calls.every(([, total]) => total === 0)).toBe(true);
  });
  it.each([2, 6])('still rejects a trustworthy identity mismatch of %i bytes', async (length) => {
    const response = new Response(new Uint8Array(length), {
      headers: { 'Content-Length': '4', 'Content-Encoding': 'identity' },
    });
    Object.defineProperty(response, 'type', { value: 'cors' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    await expect(fetchBuffer('https://scene.test/a', undefined, signal, vi.fn())).rejects.toThrow(
      /length|longer/,
    );
  });
  it('cancels and unlocks an unfinished reader without masking a callback failure', async () => {
    const cancel = vi.fn(() => {
      throw new Error('cancel failed');
    });
    const body = new ReadableStream({
      start(c) {
        c.enqueue(Uint8Array.of(1));
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );
    const failure = new Error('progress failed');
    await expect(
      fetchBuffer('https://scene.test/a', undefined, signal, () => {
        throw failure;
      }),
    ).rejects.toThrow('progress failed');
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it('accepts a compressed response without a progress callback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(Uint8Array.of(1, 2, 3), {
            headers: { 'Content-Length': '2', 'Content-Encoding': 'gzip' },
          }),
      ),
    );
    await expect(fetchBuffer('https://scene.test/a', undefined, signal)).resolves.toEqual(
      Uint8Array.of(1, 2, 3).buffer,
    );
  });
});

it('unlocks a body reader after an abort without replacing the AbortError', async () => {
  const error = new DOMException('cancelled', 'AbortError');
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(error);
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body)),
  );
  try {
    await expect(fetchBuffer('https://scene.test/a', undefined, signal, vi.fn())).rejects.toBe(
      error,
    );
    expect(body.locked).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('rejected response cleanup', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([200, 403, 206])(
    'cancels the unread body of a rejected %i range response',
    async (status) => {
      const cancel = vi.fn();
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(new ReadableStream({ cancel }), {
              status,
              headers: { 'Content-Range': 'invalid' },
            }),
        ),
      );
      await expect(
        fetchRange('https://scene.test/data.bin', 4, 4, undefined, signal),
      ).rejects.toMatchObject({ phase: 'fetch', status });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
});
