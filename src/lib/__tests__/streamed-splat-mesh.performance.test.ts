import { createStreamedMeshFixture } from './helpers/streamed-mesh-fixture';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  StreamedSplatMesh,
  type StreamedSplatMeshOptions,
  type StreamedSplatPerformanceEvent,
  type ClassicFetchWant,
} from '../streaming/streamed-splat-mesh';
import { writeCovariance, type SplatData } from '../core/splat-data';
import { SplatMesh } from '../core/splat-mesh';
import type { SplatRange } from '../core/splat-mesh-types';
import { buildLcc2Scene } from '../formats/lcc/lcc2';
import type { ChunkLoader } from '../loaders/chunk-loader';
import type { ShRange } from '../core/sh-pack';

const WIDTH = 2048;

// StreamedSplatMesh spins up a ChunkLoader Web Worker on construction; these
// tests drive `reschedule` directly, so a no-op Worker stub is enough for node.
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

function makeChunk(count: number): SplatData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i;
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

/** Builds a StreamedSplatMesh without `.load()` (see the channels tests). */
function makeStreamedMesh(
  options: StreamedSplatMeshOptions = {},
  desktopLcc2 = false,
): StreamedSplatMesh {
  const capacity = 4 * WIDTH;
  const scene = {
    source: {
      budget: capacity,
      ...(desktopLcc2 ? { lcc2QualityState: { profile: 'desktop' } } : {}),
    } as unknown,
    chunkUrls: [] as string[],
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: capacity,
  };
  return createStreamedMeshFixture(scene, capacity, capacity, options);
}

type Internals = {
  loader: ChunkLoader;
  currentShRange: () => ShRange | null;
  finishInitialRevealIfComplete: () => void;
  scene: { source: { computeDesiredRuns?: () => unknown[] } };
  cache: Map<number, { data: SplatData; bytes: number; lastUsed: number }>;
  resident: Map<string, { run: { count: number }; handle: unknown }>;
  staged: Map<string, { run: { count: number }; uploadedCount: number }>;
  failedFiles: Set<number>;
  requestChunk: (file: number, kind: 'base' | 'priority', want?: ClassicFetchWant) => void;
  cacheBytesTotal: number;
  cpuCacheBytes: number;
  initialRevealPhase: 'off' | 'capture' | 'holding' | 'released';
  writeInactiveRange: (handle: SplatRange, data: SplatData, offset: number) => void;
  reschedule: (
    camera: THREE.PerspectiveCamera,
    now: number,
  ) => StreamedSplatPerformanceEvent | null;
  createPerformanceEvent: (
    residentBefore: ReadonlyMap<string, number>,
    stagedBefore: ReadonlyMap<string, number>,
    compactionCountBefore: number,
    startedAt: number,
  ) => StreamedSplatPerformanceEvent | null;
};

function internals(mesh: StreamedSplatMesh): Internals {
  return mesh as unknown as Internals;
}

function run(file: number, offset: number, count: number): Record<string, number> {
  return { file, offset, count, leafStart: file, leafEnd: file + 1, level: 0 };
}

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  cam.updateMatrixWorld(true);
  return cam;
}

