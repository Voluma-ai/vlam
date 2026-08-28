import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { StreamedSplatMesh } from '../streaming/streamed-splat-mesh';
import { writeCovariance, type SplatData } from '../core/splat-data';
import { runKey, type LodRun } from '../streaming/lod-scheduler';

/**
 * Classic LCC progressive apply: a cell split into K sub-leaves applies each
 * slice independently - one target slice streams in while a sibling still
 * shows its prior coverage (or pinned coarse substitute for L1+).
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

/** Resolved L1 target over L2 coarse pins - progressive non-finest path. */
const TARGET: LodRun[] = [
  {
    file: 0,
    level: 1,
    offset: 0,
    count: 100,
    leafStart: 0,
    leafEnd: 1,
    distance: 15,
    coverageGroup: 9,
  },
  {
    file: 1,
    level: 1,
    offset: 0,
    count: 100,
    leafStart: 1,
    leafEnd: 2,
    distance: 15,
    coverageGroup: 9,
  },
];
const COARSE: LodRun[] = [
  {
    file: 2,
    level: 2,
    offset: 0,
    count: 50,
    leafStart: 0,
    leafEnd: 1,
    distance: 15,
    coverageGroup: 9,
  },
  {
    file: 3,
    level: 2,
    offset: 0,
    count: 50,
    leafStart: 1,
    leafEnd: 2,
    distance: 15,
    coverageGroup: 9,
  },
];

function makeMesh(desired: LodRun[] = TARGET): StreamedSplatMesh {
  const scene = {
    source: {
      budget: 4 * WIDTH,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => desired,
      coarsestRunsFor: (from: number, to: number) =>
        COARSE.filter((run) => run.leafStart >= from && run.leafEnd <= to),
    } as unknown,
    chunkUrls: [
      'https://host/data.bin#l1.0',
      'https://host/data.bin#l1.1',
      'https://host/data.bin#l2.0',
      'https://host/data.bin#l2.1',
    ],
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set<number>([2, 3]),
    maxResidentSplats: 4 * WIDTH,
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
  ) => StreamedSplatMesh;
  return new Ctor(scene, 4 * WIDTH, 4 * WIDTH, {});
}

type Internals = {
  cache: Map<number, { data: SplatData; bytes: number; lastUsed: number }>;
  reschedule: (camera: THREE.PerspectiveCamera, now: number) => unknown;
  activeCount: number;
  resident: Map<string, { run: LodRun }>;
};

function internals(mesh: StreamedSplatMesh): Internals {
  return mesh as unknown as Internals;
}

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.updateMatrixWorld(true);

describe('StreamedSplatMesh sub-chunk progressive apply (L1+)', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });

  it('applies a cached sub-leaf while its sibling defers on a coarse substitute', () => {
    const m = makeMesh();
    meshes.push(m);
    const inner = internals(m);
    inner.cache.set(2, { data: makeChunk(50), bytes: 0, lastUsed: 0 });
    inner.cache.set(3, { data: makeChunk(50), bytes: 0, lastUsed: 0 });
    inner.cache.set(0, { data: makeChunk(100), bytes: 0, lastUsed: 0 });

    inner.reschedule(camera, 0);

    // Leaf 0's L1 applied; leaf 1 still fetching → its L2 substitute renders.
    expect(inner.activeCount).toBe(100 + 50);
    expect(inner.resident.has(runKey(TARGET[0]!))).toBe(true);
    expect(inner.resident.has(runKey(COARSE[1]!))).toBe(true);
    expect(inner.resident.has(runKey(TARGET[1]!))).toBe(false);

    inner.cache.set(1, { data: makeChunk(100), bytes: 0, lastUsed: 1 });
    inner.reschedule(camera, 1);
    expect(inner.activeCount).toBe(200);
    expect(inner.resident.has(runKey(COARSE[1]!))).toBe(false);
    expect(inner.resident.has(runKey(TARGET[1]!))).toBe(true);
  });

  it('replacing one L1+ slice leaves its sibling coarse range resident', () => {
    const m = makeMesh();
    meshes.push(m);
    const inner = internals(m);
    inner.cache.set(2, { data: makeChunk(50), bytes: 0, lastUsed: 0 });
    inner.cache.set(3, { data: makeChunk(50), bytes: 0, lastUsed: 0 });
    // Neither target cached yet → both coarse substitutes.
    inner.reschedule(camera, 0);
    expect(inner.activeCount).toBe(100);
    expect(inner.resident.has(runKey(COARSE[0]!))).toBe(true);
    expect(inner.resident.has(runKey(COARSE[1]!))).toBe(true);

    inner.cache.set(0, { data: makeChunk(100), bytes: 0, lastUsed: 1 });
    inner.reschedule(camera, 1);
    expect(inner.resident.has(runKey(TARGET[0]!))).toBe(true);
    expect(inner.resident.has(runKey(COARSE[0]!))).toBe(false);
    expect(inner.resident.has(runKey(COARSE[1]!))).toBe(true);
    expect(inner.activeCount).toBe(150);
  });

  it('underfoot cell resolved to L1 uses progressive path', () => {
    // d=0 but resolved level is 1 - must paint per-slice coarse, not hold empty.
    const underfoot: LodRun[] = TARGET.map((run) => ({ ...run, distance: 0 }));
    const m = makeMesh(underfoot);
    meshes.push(m);
    const inner = internals(m);
    inner.cache.set(2, { data: makeChunk(50), bytes: 0, lastUsed: 0 });
    inner.cache.set(3, { data: makeChunk(50), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera, 0);
    expect(inner.activeCount).toBe(100);
    expect(inner.resident.size).toBe(2);
  });
});
