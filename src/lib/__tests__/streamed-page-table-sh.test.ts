import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { createStreamedMeshFixture } from './helpers/streamed-mesh-fixture';
import { StreamedSplatMesh } from '../streaming/streamed-splat-mesh';

const WIDTH = 2048;

beforeAll(() => {
  if (typeof (globalThis as { Worker?: unknown }).Worker === 'undefined') {
    (globalThis as { Worker: unknown }).Worker = class {
      postMessage(): void {}
      terminate(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    };
  }
});

class FrontierWorkerStub {
  onmessage: unknown = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  postMessage(): void {}
  terminate(): void {}
}

type Bands = 1 | 2 | 3;
const coefficients = (bands: Bands) => [0, 3, 8, 15][bands] as number;

function splats(bands: Bands, ids: number[]) {
  const count = ids.length;
  const words = coefficients(bands);
  const packed = new Uint32Array(count * words);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < words; c++) packed[i * words + c] = ids[i]! * 100 + c + 1;
  }
  return {
    count,
    globals: Uint32Array.from(ids),
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4),
    covariances: new Float32Array(count * 6),
    shPacked: {
      bands,
      packed,
      range: {
        min: [-1, -1, -1] as [number, number, number],
        max: [1, 1, 1] as [number, number, number],
      },
    },
  };
}

describe('RAD page-table SH paging', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
  });

  it.each([1, 2, 3] as const)(
    'keeps band-%i SH attached to each appended and moved splat',
    (bands) => {
      const capacity = 2 * WIDTH;
      const scene = {
        source: { budget: capacity },
        chunkUrls: [] as string[],
        chunkKind: 'file' as const,
        bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)),
        pinnedFiles: new Set<number>(),
        maxResidentSplats: capacity,
        chunkSize: 4,
        foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 },
      };
      const mesh = createStreamedMeshFixture(
        scene,
        capacity,
        capacity,
        { foveationMode: 'page-table', shBands: bands },
        FrontierWorkerStub,
      );
      meshes.push(mesh);
      const inner = mesh as unknown as {
        applyFrontierPlan: (plan: Record<string, unknown>) => void;
        pagerSlots: number;
        slabPages: Array<{ count: number }>;
        poolRangeBacking: (page: unknown) => {
          start: number;
          backing: { shPacked: Uint32Array[] };
        };
      };
      const plan = (
        appends: ReturnType<typeof splats>,
        moves = splats(bands, []),
        moveSlots = new Uint32Array(0),
      ) => ({
        type: 'plan',
        seq: 1,
        moveSlots,
        moves,
        appendStart: 0,
        appends,
        degenerateStart: 4,
        degenerateCount: 0,
        touched: new Uint32Array(0),
        residentCount: 4,
        displayCount: 4,
        displayGeneration: 1,
        gatherMissing: 0,
        dropped: 0,
        evicted: new Uint32Array(0),
        solvedLimit: 0.02,
        capacity: inner.pagerSlots,
        converged: true,
        cacheBytes: 0,
        cacheLimitBytes: 1024,
      });

      inner.applyFrontierPlan(plan(splats(bands, [1, 2, 3, 4])));
      inner.applyFrontierPlan(
        plan(splats(bands, []), splats(bands, [5, 6]), Uint32Array.from([1, 3])),
      );

      const { start, backing } = inner.poolRangeBacking(inner.slabPages[0]);
      for (const [slot, id] of [1, 5, 3, 6].entries()) {
        for (let c = 0; c < coefficients(bands); c++) {
          expect(backing.shPacked[c >> 2]![(start + slot) * 4 + (c & 3)]).toBe(id * 100 + c + 1);
        }
      }
    },
  );
});
