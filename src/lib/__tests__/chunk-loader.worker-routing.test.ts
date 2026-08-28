import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SplatData } from '../core/splat-data';

/**
 * `ChunkLoader` runs two workers: the streaming one, inlined into the published
 * entry, and the one-shot one for `.spz` / `.splat` / `.ksplat`, which is loaded
 * on demand so its parsers (SPZ's ZSTD wasm above all) stay out of that entry.
 *
 * The split is invisible to callers, which is exactly why it needs a test: a
 * format routed to the wrong worker still type-checks, and would only fail at
 * runtime on the `does not decode` guard inside the worker. These tests assert
 * which worker each format reaches, and that the one-shot worker is not
 * constructed until something actually asks for it.
 */
class SpyWorker {
  static readonly built: SpyWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly posted: { type: string; format?: string }[] = [];
  terminated = false;

  constructor(readonly kind: 'streaming' | 'one-shot') {
    SpyWorker.built.push(this);
  }

  postMessage(request: { type: string; id: number; format?: string }): void {
    this.posted.push(request);
    if (request.type !== 'load') return;
    const data: SplatData = {
      count: 1,
      positions: new Float32Array(3),
      colors: new Uint8Array(4),
      covariances: new Float32Array(6),
    };
    queueMicrotask(() =>
      this.onmessage?.({ data: { id: request.id, ok: true, data } } as MessageEvent),
    );
  }

  terminate(): void {
    this.terminated = true;
  }
}

vi.mock('../loaders/load-worker?worker&inline', () => ({
  default: class {
    constructor() {
      return new SpyWorker('streaming');
    }
  },
}));
vi.mock('../loaders/one-shot-worker?worker&inline', () => ({
  default: class {
    constructor() {
      return new SpyWorker('one-shot');
    }
  },
}));

const { ChunkLoader } = await import('../loaders/chunk-loader');

const workersOfKind = (kind: 'streaming' | 'one-shot') =>
  SpyWorker.built.filter((w) => w.kind === kind);

describe('ChunkLoader routes formats to the right worker', () => {
  const loaders: InstanceType<typeof ChunkLoader>[] = [];
  afterEach(() => {
    for (const loader of loaders) loader.dispose();
    loaders.length = 0;
    SpyWorker.built.length = 0;
  });
  const make = () => {
    const loader = new ChunkLoader();
    loaders.push(loader);
    return loader;
  };

  it('does not construct the one-shot worker until a one-shot format is asked for', async () => {
    const loader = make();
    expect(workersOfKind('one-shot')).toHaveLength(0);

    await loader.load('https://x.test/scene.sog');
    expect(workersOfKind('one-shot')).toHaveLength(0);

    await loader.load('https://x.test/scene.spz');
    expect(workersOfKind('one-shot')).toHaveLength(1);
  });

  it.each(['spz', 'splat', 'ksplat'] as const)('sends .%s to the one-shot worker', async (ext) => {
    const loader = make();
    await loader.load(`https://x.test/scene.${ext}`);

    const [oneShot] = workersOfKind('one-shot');
    expect(oneShot?.posted).toContainEqual(expect.objectContaining({ format: ext }));
    expect(workersOfKind('streaming')[0]?.posted).toHaveLength(0);
  });

  it.each(['sog', 'ply', 'rad'] as const)('keeps .%s on the streaming worker', async (ext) => {
    const loader = make();
    await loader.load(`https://x.test/scene.${ext}`);

    expect(workersOfKind('streaming')[0]?.posted).toContainEqual(
      expect.objectContaining({ format: ext }),
    );
    expect(workersOfKind('one-shot')).toHaveLength(0);
  });

  it('reuses one one-shot worker across concurrent loads', async () => {
    const loader = make();
    await Promise.all([
      loader.load('https://x.test/a.spz'),
      loader.load('https://x.test/b.ksplat'),
      loader.load('https://x.test/c.splat'),
    ]);
    expect(workersOfKind('one-shot')).toHaveLength(1);
  });

  it('routes a dropped file by its extension too', async () => {
    const loader = make();
    await loader.loadFile(new File([new Uint8Array(1)], 'scene.spz'));
    expect(workersOfKind('one-shot')[0]?.posted).toContainEqual(
      expect.objectContaining({ format: 'spz' }),
    );
  });

  it('terminates both workers on dispose', async () => {
    const loader = new ChunkLoader();
    await loader.load('https://x.test/scene.spz');
    loader.dispose();

    expect(workersOfKind('streaming')[0]?.terminated).toBe(true);
    expect(workersOfKind('one-shot')[0]?.terminated).toBe(true);
  });

  it('terminates a one-shot worker that finished loading after dispose', async () => {
    const loader = new ChunkLoader();
    const load = loader.load('https://x.test/scene.spz');
    // Dispose before the dynamic import settles: the worker does not exist yet,
    // so dispose cannot terminate it directly.
    loader.dispose();
    await expect(load).rejects.toThrow(/disposed/);

    // Let the pending import finish and construct its (already-doomed) worker.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workersOfKind('one-shot')[0]?.terminated).toBe(true);
  });

  it('rejects a one-shot load aborted while the worker chunk is loading', async () => {
    const loader = make();
    const controller = new AbortController();
    const load = loader.load('https://x.test/scene.spz', { signal: controller.signal });
    controller.abort();
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
  });
});
