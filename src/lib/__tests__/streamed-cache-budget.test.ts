import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { StreamedSplatMesh, type StreamedSplatMeshOptions } from '../streamed-splat-mesh';
import { ChunkCacheBudget } from '../chunk-cache-budget';

/**
 * How a `StreamedSplatMesh` behaves as a client of the shared cache budget: it
 * must cap its worker at the scene allowance rather than at its own capture
 * size, forward later re-splits, hand the allowance back on dispose - and,
 * critically, keep sweeping.
 *
 * That last one is the risk this change introduces. Under a scene-wide cap,
 * evictions become routine on desktop, and the old permanently-latching
 * `pageTableCacheFull` would have read the first one as "this capture will
 * never fit" and killed the mesh's pre-warming for the session. Warm-cache
 * behaviour is the thing being preserved, so it is asserted directly.
 *
 * See `chunk-cache-budget.test.ts` for the allocation policy itself.
 *
 * Built through the private constructor with a scene stub, as the other
 * `streamed-splat-mesh.*` tests do - no GPU, no network.
 */

const WIDTH = 2048;
const MIB = 1024 * 1024;

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

/** Records what the mesh posts to the frontier worker. */
class RecordingWorker {
  static last: RecordingWorker | undefined;
  readonly posted: Record<string, unknown>[] = [];
  onmessage: unknown = null;
  onerror: unknown = null;
  constructor() {
    RecordingWorker.last = this;
  }
  postMessage(msg: Record<string, unknown>): void {
    this.posted.push(msg);
  }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  of(type: string): Record<string, unknown>[] {
    return this.posted.filter((m) => m['type'] === type);
  }
}

function makeMesh(
  options: StreamedSplatMeshOptions = {},
  chunkUrls: string[] = [],
): StreamedSplatMesh {
  const budget = 4 * WIDTH;
  const scene = {
    source: {
      budget,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => [],
      coarsestRunsFor: () => [],
    } as unknown,
    chunkUrls,
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 100, 100)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: budget,
    chunkSize: 65536,
    foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 },
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
    FrontierWorkerCtor?: unknown,
  ) => StreamedSplatMesh;
  return new Ctor(
    scene,
    budget,
    budget,
    { ...options, foveationMode: 'pagetable' },
    RecordingWorker,
  );
}

/**
 * A classic streamed mesh: no frontier worker, so its chunk cache lives on the
 * main thread and evicts against `cpuCacheBytes`. This is what a `.lcc2` or SOG
 * marker is, and it must join the same scene envelope the `.rad` meshes do.
 */
function makeClassicMesh(options: StreamedSplatMeshOptions = {}): StreamedSplatMesh {
  const budget = 4 * WIDTH;
  const scene = {
    source: {
      budget,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => [],
      coarsestRunsFor: () => [],
    } as unknown,
    chunkUrls: [] as string[],
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 100, 100)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: budget,
    chunkSize: 65536,
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
  ) => StreamedSplatMesh;
  return new Ctor(scene, budget, budget, options);
}

/** The private surface these tests drive. */
interface Internals {
  applyFrontierPlan: (plan: Record<string, unknown>) => void;
  pageTableCacheAtLimit: boolean;
  cacheLimitBytes: number;
  cpuCacheBytes: number;
  reschedule: (camera: THREE.Camera, now: number) => unknown;
  requestChunk: (file: number, kind: string) => void;
  pageTableInFlight: boolean;
  sweepAllowed: () => boolean;
}

const inner = (mesh: StreamedSplatMesh) => mesh as unknown as Internals;

/** An empty plan carrying only the cache fields these tests care about. */
const emptySplats = {
  count: 0,
  positions: new Float32Array(0),
  colors: new Uint8Array(0),
  covariances: new Float32Array(0),
};
const plan = (cacheBytes: number, cacheLimitBytes: number, evicted: number[] = []) => ({
  type: 'plan' as const,
  seq: 1,
  moveSlots: new Uint32Array(0),
  moves: emptySplats,
  appendStart: 0,
  appends: emptySplats,
  degenerateStart: 0,
  degenerateCount: 0,
  touched: new Uint32Array(0),
  residentCount: 0,
  gatherMissing: 0,
  dropped: 0,
  evicted: Uint32Array.from(evicted),
  solvedLimit: 0,
  cacheBytes,
  cacheLimitBytes,
});

