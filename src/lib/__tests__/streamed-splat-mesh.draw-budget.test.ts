import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { createStreamedMeshFixture } from './helpers/streamed-mesh-fixture';
import { SceneDrawBudget } from '../streaming/scene-draw-budget';
import {
  type StreamedSplatMesh,
  type StreamedSplatMeshOptions,
} from '../streaming/streamed-splat-mesh';
import { type SplatData } from '../core/splat-data';
import { type LodRun } from '../streaming/lod-scheduler';
import type { SceneDrawSource, SceneDrawReservation } from '../streaming/scene-draw-budget';

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

const meshes: StreamedSplatMesh[] = [];
afterEach(() => {
  for (const mesh of meshes) mesh.dispose();
  meshes.length = 0;
});
const data = (count: number): SplatData => ({
  count,
  positions: new Float32Array(count * 3),
  colors: new Uint8Array(count * 4).fill(255),
  covariances: new Float32Array(count * 6).fill(0.01),
});
const run = (file: number, count: number): LodRun => ({
  file,
  count,
  offset: 0,
  level: file === 0 ? 2 : 0,
  leafStart: 0,
  leafEnd: 1,
});
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
camera.updateMatrixWorld(true);

type Inner = {
  cache: Map<number, { data: SplatData; bytes: number; lastUsed: number }>;
  reschedule: (camera: THREE.Camera, now: number) => unknown;
  shouldReschedule: (camera: THREE.Camera, now: number) => boolean;
  pendingWork: boolean;
  lodCommitBlockedBySort: boolean;
};

function fixture(
  sceneBudget: SceneDrawBudget,
  format: 'lcc' | 'lcc2' | 'sog' | 'rad',
  options: StreamedSplatMeshOptions = {},
) {
  // Two independent RAD regions exercise whole-wave admission and restoration.
  const runs = (file: number, count: number) =>
    format === 'rad'
      ? [
          { ...run(file, count / 2), offset: 0, leafStart: 0, leafEnd: 1 },
          { ...run(file, count / 2), offset: count / 2, leafStart: 1, leafEnd: 2 },
        ]
      : [run(file, count)];
  let desired = runs(0, 400);
  const scene = {
    source: {
      budget: 1000,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => desired,
      coarsestRunsFor: () => runs(0, 400),
    },
    chunkUrls: ['https://host/coarse.bin', 'https://host/fine.bin'],
    chunkKind: 'file' as const,
    chunkOptions: format === 'rad' ? [{ format: 'rad-chunk' }, { format: 'rad-chunk' }] : undefined,
    bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: 1000,
  };
  const mesh = createStreamedMeshFixture(scene, 1000, 16384, {
    drawBudget: sceneBudget,
    initialReveal: 'progressive',
    ...options,
  });
  meshes.push(mesh);
  const inner = mesh as unknown as Inner;
  inner.cache.set(0, { data: data(400), bytes: 0, lastUsed: 0 });
  inner.cache.set(1, { data: data(650), bytes: 0, lastUsed: 0 });
  mesh.setDrawVisibility(true);
  return {
    mesh,
    tick: () => inner.reschedule(camera, 0),
    refine: () => {
      desired = runs(1, 650);
    },
  };
}

