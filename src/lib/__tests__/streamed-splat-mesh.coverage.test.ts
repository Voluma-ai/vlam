import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import type { SplatData } from '../core/splat-data';
import type { SplatRange } from '../core/splat-mesh';
import type { StreamedSplatMesh } from '../streaming/streamed-splat-mesh';
import type { LodRun } from '../streaming/lod-scheduler';
import type { StreamedScene } from '../streaming/lod-source';
import { buildSwapGroups, type ClassicFetchWant } from '../streaming/streamed-splat-mesh-utils';
import { createStreamedMeshFixture } from './helpers/streamed-mesh-fixture';

const ROW = 2048;
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.updateMatrixWorld(true);

beforeAll(() => {
  vi.stubGlobal(
    'Worker',
    class {
      postMessage(): void {}
      terminate(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    },
  );
});

function run(file: number, start: number, end: number, level = 0, count = 10): LodRun {
  return { file, offset: 0, count, level, leafStart: start, leafEnd: end };
}

function data(count: number): SplatData {
  return {
    count,
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4).fill(255),
    covariances: new Float32Array(count * 6),
  };
}

/** Keep synthetic cache and transaction inspection at one test-only boundary. */
type Internals = {
  cache: Map<number, { data: SplatData; bytes: number; lastUsed: number }>;
  resident: Map<string, { run: LodRun; handle: SplatRange }>;
  staged: Map<string, { run: LodRun; handle: SplatRange; uploadedCount: number }>;
  failedFiles: Set<number>;
  reschedule: (camera: THREE.PerspectiveCamera, now: number) => unknown;
  requestChunk: (file: number, kind: string, want?: ClassicFetchWant) => void;
  stageGroup: (
    group: ReturnType<typeof buildSwapGroups>[number],
    now: number,
    allowance: number,
  ) => number;
  appendRun: (run: LodRun, now: number) => void;
};

const meshes: StreamedSplatMesh[] = [];
afterEach(() => {
  for (const mesh of meshes.splice(0)) mesh.dispose();
});

function fixture(
  desired: LodRun[],
  coarse: LodRun[],
  options: { capacity?: number; cap?: number; kind?: 'file' | 'directory' } = {},
) {
  const capacity = options.capacity ?? ROW * 12;
  let wanted = desired;
  const scene: StreamedScene = {
    source: {
      budget: capacity,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => wanted,
      coarsestRunsFor: (start, end) => coarse.filter((r) => r.leafStart < end && r.leafEnd > start),
    },
    chunkKind: options.kind ?? 'file',
    chunkUrls: Array.from({ length: 12 }, (_, i) => `https://host/${i}.sog`),
    ...(options.kind === 'directory'
      ? {}
      : {
          chunkOptions: Array.from({ length: 12 }, () => ({ format: 'sog' as const })),
        }),
    bounds: new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10)),
    pinnedFiles: new Set(coarse.map((r) => r.file)),
    maxResidentSplats: capacity,
    minimumCoverageSplats: coarse.reduce((sum, r) => sum + r.count, 0),
  };
  const mesh = createStreamedMeshFixture(scene, capacity, capacity, {
    maxSplatsPerSwap: options.cap ?? 100_000,
    cpuCacheBytes: 1,
  });
  meshes.push(mesh);
  const inner = mesh as unknown as Internals;
  const requests: number[] = [];
  inner.requestChunk = (file) => {
    requests.push(file);
  };
  let now = 0;
  return {
    mesh,
    inner,
    requests,
    cache: (...runs: LodRun[]) => {
      for (const r of runs)
        inner.cache.set(r.file, { data: data(r.count), bytes: 0, lastUsed: now });
    },
    desired: (runs: LodRun[]) => {
      wanted = runs;
    },
    tick: () => {
      inner.reschedule(camera, (now += 100));
    },
    files: () => [...inner.resident.values()].map(({ run: r }) => r.file).sort((a, b) => a - b),
    coverage: (leaves: number) => {
      const counts = new Uint8Array(leaves);
      for (const { run: r } of inner.resident.values()) {
        for (let leaf = r.leafStart; leaf < r.leafEnd; leaf++)
          counts[leaf] = (counts[leaf] as number) + 1;
      }
      expect([...counts]).toEqual(Array<number>(leaves).fill(1));
    },
  };
}

