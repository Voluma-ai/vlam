import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBuffer, fetchRange } from '../loaders/worker-fetch';
import { SplatLoadError } from '../loaders/loading';

const signal = new AbortController().signal;

describe('worker fetch validation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects a partial response with no exposed Content-Range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(4), { status: 206 })));

    await expect(fetchRange('https://scene.test/data.bin', 4, 4, undefined, signal)).rejects.toMatchObject({
      name: 'SplatLoadError',
      phase: 'fetch',
      message: expect.stringMatching(/Content-Range/),
    } satisfies Partial<SplatLoadError>);
  });

  it('rejects shifted Content-Range responses before decoding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array(4), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-3/16' },
        }),
      ),
    );

    await expect(fetchRange('https://scene.test/data.bin', 4, 4, undefined, signal)).rejects.toMatchObject({
      name: 'SplatLoadError',
      phase: 'fetch',
      message: expect.stringMatching(/expected bytes 4-7/),
    } satisfies Partial<SplatLoadError>);
  });

  it('accumulates encoded responses and reports an unknown decoded total', async () => {
    const progress = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'Content-Length': '3', 'Content-Encoding': 'br' },
        }),
      ),
    );

    await expect(fetchBuffer('https://scene.test/scene.ply', undefined, signal, progress)).resolves.toEqual(
      Uint8Array.from([1, 2, 3, 4]).buffer,
    );
    expect(progress).toHaveBeenLastCalledWith(4, 0);
  });
});
