import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { StreamedSplatMesh } from '../streamed-splat-mesh';
import { writeCovariance, type SplatData } from '../splat-data';

/**
 * M9 spatial queries on a StreamedSplatMesh: the query searches only the
 * resident (pool) splats, so a decoded-but-not-appended chunk is invisible to
 * it - the documented resident-only semantics.
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

/** A chunk of splats laid on the x axis at (i, 0, 0). */
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

function makeStreamedMesh(): StreamedSplatMesh {
  const scene = {
    source: { budget: 4 * WIDTH } as unknown,
    chunkUrls: [] as string[],
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set<number>(),
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
  appendRun: (run: unknown, now: number) => void;
};
function internals(mesh: StreamedSplatMesh): Internals {
  return mesh as unknown as Internals;
}
function run(file: number, offset: number, count: number): Record<string, number> {
  return { file, offset, count, leafStart: file, leafEnd: file + 1, level: 0 };
}

describe('StreamedSplatMesh spatial queries (M9)', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });
  function mesh(): StreamedSplatMesh {
    const m = makeStreamedMesh();
    meshes.push(m);
    return m;
  }

  it('searches only resident splats, not merely-cached chunks', () => {
    const m = mesh();
    const inner = internals(m);
    // Two chunks decoded on the CPU; only chunk 0 is made resident.
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.cache.set(1, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.appendRun(run(0, 0, 10), 0); // splats at x = 0..9 resident

    // Nearest to x=5 is the resident splat at x=5.
    const hit = m.queryNearest(new THREE.Vector3(5, 0, 0), 3);
    expect(hit!.point.toArray()).toEqual([5, 0, 0]);

    // A point far past the resident run has no resident splat within radius,
    // even though chunk 1 (also x=0..9) sits decoded in the cache.
    expect(m.queryNearest(new THREE.Vector3(50, 0, 0), 3)).toBeNull();
  });

  it('returns null cleanly before anything is resident (empty active list)', () => {
    const m = mesh();
    expect(m.queryNearest(new THREE.Vector3(5, 0, 0), 100)).toBeNull();
    expect(m.queryHeight(new THREE.Vector3(5, 10, 0), 100)).toBeNull();
  });

  it('answers queries in world space when the streamed mesh is transformed', () => {
    const m = mesh();
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(3), bytes: 0, lastUsed: 0 });
    inner.appendRun(run(0, 0, 3), 0); // local x = 0, 1, 2
    m.position.set(0, 0, 10);
    m.rotation.y = Math.PI; // local +x → world −x
    m.updateMatrixWorld(true);

    const hit = m.queryNearest(new THREE.Vector3(-2, 0, 10), 0.5);
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(-2, 5);
    expect(hit!.point.z).toBeCloseTo(10, 5);
  });

  it('sees splats added as more of the scene streams in', () => {
    const m = mesh();
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(4), bytes: 0, lastUsed: 0 });
    inner.appendRun(run(0, 0, 4), 0); // x = 0..3

    expect(m.queryNearest(new THREE.Vector3(9, 0, 0), 2)).toBeNull();
    // A second run streams in near x=9 (offset picks splats within the chunk).
    inner.cache.set(1, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.appendRun(run(1, 8, 2), 1); // x = 8, 9
    expect(m.queryNearest(new THREE.Vector3(9, 0, 0), 2)!.point.toArray()).toEqual([9, 0, 0]);
  });
});