describe('manifest streaming coverage', () => {
  it.each(['file', 'directory'] as const)(
    'publishes lower-detail cuts for %s scenes after retreat or budget reduction',
    (kind) => {
      const fine = run(1, 0, 2, 0, 100);
      const coarse = run(0, 0, 2, 3);
      const f = fixture([fine], [coarse], { kind });
      f.cache(fine, coarse);
      f.tick();
      expect(f.files()).toEqual([1]);
      f.mesh.setBudget(100);
      f.desired([coarse]);
      f.tick();
      expect(f.files()).toEqual([0]);
      f.coverage(2);
    },
  );

  it('refines a ready region while a distant sibling is still fetching', () => {
    const near = run(0, 0, 1, 2);
    const far = run(1, 1, 2, 2);
    const fineNear = run(2, 0, 1);
    const fineFar = run(3, 1, 2);
    const f = fixture([near, far], [near, far]);
    f.cache(near, far);
    f.tick();
    f.desired([fineNear, fineFar]);
    f.cache(fineNear);
    for (let i = 0; i < 40; i++) {
      f.tick();
      f.coverage(2);
    }
    expect(f.files()).toEqual([1, 2]);
    f.inner.failedFiles.add(3);
    f.tick();
    f.coverage(2);
    expect(f.files()).toEqual([1, 2]);
  });

  it('fetches missing coarse coverage before finest targets and retains it after a failed target', () => {
    const parent = run(0, 0, 2, 2);
    const left = run(1, 0, 1);
    const right = run(2, 1, 2);
    const f = fixture([left, right], [parent]);
    f.tick();
    expect(f.requests[0]).toBe(0);
    f.cache(parent, left);
    f.inner.failedFiles.add(right.file);
    f.tick();
    expect(f.files()).toEqual([0]);
    f.coverage(2);
  });

  it('rebuilds sibling transactions after installing a shared ancestor on a camera turn', () => {
    const parent = run(0, 0, 3, 2);
    const left = run(1, 0, 1);
    const middle = run(2, 1, 2);
    const right = run(3, 2, 3);
    const f = fixture([left], [parent]);
    f.cache(left, middle, parent);
    f.tick();
    f.desired([left, middle, right]);
    f.tick();
    expect(f.files()).toEqual([0]);
    f.coverage(3);
    f.cache(right);
    f.tick();
    expect(f.files()).toEqual([1, 2, 3]);
    f.coverage(3);
  });

  it('invalidates staged descendants when a fallback spans their interval', () => {
    const parent = run(0, 0, 2, 2);
    const left = run(1, 0, 1, 0, 100);
    const right = run(2, 1, 2);
    const f = fixture([left, right], [parent]);
    f.cache(left, parent);
    f.inner.stageGroup(buildSwapGroups([left], [])[0]!, 0, 1);
    expect(f.inner.staged.size).toBe(1);
    f.tick();
    expect(f.inner.staged.size).toBe(0);
    expect(f.files()).toEqual([0]);
    f.coverage(2);
  });

  it('keeps descendants intact when the row-aligned fallback cannot fit', () => {
    const parent = run(0, 0, 2, 2, ROW + 1);
    const left = run(1, 0, 1);
    const right = run(2, 1, 2);
    const other = run(3, 2, 3);
    const f = fixture([left, other], [parent, other], { capacity: ROW * 2 });
    f.cache(left, other, parent);
    f.tick();
    f.desired([left, right, other]);
    for (let i = 0; i < 40; i++) f.tick();
    expect(f.files()).toEqual([1, 3]);
    expect(f.mesh.fetchCounts.retiredEarly).toBe(0);
  });

  it('reuses completed GPU staging when a changed cut must swap without extra rows', () => {
    const parent = run(0, 0, 2, 2);
    const left = run(1, 0, 1, 0, 100);
    const right = run(2, 1, 2, 0, 100);
    const other = run(3, 2, 3);
    const f = fixture([parent, other], [parent, other], { capacity: ROW * 3, cap: 25 });
    f.cache(parent, other, left, right);
    f.tick();
    f.inner.stageGroup(buildSwapGroups([left], [])[0]!, 0, 100);
    f.inner.cache.delete(left.file);
    f.desired([left, right, other]);
    f.tick();
    expect(f.files()).toEqual([1, 2, 3]);
    expect(f.inner.staged.size).toBe(0);
    f.coverage(3);
  });

  it('reclaims partial staging for an atomic swap when the pool has no staging headroom', () => {
    const parent = run(0, 0, 2, 2);
    const left = run(1, 0, 1, 0, 100);
    const right = run(2, 1, 2, 0, 100);
    const other = run(3, 2, 3);
    const f = fixture([parent, other], [parent, other], { capacity: ROW * 3, cap: 25 });
    f.cache(parent, other, left, right);
    f.tick();
    f.inner.stageGroup(buildSwapGroups([left], [])[0]!, 0, 1);
    f.desired([left, right, other]);
    f.tick();
    expect(f.files()).toEqual([1, 2, 3]);
    expect(f.inner.staged.size).toBe(0);
    f.coverage(3);
  });

  it('commits staged siblings after their CPU chunks are evicted', () => {
    const parent = run(0, 0, 2, 2);
    const left = run(1, 0, 1, 0, 100);
    const right = run(2, 1, 2, 0, 100);
    const f = fixture([parent], [parent], { cap: 25 });
    f.cache(parent);
    f.tick();
    f.cache(left, right);
    f.desired([left, right]);
    for (let i = 0; i < 4; i++) {
      f.tick();
      f.coverage(2);
    }
    f.inner.cache.delete(left.file);
    f.requests.length = 0;
    for (let i = 0; i < 8; i++) {
      f.tick();
      f.coverage(2);
    }
    expect(f.files()).toEqual([1, 2]);
    expect(f.requests).not.toContain(left.file);
  });

  it('retains a parent during multi-tick staging and commits all siblings together', () => {
    const parent = run(0, 0, 2, 2);
    const left = run(1, 0, 1, 0, 100);
    const right = run(2, 1, 2, 0, 100);
    const f = fixture([parent], [parent], { cap: 25 });
    f.cache(parent);
    f.tick();
    f.cache(left, right);
    f.desired([left, right]);
    for (let i = 0; i < 12; i++) {
      f.tick();
      f.coverage(2);
    }
    expect(f.files()).toEqual([1, 2]);
  });
});
