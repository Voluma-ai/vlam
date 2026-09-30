import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { buildLcc2Scene } from '../formats/lcc/lcc2';
import type { SplatDatasetSource } from '../streaming/dataset-source';

const OPTIONS = { budget: 1000, lodBaseDistance: 10, lodMultiplier: 2 };

function dataset(): SplatDatasetSource {
  return {
    manifestUrl: 'https://host/scene.lcc2',
    resolve: (path) => `https://host/${path}`,
    size: () => Promise.resolve(null),
    directoryFiles: () => null,
    dispose: () => {},
  };
}

/** Two root-child cells: one in front of a default camera, one far to +X. */
function twoChildManifest(): unknown {
  return {
    version: '0.0.2',
    totalLevels: 1,
    lodSplats: [20],
    root: {
      boundingBox: { min: [-1, -1, -9], max: [51, 1, -7] },
      splatFiles: ['near.sog', 'far.sog'],
      child: {
        '0': {
          boundingBox: { min: [-1, -1, -9], max: [1, 1, -7] },
          data: { '3dgs': { name: 0, start: 0, count: 10 } },
        },
        '1': {
          boundingBox: { min: [49, -1, -9], max: [51, 1, -7] },
          data: { '3dgs': { name: 1, start: 0, count: 10 } },
        },
      },
    },
  };
}

