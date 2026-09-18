import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import type { WebGLRenderer } from 'three';
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
  readonly posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
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
      const empty = splats(bands, []);
      const plan = (appends: ReturnType<typeof splats>, writeSlots: Uint32Array) => ({
        type: 'plan',
        seq: 1,
        moveSlots: new Uint32Array(0),
        moves: empty,
        appendStart: 0,
        appends,
        writeSlots,
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

      inner.applyFrontierPlan(plan(splats(bands, [1, 2, 3, 4]), Uint32Array.from([0, 1, 2, 3])));
      inner.applyFrontierPlan(plan(splats(bands, [5, 6]), Uint32Array.from([1, 3])));

      const { start, backing } = inner.poolRangeBacking(inner.slabPages[0]);
      for (const [slot, id] of [1, 5, 3, 6].entries()) {
        for (let c = 0; c < coefficients(bands); c++) {
          expect(backing.shPacked[c >> 2]![(start + slot) * 4 + (c & 3)]).toBe(id * 100 + c + 1);
        }
      }
    },
  );

  it('does not consume a candidate generation before its complete slot list is published', async () => {
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
      { foveationMode: 'page-table', radInitialRevealPolicy: 'projected-quality' },
      FrontierWorkerStub,
    );
    meshes.push(mesh);
    const inner = mesh as unknown as {
      applyFrontierPlan: (plan: Record<string, unknown>) => void;
      pageTableDrawn: number;
      pageTableDisplayGeneration: number;
      indexedPublishGeneration: number | null;
      indexedPublishedGeneration: number;
      indexedPublishActiveListVersion: number | null;
      sortedActiveListVersion: number;
      activeListVersion: number;
      revealMultiplier: { value: number };
      material: { colorWrite: boolean };
      onActiveListReady: (version: number) => void;
      onActiveListRendered: (version: number) => void;
      pagerSlots: number;
    };
    const empty = splats(1, []);
    const base = {
      type: 'plan',
      seq: 1,
      moveSlots: new Uint32Array(0),
      moves: empty,
      appendStart: 0,
      degenerateStart: 0,
      degenerateCount: 0,
      touched: new Uint32Array(0),
      residentCount: 4,
      gatherMissing: 0,
      dropped: 0,
      evicted: new Uint32Array(0),
      solvedLimit: 0.02,
      capacity: inner.pagerSlots,
      converged: true,
      cacheBytes: 0,
      cacheLimitBytes: 1024,
      candidateGeneration: 1,
      displayGeneration: 1,
    };

    inner.applyFrontierPlan({
      ...base,
      appends: splats(1, [1, 2, 3, 4]),
      writeSlots: Uint32Array.from([0, 1, 2, 3]),
      displayCount: 0,
    });
    expect(inner.pageTableDrawn).toBe(0);
    expect(inner.pageTableDisplayGeneration).toBe(-1);
    expect(mesh.hasPublishedGeneration).toBe(false);
    expect(inner.revealMultiplier.value).toBe(0);
    expect(inner.material.colorWrite).toBe(false);

    inner.applyFrontierPlan({
      ...base,
      appends: empty,
      writeSlots: new Uint32Array(0),
      displayCount: 1,
      candidateSlots: Uint32Array.from([0]),
      candidateComplete: false,
    });
    expect(inner.pageTableDrawn).toBe(0);
    expect(inner.pageTableDisplayGeneration).toBe(-1);
    expect(inner.indexedPublishGeneration).toBeNull();

    inner.applyFrontierPlan({
      ...base,
      appends: empty,
      writeSlots: new Uint32Array(0),
      displayCount: 4,
      candidateSlots: Uint32Array.from([0, 1, 2, 3]),
      candidateComplete: true,
      revealReady: false,
      maxCentralProjectedRatio: 4,
      maxVisibleProjectedRatio: 8,
    });
    expect(inner.pageTableDrawn).toBe(0);
    expect(inner.pageTableDisplayGeneration).toBe(-1);
    expect(inner.indexedPublishGeneration).toBe(1);
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);
    const version = inner.indexedPublishActiveListVersion!;
    expect(version).toBe(inner.activeListVersion);

    inner.onActiveListRendered(version - 1);
    expect(inner.pageTableDrawn).toBe(0);
    expect(inner.indexedPublishGeneration).toBe(1);

    inner.onActiveListReady(version);
    expect(inner.pageTableDrawn).toBe(0);
    expect(inner.indexedPublishGeneration).toBe(1);
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(4);
    inner.sortedActiveListVersion = version;
    mesh.onAfterRender({} as WebGLRenderer, new THREE.Scene(), new THREE.PerspectiveCamera());
    expect(inner.pageTableDrawn).toBe(0);
    await Promise.resolve();
    expect(inner.pageTableDrawn).toBe(4);
    const published = (
      (mesh as unknown as { frontierWorker: { posted: unknown[] } }).frontierWorker.posted ?? []
    ).filter((message) => (message as { type?: string }).type === 'published') as Array<{
      type: string;
      generation: number;
      activeListVersion: number;
    }>;
    expect(published).toEqual([{ type: 'published', generation: 1, activeListVersion: version }]);
    mesh.onAfterRender({} as WebGLRenderer, new THREE.Scene(), new THREE.PerspectiveCamera());
    await Promise.resolve();
    expect(
      (
        (mesh as unknown as { frontierWorker: { posted: unknown[] } }).frontierWorker.posted ?? []
      ).filter((message) => (message as { type?: string }).type === 'published'),
    ).toHaveLength(1);
    expect(inner.pageTableDrawn).toBe(4);
    expect(inner.pageTableDisplayGeneration).toBe(1);
    expect(inner.indexedPublishedGeneration).toBe(1);
    expect(inner.indexedPublishGeneration).toBeNull();
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(4);
    expect(mesh.hasPublishedGeneration).toBe(false);
    expect(inner.revealMultiplier.value).toBe(0);

    inner.applyFrontierPlan({
      ...base,
      candidateGeneration: 2,
      displayGeneration: 2,
      appends: empty,
      writeSlots: new Uint32Array(0),
      displayCount: 4,
      candidateSlots: Uint32Array.from([0, 1, 2, 3]),
      candidateComplete: true,
      revealReady: true,
      maxCentralProjectedRatio: 4,
      maxVisibleProjectedRatio: 8,
    });
    const qualifyingVersion = inner.indexedPublishActiveListVersion!;
    inner.onActiveListReady(qualifyingVersion);
    inner.sortedActiveListVersion = qualifyingVersion;
    mesh.onAfterRender({} as WebGLRenderer, new THREE.Scene(), new THREE.PerspectiveCamera());
    await Promise.resolve();
    expect(mesh.hasPublishedGeneration).toBe(true);
    expect(inner.revealMultiplier.value).toBe(1);
    expect(inner.material.colorWrite).toBe(true);
    expect(inner.indexedPublishedGeneration).toBe(2);
  });

  it('ignores a render callback whose active-list version was replaced', async () => {
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
      { foveationMode: 'page-table' },
      FrontierWorkerStub,
    );
    meshes.push(mesh);
    const inner = mesh as unknown as {
      indexedPublishGeneration: number | null;
      indexedPendingDisplaySlots: Uint32Array | null;
      indexedPublishActiveListVersion: number | null;
      activeListVersion: number;
      sortedActiveListVersion: number;
      onActiveListReady: (version: number) => void;
      rebuildActiveList: () => void;
      frontierWorker: { posted: unknown[] };
    };
    inner.indexedPublishGeneration = 8;
    inner.indexedPendingDisplaySlots = new Uint32Array([0]);
    inner.indexedPublishActiveListVersion = inner.activeListVersion;
    const version = inner.activeListVersion;
    inner.onActiveListReady(version);
    inner.sortedActiveListVersion = version;
    mesh.onAfterRender({} as WebGLRenderer, new THREE.Scene(), new THREE.PerspectiveCamera());
    inner.rebuildActiveList();
    await Promise.resolve();
    expect(inner.indexedPublishGeneration).toBe(8);
    expect(
      inner.frontierWorker.posted.filter(
        (message) => (message as { type?: string }).type === 'published',
      ),
    ).toHaveLength(0);
  });
});
