import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SplatData } from '../core/splat-data';

/**
 * A controllable stand-in for the inlined load worker: requests do not settle
 * until the test says so, so cancellation and dispose can be interleaved with
 * worker replies at exact points. Mirrors the real worker's protocol
 * (`load`/`cancel` in, `progress`/`result` out).
 */
class ManualWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event?: ErrorEvent) => void) | null = null;
  readonly posted: { type: string; id: number }[] = [];
  terminated = false;

  postMessage(request: { type: string; id: number }): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Emits a worker reply as if it had just arrived on the message port. */
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitSuccess(id: number): void {
    const data: SplatData = {
      count: 1,
      positions: new Float32Array(3),
      colors: new Uint8Array(4),
      covariances: new Float32Array(6),
    };
    this.emit({ type: 'result', id, ok: true, data });
  }

  emitCancelled(id: number): void {
    this.emit({
      type: 'result',
      id,
      ok: false,
      cancelled: true,
      error: {
        name: 'SplatLoadError',
        message: 'cancelled',
        phase: 'worker',
        url: 'x',
        retryable: false,
      },
    });
  }

  emitProgress(id: number, loaded: number, total: number): void {
    this.emit({ type: 'progress', id, loaded, total });
  }
}

let currentWorker: ManualWorker;

vi.mock('../loaders/load-worker?worker&inline', () => ({
  default: class {
    constructor() {
      currentWorker = new ManualWorker();
      return currentWorker;
    }
  },
}));

// Every format exercised here is a streaming one, so the one-shot worker is
// never constructed - the mock only guarantees a real one cannot be.
vi.mock('../loaders/one-shot-worker?worker&inline', () => ({ default: ManualWorker }));

// Imported after the mock so ChunkLoader picks up ManualWorker.
const { ChunkLoader } = await import('../loaders/chunk-loader');

/** Resolves once queued microtasks (promise reactions) have run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('ChunkLoader cancellation and dispose', () => {
  const loaders: InstanceType<typeof ChunkLoader>[] = [];
  afterEach(() => {
    for (const l of loaders) l.dispose();
    loaders.length = 0;
  });
  const make = () => {
    const l = new ChunkLoader();
    loaders.push(l);
    return { loader: l, worker: currentWorker };
  };

  it('rejects with AbortError immediately on abort, before any worker reply', async () => {
    const { loader } = make();
    const controller = new AbortController();
    const load = loader.load('https://x.test/scene.ply', { signal: controller.signal });
    const settled = expect(load).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await settled; // no worker reply was ever emitted
  });

  it('posts a cancel message to the worker on abort', async () => {
    const { loader, worker } = make();
    const controller = new AbortController();
    const load = loader.load('https://x.test/scene.ply', { signal: controller.signal });
    controller.abort();
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.posted).toContainEqual({ type: 'cancel', id: 0 });
  });

  it('drops a success that raced the cancel instead of resolving after abort', async () => {
    const { loader, worker } = make();
    const controller = new AbortController();
    const load = loader.load('https://x.test/scene.ply', { signal: controller.signal });
    controller.abort();
    // The worker finished the decode before it saw the cancel.
    worker.emitSuccess(0);
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ignores the worker cancelled acknowledgement after settling (no double settle)', async () => {
    const { loader, worker } = make();
    const controller = new AbortController();
    const load = loader.load('https://x.test/scene.ply', { signal: controller.signal });
    controller.abort();
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
    worker.emitCancelled(0); // late acknowledgement must be a no-op
    await flush();
  });

  it('stops progress callbacks after abort', async () => {
    const { loader, worker } = make();
    const controller = new AbortController();
    const onProgress = vi.fn();
    const load = loader.load('https://x.test/scene.ply', { signal: controller.signal, onProgress });
    worker.emitProgress(0, 10, 100);
    expect(onProgress).toHaveBeenCalledTimes(1);
    controller.abort();
    worker.emitProgress(0, 50, 100);
    expect(onProgress).toHaveBeenCalledTimes(1);
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects an already-aborted signal without posting to the worker', async () => {
    const { loader, worker } = make();
    const controller = new AbortController();
    controller.abort();
    await expect(
      loader.load('https://x.test/scene.ply', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.posted).toHaveLength(0);
  });

  it('dispose rejects all in-flight loads with AbortError and terminates the worker', async () => {
    const { loader, worker } = make();
    const a = loader.load('https://x.test/a.ply');
    const b = loader.load('https://x.test/b.ply');
    loader.dispose();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
  });

  it('rejects loads started after dispose', async () => {
    const { loader } = make();
    loader.dispose();
    await expect(loader.load('https://x.test/a.ply')).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('double dispose is safe and a post-dispose abort does not post to the dead worker', async () => {
    const { loader, worker } = make();
    const controller = new AbortController();
    const load = loader.load('https://x.test/a.ply', { signal: controller.signal });
    loader.dispose();
    loader.dispose();
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
    const postedBefore = worker.posted.length;
    controller.abort(); // listener was removed by dispose's rejectAll
    expect(worker.posted).toHaveLength(postedBefore);
  });

  it('a worker error rejects every pending load', async () => {
    const { loader, worker } = make();
    const a = loader.load('https://x.test/a.ply');
    const b = loader.load('https://x.test/b.ply');
    worker.onerror?.();
    // The documented contract is SplatLoadError or AbortError only - a worker
    // that never starts (blocked blob: worker under CSP) must not leak a bare
    // Error to callers switching on `phase`.
    for (const pending of [a, b]) {
      await expect(pending).rejects.toMatchObject({
        name: 'SplatLoadError',
        phase: 'worker',
        retryable: false,
        message: 'Chunk loading worker failed.',
      });
    }
  });

  it('a worker error message from the ErrorEvent is preserved', async () => {
    const { loader, worker } = make();
    const pending = loader.load('https://x.test/a.ply');
    worker.onerror?.({ message: 'Refused to create a worker.' } as ErrorEvent);
    await expect(pending).rejects.toMatchObject({
      name: 'SplatLoadError',
      phase: 'worker',
      message: 'Chunk loading worker failed. Refused to create a worker.',
    });
  });

  it('rejects loads started after a worker failure without posting to the dead worker', async () => {
    const { loader, worker } = make();
    worker.onerror?.();
    await expect(loader.load('https://x.test/a.ply')).rejects.toMatchObject({
      name: 'SplatLoadError',
      phase: 'worker',
      retryable: false,
    });
    expect(worker.terminated).toBe(true);
    expect(worker.posted).toHaveLength(0);
  });

  it('an abort on one load leaves an unrelated concurrent load untouched', async () => {
    const { loader, worker } = make();
    const controller = new AbortController();
    const cancelled = loader.load('https://x.test/a.ply', { signal: controller.signal });
    const kept = loader.load('https://x.test/b.ply');
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    worker.emitSuccess(1);
    await expect(kept).resolves.toMatchObject({ count: 1 });
  });
});
