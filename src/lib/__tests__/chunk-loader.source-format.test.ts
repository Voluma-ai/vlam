import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SplatData } from '../core/splat-data';

/**
 * A stand-in for the inlined load worker: it echoes a fixed one-splat scene for
 * every `load` request, so `ChunkLoader` can be exercised without spawning a
 * real worker or decoding anything. Only the format-stamping glue is under test.
 */
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(request: { type: string; id: number }): void {
    if (request.type !== 'load') return;
    const data: SplatData = {
      count: 1,
      positions: new Float32Array(3),
      colors: new Uint8Array(4),
      covariances: new Float32Array(6),
    };
    // Settle asynchronously, like a real worker message.
    queueMicrotask(() =>
      this.onmessage?.({ data: { id: request.id, ok: true, data } } as MessageEvent),
    );
  }
  terminate(): void {}
}

vi.mock('../loaders/load-worker?worker&inline', () => ({ default: FakeWorker }));
// `.spz` routes to the one-shot worker, which is loaded on demand.
vi.mock('../loaders/one-shot-worker?worker&inline', () => ({ default: FakeWorker }));

// Imported after the mock so ChunkLoader picks up FakeWorker.
const { ChunkLoader } = await import('../loaders/chunk-loader');

describe('ChunkLoader stamps SplatData.format', () => {
  const loaders: InstanceType<typeof ChunkLoader>[] = [];
  afterEach(() => {
    for (const l of loaders) l.dispose();
    loaders.length = 0;
  });
  const make = () => {
    const l = new ChunkLoader();
    loaders.push(l);
    return l;
  };

  it('stamps a dropped file from its extension', async () => {
    const data = await make().loadFile(new File([new Uint8Array(1)], 'scene.ply'));
    expect(data.format).toBe('ply');
  });

  it('stamps a URL load from its extension', async () => {
    const data = await make().load('https://x.test/scene.spz');
    expect(data.format).toBe('spz');
  });

  it('stamps a directory (unbundled SOG) load as sog', async () => {
    const data = await make().load('https://x.test/chunk/', { kind: 'directory' });
    expect(data.format).toBe('sog');
  });

  it('leaves chunk-only formats (rad-chunk) unstamped', async () => {
    const data = await make().load('https://x.test/data.rad', {
      format: 'rad-chunk',
      rad: { byteOffset: 0, byteLength: 1 } as never,
    });
    expect(data.format).toBeUndefined();
  });
});
