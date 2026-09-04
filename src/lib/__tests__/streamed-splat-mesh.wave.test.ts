import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { StreamedSplatMesh } from '../streaming/streamed-splat-mesh';
import { writeCovariance, type SplatData } from '../core/splat-data';
import { runKey, type LodRun } from '../streaming/lod-scheduler';

/**
 * Prefix-reader `.rad` keys runs by global splat index, so a parent and its
 * children never share a swap group. Prefetch of the next chunk is also a
 * purely additive group. Fetch-intent runs are not part of the presented cut,
 * so a drawable overview can publish while speculative prefetch continues in
 * the background.
 */

const WIDTH = 2048;

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

function run(partial: Omit<LodRun, 'offset'> & { offset?: number }): LodRun {
  return { offset: 0, ...partial };
}

type Internals = {
  cache: Map<number, { data: SplatData; bytes: number; lastUsed: number }>;
  reschedule: (camera: THREE.PerspectiveCamera, now: number) => unknown;
  requestChunk: (file: number, kind: string) => void;
  resident: Map<string, { run: LodRun }>;
  staged: Map<string, { run: LodRun; uploadedCount: number }>;
  activeCount: number;
  fetchCounts: { retiredEarly: number };
  scene: { source: { computeDesiredRuns: () => LodRun[] } };
  cpuCacheBytes: number;
  cacheBytesTotal: number;
};

function internals(mesh: StreamedSplatMesh): Internals {
  return mesh as unknown as Internals;
}

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.updateMatrixWorld(true);

function makeMesh(
  desired: LodRun[],
  options: { maxSplatsPerSwap?: number; capacity?: number } = {},
): StreamedSplatMesh {
  const maxFile = Math.max(0, ...desired.map((r) => r.file));
  const capacity = options.capacity ?? 4 * WIDTH;
  const scene = {
    source: {
      budget: capacity,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => desired,
      coarsestRunsFor: () => [] as LodRun[],
    },
    chunkUrls: Array.from({ length: maxFile + 1 }, (_, f) => `https://host/data.bin#${f}`),
    chunkKind: 'file' as const,
    chunkOptions: Array.from({ length: maxFile + 1 }, () => ({ format: 'rad-chunk' as const })),
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: capacity,
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
  ) => StreamedSplatMesh;
  return new Ctor(scene, capacity, capacity, options);
}

function residentFiles(inner: Internals): number[] {
  return [...inner.resident.values()].map((entry) => entry.run.file).sort((a, b) => a - b);
}

