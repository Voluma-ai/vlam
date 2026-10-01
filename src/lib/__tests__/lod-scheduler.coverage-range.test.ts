import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { LodScheduler } from '../streaming/lod-scheduler';
import type { LodManifest } from '../streaming/lod-manifest';
import { SceneDrawBudget } from '../streaming/scene-draw-budget';
import { createStreamedMeshFixture } from './helpers/streamed-mesh-fixture';

beforeAll(() => {
  globalThis.Worker ??= class {
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
    onmessage = null;
    onerror = null;
  } as unknown as typeof Worker;
});

function manifest(leafCount = 3): LodManifest {
  const bounds = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
  return {
    leaves: Array.from({ length: leafCount }, (_, index) => ({
      bounds,
      lods: [
        { file: 0, offset: index * 100, count: 100 },
        { file: 1, offset: index * 10, count: 10 },
      ],
    })),
    chunkUrls: ['https://host/fine.bin', 'https://host/coarse.bin'],
    counts: [leafCount * 100, leafCount * 10],
    lodLevels: 2,
    bounds,
  };
}

describe('flat-source coarsest coverage ranges', () => {
  it('returns every leaf exactly once for a whole-scene coverage-floor query', () => {
    const source = new LodScheduler(manifest(), {
      budget: 1000,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });
    expect(source.coarsestRunsFor(0, Number.MAX_SAFE_INTEGER)).toEqual([
      expect.objectContaining({
        file: 1,
        level: 1,
        offset: 0,
        count: 30,
        leafStart: 0,
        leafEnd: 3,
      }),
    ]);
  });

  it('intersects partially overlapping ranges with the manifest', () => {
    const source = new LodScheduler(manifest(), {
      budget: 1000,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });
    expect(source.coarsestRunsFor(-2, 2)).toEqual([
      expect.objectContaining({ level: 1, offset: 0, count: 20, leafStart: 0, leafEnd: 2 }),
    ]);
    expect(source.coarsestRunsFor(1, Number.MAX_SAFE_INTEGER)).toEqual([
      expect.objectContaining({ level: 1, offset: 10, count: 20, leafStart: 1, leafEnd: 3 }),
    ]);
  });

  it('returns no runs for empty, reversed, or disjoint ranges', () => {
    const source = new LodScheduler(manifest(), {
      budget: 1000,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });
    for (const [from, to] of [
      [0, 0],
      [2, 1],
      [3, Number.MAX_SAFE_INTEGER],
      [-2, 0],
    ] as const) {
      expect(source.coarsestRunsFor(from, to)).toEqual([]);
    }
    const empty = new LodScheduler(manifest(0), {
      budget: 1000,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });
    expect(empty.coarsestRunsFor(0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('constructs a streamed flat-source mesh with shared draw-budget coverage', () => {
    const input = manifest();
    const mesh = createStreamedMeshFixture(
      {
        source: new LodScheduler(input, { budget: 1000, lodBaseDistance: 10, lodMultiplier: 2 }),
        chunkUrls: input.chunkUrls,
        chunkKind: 'file',
        bounds: input.bounds,
        pinnedFiles: new Set<number>(),
        maxResidentSplats: 1000,
      },
      1000,
      16384,
      { drawBudget: new SceneDrawBudget({ budget: 1000 }) },
    );
    try {
      expect(mesh.minimumDrawCoverage).toBe(30);
    } finally {
      mesh.dispose();
    }
  });
});
