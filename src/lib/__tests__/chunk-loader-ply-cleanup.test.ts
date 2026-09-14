import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../internal/experiments', () => ({
  experiments: {
    initialPoolUpload: 'existing',
    radTraversal: 'heap',
    remotePly: 'exact-stream',
    webglProvokingVertex: 'existing',
  },
}));

let posted: { type: string; id: number; resourceId?: string }[] = [];
let terminated = false;
vi.mock('../loaders/load-worker?worker&inline', () => ({
  default: class {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    postMessage(request: { type: string; id: number; resourceId?: string }) {
      posted.push(request);
    }
    terminate() {
      terminated = true;
    }
  },
}));

const { ChunkLoader } = await import('../loaders/chunk-loader');
const { recoverPlyTemporaryOrphans } = await import('../loaders/ply-temp');
afterEach(() => vi.unstubAllGlobals());

it('retains OPFS ownership after immediate abort and cleans after forced worker termination', async () => {
  posted = [];
  terminated = false;
  const files = new Set<string>();
  const removed: string[] = [];
  const directory = {
    async *[Symbol.asyncIterator]() {
      for (const id of files) yield [id, { kind: 'file' }] as const;
    },
    removeEntry: async (id: string) => {
      files.delete(id);
      removed.push(id);
    },
  };
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) },
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object) => Promise<unknown>,
      ) => callback({}),
    },
  });
  const loader = new ChunkLoader();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const controller = new AbortController();
  const pending = loader.load('https://example.test/scene.ply', { signal: controller.signal });
  const id = posted.find((entry) => entry.type === 'load')?.resourceId;
  expect(id).toMatch(/^[a-zA-Z0-9-]+$/);
  files.add(id!);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  loader.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(terminated).toBe(true);
  expect(removed).toContain(id);
  expect(files.size).toBe(0);
});

it('recovers only unlocked files in the VLAM temporary namespace', async () => {
  const files = new Set(['orphan-id', 'active-id', 'unrelated.txt']);
  const removed: string[] = [];
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async (name: string) => {
          expect(name).toBe('vlam-ply-experiment');
          return {
            async *[Symbol.asyncIterator]() {
              for (const id of files) yield [id, { kind: 'file' }] as const;
            },
            removeEntry: async (id: string) => {
              removed.push(id);
              files.delete(id);
            },
          };
        },
      }),
    },
    locks: {
      request: async (
        name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<unknown>,
      ) => callback(name === 'vlam-ply-active-id' ? null : {}),
    },
  });
  await recoverPlyTemporaryOrphans();
  expect(removed).toEqual(['orphan-id']);
  expect(files).toEqual(new Set(['active-id', 'unrelated.txt']));
});