describe('prefix-reader RAD wave commit', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });

  it('presents the drawable overview while prefetch is in flight', () => {
    const parent = run({ file: 0, level: 4, count: 40, leafStart: 0, leafEnd: 40 });
    const children = run({ file: 1, level: 3, count: 60, leafStart: 40, leafEnd: 100 });
    const prefetch = run({
      file: 2,
      level: 2,
      count: 80,
      leafStart: 100,
      leafEnd: 180,
      fetchIntent: true,
    });

    const m = makeMesh([parent, prefetch]);
    meshes.push(m);
    const inner = internals(m);
    inner.requestChunk = () => {};
    inner.cache.set(0, { data: makeChunk(40), bytes: 0, lastUsed: 0 });

    inner.reschedule(camera, 0);
    expect(residentFiles(inner)).toEqual([0]);
    expect(inner.activeCount).toBe(40);

    inner.scene.source.computeDesiredRuns = () => [children, prefetch];
    inner.cache.set(1, { data: makeChunk(60), bytes: 0, lastUsed: 1 });

    for (let tick = 1; tick <= 4; tick++) {
      inner.reschedule(camera, tick);
      expect(residentFiles(inner)).toEqual([1]);
      expect(filesOverlap(inner, [0, 1])).toBe(false);
    }

    expect(inner.activeCount).toBe(60);
    expect(inner.resident.has(runKey(parent))).toBe(false);
    expect(inner.resident.has(runKey(prefetch))).toBe(false);
    expect(inner.fetchCounts.retiredEarly).toBe(0);

    inner.scene.source.computeDesiredRuns = () => [children];
    inner.reschedule(camera, 5);
    expect(residentFiles(inner)).toEqual([1]);
    expect(inner.activeCount).toBe(60);
    expect(inner.resident.has(runKey(parent))).toBe(false);
  });

  it('publishes a resident prefix cut when a fetch-intent run never lands', () => {
    const resident = run({ file: 0, level: 4, count: 40, leafStart: 0, leafEnd: 40 });
    const refined = run({ file: 1, level: 3, count: 60, leafStart: 40, leafEnd: 100 });
    const neverLandingPrefetch = run({
      file: 2,
      level: 2,
      count: 80,
      leafStart: 100,
      leafEnd: 180,
      fetchIntent: true,
    });

    const m = makeMesh([resident, neverLandingPrefetch]);
    meshes.push(m);
    const inner = internals(m);
    inner.requestChunk = () => {};
    inner.cpuCacheBytes = Number.MAX_SAFE_INTEGER;
    inner.cache.set(0, { data: makeChunk(40), bytes: 0, lastUsed: 0 });
    inner.cache.set(1, { data: makeChunk(60), bytes: 0, lastUsed: 0 });

    inner.reschedule(camera, 0);
    expect(residentFiles(inner)).toEqual([0]);
    expect(inner.activeCount).toBe(40);

    inner.scene.source.computeDesiredRuns = () => [refined, neverLandingPrefetch];
    inner.reschedule(camera, 1);
    expect(residentFiles(inner)).toEqual([1]);
    expect(inner.activeCount).toBe(60);
  });

  it('fetches prefix prefetch chunks while presenting the drawable cut', () => {
    const parent = run({ file: 0, level: 4, count: 40, leafStart: 0, leafEnd: 40 });
    const prefetch = run({
      file: 2,
      level: 2,
      count: 80,
      leafStart: 100,
      leafEnd: 180,
      fetchIntent: true,
    });
    const m = makeMesh([parent, prefetch]);
    meshes.push(m);
    const inner = internals(m);
    const requested: number[] = [];
    inner.requestChunk = (file) => {
      requested.push(file);
    };
    inner.cache.set(0, { data: makeChunk(40), bytes: 0, lastUsed: 0 });

    inner.reschedule(camera, 0);
    expect(residentFiles(inner)).toEqual([0]);
    expect(inner.activeCount).toBe(40);
    expect(requested).toContain(2);
    expect(inner.resident.has(runKey(prefetch))).toBe(false);
  });

  it('stages children across the append cap without replacing the parent early', () => {
    const parent = run({ file: 0, level: 4, count: 40, leafStart: 0, leafEnd: 40 });
    const children = run({ file: 1, level: 3, count: 60, leafStart: 40, leafEnd: 100 });
    const prefetch = run({
      file: 2,
      level: 2,
      count: 80,
      leafStart: 100,
      leafEnd: 180,
      fetchIntent: true,
    });

    const m = makeMesh([parent, prefetch], { maxSplatsPerSwap: 25 });
    meshes.push(m);
    const inner = internals(m);
    inner.requestChunk = () => {};
    inner.cache.set(0, { data: makeChunk(40), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera, 0);
    inner.reschedule(camera, 1);
    inner.reschedule(camera, 2);
    expect(inner.activeCount).toBe(40);
    expect(residentFiles(inner)).toEqual([0]);

    inner.scene.source.computeDesiredRuns = () => [children, prefetch];
    inner.cache.set(1, { data: makeChunk(60), bytes: 0, lastUsed: 1 });

    inner.reschedule(camera, 1);
    expect(residentFiles(inner)).toEqual([0]);
    expect(inner.staged.get(runKey(children))?.uploadedCount).toBe(25);

    inner.reschedule(camera, 2);
    expect(inner.staged.get(runKey(children))?.uploadedCount).toBe(50);

    inner.reschedule(camera, 3);
    expect(inner.staged.get(runKey(children))?.uploadedCount).toBe(60);
    expect(inner.activeCount).toBe(40);

    inner.reschedule(camera, 4);
    expect(residentFiles(inner)).toEqual([1]);
    expect(inner.activeCount).toBe(60);
    expect(inner.fetchCounts.retiredEarly).toBe(0);

    inner.scene.source.computeDesiredRuns = () => [children];
    inner.reschedule(camera, 5);
    expect(residentFiles(inner)).toEqual([1]);
    expect(inner.activeCount).toBe(60);
  });

  it('does not activate the first child group while a sibling is still staging', () => {
    const childA = run({ file: 1, level: 3, count: 30, leafStart: 40, leafEnd: 70 });
    const childB = run({ file: 2, level: 3, count: 30, leafStart: 70, leafEnd: 100 });

    const m = makeMesh([childA, childB], { maxSplatsPerSwap: 25 });
    meshes.push(m);
    const inner = internals(m);
    inner.requestChunk = () => {};
    inner.cache.set(1, { data: makeChunk(30), bytes: 0, lastUsed: 1 });
    inner.cache.set(2, { data: makeChunk(30), bytes: 0, lastUsed: 1 });

    inner.reschedule(camera, 1);
    expect(inner.resident.has(runKey(childA))).toBe(false);
    expect(inner.resident.has(runKey(childB))).toBe(false);
    expect(residentFiles(inner)).toEqual([]);

    inner.reschedule(camera, 2);
    expect(inner.resident.has(runKey(childA))).toBe(false);

    inner.reschedule(camera, 3);
    expect(inner.resident.has(runKey(childA))).toBe(false);

    inner.reschedule(camera, 4);
    expect(residentFiles(inner).sort()).toEqual([1, 2]);
    expect(inner.activeCount).toBe(60);
  });

  it('publishes a fully staged cut when the CPU cache is full even if later files are uncached', () => {
    const parent = run({ file: 0, level: 4, count: 40, leafStart: 0, leafEnd: 40 });
    const children = run({ file: 1, level: 3, count: 60, leafStart: 40, leafEnd: 100 });
    const prefetch = run({
      file: 2,
      level: 2,
      count: 80,
      leafStart: 100,
      leafEnd: 180,
      fetchIntent: true,
    });

    const m = makeMesh([parent, prefetch]);
    meshes.push(m);
    const inner = internals(m);
    inner.requestChunk = () => {};
    inner.cache.set(0, { data: makeChunk(40), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera, 0);
    expect(residentFiles(inner)).toEqual([0]);
    expect(inner.activeCount).toBe(40);

    inner.scene.source.computeDesiredRuns = () => [children, prefetch];
    inner.cache.set(1, { data: makeChunk(60), bytes: 40 * 1024 * 1024, lastUsed: 1 });
    for (let tick = 2; tick <= 5; tick++) inner.reschedule(camera, tick);
    expect(residentFiles(inner)).toEqual([1]);
    expect(inner.activeCount).toBe(60);

    inner.cpuCacheBytes = 1;
    inner.cacheBytesTotal = 2;
    inner.reschedule(camera, 6);
    expect(residentFiles(inner)).toEqual([1]);
    expect(inner.activeCount).toBe(60);
    expect(inner.fetchCounts.retiredEarly).toBe(0);
  });

  it('does not replace a published cut with a coarser one when the cache is full', () => {
    const parent = run({ file: 0, level: 4, count: 40, leafStart: 0, leafEnd: 40 });
    const children = run({ file: 1, level: 3, count: 60, leafStart: 40, leafEnd: 100 });
    const prefetch = run({
      file: 2,
      level: 2,
      count: 80,
      leafStart: 100,
      leafEnd: 180,
      fetchIntent: true,
    });

    const m = makeMesh([children]);
    meshes.push(m);
    const inner = internals(m);
    inner.requestChunk = () => {};
    inner.cache.set(1, { data: makeChunk(60), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera, 0);
    inner.reschedule(camera, 1);
    expect(residentFiles(inner)).toEqual([1]);
    expect(inner.activeCount).toBe(60);

    inner.scene.source.computeDesiredRuns = () => [parent, prefetch];
    inner.cache.set(0, { data: makeChunk(40), bytes: 0, lastUsed: 1 });
    inner.cpuCacheBytes = 1;
    inner.cacheBytesTotal = 2;
    for (let tick = 2; tick <= 6; tick++) inner.reschedule(camera, tick);
    expect(residentFiles(inner)).toEqual([1]);
    expect(inner.activeCount).toBe(60);
    expect(inner.fetchCounts.retiredEarly).toBe(0);
  });

  it('stages a deeper cut without presenting intermediates while prefetch is uncached', () => {
    const parent = run({ file: 0, level: 4, count: 40, leafStart: 0, leafEnd: 40 });
    const children = run({ file: 1, level: 3, count: 60, leafStart: 40, leafEnd: 100 });
    const finer = run({ file: 3, level: 2, count: 80, leafStart: 100, leafEnd: 180 });
    const prefetch = run({
      file: 4,
      level: 1,
      count: 90,
      leafStart: 180,
      leafEnd: 270,
      fetchIntent: true,
    });

    const m = makeMesh([parent, prefetch]);
    meshes.push(m);
    const inner = internals(m);
    inner.requestChunk = () => {};
    inner.cache.set(0, { data: makeChunk(40), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera, 0);
    inner.reschedule(camera, 1);
    expect(residentFiles(inner)).toEqual([0]);
    expect(inner.activeCount).toBe(40);

    inner.scene.source.computeDesiredRuns = () => [children, prefetch];
    inner.cache.set(1, { data: makeChunk(60), bytes: 0, lastUsed: 1 });
    for (let tick = 2; tick <= 5; tick++) inner.reschedule(camera, tick);
    expect(residentFiles(inner)).toEqual([1]);
    expect(inner.activeCount).toBe(60);

    inner.scene.source.computeDesiredRuns = () => [finer, prefetch];
    inner.cache.set(3, { data: makeChunk(80), bytes: 0, lastUsed: 2 });
    for (let tick = 6; tick <= 10; tick++) inner.reschedule(camera, tick);
    expect(residentFiles(inner)).toEqual([3]);
    expect(inner.activeCount).toBe(80);

    inner.scene.source.computeDesiredRuns = () => [finer];
    inner.reschedule(camera, 11);
    expect(residentFiles(inner)).toEqual([3]);
    expect(inner.activeCount).toBe(80);
    expect(inner.fetchCounts.retiredEarly).toBe(0);
  });

  it('abandons a mid-staging overview when a deeper frontier arrives before publish', () => {
    const coarse = run({ file: 0, level: 4, count: 40, leafStart: 0, leafEnd: 40 });
    const fine = run({ file: 1, level: 3, count: 60, leafStart: 40, leafEnd: 100 });
    const m = makeMesh([coarse], { maxSplatsPerSwap: 25 });
    meshes.push(m);
    const inner = internals(m);
    inner.requestChunk = () => {};
    inner.cache.set(0, { data: makeChunk(40), bytes: 0, lastUsed: 0 });

    inner.reschedule(camera, 0);
    expect(inner.resident.size).toBe(0);
    expect(inner.staged.get(runKey(coarse))?.uploadedCount).toBe(25);

    inner.scene.source.computeDesiredRuns = () => [fine];
    inner.cache.set(1, { data: makeChunk(60), bytes: 0, lastUsed: 1 });

    inner.reschedule(camera, 1);
    inner.reschedule(camera, 2);
    expect(residentFiles(inner)).toEqual([]);
    expect(inner.resident.has(runKey(fine))).toBe(false);

    for (let tick = 3; tick <= 8; tick++) inner.reschedule(camera, tick);
    expect(residentFiles(inner)).toEqual([1]);
    expect(inner.activeCount).toBe(60);
    expect(inner.fetchCounts.retiredEarly).toBe(0);
  });

  it('refines past first paint once every deeper chunk is resident', () => {
    // Mirrors the live Part 6 stall: publish the coarse overview while later
    // chunks are still in flight, then land the whole capture and raise the
    // effective frontier. The presented cut must deepen — not stay stuck on
    // the first-paint overview forever.
    const overview = run({ file: 0, level: 4, count: 40, leafStart: 0, leafEnd: 40 });
    const mid = run({ file: 1, level: 3, count: 60, leafStart: 40, leafEnd: 100 });
    const fine = run({ file: 2, level: 2, count: 80, leafStart: 100, leafEnd: 180 });
    const stillFetching = run({
      file: 3,
      level: 1,
      count: 90,
      leafStart: 180,
      leafEnd: 270,
      fetchIntent: true,
    });

    const m = makeMesh([overview, stillFetching]);
    meshes.push(m);
    const inner = internals(m);
    inner.requestChunk = () => {};
    inner.cpuCacheBytes = Number.MAX_SAFE_INTEGER;
    inner.cache.set(0, { data: makeChunk(40), bytes: 0, lastUsed: 0 });

    inner.reschedule(camera, 0);
    expect(residentFiles(inner)).toEqual([0]);
    expect(inner.activeCount).toBe(40);

    // Deeper drawable content arrives while a speculative prefetch remains
    // outstanding — the same shape as a cold timeline marker whose capture is
    // still streaming after first paint.
    inner.scene.source.computeDesiredRuns = () => [mid, stillFetching];
    inner.cache.set(1, { data: makeChunk(60), bytes: 0, lastUsed: 1 });
    for (let tick = 1; tick <= 4; tick++) inner.reschedule(camera, tick);
    expect(residentFiles(inner)).toEqual([1]);
    expect(inner.activeCount).toBe(60);

    // Whole remaining capture becomes resident; frontier deepens past mid.
    inner.scene.source.computeDesiredRuns = () => [fine];
    inner.cache.set(2, { data: makeChunk(80), bytes: 0, lastUsed: 2 });
    for (let tick = 5; tick <= 10; tick++) inner.reschedule(camera, tick);
    expect(residentFiles(inner)).toEqual([2]);
    expect(inner.activeCount).toBe(80);
    expect(inner.fetchCounts.retiredEarly).toBe(0);
  });

  it('refines under pool pressure after first paint while a sibling is still fetching', () => {
    const overview = run({ file: 0, level: 4, count: 40, leafStart: 0, leafEnd: 40 });
    const readyChild = run({ file: 1, level: 3, count: 60, leafStart: 40, leafEnd: 100 });
    const lateSibling = run({ file: 2, level: 3, count: 60, leafStart: 100, leafEnd: 160 });

    const m = makeMesh([overview]);
    meshes.push(m);
    const inner = internals(m);
    inner.requestChunk = () => {};
    inner.cpuCacheBytes = Number.MAX_SAFE_INTEGER;
    inner.cache.set(0, { data: makeChunk(40), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera, 0);
    expect(residentFiles(inner)).toEqual([0]);
    expect(inner.activeCount).toBe(40);

    // One refined sibling is cached; the other is not. Force the pressure
    // valve so the staged sibling can publish instead of waiting forever.
    inner.scene.source.computeDesiredRuns = () => [readyChild, lateSibling];
    inner.cache.set(1, { data: makeChunk(60), bytes: 0, lastUsed: 1 });
    for (let tick = 1; tick <= 4; tick++) inner.reschedule(camera, tick);
    // Without pressure, Spark-style waits for the full drawable cut.
    expect(residentFiles(inner)).toEqual([0]);
    expect(inner.activeCount).toBe(40);

    inner.cpuCacheBytes = 1;
    inner.cacheBytesTotal = 2;
    for (let tick = 5; tick <= 10; tick++) inner.reschedule(camera, tick);
    expect(residentFiles(inner)).toContain(1);
    expect(inner.activeCount).toBeGreaterThanOrEqual(60);
  });

  it('commits a fully staged multi-file frontier when every group exceeds the append cap', () => {
    // Live captures emit ~40–60k-splat runs per chunk — each above the default
    // 32k append cap. After first paint the whole frontier can sit fully staged
    // while the oversized-group deferral refuses to commit if any upload lands
    // in the same tick. Once staging is complete, the next tick must publish.
    const overview = run({ file: 0, level: 8, count: 40_000, leafStart: 0, leafEnd: 40_000 });
    const refined = Array.from({ length: 8 }, (_, i) => {
      const start = i * 65_536;
      return run({
        file: i,
        level: 8 - i,
        count: 40_000,
        leafStart: start,
        leafEnd: start + 40_000,
      });
    });

    const m = makeMesh([overview], { maxSplatsPerSwap: 32_000, capacity: 8 * 65_536 });
    meshes.push(m);
    const inner = internals(m);
    inner.requestChunk = () => {};
    inner.cpuCacheBytes = Number.MAX_SAFE_INTEGER;
    inner.cache.set(0, { data: makeChunk(40_000), bytes: 0, lastUsed: 0 });

    // First paint the overview (may take two ticks under the append cap).
    for (let tick = 0; tick < 4; tick++) inner.reschedule(camera, tick);
    expect(residentFiles(inner)).toEqual([0]);
    expect(inner.activeCount).toBe(40_000);

    for (let i = 0; i < refined.length; i++) {
      inner.cache.set(i, { data: makeChunk(40_000), bytes: 0, lastUsed: i + 1 });
    }
    inner.scene.source.computeDesiredRuns = () => refined;

    // Stage across many ticks, then the cut must publish — not remain stuck on
    // the overview with a fully staged frontier sitting inactive.
    for (let tick = 10; tick < 80; tick++) inner.reschedule(camera, tick);
    expect(inner.activeCount).toBe(8 * 40_000);
    expect(residentFiles(inner).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(inner.fetchCounts.retiredEarly).toBe(0);
  });

  it('refines after first paint when RAD chunk levels exceed the old quality base of 32', () => {
    // Prefix `.rad` sets level = numChunks - chunkIndex. A 100+ chunk capture
    // therefore publishes overview level ≈ 103. The old fine metric used
    // `(32 - level)`, which goes deeply negative and scored every deeper,
    // larger cut as a regression — permanently freezing activeCount after
    // first paint even with the whole frontier staged and cached.
    //
    // With levelBase=32 this deeper cut scores worse than the overview
    // despite 5× the splat count; with a base that clears RAD levels it must
    // publish. Counts stay small so the assertion is about quality, not
    // append-cap staging.
    const overview = run({ file: 0, level: 103, count: 400, leafStart: 0, leafEnd: 400 });
    const deeper = Array.from({ length: 4 }, (_, i) => {
      const start = i * 500;
      return run({
        file: i,
        level: 100 - i * 10,
        count: 500,
        leafStart: start,
        leafEnd: start + 500,
      });
    });

    const m = makeMesh([overview], { capacity: 8 * WIDTH });
    meshes.push(m);
    const inner = internals(m);
    inner.requestChunk = () => {};
    inner.cpuCacheBytes = Number.MAX_SAFE_INTEGER;
    inner.cache.set(0, { data: makeChunk(400), bytes: 0, lastUsed: 0 });

    for (let tick = 0; tick < 3; tick++) inner.reschedule(camera, tick);
    expect(residentFiles(inner)).toEqual([0]);
    expect(inner.activeCount).toBe(400);

    for (let i = 0; i < deeper.length; i++) {
      inner.cache.set(i, { data: makeChunk(500), bytes: 0, lastUsed: i + 1 });
    }
    inner.scene.source.computeDesiredRuns = () => deeper;

    for (let tick = 3; tick < 20; tick++) inner.reschedule(camera, tick);
    expect(inner.activeCount).toBe(4 * 500);
    expect(residentFiles(inner).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(inner.fetchCounts.retiredEarly).toBe(0);
  });
});

function filesOverlap(inner: Internals, files: readonly number[]): boolean {
  const resident = new Set(residentFiles(inner));
  return files.filter((file) => resident.has(file)).length > 1;
}
