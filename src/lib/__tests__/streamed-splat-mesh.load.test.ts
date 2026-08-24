import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StreamedSplatMesh } from '../streamed-splat-mesh';
import { SplatLoadError, isAbortError } from '../loading';

// StreamedSplatMesh's module graph pulls in ChunkLoader's worker; every path
// under test fails before a mesh (and hence a worker) is ever constructed,
// so a no-op stub suffices.
beforeAll(() => {
  if (typeof (globalThis as { Worker?: unknown }).Worker === 'undefined') {
    (globalThis as { Worker: unknown }).Worker = class {
      postMessage(): void {}
      terminate(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
      onmessage: unknown = null;
      onerror: unknown = null;
    };
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StreamedSplatMesh.load error contract', () => {
  it('rejects with SplatLoadError (phase manifest) on a manifest HTTP failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const error = await StreamedSplatMesh.load('https://host.test/scene/lod-meta.json').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SplatLoadError);
    const loadError = error as SplatLoadError;
    expect(loadError.phase).toBe('manifest');
    expect(loadError.status).toBe(500);
    expect(loadError.retryable).toBe(true);
  });

  it('wraps a raw network TypeError as SplatLoadError (phase fetch)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const error = await StreamedSplatMesh.load('https://host.test/scene/lod-meta.json').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SplatLoadError);
    expect((error as SplatLoadError).phase).toBe('fetch');
  });

  it('wraps a malformed manifest as SplatLoadError (phase manifest)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"not": "a manifest"}', { status: 200 })),
    );
    const error = await StreamedSplatMesh.load('https://host.test/scene/lod-meta.json').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SplatLoadError);
    expect((error as SplatLoadError).phase).toBe('manifest');
  });

  it('rejects a relative URL with SplatLoadError (phase resolve) without a page location', async () => {
    // Node has no globalThis.location; a relative URL cannot resolve.
    const error = await StreamedSplatMesh.load('scene/lod-meta.json').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SplatLoadError);
    expect((error as SplatLoadError).phase).toBe('resolve');
  });

  it('resolves a relative URL against options.baseUrl', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await StreamedSplatMesh.load('scene/lod-meta.json', {
      baseUrl: 'https://host.test/data/',
    }).catch(() => {});
    expect(fetchMock).toHaveBeenCalledWith(
      'https://host.test/data/scene/lod-meta.json',
      expect.anything(),
    );
  });

  it('rejects with AbortError when the signal is already aborted', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    const error = await StreamedSplatMesh.load('https://host.test/scene/lod-meta.json', {
      signal: controller.signal,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isAbortError(error)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with AbortError when aborted while the manifest is in flight', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );
    const pending = StreamedSplatMesh.load('https://host.test/scene/lod-meta.json', {
      signal: controller.signal,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    controller.abort();
    expect(isAbortError(await pending)).toBe(true);
  });
});

describe('StreamedSplatMesh.loadLocal error contract', () => {
  it('rejects a folder without a manifest with SplatLoadError (phase manifest, not retryable)', async () => {
    const error = await StreamedSplatMesh.loadLocal(new Map()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SplatLoadError);
    const loadError = error as SplatLoadError;
    expect(loadError.phase).toBe('manifest');
    expect(loadError.retryable).toBe(false);
    expect(loadError.message).toMatch(/no streamed-scene manifest/);
  });
});