describe('StreamedSplatMesh performance-event gating', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });

  it('skips the before-snapshots and event construction without a listener', () => {
    const m = makeStreamedMesh();
    meshes.push(m);
    const inner = internals(m);
    const buildEvent = vi.spyOn(inner, 'createPerformanceEvent');
    inner.scene.source.computeDesiredRuns = () => [run(0, 0, 10)];
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });

    expect(inner.reschedule(camera(), 0)).toBeNull();
    // The reschedule work itself still happened; only its diffing was skipped.
    expect(inner.resident.size).toBe(1);
    expect(buildEvent).not.toHaveBeenCalled();
  });

  it('still builds the event for a changed tick when a listener is set', () => {
    const m = makeStreamedMesh({ onPerformanceEvent: () => {} });
    meshes.push(m);
    const inner = internals(m);
    inner.scene.source.computeDesiredRuns = () => [run(0, 0, 10)];
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });

    const event = inner.reschedule(camera(), 0);
    expect(event).toMatchObject({
      appendedCount: 10,
      removedCount: 0,
      activeCount: 10,
      forcedSort: true,
    });

    // A settled tick (same desired runs, all resident) reports no event.
    expect(inner.reschedule(camera(), 1)).toBeNull();
  });

  it('limits interactive hidden staging across swap groups and resumes on later updates', () => {
    const m = makeStreamedMesh({ maxSplatsPerSwap: 2048 });
    meshes.push(m);
    const inner = internals(m);
    const desired = Array.from({ length: 2 }, (_, index) => ({
      file: 0,
      offset: index * 4096,
      count: 4096,
      leafStart: index,
      leafEnd: index + 1,
      level: 1,
    }));
    inner.scene.source.computeDesiredRuns = () => desired;
    inner.cache.set(0, { data: makeChunk(8192), bytes: 0, lastUsed: 0 });
    inner.initialRevealPhase = 'released';

    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 0.5;
      return clock;
    });

    const view = camera();
    inner.reschedule(view, 0);

    const stagedCount = (): number =>
      [...inner.staged.values()].reduce((sum, entry) => sum + entry.uploadedCount, 0);
    // The shared upload allowance admits one complete row per update,
    // independently of how many replacement groups are pending.
    expect(stagedCount()).toBe(2 * 1024);
    expect(inner.resident.size).toBe(0);

    inner.reschedule(view, 1);
    expect(stagedCount()).toBe(4 * 1024);
    expect(inner.resident.size).toBe(0);
  });

  it('stages multiple row batches after selection exceeds the preparation budget', () => {
    const m = makeStreamedMesh({ maxSplatsPerSwap: 4096 });
    meshes.push(m);
    const inner = internals(m);
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    inner.scene.source.computeDesiredRuns = () => {
      clock += 20; // Expensive selection must not starve the staging deadline.
      return [run(0, 0, 8192)];
    };
    inner.cache.set(0, { data: makeChunk(8192), bytes: 0, lastUsed: 0 });
    inner.initialRevealPhase = 'released';
    const write = inner.writeInactiveRange.bind(m);
    vi.spyOn(inner, 'writeInactiveRange').mockImplementation((...args) => {
      clock += 0.1;
      return write(...args);
    });

    const view = camera();
    inner.reschedule(view, 0);
    expect([...inner.staged.values()].map((entry) => entry.uploadedCount)).toEqual([4096]);
    expect(inner.resident.size).toBe(0);
    inner.reschedule(view, 1);
    expect([...inner.staged.values()].map((entry) => entry.uploadedCount)).toEqual([8192]);
    expect(inner.resident.size).toBe(0);
    inner.reschedule(view, 2);
    expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([8192]);
    expect(inner.staged.size).toBe(0);
  });

  it('stages cached desktop LCC2 siblings while missing data holds the old covering parent', () => {
    const m = makeStreamedMesh({ maxSplatsPerSwap: 2048 }, true);
    meshes.push(m);
    const inner = internals(m);
    const old = { file: 0, offset: 0, count: 10, leafStart: 0, leafEnd: 2, level: 2 };
    inner.scene.source.computeDesiredRuns = () => [old];
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera(), 0);
    inner.initialRevealPhase = 'released';
    const replacements = [
      { file: 1, offset: 0, count: 2048, leafStart: 0, leafEnd: 1, level: 1 },
      { file: 2, offset: 0, count: 2048, leafStart: 1, leafEnd: 2, level: 1 },
    ];
    inner.scene.source.computeDesiredRuns = () => replacements;
    inner.cache.set(1, { data: makeChunk(2048), bytes: 0, lastUsed: 0 });
    // Keep the synthetic worker from fetching; file 2 becomes available below.
    inner.failedFiles.add(2);
    vi.spyOn(performance, 'now').mockReturnValue(0);
    inner.reschedule(camera(), 1);
    expect([...inner.staged.values()].map((entry) => entry.uploadedCount)).toEqual([2048]);
    expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([10]);
    // GPU-complete staging must survive CPU-cache eviction while a sibling loads.
    inner.cache.delete(1);
    inner.cache.set(2, { data: makeChunk(2048), bytes: 0, lastUsed: 0 });
    inner.failedFiles.delete(2);
    inner.reschedule(camera(), 2);
    expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([10]);
    inner.reschedule(camera(), 3);
    expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([2048, 2048]);
    expect(inner.staged.size).toBe(0);
  });

  it('stages the near LCC2 owner before an earlier manifest sibling', () => {
    const m = makeStreamedMesh({ maxSplatsPerSwap: 2048 });
    meshes.push(m);
    const inner = internals(m);
    Object.defineProperty(inner.scene.source, 'lcc2QualityState', { value: null });
    inner.scene.source.computeDesiredRuns = () => [
      { ...run(0, 0, 4096), distance: 100, inView: true, screenImportance: 100 },
      { ...run(1, 0, 4096), distance: 1, inView: true, screenImportance: 1 },
    ];
    inner.cache.set(0, { data: makeChunk(4096), bytes: 0, lastUsed: 0 });
    inner.cache.set(1, { data: makeChunk(4096), bytes: 0, lastUsed: 0 });
    inner.initialRevealPhase = 'released';
    vi.spyOn(performance, 'now').mockReturnValue(0);
    inner.reschedule(camera(), 0);
    expect([...inner.staged.keys()]).toEqual(['1:0:0:4096']);
    expect([...inner.staged.values()].map((entry) => entry.uploadedCount)).toEqual([2048]);
    expect(inner.resident.size).toBe(0);
  });

  it('fetches a hidden sibling needed to publish near LCC2 detail before distant detail', () => {
    const m = makeStreamedMesh({ maxSplatsPerSwap: 2048 });
    meshes.push(m);
    const inner = internals(m);
    inner.initialRevealPhase = 'released';
    const parents = [
      { file: 0, offset: 0, count: 10, leafStart: 0, leafEnd: 2, level: 2 },
      { file: 0, offset: 10, count: 10, leafStart: 2, leafEnd: 3, level: 2 },
    ];
    inner.scene.source.computeDesiredRuns = () => parents;
    inner.cache.set(0, { data: makeChunk(20), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera(), 0);
    Object.defineProperty(inner.scene.source, 'lcc2QualityState', { value: null });
    inner.scene.source.computeDesiredRuns = () => [
      {
        file: 1,
        offset: 0,
        count: 2048,
        leafStart: 0,
        leafEnd: 1,
        level: 0,
        distance: 1,
        inView: true,
        screenImportance: 1,
      },
      {
        file: 2,
        offset: 0,
        count: 100,
        leafStart: 1,
        leafEnd: 2,
        level: 2,
        distance: 100,
        inView: false,
        screenImportance: 100,
      },
      {
        file: 3,
        offset: 0,
        count: 2048,
        leafStart: 2,
        leafEnd: 3,
        level: 0,
        distance: 20,
        inView: true,
        screenImportance: 20,
      },
    ];
    inner.cache.set(1, { data: makeChunk(2048), bytes: 0, lastUsed: 0 });
    const request = vi.spyOn(inner, 'requestChunk').mockImplementation(() => {});
    vi.spyOn(performance, 'now').mockReturnValue(0);
    inner.reschedule(camera(), 1);
    expect(request.mock.calls.map(([file]) => file)).toEqual([2, 3]);
    expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([10, 10]);
  });

  it.each([
    { cacheFull: false, finestFirst: false },
    { cacheFull: true, finestFirst: false },
    { cacheFull: false, finestFirst: true },
  ])(
    'publishes ready LCC2 detail while prefetching only with cache headroom: %j',
    ({ cacheFull, finestFirst }) => {
      const bounds = { min: [-1, -1, -2], max: [1, 1, -1] };
      const node = (file: number, count: number) => ({
        boundingBox: bounds,
        data: { '3dgs': { name: file, start: 0, count } },
      });
      const scene = buildLcc2Scene(
        {
          version: '0.0.2',
          totalLevels: 3,
          lodSplats: [30, 20, 10],
          root: {
            boundingBox: bounds,
            splatFiles: ['coarse.sog', 'middle.sog', 'fine.sog'],
            child: {
              '0': {
                ...node(0, 10),
                child: { '0': { ...node(1, 20), child: { '0': node(2, 30) } } },
              },
            },
          },
        },
        {
          manifestUrl: 'https://host/scene.lcc2',
          resolve: (path) => `https://host/${path}`,
          size: async () => null,
          directoryFiles: () => null,
          dispose: () => {},
        },
        { budget: 1000, lodBaseDistance: 10, lodMultiplier: 2, lcc2Policy: { quality: 'desktop' } },
      );
      const m = createStreamedMeshFixture(scene, 4 * WIDTH, 4 * WIDTH, {});
      meshes.push(m);
      const inner = internals(m);
      inner.initialRevealPhase = 'released';
      inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
      inner.cacheBytesTotal = cacheFull ? inner.cpuCacheBytes : 0;
      const request = vi.spyOn(inner, 'requestChunk').mockImplementation(() => {});
      inner.reschedule(camera(), 1000);
      // Full coarse coverage is already published. Prioritize the actual final
      // demand rather than leaving it behind all intermediate quality rungs.
      expect(request.mock.calls.map(([file, kind]) => [file, kind])).toEqual(
        cacheFull
          ? [[1, 'priority']]
          : [
              [2, 'priority'],
              [1, 'priority'],
            ],
      );
      expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([10]);
      if (finestFirst) {
        // An eager final download may win the race. It can replace the coarse
        // cover directly; the intermediate network request must not gate it.
        inner.cache.set(2, { data: makeChunk(30), bytes: 0, lastUsed: 0 });
        inner.reschedule(camera(), 1001);
        expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([30]);
        return;
      }
      inner.cache.set(1, { data: makeChunk(20), bytes: 0, lastUsed: 0 });
      request.mockClear();
      inner.reschedule(camera(), 1001);
      expect(request.mock.calls.map(([file]) => file)).toEqual([2]);
      expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([20]);
      inner.cache.set(2, { data: makeChunk(30), bytes: 0, lastUsed: 0 });
      inner.reschedule(camera(), 1002);
      expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([30]);
    },
  );

  it('promotes a coverage dependency when a finest sibling is already cached', () => {
    const bounds = { min: [-1, -1, -2], max: [1, 1, -1] };
    const node = (file: number, count: number) => ({
      boundingBox: bounds,
      data: { '3dgs': { name: file, start: 0, count } },
    });
    const scene = buildLcc2Scene(
      {
        version: '0.0.2',
        totalLevels: 3,
        lodSplats: [60, 20, 10],
        root: {
          boundingBox: bounds,
          splatFiles: ['coarse.sog', 'middle.sog', 'near.sog', 'sibling.sog'],
          child: {
            '0': {
              ...node(0, 10),
              child: { '0': { ...node(1, 20), child: { '0': node(2, 30), '1': node(3, 30) } } },
            },
          },
        },
      },
      {
        manifestUrl: 'https://host/scene.lcc2',
        resolve: (path) => `https://host/${path}`,
        size: async () => null,
        directoryFiles: () => null,
        dispose: () => {},
      },
      { budget: 1000, lodBaseDistance: 10, lodMultiplier: 2, lcc2Policy: { quality: 'desktop' } },
    );
    const m = createStreamedMeshFixture(scene, 4 * WIDTH, 4 * WIDTH, {});
    meshes.push(m);
    const inner = internals(m);
    inner.initialRevealPhase = 'released';
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.cache.set(2, { data: makeChunk(30), bytes: 0, lastUsed: 0 });
    const request = vi.spyOn(inner, 'requestChunk').mockImplementation(() => {});
    inner.reschedule(camera(), 1000);
    expect(request.mock.calls.find(([file]) => file === 1)?.[2]?.phase).toBe('finest-target');
    // The covering parent remains visible until a complete replacement exists.
    expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([10]);
  });

  it('retains intermediate LCC2 upload progress when a finer download arrives', () => {
    const bounds = { min: [-1, -1, -2], max: [1, 1, -1] };
    const node = (file: number, count: number) => ({
      boundingBox: bounds,
      data: { '3dgs': { name: file, start: 0, count } },
    });
    const scene = buildLcc2Scene(
      {
        version: '0.0.2',
        totalLevels: 3,
        lodSplats: [8192, 4096, 10],
        root: {
          boundingBox: bounds,
          splatFiles: ['coarse.sog', 'middle.sog', 'fine.sog'],
          child: {
            '0': {
              ...node(0, 10),
              child: { '0': { ...node(1, 4096), child: { '0': node(2, 8192) } } },
            },
          },
        },
      },
      {
        manifestUrl: 'https://host/scene.lcc2',
        resolve: (path) => `https://host/${path}`,
        size: async () => null,
        directoryFiles: () => null,
        dispose: () => {},
      },
      { budget: 20000, lodBaseDistance: 10, lodMultiplier: 2, lcc2Policy: { quality: 'desktop' } },
    );
    const m = createStreamedMeshFixture(scene, 16 * WIDTH, 16 * WIDTH, { maxSplatsPerSwap: WIDTH });
    meshes.push(m);
    const inner = internals(m);
    inner.initialRevealPhase = 'released';
    vi.spyOn(inner, 'requestChunk').mockImplementation(() => {});
    vi.spyOn(performance, 'now').mockReturnValue(0);
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera(), 1000);
    inner.cache.set(1, { data: makeChunk(4096), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera(), 1001);
    expect([...inner.staged.values()].map((entry) => entry.uploadedCount)).toEqual([2048]);
    inner.cache.set(2, { data: makeChunk(8192), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera(), 1002);
    expect([...inner.staged.values()].map((entry) => entry.uploadedCount)).toEqual([4096]);
    expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([10]);
    inner.reschedule(camera(), 1003);
    expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([4096]);
    for (let now = 1004; now <= 1008; now++) inner.reschedule(camera(), now);
    expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([8192]);
  });

  it.each([true, false])('warms startup detail only for desktop LCC2 policy: %s', (desktop) => {
    const bounds = { min: [-1, -1, -2], max: [1, 1, -1] };
    const scene = buildLcc2Scene(
      {
        version: '0.0.2',
        totalLevels: 2,
        lodSplats: [20, 10],
        root: {
          boundingBox: bounds,
          splatFiles: ['coarse.sog', 'fine.sog'],
          child: {
            '0': {
              boundingBox: bounds,
              data: { '3dgs': { name: 0, start: 0, count: 10 } },
              child: {
                '0': { boundingBox: bounds, data: { '3dgs': { name: 1, start: 0, count: 20 } } },
              },
            },
          },
        },
      },
      {
        manifestUrl: 'https://host/scene.lcc2',
        resolve: (path) => `https://host/${path}`,
        size: async () => null,
        directoryFiles: () => null,
        dispose: () => {},
      },
      {
        budget: 1000,
        lodBaseDistance: 10,
        lodMultiplier: 2,
        ...(desktop ? { lcc2Policy: { quality: 'desktop' as const } } : {}),
      },
    );
    const m = createStreamedMeshFixture(scene, 4 * WIDTH, 4 * WIDTH, {
      initialReveal: 'hold-coverage',
    });
    meshes.push(m);
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    const request = vi.spyOn(inner, 'requestChunk').mockImplementation(() => {});
    vi.spyOn(performance, 'now').mockReturnValue(0);
    inner.reschedule(camera(), 1000);
    expect(request.mock.calls.map(([file, kind]) => [file, kind])).toEqual(
      desktop ? [[1, 'base']] : [],
    );
    // Warming final detail must not change frozen coverage or publish it early.
    expect([...inner.resident.values()].map((entry) => entry.run.count)).toEqual([10]);
    if (desktop) {
      const shMesh = createStreamedMeshFixture(scene, 4 * WIDTH, 4 * WIDTH, {
        initialReveal: 'hold-coverage',
        shBands: 1,
      });
      meshes.push(shMesh);
      const shInner = internals(shMesh);
      shInner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
      vi.spyOn(shInner, 'finishInitialRevealIfComplete').mockImplementation(() => {});
      const range = vi.spyOn(shInner, 'currentShRange').mockReturnValue(null);
      const shRequest = vi.spyOn(shInner, 'requestChunk').mockImplementation(() => {});
      shInner.reschedule(camera(), 1000);
      expect(shRequest).not.toHaveBeenCalled();
      // Defer speculative SH until it can use the pool's stable range, then
      // warm it during the hold without changing frozen coarse coverage.
      range.mockReturnValue({ min: [-1, -1, -1], max: [1, 1, 1] });
      shInner.reschedule(camera(), 1001);
      expect(shRequest.mock.calls.map(([file, kind]) => [file, kind])).toEqual([[1, 'base']]);
      expect([...shInner.resident.values()].map((entry) => entry.run.count)).toEqual([10]);
    }
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'preconverts fetched SH only for desktop LCC2 with a locked range: %s/%s',
    (desktop, locked) => {
      const scene = {
        source: {
          budget: 4 * WIDTH,
          ...(desktop ? { lcc2QualityState: { profile: 'desktop' } } : {}),
        } as unknown,
        chunkUrls: ['https://host/chunk.sog'],
        chunkKind: 'file' as const,
        chunkOptions: [{ format: 'sog' as const, sog: { packShBands: 1 as const } }],
        bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)),
        pinnedFiles: new Set<number>(),
        maxResidentSplats: 4 * WIDTH,
      };
      const m = createStreamedMeshFixture(scene, 4 * WIDTH, 4 * WIDTH, { shBands: 1 });
      meshes.push(m);
      const inner = internals(m);
      const range: ShRange = { min: [-1, -2, -3], max: [1, 2, 3] };
      vi.spyOn(inner, 'currentShRange').mockReturnValue(locked ? range : null);
      const load = vi.spyOn(inner.loader, 'load').mockResolvedValue(makeChunk(10));
      inner.requestChunk(0, 'priority');
      expect(load).toHaveBeenCalledWith(
        'https://host/chunk.sog',
        expect.objectContaining({
          sog: { packShBands: 1, ...(desktop && locked ? { targetRange: range } : {}) },
        }),
      );
    },
  );

  it('reports texture copies from an update without a LOD reschedule', () => {
    const events: StreamedSplatPerformanceEvent[] = [];
    const m = makeStreamedMesh({ onPerformanceEvent: (event) => events.push(event) });
    meshes.push(m);
    const frame = m as unknown as {
      shouldReschedule: () => boolean;
      getUpdateTimings: () => {
        activeListMs: number;
        uploadMs: number;
        sortSubmitMs: number;
        stagingTextureAllocations: number;
        textureCopyCount: number;
        textureCopyBytes: number;
        activeListUpdateRanges: number;
      };
    };
    vi.spyOn(frame, 'shouldReschedule').mockReturnValue(false);
    vi.spyOn(SplatMesh.prototype, 'update').mockImplementation(() => {});
    vi.spyOn(frame, 'getUpdateTimings').mockReturnValue({
      activeListMs: 0,
      uploadMs: 3,
      sortSubmitMs: 0,
      stagingTextureAllocations: 2,
      textureCopyCount: 7,
      textureCopyBytes: 4096,
      activeListUpdateRanges: 0,
    });

    m.update(camera(), {} as THREE.WebGPURenderer);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      textureCopyCount: 7,
      textureCopyBytes: 4096,
      stagingTextureAllocations: 2,
      appendedCount: 0,
      stagedCount: 0,
    });
  });
});
