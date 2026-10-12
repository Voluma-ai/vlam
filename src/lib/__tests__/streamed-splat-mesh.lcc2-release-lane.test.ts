import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { StreamedSplatMesh } from '../streaming/streamed-splat-mesh';
import { buildLcc2Scene } from '../formats/lcc/lcc2';
import { writeCovariance, type SplatData } from '../core/splat-data';
import type { LodRun } from '../streaming/lod-scheduler';
import { createStreamedMeshFixture } from './helpers/streamed-mesh-fixture';

const WIDTH = 2048;
// Two regions on either side of the origin. Each is one coarse node over one
// finest cell; the region behind the start pose (B) has twice the fine detail.
const COARSE = WIDTH / 2;
const FINE_A = 2 * WIDTH;
const FINE_B = 4 * WIDTH;
// Room for B fine + A coarse while settling the first pose...
const START_BUDGET = 6 * WIDTH;
// ...then a budget that fits only the turned cut (A fine + B coarse).
const TURNED_BUDGET = 3 * WIDTH;
const CAPACITY = 16 * WIDTH;
// One in-view refinement fills a tick's append cap on its own.
const APPEND_CAP = FINE_A;

const FILE = { coarseA: 0, fineA: 1, coarseB: 2, fineB: 3 } as const;

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
  initialRevealPhase: 'off' | 'capture' | 'holding' | 'released';
  requestChunk: (file: number, kind: string) => void;
  reschedule: (camera: THREE.Camera, now: number) => unknown;
};

const meshes: StreamedSplatMesh[] = [];
afterEach(() => {
  for (const mesh of meshes) mesh.dispose();
  meshes.length = 0;
  vi.restoreAllMocks();
});

function setup() {
  const box = (z: number) => ({ min: [-1, -1, z - 1], max: [1, 1, z + 1] });
  const region = (z: number, coarse: number, fine: number, count: number) => ({
    boundingBox: box(z),
    data: { '3dgs': { name: coarse, start: 0, count: COARSE } },
    child: {
      '0': { boundingBox: box(z), data: { '3dgs': { name: fine, start: 0, count } } },
    },
  });
  const scene = buildLcc2Scene(
    {
      version: '0.0.2',
      totalLevels: 2,
      lodSplats: [FINE_A + FINE_B, 2 * COARSE],
      root: {
        boundingBox: { min: [-1, -1, -9], max: [1, 1, 9] },
        splatFiles: ['coarse-a.sog', 'fine-a.sog', 'coarse-b.sog', 'fine-b.sog'],
        child: {
          // Source-local z; the LCC2 format transform may flip it, so place the camera from
          // world-space region centres rather than assuming a sign.
          '0': region(-8, FILE.coarseA, FILE.fineA, FINE_A),
          '1': region(8, FILE.coarseB, FILE.fineB, FINE_B),
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
    { budget: START_BUDGET, lodBaseDistance: 10, lodMultiplier: 2 },
  );
  const mesh = createStreamedMeshFixture(scene, START_BUDGET, CAPACITY, {
    initialReveal: 'progressive',
    maxSplatsPerSwap: APPEND_CAP,
  });
  meshes.push(mesh);
  mesh.updateMatrixWorld(true);
  const inner = mesh as unknown as Internals;
  vi.spyOn(inner, 'requestChunk').mockImplementation(() => {});
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const cache = (file: number, count: number) => {
    inner.cache.set(file, { data: chunk(count), bytes: 0, lastUsed: 0 });
  };
  cache(FILE.coarseA, COARSE);
  cache(FILE.coarseB, COARSE);
  cache(FILE.fineB, FINE_B);
  // Region centres in world space (the LCC2 format transform may flip axes).
  const centre = (z: number) => new THREE.Vector3(0, 0, z).applyMatrix4(mesh.matrixWorld);
  const a = centre(-8);
  const b = centre(8);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  // Stand near `target`, facing it, with the other region behind the camera.
  const pose = (target: THREE.Vector3, other: THREE.Vector3) => {
    camera.position.copy(target).lerp(other, 0.2);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
  };
  return { mesh, inner, scene, cache, camera, pose, a, b };
}

const residentFiles = (inner: Internals) =>
  [...inner.resident.values()].map(({ run }) => run.file).sort((x, y) => x - y);

describe('LCC2 over-budget release lane', () => {
  it('coarsens an out-of-view region in the same tick an in-view refinement fills the cap', () => {
    const f = setup();
    // Pose 1: close to B, A is far and behind. Settle B fine + A coarse.
    f.pose(f.b, f.a);
    for (let t = 1000; t < 1040; t++) f.inner.reschedule(f.camera, t);
    expect(residentFiles(f.inner)).toEqual([FILE.coarseA, FILE.fineB]);
    expect(f.mesh.activeSplatCount).toBe(COARSE + FINE_B);

    // Turn to A with its fine run ready and a budget the resident set is well
    // above. The in-view refinement (A coarse -> fine) ranks first and spends
    // the whole append cap; the out-of-view coarsening (B fine -> coarse)
    // frees more than it adds and must still land in the same tick.
    f.cache(FILE.fineA, FINE_A);
    f.mesh.setBudget(TURNED_BUDGET);
    f.pose(f.a, f.b);
    expect(f.mesh.activeSplatCount).toBeGreaterThan(TURNED_BUDGET);

    f.inner.reschedule(f.camera, 5000);
    expect(f.inner.staged.size).toBe(0);
    // Refinement committed...
    expect(residentFiles(f.inner)).toContain(FILE.fineA);
    // ...and so did the release: B's fine run left, its coarse ancestor is in.
    expect(residentFiles(f.inner)).not.toContain(FILE.fineB);
    expect(residentFiles(f.inner)).toEqual([FILE.fineA, FILE.coarseB]);
    expect(f.mesh.activeSplatCount).toBe(FINE_A + COARSE);
    expect(f.mesh.activeSplatCount).toBeLessThanOrEqual(TURNED_BUDGET);
  });
});