describe('complete streamed publication admission', () => {
  it('keeps settled selection through unchanged control-mode entry/exit, and wakes for movement or projection', () => {
    const budget = new SceneDrawBudget({ budget: 1000 });
    const a = fixture(budget, 'lcc2');
    budget.beginFrame();
    a.tick();
    const inner = a.mesh as unknown as Inner;
    inner.pendingWork = false;
    inner.lodCommitBlockedBySort = false;
    const unchanged = camera.clone();
    expect(inner.shouldReschedule(unchanged, 5000)).toBe(false);
    expect(inner.shouldReschedule(camera, 6000)).toBe(false);
    unchanged.position.x += 1;
    unchanged.updateMatrixWorld(true);
    expect(inner.shouldReschedule(unchanged, 6000)).toBe(true);
    unchanged.copy(camera);
    unchanged.fov += 1;
    unchanged.updateProjectionMatrix();
    expect(inner.shouldReschedule(unchanged, 6000)).toBe(true);
  });

  it.each(['position', 'rotation', 'scale', 'parent'] as const)(
    'reschedules settled LOD after a %s transform with a stationary camera',
    (change) => {
      const budget = new SceneDrawBudget({ budget: 1000 });
      const a = fixture(budget, 'lcc2');
      const parent = new THREE.Group();
      parent.add(a.mesh);
      a.mesh.updateWorldMatrix(true, false);
      budget.beginFrame();
      a.tick();
      const inner = a.mesh as unknown as Inner;
      inner.pendingWork = false;
      inner.lodCommitBlockedBySort = false;
      expect(inner.shouldReschedule(camera, 6000)).toBe(false);
      if (change === 'position') a.mesh.position.x = 100;
      if (change === 'rotation') a.mesh.rotation.y = 1;
      if (change === 'scale') a.mesh.scale.setScalar(2);
      if (change === 'parent') parent.position.x = 100;
      a.mesh.updateWorldMatrix(true, false);
      expect(inner.shouldReschedule(camera, 6000)).toBe(true);
      a.tick();
      inner.pendingWork = false;
      inner.lodCommitBlockedBySort = false;
      expect(inner.shouldReschedule(camera, 7000)).toBe(false);
    },
  );

  it('cancels admission before acknowledging a stale indexed worker publication', () => {
    const budget = new SceneDrawBudget({ budget: 10 });
    const scene = {
      source: { budget: 4 },
      chunkUrls: ['0'],
      chunkKind: 'file' as const,
      bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)),
      pinnedFiles: new Set<number>(),
      maxResidentSplats: 8,
      chunkSize: 4,
      foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 },
    };
    const mesh = createStreamedMeshFixture(
      scene,
      4,
      8,
      { foveationMode: 'page-table', drawBudget: budget },
      globalThis.Worker,
    );
    meshes.push(mesh);
    const inner = mesh as unknown as {
      sceneDrawSource: SceneDrawSource;
      drawReservation: SceneDrawReservation | null;
      indexedDisplayedSlots: Uint32Array;
      indexedPendingDisplaySlots: Uint32Array | null;
      indexedPublishGeneration: number | null;
      indexedPublishActiveListVersion: number | null;
      indexedPublishRevision: number | null;
      demandGeneration: number;
      pageTableDrawn: number;
      onActiveListRendered(version: number): void;
    };
    inner.sceneDrawSource.reserve(1)!.commit();
    inner.indexedDisplayedSlots = Uint32Array.of(0);
    inner.pageTableDrawn = 1;
    inner.indexedPendingDisplaySlots = Uint32Array.of(1, 2);
    inner.indexedPublishGeneration = 3;
    inner.indexedPublishActiveListVersion = 7;
    inner.indexedPublishRevision = inner.demandGeneration - 1;
    inner.drawReservation = inner.sceneDrawSource.reserve(2)!;
    inner.onActiveListRendered(7);
    expect(budget.activeUsage).toBe(1);
    expect(budget.reservedUsage).toBe(1);
    expect(inner.indexedPendingDisplaySlots).toBeNull();
    expect(inner.pageTableDrawn).toBe(1);
  });

  it.each(['lcc', 'lcc2', 'sog', 'rad'] as const)(
    'keeps both %s sources complete while simultaneous refinement waits',
    (format) => {
      const budget = new SceneDrawBudget({ budget: 1000, allowTemporaryExcess: false });
      const a = fixture(budget, format);
      const b = fixture(budget, format);
      for (let i = 0; i < 4; i++) {
        budget.beginFrame();
        a.tick();
        b.tick();
      }
      expect(a.mesh.activeSplatCount).toBe(400);
      expect(b.mesh.activeSplatCount).toBe(400);
      a.refine();
      b.refine();
      for (let i = 0; i < 4; i++) {
        budget.beginFrame();
        a.tick();
        b.tick();
      }
      // A whole replacement costs 650 + 400 = 1050; both keep the old cut.
      expect(a.mesh.activeSplatCount).toBe(400);
      expect(b.mesh.activeSplatCount).toBe(400);
      expect(budget.activeUsage).toBe(800);
      expect(a.mesh.capacity).toBe(16384);
      expect(b.mesh.capacity).toBe(16384);
    },
  );

  it.each(['lcc', 'rad'] as const)(
    'restores a complete retained %s cut at temporary expiry',
    (format) => {
      const budget = new SceneDrawBudget({ budget: 1000 });
      const a = fixture(budget, format);
      const b = fixture(budget, 'lcc2');
      for (let i = 0; i < 4; i++) {
        budget.beginFrame();
        a.tick();
        b.tick();
      }
      budget.beginFrame(500);
      a.refine();
      for (let i = 0; i < 4; i++) {
        budget.beginFrame();
        a.tick();
      }
      expect(a.mesh.activeSplatCount).toBe(650);
      expect(b.mesh.activeSplatCount).toBe(400);
      expect(budget.activeUsage).toBe(1050);
      budget.beginFrame(1000);
      expect(a.mesh.activeSplatCount).toBe(400);
      expect(b.mesh.activeSplatCount).toBe(400);
      expect(budget.activeUsage).toBe(800);
    },
  );

  it('preserves both source capacities when the activity budget drops', () => {
    const budget = new SceneDrawBudget({ budget: 1000 });
    const a = fixture(budget, 'lcc2');
    for (let i = 0; i < 4; i++) {
      budget.beginFrame();
      a.tick();
    }
    a.mesh.setBudget(850);
    expect(a.mesh.capacity).toBe(16384);
    expect(a.mesh.activeSplatCount).toBe(400);
    a.mesh.dispose();
    expect(budget.activeUsage).toBe(0);
  });
});
