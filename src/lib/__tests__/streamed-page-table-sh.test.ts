import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import type { WebGLRenderer } from 'three';
import { createStreamedMeshFixture } from './helpers/streamed-mesh-fixture';
import { StreamedSplatMesh } from '../streaming/streamed-splat-mesh';
import { SplatPool } from '../core/splat-mesh-pool';

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
  const pools: SplatPool[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
    for (const pool of pools) pool.dispose();
    pools.length = 0;
  });

  it('uploads a chunk into fragmented rows of a shared pool', () => {
    const chunkSize = 65_536;
    const pool = new SplatPool({ capacity: 64 * WIDTH });
    pools.push(pool);
    pool.freeRowSpans = Array.from({ length: 32 }, (_, index) => ({
      start: index * 2,
      count: 1,
    }));
    const scene = {
      source: { budget: chunkSize },
      chunkUrls: ['0'] as string[],
      chunkKind: 'file' as const,
      bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)),
      pinnedFiles: new Set<number>(),
      maxResidentSplats: chunkSize,
      chunkSize,
      foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 },
    };
    const mesh = createStreamedMeshFixture(
      scene,
      chunkSize,
      chunkSize,
      { foveationMode: 'page-table', pool },
      FrontierWorkerStub,
      false,
      true,
    );
    meshes.push(mesh);
    const inner = mesh as unknown as {
      installRadChunkPage: (file: number, data: ReturnType<typeof splats>) => boolean;
      poolIndicesForRadGlobals: (globals: Uint32Array) => Uint32Array | null;
      radChunkPages: Map<number, { ranges: Array<unknown>; starts: Uint32Array }>;
    };
    const data = splats(
      1,
      Array.from({ length: chunkSize }, (_, index) => index),
    );

    expect(inner.installRadChunkPage(0, data)).toBe(true);
    const page = inner.radChunkPages.get(0);
    expect(page?.ranges).toHaveLength(32);
    expect(page?.starts).toEqual(
      Uint32Array.from(Array.from({ length: 32 }, (_, index) => index * 2 * WIDTH)),
    );
    expect(inner.poolIndicesForRadGlobals(Uint32Array.from([0, WIDTH, chunkSize - 1]))).toEqual(
      Uint32Array.from([0, 2 * WIDTH, 62 * WIDTH + WIDTH - 1]),
    );
  });

  it('keeps shared-pool chunk residency near the governed draw budget', () => {
    const pool = new SplatPool({ capacity: 8 * WIDTH });
    pools.push(pool);
    const scene = {
      source: { budget: 4 },
      chunkUrls: ['0', '1', '2', '3'] as string[],
      chunkKind: 'file' as const,
      bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)),
      pinnedFiles: new Set<number>(),
      maxResidentSplats: 16,
      chunkSize: 4,
      foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 },
    };
    const mesh = createStreamedMeshFixture(
      scene,
      4,
      16,
      { foveationMode: 'page-table', pool },
      FrontierWorkerStub,
      false,
      true,
    );
    meshes.push(mesh);
    const inner = mesh as unknown as {
      installRadChunkPage: (file: number, data: ReturnType<typeof splats>) => boolean;
      radChunkPages: Map<number, unknown>;
    };

    expect(inner.installRadChunkPage(0, splats(1, [0, 1, 2, 3]))).toBe(true);
    expect(inner.installRadChunkPage(1, splats(1, [4, 5, 6, 7]))).toBe(true);
    expect(inner.installRadChunkPage(2, splats(1, [8, 9, 10, 11]))).toBe(true);
    expect(inner.radChunkPages.size).toBe(2);
    expect(inner.radChunkPages.has(2)).toBe(true);
  });

  it('does not reserve headroom inside a capture smaller than the shared pool allowance', () => {
    const pool = new SplatPool({ capacity: 8 * WIDTH });
    pools.push(pool);
    const scene = {
      source: { budget: 16 },
      chunkUrls: ['0', '1', '2', '3'] as string[],
      chunkKind: 'file' as const,
      bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)),
      pinnedFiles: new Set<number>(),
      maxResidentSplats: 16,
      chunkSize: 4,
      foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 },
    };
    const mesh = createStreamedMeshFixture(
      scene,
      16,
      16,
      { foveationMode: 'page-table', pool },
      FrontierWorkerStub,
      false,
      true,
    );
    meshes.push(mesh);
    const inner = mesh as unknown as {
      installRadChunkPage: (file: number, data: ReturnType<typeof splats>) => boolean;
      radChunkPages: Map<number, unknown>;
    };

    for (let file = 0; file < 4; file++) {
      const first = file * 4;
      expect(
        inner.installRadChunkPage(file, splats(1, [first, first + 1, first + 2, first + 3])),
      ).toBe(true);
    }
    expect(inner.radChunkPages.size).toBe(4);
  });

  it('uploads only the populated rows of a short final RAD chunk', () => {
    const chunkSize = 65_536;
    const count = 23_451;
    const pool = new SplatPool({ capacity: chunkSize });
    pools.push(pool);
    const scene = {
      source: { budget: chunkSize },
      chunkUrls: ['0'] as string[],
      chunkKind: 'file' as const,
      bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)),
      pinnedFiles: new Set<number>(),
      maxResidentSplats: chunkSize,
      chunkSize,
      foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 },
    };
    const mesh = createStreamedMeshFixture(
      scene,
      chunkSize,
      chunkSize,
      { foveationMode: 'page-table', pool },
      FrontierWorkerStub,
      false,
      true,
    );
    meshes.push(mesh);
    const inner = mesh as unknown as {
      installRadChunkPage: (file: number, data: ReturnType<typeof splats>) => boolean;
      radChunkPages: Map<number, { ranges: Array<unknown> }>;
    };

    expect(
      inner.installRadChunkPage(
        0,
        splats(
          1,
          Array.from({ length: count }, (_, index) => index),
        ),
      ),
    ).toBe(true);
    expect(inner.radChunkPages.get(0)?.ranges).toHaveLength(Math.ceil(count / WIDTH));
  });

  it('maps shared page-table candidates to disjoint pool indices for unified views', () => {
    const pool = new SplatPool({ capacity: 4 * WIDTH });
    pools.push(pool);
    const scene = {
      source: { budget: WIDTH },
      chunkUrls: ['0', '1', '2'] as string[],
      chunkKind: 'file' as const,
      bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)),
      pinnedFiles: new Set<number>(),
      maxResidentSplats: WIDTH,
      chunkSize: 4,
      foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 },
    };
    const make = () => {
      const mesh = createStreamedMeshFixture(
        scene,
        WIDTH,
        2 * WIDTH,
        { foveationMode: 'page-table', pool },
        FrontierWorkerStub,
      );
      meshes.push(mesh);
      return mesh as unknown as {
        applyFrontierPlan: (plan: Record<string, unknown>) => void;
        onActiveListRendered: (version: number) => void;
        pagerSlots: number;
        pageTableDrawn: number;
        activeListVersion: number;
        slabPages: Array<unknown>;
        poolRangeBacking: (page: unknown) => { start: number };
      };
    };
    const a = make();
    const b = make();
    const aStart = a.poolRangeBacking(a.slabPages[0]).start;
    const bStart = b.poolRangeBacking(b.slabPages[0]).start;
    expect(aStart).not.toBe(bStart);

    const plainSplats = (ids: number[]) => {
      const { shPacked: _shPacked, ...plain } = splats(1, ids);
      return plain;
    };
    const plan = (
      generation: number,
      ids: number[],
      writeSlots: number[],
      candidateSlots: number[],
      count: number,
    ) => ({
      type: 'plan',
      seq: generation,
      moveSlots: new Uint32Array(0),
      moves: plainSplats([]),
      appendStart: 0,
      appends: plainSplats(ids),
      writeSlots: Uint32Array.from(writeSlots),
      degenerateStart: 0,
      degenerateCount: 0,
      touched: new Uint32Array(0),
      residentCount: count,
      displayCount: count,
      candidateGeneration: generation,
      candidateSlots: Uint32Array.from(candidateSlots),
      candidateComplete: true,
      gatherMissing: 0,
      dropped: 0,
      evicted: new Uint32Array(0),
      solvedLimit: 0.02,
      capacity: a.pagerSlots,
      converged: true,
      cacheBytes: 0,
      cacheLimitBytes: 1024,
    });

    a.applyFrontierPlan(plan(1, [0, 1], [0, 1], [0, 1], 2));
    b.applyFrontierPlan(plan(1, [2, 3], [0, 1], [0, 1], 2));
    const aView = (meshes[0] as StreamedSplatMesh).getUnifiedSourceView();
    const bView = (meshes[1] as StreamedSplatMesh).getUnifiedSourceView();
    expect((aView.sourceIndex.array as Uint32Array).slice(0, 2)).toEqual(
      Uint32Array.from([aStart, aStart + 1]),
    );
    expect((bView.sourceIndex.array as Uint32Array).slice(0, 2)).toEqual(
      Uint32Array.from([bStart, bStart + 1]),
    );
    expect(aView.activeListVersion).toBe(a.activeListVersion);
    expect(bView.activeListVersion).toBe(b.activeListVersion);
    a.onActiveListRendered(a.activeListVersion);
    b.onActiveListRendered(b.activeListVersion);

    a.applyFrontierPlan(plan(2, [4, 5], [2, 3], [0, 1, 2, 3], 4));
    expect(a.pageTableDrawn).toBe(2);
    a.onActiveListRendered(a.activeListVersion);
    expect(a.pageTableDrawn).toBe(4);
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