function frustumOf(camera: THREE.Camera): THREE.Frustum {
  camera.updateMatrixWorld(true);
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

describe('OctreeLodSource.coverageRunsFor', () => {
  it('returns only the in-view root child', () => {
    const scene = buildLcc2Scene(twoChildManifest(), dataset(), OPTIONS);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.updateMatrixWorld(true);

    const runs = scene.source.coverageRunsFor!(camera.position, frustumOf(camera));
    expect(runs.map((r) => r.file)).toEqual([0]);
    expect(runs[0]?.leafStart).toBe(0);
    expect(runs[0]?.leafEnd).toBe(1);
  });

  it('selects the other child when the camera looks at it', () => {
    const scene = buildLcc2Scene(twoChildManifest(), dataset(), OPTIONS);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(50, 0, 0);
    camera.lookAt(50, 0, -8);
    camera.updateMatrixWorld(true);

    const runs = scene.source.coverageRunsFor!(camera.position, frustumOf(camera));
    expect(runs.map((r) => r.file)).toEqual([1]);
  });

  it('falls back to the nearest cell when the frustum is empty', () => {
    const scene = buildLcc2Scene(twoChildManifest(), dataset(), OPTIONS);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.lookAt(0, 0, 10);
    camera.updateMatrixWorld(true);

    const runs = scene.source.coverageRunsFor!(camera.position, frustumOf(camera));
    expect(runs.map((r) => r.file)).toEqual([0]);
  });
});

describe('desktop LCC2 startup base coverage', () => {
  it.each([
    [true, 1000, 1, 20],
    [true, 30, 0, 10],
    [false, 1000, 0, 10],
  ] as const)(
    'selects a budgeted base without changing legacy coverage: %s/%s',
    (desktop, budget, file, count) => {
      const bounds = { min: [-1, -1, -9], max: [1, 1, -7] };
      const node = (depth: number): object => ({
        boundingBox: bounds,
        data: { '3dgs': { name: depth, start: 0, count: 10 * 2 ** depth } },
        ...(depth < 2 ? { child: { '0': node(depth + 1) } } : {}),
      });
      const scene = buildLcc2Scene(
        {
          version: '0.0.2',
          totalLevels: 3,
          lodSplats: [40, 20, 10],
          root: {
            boundingBox: bounds,
            splatFiles: ['coarse.sog', 'base.sog', 'fine.sog'],
            child: { '0': node(0) },
          },
        },
        dataset(),
        {
          ...OPTIONS,
          budget,
          ...(desktop ? { lcc2Policy: { quality: 'desktop' as const } } : {}),
        },
      );
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      const coverage = scene.source.coverageRunsFor!(camera.position, frustumOf(camera));
      expect(coverage.map((run) => [run.file, run.count, run.leafStart, run.leafEnd])).toEqual([
        [file, count, 0, 1],
      ]);
      expect(coverage.reduce((sum, run) => sum + run.count, 0)).toBeLessThanOrEqual(budget);
    },
  );
});

describe('OctreeLodSource budget fill', () => {
  it.each([true, false])('keeps oversized-refinement handling scoped to desktop: %s', (desktop) => {
    const bounds = (z: number) => ({ min: [-1, -1, z - 1], max: [1, 1, z + 1] });
    const branch = (file: number, z: number, fineCount: number) => ({
      boundingBox: bounds(z),
      data: { '3dgs': { name: file, start: 0, count: 10 } },
      child: {
        '0': {
          boundingBox: bounds(z),
          data: { '3dgs': { name: file + 2, start: 0, count: fineCount } },
        },
      },
    });
    const manifest = {
      version: '0.0.2',
      totalLevels: 2,
      lodSplats: [660, 20],
      root: {
        boundingBox: { min: [-1, -1, -9], max: [1, 1, -3] },
        splatFiles: ['near-coarse.sog', 'far-coarse.sog', 'near-fine.sog', 'far-fine.sog'],
        child: { '0': branch(0, -4, 600), '1': branch(1, -8, 60) },
      },
    };
    const scene = buildLcc2Scene(manifest, dataset(), {
      ...OPTIONS,
      budget: 100,
      ...(desktop ? { lcc2Policy: { quality: 'desktop' as const } } : {}),
    });
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    // Both branches want fine detail, but only the smaller far refinement fits.
    // Legacy distance selection must still stop at the oversized near candidate.
    const runs = scene.source.computeDesiredRuns(camera.position, frustumOf(camera), 1000);
    expect(runs.map((run) => run.file)).toEqual(desktop ? [0, 3] : [0, 1]);
    expect(runs.reduce((sum, run) => sum + run.count, 0)).toBe(desktop ? 70 : 20);
    expect(runs.map((run) => [run.leafStart, run.leafEnd])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });
});

describe('OctreeLodSource legacy fill threshold', () => {
  it.each([true, false])('keeps the 85% stop threshold without desktop policy: %s', (desktop) => {
    const bounds = { min: [-1, -1, -21], max: [1, 1, -20] };
    const child = Object.fromEntries(Array.from({ length: 10 }, (_, file) => [file, {
      boundingBox: bounds,
      data: { '3dgs': { name: file, start: 0, count: 85_000 } },
      child: { '0': {
        boundingBox: bounds,
        data: { '3dgs': { name: file + 10, start: 0, count: 100_000 } },
      } },
    }]));
    const scene = buildLcc2Scene({
      version: '0.0.2', totalLevels: 2, lodSplats: [1_000_000, 850_000],
      root: { boundingBox: bounds, splatFiles: Array.from({ length: 20 }, (_, file) => `${file}.sog`), child },
    }, dataset(), {
      ...OPTIONS, budget: 1_000_000,
      ...(desktop ? { lcc2Policy: { quality: 'desktop' as const } } : {}),
    });
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const runs = scene.source.computeDesiredRuns(camera.position, frustumOf(camera), 1000);
    expect(runs.reduce((sum, run) => sum + run.count, 0)).toBe(desktop ? 1_000_000 : 850_000);
    expect(runs.every((run) => run.level === (desktop ? 0 : 1))).toBe(true);
  });
});

describe('OctreeLodSource desktop quality policy', () => {
  it('normalizes depth and maps scene-scaled bands relative to the budget-derived base', () => {
    const files = Array.from({ length: 6 }, (_, i) => `${i}.sog`);
    const counts = [100, 150, 500, 600, 650, 700];
    const makeManifest = (distance: number) => {
      const bounds = { min: [-1, -1, -distance - 1], max: [1, 1, -distance] };
      const node = (depth: number): object => ({
        boundingBox: bounds,
        data: { '3dgs': { name: depth - 1, start: 0, count: counts[depth - 1] } },
        ...(depth < 6 ? { child: { '0': node(depth + 1) } } : {}),
      });
      return {
        version: '0.0.2',
        totalLevels: 6,
        lodSplats: [700],
        root: { boundingBox: bounds, splatFiles: files, child: { '0': node(1) } },
      };
    };
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    for (const [distance, depth] of [
      [30, 6],
      [40, 4],
      [90, 2],
    ]) {
      const scene = buildLcc2Scene(makeManifest(distance!), dataset(), {
        ...OPTIONS,
        budget: 800,
        lcc2Policy: { quality: 'desktop' },
      });
      const runs = scene.source.computeDesiredRuns(camera.position, frustumOf(camera), 1000);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.file).toBe(depth! - 1);
      expect(runs[0]?.level).toBe(6 - depth!);
    }
  });

  it('warms nearby off-screen detail during camera movement and expires the wider loading margin', () => {
    const bounds = { min: [20, -1, -7], max: [21, 1, -6] };
    const counts = [100, 150, 500, 600, 650, 700];
    const node = (depth: number): object => ({
      boundingBox: bounds,
      data: { '3dgs': { name: depth - 1, start: 0, count: counts[depth - 1] } },
      ...(depth < 6 ? { child: { '0': node(depth + 1) } } : {}),
    });
    const scene = buildLcc2Scene(
      {
        version: '0.0.2',
        totalLevels: 6,
        lodSplats: [700],
        root: {
          boundingBox: bounds,
          splatFiles: Array.from({ length: 6 }, (_, i) => `${i}.sog`),
          child: { '0': node(1) },
        },
      },
      dataset(),
      { ...OPTIONS, budget: 800, lcc2Policy: { quality: 'desktop' } },
    );
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const select = (time: number) =>
      scene.source.computeDesiredRuns(
        camera.position,
        frustumOf(camera),
        time,
        camera.getWorldDirection(new THREE.Vector3()),
      );
    expect(select(1000).map((run) => run.file)).toEqual([5]);
    expect(select(2400).map((run) => run.file)).toEqual([5]);
    // Expiry must invalidate the reused selection even inside its 500 ms dwell cache.
    expect(select(2550)[0]?.level).toBeGreaterThan(0);
    camera.position.x = 0.1;
    const upcoming = select(3100);
    expect(upcoming.map((run) => run.file)).toEqual([5]);
    expect(upcoming[0]?.inView).toBe(false);
    expect(upcoming.reduce((sum, run) => sum + run.count, 0)).toBeLessThanOrEqual(800);
    expect(select(4700)[0]?.level).toBeGreaterThan(0);
    // A turn widens loading too, even without translation or entering the view.
    camera.rotation.y = THREE.MathUtils.degToRad(2);
    const turning = select(5300);
    expect(turning.map((run) => run.file)).toEqual([5]);
    expect(turning[0]?.inView).toBe(false);
  });

  it('spends detail on a visible branch before a similarly near hidden branch', () => {
    const branch = (file: number, z: number) => ({
      boundingBox: { min: [-1, -1, z - 1], max: [1, 1, z + 1] },
      data: { '3dgs': { name: file, start: 0, count: 10 } },
      child: {
        '0': {
          boundingBox: { min: [-1, -1, z - 1], max: [1, 1, z + 1] },
          data: { '3dgs': { name: file + 2, start: 0, count: 80 } },
        },
      },
    });
    const scene = buildLcc2Scene(
      {
        version: '0.0.2',
        totalLevels: 2,
        lodSplats: [160, 20],
        root: {
          boundingBox: { min: [-1, -1, -11], max: [1, 1, 11] },
          splatFiles: ['front.sog', 'back.sog', 'front-fine.sog', 'back-fine.sog'],
          child: { '0': branch(0, -10), '1': branch(1, 10) },
        },
      },
      dataset(),
      {
        ...OPTIONS,
        budget: 100,
        lcc2Policy: { quality: 'desktop' },
      },
    );
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const runs = scene.source.computeDesiredRuns(
      camera.position,
      frustumOf(camera),
      1000,
      new THREE.Vector3(0, 0, -1),
    );
    expect(runs.map((run) => run.file)).toEqual([2, 1]);
    expect(runs.reduce((sum, run) => sum + run.count, 0)).toBe(90);
    expect(runs.map((run) => [run.leafStart, run.leafEnd])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });
});

describe('OctreeLodSource desktop pool capacity', () => {
  it.each([2048, 4096, Infinity])('accounts for every padded owner row: %s slots', (capacity) => {
    const bounds = { min: [-1, -1, -9], max: [1, 1, -7] };
    const scene = buildLcc2Scene({
      version: '0.0.2', totalLevels: 2, lodSplats: [2000, 300],
      root: { boundingBox: bounds, splatFiles: ['coarse.sog', 'fine.sog'], child: {
        '0': { boundingBox: bounds, data: { '3dgs': { name: 0, start: 0, count: 300 } }, child: {
          '0': { boundingBox: bounds, data: { '3dgs': { name: 1, start: 0, count: 1000 } } },
          '1': { boundingBox: bounds, data: { '3dgs': { name: 1, start: 1000, count: 1000 } } },
        } },
      } },
    }, dataset(), { ...OPTIONS, budget: 5000, lcc2Policy: { quality: 'desktop' } });
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const select = (time: number) => scene.source.computeDesiredRuns(camera.position, frustumOf(camera), time);
    expect(select(1000).map((run) => run.file)).toEqual([1, 1]);
    scene.source.setPoolCapacity!(capacity, 2048);
    // The capacity change invalidates the cached selection inside its dwell window.
    expect(select(1001).map((run) => run.file)).toEqual(capacity === 2048 ? [0] : [1, 1]);
    expect(scene.source.budget).toBe(5000);
  });
});

describe('OctreeLodSource intermediate publication', () => {
  it('refines a ready nearby child while a distant final child is still missing', () => {
    const box = { min: [-1, -1, -9], max: [3, 1, -7] };
    const branch = (offset: number, file: number) => ({
      boundingBox: box,
      data: { '3dgs': { name: 1, start: offset, count: 10 } },
      child: { '0': { boundingBox: box, data: { '3dgs': { name: file, start: 0, count: 10 } } } },
    });
    const manifest = {
      version: '0.0.2',
      totalLevels: 3,
      lodSplats: [20, 20, 10],
      root: {
        boundingBox: box,
        splatFiles: ['coarse.sog', 'middle.sog', 'near.sog', 'far.sog'],
        child: {
          '0': {
            boundingBox: box,
            data: { '3dgs': { name: 0, start: 0, count: 10 } },
            child: { '0': branch(0, 2), '1': branch(10, 3) },
          },
        },
      },
    };
    const scene = buildLcc2Scene(manifest, dataset(), {
      ...OPTIONS,
      lcc2Policy: { quality: 'desktop' },
    });
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const desired = scene.source.computeDesiredRuns(camera.position, frustumOf(camera), 1000);
    expect(desired.map((run) => run.file)).toEqual([2, 3]);
    const available = new Set([0]);
    const cut = () => scene.source.computeStreamingCut!(desired, (run) => available.has(run.file));
    expect(cut().runs.map((run) => run.file)).toEqual([0]);
    expect(cut().pending.map((run) => run.file)).toEqual([1, 1]);
    available.add(1);
    expect(cut().runs.map((run) => run.file)).toEqual([1, 1]);
    expect(cut().pending.map((run) => run.file)).toEqual([2, 3]);
    available.add(2);
    const mixed = cut();
    expect(mixed.runs.map((run) => run.file)).toEqual([2, 1]);
    expect(mixed.pending.map((run) => run.file)).toEqual([3]);
    expect(mixed.runs.map((run) => [run.leafStart, run.leafEnd])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    available.add(3);
    expect(cut().runs.map((run) => run.file)).toEqual([2, 3]);
    expect(cut().pending).toEqual([]);
  });
});
