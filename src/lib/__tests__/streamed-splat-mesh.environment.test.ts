import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { StreamedSplatMesh, type StreamedSplatMeshOptions } from '../streamed-splat-mesh';
import { writeCovariance, type SplatData } from '../splat-data';

const WIDTH = 2048;

// StreamedSplatMesh spins up a ChunkLoader Web Worker on construction; these
// tests seed the CPU cache directly and never fetch, so a no-op stub suffices.
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

/**
 * Builds a StreamedSplatMesh over a stub scene that ships an environment tile
 * (chunk file 0). `computeDesiredRuns` returns no LOD runs, so the only thing
 * that ever becomes resident is the env tile.
 */
function makeEnvMesh(options: StreamedSplatMeshOptions = {}, withEnv = true): StreamedSplatMesh {
  const scene = {
    source: {
      budget: 4 * WIDTH,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => [],
      coarsestRunsFor: () => [],
    } as unknown,
    chunkUrls: ['https://host/env.sog'],
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set<number>(withEnv ? [0] : []),
    maxResidentSplats: 4 * WIDTH,
    ...(withEnv ? { environment: { file: 0 } } : {}),
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
  ) => StreamedSplatMesh;
  return new Ctor(scene, 4 * WIDTH, 4 * WIDTH, options);
}

type Internals = {
  cache: Map<number, { data: SplatData; bytes: number; lastUsed: number }>;
  reschedule: (camera: THREE.PerspectiveCamera, now: number) => unknown;
  activeCount: number;
};

function internals(mesh: StreamedSplatMesh): Internals {
  return mesh as unknown as Internals;
}

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.updateMatrixWorld(true);

describe('StreamedSplatMesh environment tile (M12)', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });
  function mesh(options: StreamedSplatMeshOptions = {}, withEnv = true): StreamedSplatMesh {
    const m = makeEnvMesh(options, withEnv);
    meshes.push(m);
    return m;
  }

  it('reports whether the scene ships an environment tile', () => {
    expect(mesh().hasEnvironment).toBe(true);
    expect(mesh({}, false).hasEnvironment).toBe(false);
  });

  it('loads the env tile whole and measures its count at decode', () => {
    const m = mesh();
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(1234), bytes: 0, lastUsed: 0 });

    // No count is known before it loads.
    expect(m.environmentSplatCount).toBe(0);
    inner.reschedule(camera, 0);

    expect(m.environmentSplatCount).toBe(1234);
    expect(inner.activeCount).toBe(1234);
    expect(m.environmentEnabled).toBe(true);
  });

  it('toggles visibility live without refetching, keeping the pool range', () => {
    const m = mesh();
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(500), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera, 0);
    expect(inner.activeCount).toBe(500);

    m.setEnvironmentEnabled(false);
    expect(m.environmentEnabled).toBe(false);
    expect(inner.activeCount).toBe(0);
    // Still measured (still pool-resident), just hidden.
    expect(m.environmentSplatCount).toBe(500);

    // Re-enable: evict the CPU chunk first to prove no refetch/re-decode.
    inner.cache.delete(0);
    m.setEnvironmentEnabled(true);
    expect(inner.activeCount).toBe(500);
  });

  it('does not load the env tile when it starts disabled', () => {
    const m = mesh({ environmentEnabled: false });
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(500), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera, 0);

    expect(inner.activeCount).toBe(0);
    expect(m.environmentEnabled).toBe(false);
    expect(m.environmentSplatCount).toBe(0);

    // Enabling loads it from the still-cached chunk on the next reschedule.
    m.setEnvironmentEnabled(true);
    inner.reschedule(camera, 1);
    expect(inner.activeCount).toBe(500);
  });

  it('gives up once, without compacting per tick, on an env larger than the pool', () => {
    // The env sits outside the LOD budget, in headroom nothing guarantees is
    // free. An env that can never fit must not retry through a full-pool
    // compact() every reschedule (a permanent livelock); it warns once and
    // stops.
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: string) => warnings.push(String(message));
    try {
      const m = mesh();
      const inner = internals(m);
      const compactions = (): number =>
        (m as unknown as { compactionCount: number }).compactionCount;
      // Pool capacity is 4 rows; ask for 5 rows of env splats.
      inner.cache.set(0, { data: makeChunk(5 * WIDTH), bytes: 0, lastUsed: 0 });

      inner.reschedule(camera, 0);
      inner.reschedule(camera, 1);
      inner.reschedule(camera, 2);

      expect(inner.activeCount).toBe(0);
      expect(compactions()).toBe(0); // never tried to compact its way in
      expect(warnings.filter((w) => w.includes('environment tile'))).toHaveLength(1);
    } finally {
      console.warn = original;
    }
  });

  it('ignores env controls on a scene without an environment tile', () => {
    const m = mesh({}, false);
    expect(() => m.setEnvironmentEnabled(false)).not.toThrow();
    expect(m.environmentEnabled).toBe(true); // unchanged: no tile to hide
    expect(m.environmentSplatCount).toBe(0);
  });
});
