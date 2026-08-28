import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { writeCovariance, type SplatData } from '../splat-data';

/**
 * How a `StreamedSplatMesh` behaves as a client of the shared fetch scheduler:
 * it must take a slot before fetching, hand it back however the fetch settles
 * (resolve, reject or abort), stop sweeping once it loses its weight, and
 * unregister when disposed. A slot leaked on any of these paths permanently
 * shrinks the scene's pipe, so each settle path is asserted separately.
 *
 * See `chunk-fetch-scheduler.test.ts` for the arbitration policy itself.
 */

class StubWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

vi.mock('../sort-worker?worker&inline', () => ({ default: StubWorker }));
vi.mock('../load-worker?worker&inline', () => ({ default: StubWorker }));
vi.mock('../one-shot-worker?worker&inline', () => ({ default: StubWorker }));

const { StreamedSplatMesh } = await import('../streamed-splat-mesh');
const { ChunkFetchScheduler } = await import('../chunk-fetch-scheduler');

const WIDTH = 2048;
type StreamedMesh = import('../streamed-splat-mesh').StreamedSplatMesh;

function makeData(count: number): SplatData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

function makeStreamedMesh(options: Record<string, unknown> = {}): StreamedMesh {
  const scene = {
    source: {
      budget: 4 * WIDTH,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => [],
      coarsestRunsFor: () => [],
    } as unknown,
    chunkUrls: ['https://host/chunk-0/', 'https://host/chunk-1/', 'https://host/chunk-2/'],
    chunkKind: 'directory' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: 4 * WIDTH,
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
  ) => StreamedMesh;
  return new Ctor(scene, 4 * WIDTH, 4 * WIDTH, options);
}

/** The private surface these tests drive. */
interface Internals {
  requestChunk: (file: number, kind: string) => void;
  forwardChunkToWorker: (file: number, data: SplatData) => void;
  postToWorker: (message: unknown, transfer?: Transferable[]) => void;
  sweepAllowed: () => boolean;
  fetching: Map<number, { controller: AbortController; kind: string }>;
  loader: { load: (url: string, options: { signal: AbortSignal }) => Promise<SplatData> };
}

