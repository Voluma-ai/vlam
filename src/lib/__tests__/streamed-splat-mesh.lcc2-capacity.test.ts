import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { SceneDrawBudget } from '../streaming/scene-draw-budget';
import { StreamedSplatMesh } from '../streaming/streamed-splat-mesh';
import { buildLcc2Scene } from '../formats/lcc/lcc2';
import { writeCovariance, type SplatData } from '../core/splat-data';
import type { LodRun } from '../streaming/lod-scheduler';
import { createStreamedMeshFixture } from './helpers/streamed-mesh-fixture';

const WIDTH = 2048;
const BUDGET = 8 * WIDTH;
const CAPACITY = 12 * WIDTH;
const COARSE = WIDTH / 2;
const BASE = 3.5 * WIDTH;

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

function chunk(count: number): SplatData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

type Internals = {
  cache: Map<number, { data: SplatData; bytes: number; lastUsed: number }>;
  resident: Map<string, { run: LodRun }>;
  staged: Map<string, { run: LodRun; uploadedCount: number }>;
  frozenCriticalRuns: LodRun[] | null;
  initialRevealPhase: 'off' | 'capture' | 'holding' | 'released';
  pendingWork: boolean;
  requestChunk: (file: number, kind: string) => void;
  reschedule: (camera: THREE.Camera, now: number) => unknown;
};

let sharedAdmission = false;
const meshes: StreamedSplatMesh[] = [];
afterEach(() => {
  for (const mesh of meshes) mesh.dispose();
  meshes.length = 0;
  vi.restoreAllMocks();
});

