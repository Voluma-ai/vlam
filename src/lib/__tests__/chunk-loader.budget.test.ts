import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SplatData } from '../core/splat-data';
import type { LoadWorkerRequest } from '../loaders/load-worker-protocol';

/** Files hold 10 splats. A budgeted load asks for its share and thins to it. */
class BudgetWorker {
  static requests: Extract<LoadWorkerRequest, { type: 'load' }>[] = [];
  static failNext = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(request: LoadWorkerRequest): void {
    if (request.type === 'cancel') return;
    if (request.type === 'grant') {
      const count = Math.min(10, request.maxSplats);
      queueMicrotask(() => this.reply(request.id, count));
      return;
    }
    BudgetWorker.requests.push(request);
    if (BudgetWorker.failNext) {
      BudgetWorker.failNext = false;
      queueMicrotask(() =>
        this.onmessage?.({
          data: {
            type: 'result',
            id: request.id,
            ok: false,
            cancelled: false,
            error: {
              name: 'SplatLoadError',
              message: 'bad',
              phase: 'decode',
              url: '',
              retryable: false,
            },
          },
        } as MessageEvent),
      );
      return;
    }
    if (request.budgeted) {
      queueMicrotask(() =>
        this.onmessage?.({ data: { type: 'budget', id: request.id, count: 10 } } as MessageEvent),
      );
      return;
    }
    queueMicrotask(() => this.reply(request.id, 10));
  }
  private reply(id: number, count: number): void {
    const data: SplatData = {
      count,
      positions: new Float32Array(count * 3),
      colors: new Uint8Array(count * 4),
      covariances: new Float32Array(count * 6),
      ...(count < 10 ? { sourceCount: 10 } : {}),
    };
    this.onmessage?.({ data: { type: 'result', id, ok: true, data } } as MessageEvent);
  }
  terminate(): void {}
}

vi.mock('../loaders/load-worker?worker&inline', () => ({ default: BudgetWorker }));
vi.mock('../loaders/one-shot-worker?worker&inline', () => ({ default: BudgetWorker }));

const { ChunkLoader } = await import('../loaders/chunk-loader');
const { SplatSceneBudget } = await import('../loaders/splat-scene-budget');

describe('ChunkLoader under a scene budget', () => {
  const loaders: InstanceType<typeof ChunkLoader>[] = [];
  afterEach(() => {
    for (const loader of loaders) loader.dispose();
    loaders.length = 0;
    BudgetWorker.requests = [];
    vi.restoreAllMocks();
  });
  const make = () => {
    const loader = new ChunkLoader();
    loaders.push(loader);
    return loader;
  };

  it('budgets whole-file loads only, never streamed chunks', async () => {
    const sceneBudget = new SplatSceneBudget({ profile: null, total: 100 });
    const loader = make();
    await loader.load('https://x.test/a.sog', { sceneBudget });
    await loader.loadFile(new File([new Uint8Array(1)], 'b.spz'), { sceneBudget });
    await loader.load('https://x.test/chunk/', { kind: 'directory', sceneBudget });
    await loader.load('https://x.test/data.rad', {
      format: 'rad-chunk',
      rad: { start: 0, length: 1 },
      sceneBudget,
    });
    await loader.load('https://x.test/data.bin', {
      format: 'lcc-bin',
      lcc: {} as never,
      sceneBudget,
    });
    expect(BudgetWorker.requests.map((request) => request.budgeted === true)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(sceneBudget.resident).toBe(20);
  });

  it('thins to the share left free and warns with the budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sceneBudget = new SplatSceneBudget({ profile: null, total: 16 });
    const loader = make();
    const first = await loader.load('https://x.test/a.sog', { sceneBudget });
    const second = await loader.load('https://x.test/b.sog', { sceneBudget });
    expect(first.count).toBe(10);
    expect(second.count).toBe(6);
    expect(sceneBudget.resident).toBe(16);
    expect(String(warn.mock.calls.at(-1)?.join(' '))).toMatch(/scene budget of 16/);
  });

  it('releases the share when the load fails', async () => {
    const sceneBudget = new SplatSceneBudget({ profile: null, total: 16 });
    BudgetWorker.failNext = true;
    await expect(make().load('https://x.test/a.sog', { sceneBudget })).rejects.toThrow(/bad/);
    expect(sceneBudget.free).toBe(16);
  });

  it('releases the share when the load is cancelled after the grant', async () => {
    const sceneBudget = new SplatSceneBudget({ profile: null, total: 16 });
    const controller = new AbortController();
    const reserve = sceneBudget.reserve.bind(sceneBudget);
    vi.spyOn(sceneBudget, 'reserve').mockImplementation((count, input) => {
      const reservation = reserve(count, input);
      // Cancel after the share is granted, before the result arrives.
      queueMicrotask(() => controller.abort());
      return reservation;
    });
    await expect(
      make().load('https://x.test/a.sog', { sceneBudget, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(sceneBudget.free).toBe(16);
  });

  it('rejects a file the full budget leaves no room for', async () => {
    const sceneBudget = new SplatSceneBudget({ profile: null, total: 10 });
    // Hold the whole budget with data no mesh can shrink.
    const held = sceneBudget.reserve(10);
    held.commit({
      count: 10,
      positions: new Float32Array(30),
      colors: new Uint8Array(40),
      covariances: new Float32Array(60),
    });
    await expect(make().load('https://x.test/a.sog', { sceneBudget })).rejects.toMatchObject({
      name: 'SplatLoadError',
      message: expect.stringMatching(/scene budget of 10 splats is taken/),
    });
    expect(sceneBudget.free).toBe(0);
  });
});
