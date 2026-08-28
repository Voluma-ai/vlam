import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { RadLodSource } from '../formats/rad/rad';
import type { LodRun } from '../streaming/lod-scheduler';
import type { SplatData } from '../core/splat-data';

const CAMERA = new THREE.Vector3();
const FRUSTUM = new THREE.Frustum();

/** A chunk's `SplatData` carrying only the tree columns the source reads. */
function chunkData(childCount: number[], childStart: number[]): SplatData {
  const count = childCount.length;
  return {
    count,
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4),
    covariances: new Float32Array(count * 6),
    radTree: {
      childCount: Uint16Array.from(childCount),
      childStart: Uint32Array.from(childStart),
      size: new Float32Array(count),
    },
  };
}

/**
 * A 3-chunk tree (chunkSize 4, 12 splats). Internal nodes: g0→[4,6), g1→[6,8),
 * g6→[8,10). The other 9 splats are leaves, so the fully-refined frontier is
 * the 9 leaves.
 */
function buildTree(): { source: RadLodSource; chunks: SplatData[] } {
  const chunks = [
    chunkData([2, 2, 0, 0], [4, 6, 0, 0]),
    chunkData([0, 0, 2, 0], [0, 0, 8, 0]),
    chunkData([0, 0, 0, 0], [0, 0, 0, 0]),
  ];
  const source = new RadLodSource(12, 4, [4, 4, 4], {
    budget: 100,
    lodBaseDistance: 10,
    lodMultiplier: 2,
  });
  return { source, chunks };
}

function drawnCount(runs: readonly LodRun[]): number {
  return runs.reduce((sum, r) => sum + r.count, 0);
}

function frontierRunsOnly(runs: readonly LodRun[], decodedChunks: number): LodRun[] {
  return runs.filter((r) => r.file < decodedChunks);
}

describe('RadLodSource', () => {
  it('draws chunk 0 as the whole coarse scene when only it is decoded', () => {
    const { source, chunks } = buildTree();
    source.onChunkDecoded(0, chunks[0]!);

    const runs = source.computeDesiredRuns(CAMERA, FRUSTUM, 0);
    expect(drawnCount(frontierRunsOnly(runs, 1))).toBe(4);
    expect(runs.some((r) => r.file === 1)).toBe(true);
    expect(runs.some((r) => r.file === 2)).toBe(true);
  });

  it('hides parents and reveals children as chunks decode', () => {
    const { source, chunks } = buildTree();
    source.onChunkDecoded(0, chunks[0]!);
    source.onChunkDecoded(1, chunks[1]!);

    const runs = source.computeDesiredRuns(CAMERA, FRUSTUM, 0);
    expect(drawnCount(frontierRunsOnly(runs, 2))).toBe(6);
    expect(runs.every((r) => r.file !== 0 || r.leafStart >= 2)).toBe(true);
  });

  it('converges to exactly the leaves once every chunk is decoded', () => {
    const { source, chunks } = buildTree();
    chunks.forEach((data, file) => source.onChunkDecoded(file, data));

    const runs = source.computeDesiredRuns(CAMERA, FRUSTUM, 0);
    expect(drawnCount(runs)).toBe(9); // the 9 leaves
    expect(runs.every((r) => r.file < 3)).toBe(true);
  });

  it('coarsens the rendered prefix to fit a reduced budget', () => {
    const { source, chunks } = buildTree();
    chunks.forEach((data, file) => source.onChunkDecoded(file, data));

    source.budget = 5; // depth-2 frontier is 6, depth-1 is 4 → render depth 1
    const runs = source.computeDesiredRuns(CAMERA, FRUSTUM, 0);
    expect(drawnCount(runs)).toBe(4);
  });

  describe('frontier cache', () => {
    /** Counts the frontier walks a call actually performs. */
    function countingSource() {
      const { source, chunks } = buildTree();
      for (let c = 0; c < chunks.length; c++) source.onChunkDecoded(c, chunks[c]!);
      // `frontierRuns` is private, so reach it structurally: shim a layer
      // between the instance and its prototype rather than typing through it.
      type Walker = { frontierRuns: (depth: number, resident: number) => LodRun[] };
      const proto = Object.getPrototypeOf(source) as Walker;
      const original = proto.frontierRuns;
      let walks = 0;
      const instrumented = Object.create(proto) as Walker;
      instrumented.frontierRuns = function (this: unknown, depth: number, resident: number) {
        walks++;
        return original.call(this, depth, resident);
      };
      Object.setPrototypeOf(source, instrumented);
      return { source, walks: () => walks };
    }

    it('does not re-walk the tree when the budget drifts within one depth band', () => {
      // A camera-weighted governor rewrites the budget every frame. The chosen
      // depth is unchanged across small moves, so the walk must not repeat.
      const { source, walks } = countingSource();
      source.budget = 9;
      source.computeDesiredRuns(CAMERA, FRUSTUM, 0);
      const afterFirst = walks();
      expect(afterFirst).toBeGreaterThan(0);

      const baseline = source.computeDesiredRuns(CAMERA, FRUSTUM, 0);
      for (const budget of [9, 10, 11, 20, 50, 9]) {
        source.budget = budget;
        expect(source.computeDesiredRuns(CAMERA, FRUSTUM, 0)).toEqual(baseline);
      }
      expect(walks()).toBe(afterFirst);
    });

    it('still re-walks when the budget crosses out of the band', () => {
      // Correctness half: the cache must not pin a frontier the budget can no
      // longer afford.
      const { source, walks } = countingSource();
      source.budget = 100;
      const fine = source.computeDesiredRuns(CAMERA, FRUSTUM, 0);
      const afterFine = walks();

      source.budget = 1; // far below the finest frontier: must coarsen
      const coarse = source.computeDesiredRuns(CAMERA, FRUSTUM, 0);
      expect(walks()).toBeGreaterThan(afterFine);
      expect(drawnCount(coarse)).toBeLessThan(drawnCount(fine));

      source.budget = 100; // and back again
      expect(source.computeDesiredRuns(CAMERA, FRUSTUM, 0)).toEqual(fine);
    });

    it('re-walks when discovery advances even if the budget is unchanged', () => {
      const { source, chunks } = buildTree();
      source.budget = 100;
      source.onChunkDecoded(0, chunks[0]!);
      const shallow = drawnCount(
        frontierRunsOnly(source.computeDesiredRuns(CAMERA, FRUSTUM, 0), 1),
      );
      source.onChunkDecoded(1, chunks[1]!);
      const deeper = drawnCount(frontierRunsOnly(source.computeDesiredRuns(CAMERA, FRUSTUM, 0), 2));
      expect(deeper).toBeGreaterThan(shallow);
    });
  });

  it('reports whole-scene coverage from chunk 0 for substitutes', () => {
    const { source, chunks } = buildTree();
    source.onChunkDecoded(0, chunks[0]!);

    expect(source.coverageSplatCount).toBe(4);
    expect(source.coarsestRunsFor(0, 4).length).toBeGreaterThan(0);
    expect(source.coarsestRunsFor(8, 12)).toEqual([]);
  });
});