/** Replaces the loader with one whose fetches settle on command. */
function captureLoads(mesh: StreamedMesh): {
  settle: (index: number, data?: SplatData) => void;
  fail: (index: number, error: unknown) => void;
  count: () => number;
} {
  const pending: { resolve: (d: SplatData) => void; reject: (e: unknown) => void }[] = [];
  (mesh as unknown as Internals).loader.load = (_url, options) =>
    new Promise<SplatData>((resolve, reject) => {
      pending.push({ resolve, reject });
      options.signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  return {
    settle: (index, data = makeData(4)) => pending[index]?.resolve(data),
    fail: (index, error) => pending[index]?.reject(error),
    count: () => pending.length,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('StreamedSplatMesh fetch arbitration', () => {
  it('sweeps by default, and stops sweeping once its weight goes to zero', () => {
    const unweighted = makeStreamedMesh();
    // A host that never asked for arbitration keeps the old behaviour exactly.
    expect((unweighted as unknown as Internals).sweepAllowed()).toBe(true);

    let weight = 2;
    const weighted = makeStreamedMesh({ fetchWeight: () => weight });
    expect((weighted as unknown as Internals).sweepAllowed()).toBe(true);
    weight = 0; // the camera turned away, or the mesh was hidden
    expect((weighted as unknown as Internals).sweepAllowed()).toBe(false);

    unweighted.dispose();
    weighted.dispose();
  });

  it('declines the sweep entirely on a smooth performance profile', () => {
    // The sweep pre-warms the *whole* capture and only stops once an eviction
    // latches `pageTableCacheFull` - but the cache floor is sized from the
    // capture itself, so a capture that fits is swept to completion. Measured
    // on the 5.9M-leaf reference `.rad`: a steady ~1 chunk/second drip pulling
    // all 447 MB down long after the view had settled at full detail.
    //
    // `smooth` (the mobile default) is exactly the profile that should decline
    // hundreds of MB of possibly-metered download, a decoded cache rivalling the
    // splat pool, and continuous decode heat - for a camera move that may never
    // happen. It already declines SH bands on the same reasoning.
    const smooth = makeStreamedMesh({ performanceProfile: 'smooth' });
    expect((smooth as unknown as Internals).sweepAllowed()).toBe(false);
    smooth.dispose();

    const quality = makeStreamedMesh({ performanceProfile: 'quality' });
    expect((quality as unknown as Internals).sweepAllowed()).toBe(true);
    quality.dispose();
  });

  it('keeps the profile gate ahead of a positive fetch weight', () => {
    // A weighted mesh on a phone must still decline. Weight answers "is this
    // mesh worth fetching for", not "pre-fetch its entire capture on spec".
    const mesh = makeStreamedMesh({ performanceProfile: 'smooth', fetchWeight: () => 5 });
    expect((mesh as unknown as Internals).sweepAllowed()).toBe(false);
    mesh.dispose();
  });

  it('treats a non-finite weight as no claim rather than sweeping anyway', () => {
    const mesh = makeStreamedMesh({ fetchWeight: () => NaN });
    expect((mesh as unknown as Internals).sweepAllowed()).toBe(false);
    mesh.dispose();
  });

  it('does not fetch when the scheduler denies a slot', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 1 });
    const mesh = makeStreamedMesh({ fetchScheduler: scheduler, fetchWeight: () => 1 });
    const loads = captureLoads(mesh);
    const inner = mesh as unknown as Internals;

    inner.requestChunk(0, 'priority');
    expect(loads.count()).toBe(1);
    // The pipe is full - the second request is simply not made. It must not be
    // recorded as an attempt, or a busy scene would exhaust its retry budget.
    inner.requestChunk(1, 'priority');
    expect(loads.count()).toBe(1);
    expect(inner.fetching.size).toBe(1);

    mesh.dispose();
    scheduler.dispose();
  });

  it('returns its slot however the fetch settles', async () => {
    for (const settleWith of ['resolve', 'reject', 'abort'] as const) {
      const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 4 });
      const mesh = makeStreamedMesh({ fetchScheduler: scheduler, fetchWeight: () => 1 });
      const loads = captureLoads(mesh);
      const inner = mesh as unknown as Internals;

      inner.requestChunk(0, 'priority');
      expect(scheduler.inflight).toBe(1);

      if (settleWith === 'resolve') loads.settle(0);
      else if (settleWith === 'reject') loads.fail(0, new Error('boom'));
      else inner.fetching.get(0)?.controller.abort();
      await flush();

      expect(scheduler.inflight, `slot leaked on ${settleWith}`).toBe(0);
      mesh.dispose();
      scheduler.dispose();
    }
  });

  it('tags fetches by kind so a shed can target the speculative ones', () => {
    const mesh = makeStreamedMesh();
    const inner = mesh as unknown as Internals;
    captureLoads(mesh);

    inner.requestChunk(0, 'priority');
    inner.requestChunk(1, 'sweep');
    expect(inner.fetching.get(0)?.kind).toBe('priority');
    expect(inner.fetching.get(1)?.kind).toBe('sweep');

    // Shedding sweeps must leave the detail that is actually on screen alone.
    (mesh as unknown as { abortFetches: (kind: string) => void }).abortFetches('sweep');
    expect(inner.fetching.get(0)?.controller.signal.aborted).toBe(false);
    expect(inner.fetching.get(1)?.controller.signal.aborted).toBe(true);

    mesh.dispose();
  });

  it('releases the pipe to its siblings when disposed mid-flight', async () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 4 });
    const mesh = makeStreamedMesh({ fetchScheduler: scheduler, fetchWeight: () => 1 });
    captureLoads(mesh);
    const inner = mesh as unknown as Internals;

    inner.requestChunk(0, 'priority');
    inner.requestChunk(1, 'priority');
    expect(scheduler.inflight).toBe(2);
    expect(scheduler.clientCount).toBe(1);

    mesh.dispose();
    await flush();
    // Unregistering reclaims the slots, and the late aborts landing afterwards
    // must not refund them a second time.
    expect(scheduler.inflight).toBe(0);
    expect(scheduler.clientCount).toBe(0);

    scheduler.dispose();
  });

  it('fetches unarbitrated when no scheduler is shared', () => {
    const mesh = makeStreamedMesh();
    const loads = captureLoads(mesh);
    const inner = mesh as unknown as Internals;

    // Backward compatibility: the per-mesh in-flight cap is still the only bound.
    inner.requestChunk(0, 'priority');
    inner.requestChunk(1, 'sweep');
    inner.requestChunk(2, 'base');
    expect(loads.count()).toBe(3);

    mesh.dispose();
  });
});

describe('StreamedSplatMesh page-table chunk forwarding', () => {
  /** A chunk carrying the LOD tree and 3 bands of packed SH. */
  function makeTreeChunk(count: number): SplatData {
    return {
      ...makeData(count),
      radTree: {
        childCount: new Uint16Array(count),
        childStart: new Uint32Array(count),
        size: new Float32Array(count),
      },
      shPacked: {
        bands: 3,
        packed: new Uint32Array(count * 15),
        range: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    } as unknown as SplatData;
  }

  function captureForward(mesh: StreamedMesh): Record<string, unknown>[] {
    const sent: Record<string, unknown>[] = [];
    (mesh as unknown as Internals).postToWorker = (message) => {
      sent.push(message as Record<string, unknown>);
    };
    return sent;
  }

  it('does not hand the worker SH the mesh has declined', () => {
    // The worker charges its cache for every byte it is given, and 15
    // coefficients is 60 B/splat against 40 B for position, colour and
    // covariance combined. Forwarding SH that the pool will never render made it
    // 60% of the chunk cache: measured at 100 B/splat against a cache floor
    // estimated at 40, so the cache filled at ~52 chunks worth of its limit
    // instead of 132 and the frontier thrashed one eviction and one refetch
    // every couple of seconds, forever.
    const mesh = makeStreamedMesh();
    expect(mesh.shBands).toBe(0);
    const sent = captureForward(mesh);
    (mesh as unknown as Internals).forwardChunkToWorker(1, makeTreeChunk(8));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.shBands).toBe(0);
    expect(sent[0]?.shPacked).toBeUndefined();
    mesh.dispose();
  });

  it('still forwards SH when the mesh actually renders it', () => {
    const mesh = makeStreamedMesh({ shBands: 3 });
    expect(mesh.shBands).toBe(3);
    const sent = captureForward(mesh);
    (mesh as unknown as Internals).forwardChunkToWorker(1, makeTreeChunk(8));
    expect(sent[0]?.shBands).toBe(3);
    expect(sent[0]?.shPacked).toBeInstanceOf(Uint32Array);
    mesh.dispose();
  });
});
