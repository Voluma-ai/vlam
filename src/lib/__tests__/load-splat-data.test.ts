import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SplatData } from '../splat-data';
import { SplatLoadError } from '../loading';

/**
 * Controllable stand-in for both load workers. Settles on demand so URL,
 * file, progress, cancel, and structured-error paths can be driven without
 * a real decode.
 */
class ManualWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event?: ErrorEvent) => void) | null = null;
  readonly posted: { type: string; id: number }[] = [];

  postMessage(request: { type: string; id: number }): void {
    this.posted.push(request);
  }

  terminate(): void {}

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

  emitProgress(id: number, loaded: number, total: number): void {
    this.emit({ type: 'progress', id, loaded, total });
  }

  emitDecodeError(id: number, url: string): void {
    this.emit({
      type: 'result',
      id,
      ok: false,
      cancelled: false,
      error: {
        name: 'SplatLoadError',
        message: 'decode failed',
        phase: 'decode',
        url,
        retryable: false,
      },
    });
  }
}

let currentWorker: ManualWorker;

vi.mock('../load-worker?worker&inline', () => ({
  default: class {
    constructor() {
      currentWorker = new ManualWorker();
      return currentWorker;
    }
  },
}));

vi.mock('../one-shot-worker?worker&inline', () => ({
  default: class {
    constructor() {
      currentWorker = new ManualWorker();
      return currentWorker;
    }
  },
}));

const { loadSplatData, loadSplatDataFile } = await import('../load-splat-data');

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('loadSplatData / loadSplatDataFile', () => {
  afterEach(() => {
    currentWorker = undefined as unknown as ManualWorker;
  });

  it('loads a URL and stamps format from the extension', async () => {
    const pending = loadSplatData('https://x.test/garden.ply');
    await flush();
    currentWorker.emitSuccess(0);
    const data = await pending;
    expect(data.count).toBe(1);
    expect(data.format).toBe('ply');
  });

  it('honours an explicit format when the URL has no extension', async () => {
    const pending = loadSplatData('https://x.test/api/42', { format: 'sog' });
    await flush();
    currentWorker.emitSuccess(0);
    expect((await pending).format).toBe('sog');
  });

  it('loads a local file and stamps format from the name', async () => {
    const pending = loadSplatDataFile(new File([new Uint8Array(1)], 'drop.spz'));
    await flush();
    currentWorker.emitSuccess(0);
    expect((await pending).format).toBe('spz');
  });

  it('reports progress from the worker', async () => {
    const onProgress = vi.fn();
    const pending = loadSplatData('https://x.test/garden.ply', { onProgress });
    await flush();
    currentWorker.emitProgress(0, 10, 100);
    expect(onProgress).toHaveBeenCalledWith(10, 100);
    currentWorker.emitSuccess(0);
    await pending;
  });

  it('rejects with AbortError when the signal fires', async () => {
    const controller = new AbortController();
    const pending = loadSplatData('https://x.test/garden.ply', { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with SplatLoadError on a decode failure', async () => {
    const pending = loadSplatData('https://x.test/garden.ply');
    await flush();
    currentWorker.emitDecodeError(0, 'https://x.test/garden.ply');
    await expect(pending).rejects.toMatchObject({
      name: 'SplatLoadError',
      phase: 'decode',
      retryable: false,
    });
    await expect(pending).rejects.toBeInstanceOf(SplatLoadError);
  });

  it('rejects an unknown local-file extension as a resolve-phase SplatLoadError', async () => {
    await expect(
      loadSplatDataFile(new File([new Uint8Array(1)], 'notes.txt')),
    ).rejects.toMatchObject({
      name: 'SplatLoadError',
      phase: 'resolve',
      retryable: false,
    });
  });
});
