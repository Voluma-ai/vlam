import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../loaders/one-shot-worker?worker&inline');
});

describe('loads awaiting the lazy worker import', () => {
  it.each(['abort', 'dispose'] as const)(
    'settles on %s before import completion',
    async (action) => {
      vi.resetModules();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const posted: { type: string; id: number }[] = [];
      const terminate = vi.fn();
      vi.doMock('../loaders/load-worker?worker&inline', () => ({
        default: class {
          terminate() {}
        },
      }));
      vi.doMock('../loaders/one-shot-worker?worker&inline', async () => {
        await gate;
        return {
          default: class {
            onmessage: ((event: { data: unknown }) => void) | null = null;
            terminate = terminate;
            postMessage(message: { type: string; id: number }) {
              posted.push(message);
              queueMicrotask(() =>
                this.onmessage?.({
                  data: {
                    type: 'result',
                    id: message.id,
                    ok: true,
                    data: {
                      count: 0,
                      positions: new Float32Array(),
                      colors: new Uint8Array(),
                      covariances: new Float32Array(),
                    },
                  },
                }),
              );
            }
          },
        };
      });
      const { ChunkLoader } = await import('../loaders/chunk-loader');
      const loader = new ChunkLoader();
      const controller = new AbortController();
      const pending = loader.load('https://scene.test/a.splat', { signal: controller.signal });
      let error: unknown;
      const observed = pending.catch((reason: unknown) => {
        error = reason;
      });
      const survivor = action === 'abort' ? loader.load('https://scene.test/b.splat') : null;
      if (action === 'abort') controller.abort();
      else loader.dispose();
      try {
        await vi.waitFor(() => expect(error).toMatchObject({ name: 'AbortError' }));
        expect(posted).toEqual([]);
      } finally {
        release();
      }
      await observed;
      if (survivor) await survivor;
      await vi.dynamicImportSettled();
      expect(posted).toHaveLength(survivor ? 1 : 0);
      loader.dispose();
      expect(terminate).toHaveBeenCalledOnce();
    },
  );
});