describe('StreamedSplatMesh chunk cache budget', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
    RecordingWorker.last = undefined;
  });
  const track = (mesh: StreamedSplatMesh) => {
    meshes.push(mesh);
    return mesh;
  };

  it('caps the worker at its own capture when no budget is shared', () => {
    // The pre-existing behaviour, unchanged for a host that never opted in.
    track(makeMesh());
    const init = RecordingWorker.last?.of('init')[0];
    expect(init?.['cpuCacheBytes']).toBeGreaterThan(0);
  });

  it('caps the worker at the scene allowance instead, when one is shared', () => {
    const cacheBudget = new ChunkCacheBudget({ totalBytes: 128 * MIB, perMeshFloorBytes: 8 * MIB });
    const mesh = track(makeMesh({ cacheBudget, fetchWeight: () => 1 }));

    const init = RecordingWorker.last?.of('init')[0];
    expect(init?.['cpuCacheBytes']).toBe(inner(mesh).cacheLimitBytes);
    // Whatever the split, it can never exceed the scene envelope - that is the
    // whole point, and it is what an unshared mesh could not promise. Left
    // alone this mesh would have asked for `min(2 GiB, its capture)`.
    expect(init?.['cpuCacheBytes']).toBeLessThanOrEqual(128 * MIB);
    expect(mesh.fetchCounts.cacheLimitBytes).toBe(init?.['cpuCacheBytes']);
  });

  it('never lets a scene of meshes exceed the shared total', () => {
    const cacheBudget = new ChunkCacheBudget({ totalBytes: 256 * MIB, perMeshFloorBytes: 8 * MIB });
    const limits: number[] = [];
    for (let i = 0; i < 14; i++) {
      const mesh = track(makeMesh({ cacheBudget, fetchWeight: () => i + 1 }));
      limits.push(inner(mesh).cacheLimitBytes);
    }
    const total = meshes.reduce((sum, mesh) => sum + inner(mesh).cacheLimitBytes, 0);
    expect(total).toBeLessThanOrEqual(256 * MIB);
    expect(limits.every((value) => value > 0)).toBe(true);
  });

  it('bounds a classic streamed mesh too, not only the page-table ones', () => {
    // A scene of `.lcc2` markers has no frontier worker anywhere, so a budget
    // that only covered the page-table path would leave exactly the marker-heavy
    // scenes it exists for outside the envelope.
    const cacheBudget = new ChunkCacheBudget({ totalBytes: 64 * MIB, perMeshFloorBytes: 0 });
    const a = track(makeClassicMesh({ cacheBudget, fetchWeight: () => 1 }));
    const b = track(makeClassicMesh({ cacheBudget, fetchWeight: () => 1 }));

    expect(cacheBudget.clientCount).toBe(2);
    // `evictChunks` reads `cpuCacheBytes` directly, so the allowance has to land
    // there rather than only on the reporting field.
    expect(inner(a).cpuCacheBytes).toBe(inner(a).cacheLimitBytes);
    expect(inner(a).cpuCacheBytes + inner(b).cpuCacheBytes).toBeLessThanOrEqual(64 * MIB);
    expect(a.fetchCounts.cacheLimitBytes).toBe(inner(a).cpuCacheBytes);
  });

  it('moves a classic mesh cap when the scene re-splits', () => {
    const cacheBudget = new ChunkCacheBudget({
      totalBytes: 64 * MIB,
      perMeshFloorBytes: 0,
      minIntervalMs: 0,
      deadband: 0,
    });
    let weight = 1;
    const mesh = track(makeClassicMesh({ cacheBudget, fetchWeight: () => weight }));
    track(makeClassicMesh({ cacheBudget, fetchWeight: () => 1 }));
    const before = inner(mesh).cpuCacheBytes;

    weight = 10;
    cacheBudget.weightsChanged(1000);

    expect(inner(mesh).cpuCacheBytes).toBeGreaterThan(before);
    expect(inner(mesh).cpuCacheBytes).toBe(inner(mesh).cacheLimitBytes);
  });

  it('forwards a re-split to the worker as a cacheBudget message', () => {
    const cacheBudget = new ChunkCacheBudget({
      totalBytes: 64 * MIB,
      perMeshFloorBytes: 0,
      minIntervalMs: 0,
      deadband: 0,
    });
    let weight = 1;
    const mesh = track(makeMesh({ cacheBudget, fetchWeight: () => weight }));
    const worker = RecordingWorker.last;
    // A sibling, so there is something to redistribute between.
    track(makeMesh({ cacheBudget, fetchWeight: () => 1 }));
    const before = inner(mesh).cacheLimitBytes;

    weight = 10;
    cacheBudget.weightsChanged(1000);

    // Two posts, both real: the sibling's registration halved this mesh's share
    // first, then the weight change gave most of it back. The last one is the
    // one the worker is now evicting against.
    const posts = worker?.of('cacheBudget') ?? [];
    expect(posts.length).toBe(2);
    const latest = posts.at(-1)?.['cpuCacheBytes'];
    expect(latest).toBeGreaterThan(before);
    expect(inner(mesh).cacheLimitBytes).toBe(latest);
    expect(mesh.fetchCounts.cacheLimitBytes).toBe(latest);
  });

  it('hands its allowance back on dispose without posting to the dead worker', () => {
    const cacheBudget = new ChunkCacheBudget({ totalBytes: 64 * MIB, perMeshFloorBytes: 0 });
    const staying = track(makeMesh({ cacheBudget, fetchWeight: () => 1 }));
    const leaving = makeMesh({ cacheBudget, fetchWeight: () => 1 });
    const leavingWorker = RecordingWorker.last;
    const before = inner(staying).cacheLimitBytes;

    leaving.dispose();

    expect(cacheBudget.clientCount).toBe(1);
    expect(inner(staying).cacheLimitBytes).toBeGreaterThan(before);
    // The disposed mesh terminated its worker; a reallocation callback reaching
    // it would post into nothing.
    expect(leavingWorker?.of('cacheBudget').length ?? 0).toBe(0);
  });

  it('re-arms the sweep when the cache drops back under its cap', () => {
    // The regression this guards: `pageTableCacheFull` used to latch on the
    // first eviction and never clear, which was safe only while the cap was
    // sized to the capture. Under a scene budget a far mesh is trimmed as a
    // matter of course, and latching would leave it unable to re-warm when the
    // camera came back to it.
    const mesh = track(makeMesh({ fetchWeight: () => 1 }));

    inner(mesh).applyFrontierPlan(plan(100 * MIB, 100 * MIB, [7]));
    expect(inner(mesh).pageTableCacheAtLimit).toBe(true);
    // Monotonic diagnostics still record that it happened.
    expect(mesh.fetchCounts.cacheFull).toBe(true);
    expect(mesh.fetchCounts.evicted).toBe(1);

    // The allowance grew (camera approaching) and the cache is now under it.
    inner(mesh).applyFrontierPlan(plan(100 * MIB, 200 * MIB));
    expect(inner(mesh).pageTableCacheAtLimit).toBe(false);
    expect(inner(mesh).sweepAllowed()).toBe(true);
  });

  it('re-arms the sweep as soon as a raised allowance arrives, not at the next plan', () => {
    const cacheBudget = new ChunkCacheBudget({
      totalBytes: 64 * MIB,
      perMeshFloorBytes: 0,
      minIntervalMs: 0,
      deadband: 0,
    });
    let weight = 1;
    const mesh = track(makeMesh({ cacheBudget, fetchWeight: () => weight }));
    track(makeMesh({ cacheBudget, fetchWeight: () => 1 }));

    // Pin the mesh at its cap.
    const limit = inner(mesh).cacheLimitBytes;
    inner(mesh).applyFrontierPlan(plan(limit, limit, [1]));
    expect(inner(mesh).pageTableCacheAtLimit).toBe(true);

    weight = 20;
    cacheBudget.weightsChanged(1000);

    expect(inner(mesh).pageTableCacheAtLimit).toBe(false);
  });
});