function setup(
  options: {
    withEnv?: boolean;
    enabled?: boolean;
    desktop?: boolean;
    drawBudget?: SceneDrawBudget;
  } = {},
) {
  const bounds = { min: [-1, -1, -9], max: [1, 1, -7] };
  const node = (file: number, count: number) => ({
    boundingBox: bounds,
    data: { '3dgs': { name: file, start: 0, count } },
  });
  const scene = buildLcc2Scene(
    {
      version: '0.0.2',
      totalLevels: 3,
      lodSplats: [BUDGET, BASE, COARSE],
      root: {
        boundingBox: bounds,
        splatFiles: ['coarse.sog', 'base.sog', 'fine.sog', 'env.sog'],
        ...(options.withEnv === false ? {} : { data: { env: { name: 3 } } }),
        child: {
          '0': {
            ...node(0, COARSE),
            child: {
              '0': { ...node(1, BASE), child: { '0': node(2, BUDGET) } },
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
      budget: BUDGET,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      ...(options.desktop === false ? {} : { lcc2Policy: { quality: 'desktop' as const } }),
    },
  );
  const drawBudget =
    options.drawBudget ??
    (sharedAdmission
      ? new SceneDrawBudget({ budget: CAPACITY, allowTemporaryExcess: false })
      : undefined);
  const mesh = createStreamedMeshFixture(scene, BUDGET, CAPACITY, {
    initialReveal: 'hold-coverage',
    drawBudget,
    maxSplatsPerSwap: WIDTH,
    ...(options.enabled === undefined ? {} : { environmentEnabled: options.enabled }),
  });
  meshes.push(mesh);
  const inner = mesh as unknown as Internals;
  vi.spyOn(inner, 'requestChunk').mockImplementation(() => {});
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.updateMatrixWorld(true);
  const cache = (file: number, count: number) => {
    inner.cache.set(file, { data: chunk(count), bytes: 0, lastUsed: 0 });
  };
  cache(0, COARSE);
  cache(1, BASE);
  cache(2, BUDGET);
  return { mesh, inner, scene, camera, cache };
}

const slots = (runs: readonly LodRun[]) =>
  runs.reduce((sum, run) => sum + Math.ceil(run.count / WIDTH) * WIDTH, 0);

function settle(fixture: ReturnType<typeof setup>, from = 1000): void {
  // Base plus fine preparation needs twelve row uploads and publication ticks.
  for (let time = from; time < from + 24; time++) fixture.inner.reschedule(fixture.camera, time);
}

describe.each([false, true])(
  'desktop LCC2 environment capacity (shared admission: %s)',
  (shared) => {
    beforeAll(() => {
      sharedAdmission = shared;
    });
    it('falls back within the frozen region when the environment decodes after capture', () => {
      const f = setup();
      f.inner.reschedule(f.camera, 1000);
      expect(f.inner.initialRevealPhase).toBe('holding');
      expect(f.inner.frozenCriticalRuns?.map((run) => run.file)).toEqual([1]);
      expect(f.inner.staged.size).toBe(0);

      f.cache(3, 8.5 * WIDTH); // Nine reserved rows leave three rows for LOD.
      f.inner.reschedule(f.camera, 1001);
      expect(f.mesh.initialRevealState.status).toBe('ready');
      expect([...f.inner.resident.values()].map(({ run }) => run.file)).toEqual([0]);
      expect(f.mesh.environmentSplatCount).toBe(8.5 * WIDTH);
      settle(f, 1002);
      expect(slots(f.scene.source.lcc2QualityState!.desired)).toBeLessThanOrEqual(3 * WIDTH);
      expect([...f.inner.resident.values()].map(({ run }) => run.file)).toEqual([0]);
      expect(f.inner.pendingWork).toBe(false);
      expect(f.mesh.budget).toBe(BUDGET);
      expect(f.scene.source.budget).toBe(BUDGET);
    });

    it('fits recaptured coverage beside a hidden but still resident environment', () => {
      const f = setup();
      f.cache(3, 8.5 * WIDTH);
      settle(f);
      f.mesh.setEnvironmentEnabled(false);
      f.inner.cache.delete(3); // Resident row ownership survives CPU eviction and hiding.
      f.mesh.recaptureInitialReveal();
      settle(f, 2000);
      expect(f.mesh.initialRevealState.status).toBe('ready');
      expect(slots(f.scene.source.lcc2QualityState!.desired)).toBeLessThanOrEqual(3 * WIDTH);
      expect([...f.inner.resident.values()].map(({ run }) => run.file)).toEqual([0]);
      expect(f.mesh.environmentSplatCount).toBe(8.5 * WIDTH);
      expect(f.mesh.environmentEnabled).toBe(false);
      expect(f.mesh.budget).toBe(BUDGET);
      expect(f.inner.pendingWork).toBe(false);
    });

    it('publishes fine detail atomically when it fits after retiring its old cover', () => {
      const f = setup();
      f.cache(3, 4 * WIDTH); // Final detail fills the eight remaining rows exactly.
      settle(f);
      expect(f.mesh.initialRevealState.status).toBe('ready');
      expect([...f.inner.resident.values()].map(({ run }) => run.file)).toEqual([2]);
      expect(f.mesh.activeSplatCount).toBe(BUDGET + 4 * WIDTH);
      expect(f.inner.staged.size).toBe(0);
      expect(f.inner.pendingWork).toBe(false);
    });

    it.each([{ withEnv: false }, { enabled: false }, { withEnv: true }])(
      'preserves detail with absent, disabled or small environments: %j',
      (options) => {
        const f = setup(options);
        f.cache(3, options.enabled === false ? 8.5 * WIDTH : WIDTH);
        settle(f);
        expect(f.mesh.initialRevealState.status).toBe('ready');
        expect(f.scene.source.lcc2QualityState!.desired.map((run) => run.file)).toEqual([2]);
        expect([...f.inner.resident.values()].map(({ run }) => run.file)).toEqual([2]);
        expect(f.mesh.budget).toBe(BUDGET);
        expect(f.scene.source.budget).toBe(BUDGET);
      },
    );

    it.runIf(shared)(
      'retains complete old coverage when a storage-reusing swap exceeds draw admission',
      () => {
        const drawBudget = new SceneDrawBudget({ budget: 5 * WIDTH, allowTemporaryExcess: false });
        const f = setup({ drawBudget });
        f.cache(3, WIDTH);
        settle(f);
        expect([...f.inner.resident.values()].map(({ run }) => run.file)).toEqual([1]);
        expect(f.mesh.activeSplatCount).toBe(BASE + WIDTH);
        expect(drawBudget.activeUsage).toBe(BASE + WIDTH);
        expect(f.inner.pendingWork).toBe(true);

        // Once the scene has room, replacement reuses the old rows without
        // publishing both cuts or increasing the fixed texture pool.
        drawBudget.setBudget(CAPACITY);
        drawBudget.beginFrame();
        settle(f, 2000);
        expect([...f.inner.resident.values()].map(({ run }) => run.file)).toEqual([2]);
        expect(drawBudget.activeUsage).toBe(BUDGET + WIDTH);
        expect(f.mesh.activeSplatCount).toBe(drawBudget.activeUsage);
        expect(f.mesh.capacity).toBe(CAPACITY);
        expect(f.inner.pendingWork).toBe(false);
      },
    );

    it.runIf(shared)(
      'defers a storage-reusing swap when the shared staging slice is exhausted',
      () => {
        const drawBudget = new SceneDrawBudget({ budget: CAPACITY, allowTemporaryExcess: false });
        const f = setup({ drawBudget });
        f.cache(3, WIDTH);
        const fine = f.inner.cache.get(2)!;
        f.inner.cache.delete(2);
        settle(f);
        expect([...f.inner.resident.values()].map(({ run }) => run.file)).toEqual([1]);
        f.inner.cache.set(2, fine);
        const other = drawBudget.register({ limit: CAPACITY });
        drawBudget.beginFrame();
        other.chargeStaging(3);
        settle(f, 2000);
        expect([...f.inner.resident.values()].map(({ run }) => run.file)).toEqual([1]);
        expect(f.mesh.activeSplatCount).toBe(BASE + WIDTH);
        drawBudget.beginFrame();
        settle(f, 3000);
        expect([...f.inner.resident.values()].map(({ run }) => run.file)).toEqual([2]);
        expect(f.inner.pendingWork).toBe(false);
        other.dispose();
      },
    );

    it('skips an environment that fits alone but cannot coexist with minimum main coverage', () => {
      const f = setup();
      f.cache(3, CAPACITY);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      settle(f);
      expect(f.mesh.initialRevealState.status).toBe('ready');
      expect(f.mesh.environmentSplatCount).toBe(0);
      expect([...f.inner.resident.values()].map(({ run }) => run.file)).toEqual([2]);
      expect(warning).toHaveBeenCalled();
      expect(f.inner.pendingWork).toBe(false);
    });
  },
);
