import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { compareDemand } from '../formats/rad/frontier-demand';
import type { FrontierDemandReply } from '../formats/rad/frontier-worker-protocol';
import { createStreamedMeshFixture } from './helpers/streamed-mesh-fixture';

describe('Spark-matching demand order', () => {
  it('orders by projected importance, not screen tier', () => {
    const wants = [
      { file: 9, tier: 0 as const, priority: 1 },
      { file: 2, tier: 0 as const, priority: 8 },
      { file: 4, tier: 0 as const, priority: 8 },
    ];
    expect([...wants].sort(compareDemand).map((want) => want.file)).toEqual([2, 4, 9]);
    expect(
      [
        { file: 1, tier: 0 as const, priority: 2 },
        { file: 7, tier: 2 as const, priority: 9 },
      ]
        .sort(compareDemand)
        .map((want) => want.file),
    ).toEqual([7, 1]);
  });
});

class WorkerStub {
  posted: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror = null;
  onmessageerror = null;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {}
}

describe('page-table demand reconciliation', () => {
  const meshes: ReturnType<typeof createStreamedMeshFixture>[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
  });
  function fixture() {
    const scene = {
      source: {
        budget: 8192,
        lodBaseDistance: 10,
        lodMultiplier: 2,
        computeDesiredRuns: () => [],
        coarsestRunsFor: () => [],
      },
      chunkUrls: Array.from({ length: 30 }, (_, i) => `https://example.test/${i}`),
      chunkSize: 4,
      chunkKind: 'file',
      bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
      pinnedFiles: new Set([0]),
      maxResidentSplats: 8192,
      foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 },
    };
    const mesh = createStreamedMeshFixture(
      scene,
      8192,
      8192,
      { foveationMode: 'page-table' },
      WorkerStub,
    );
    meshes.push(mesh);
    const inner = mesh as unknown as {
      demandGeneration: number;
      demandReadyGeneration: number;
      demandNeedsNewRevision: boolean;
      demandWants: FrontierDemandReply['wants'];
      pageTableCachedFiles: Set<number>;
      fetching: Map<number, { controller: AbortController; kind: string }>;
      requestChunk: (file: number, kind: string) => void;
      applyDemand: (reply: FrontierDemandReply) => void;
      reconcileDemand: (complete?: boolean) => void;
      pageTableInFlight: boolean;
      pageTableFetchPriority: readonly number[];
      handleFrontierMessage: (reply: FrontierDemandReply | { type: 'plan' }) => void;
      applyFrontierPlan: (plan: Record<string, unknown>) => void;
      reschedulePageTable: (
        camera: THREE.Vector3,
        forward: THREE.Vector3,
        frustum: THREE.Frustum,
        now: number,
        projection?: number[],
      ) => void;
      indexedPublishGeneration: number | null;
      indexedPendingDisplaySlots: Uint32Array | null;
      indexedPublishActiveListVersion: number | null;
      activeListVersion: number;
      pendingWork: boolean;
      lastPostedCamera: readonly [number, number, number] | null;
      lastPostedForward: readonly [number, number, number] | null;
      lastPostedProjection: readonly number[] | null;
      onActiveListReady: (activeListVersion: number) => void;
      onActiveListRendered: (activeListVersion: number) => void;
      notifyUnifiedPublication: () => void;
      rebuildActiveList: () => void;
      frontierWorker: WorkerStub;
      radChunkResidency: boolean;
      radChunkAllocator: {
        chunkSize: number;
        residentCount: number;
        capacityPages: number;
        pageOf: (file: number) => number | undefined;
        poolSlots: (globals: ArrayLike<number>) => Uint32Array | null;
      } | null;
      radChunkPages: Map<number, { lastUsed: number }>;
      radChunkDisplayedGlobals: Uint32Array;
      radChunkPendingGlobals: Uint32Array | null;
      radChunkPublishGeneration: number | null;
      radChunkPublishActiveListVersion: number | null;
      radChunkSelectionIdValue: number;
      radChunkLastInvalidationReasonValue: string | null;
      pageTableDisplayGeneration: number;
      pageTableDrawBudget: number;
      pageTableSeq: number;
      replaceActiveIndices: (indices: Uint32Array) => number;
      sourceIndexAttribute: { array: Uint32Array };
      activeSlotByPoolIndex: Uint32Array;
      activeCount: number;
    };
    inner.pageTableInFlight = true;
    inner.pageTableCachedFiles.add(0);
    return inner;
  }

  function chunkPagesFixture() {
    const inner = fixture() as ReturnType<typeof fixture> & {
      radChunkAllocator: {
        chunkSize: number;
        residentCount: number;
        capacityPages: number;
        pageOf: (file: number) => number | undefined;
        poolSlots: (globals: ArrayLike<number>) => Uint32Array | null;
      } | null;
      radChunkPages: Map<number, { lastUsed: number }>;
      radChunkDisplayedGlobals: Uint32Array;
      radChunkPendingGlobals: Uint32Array | null;
      radChunkPublishGeneration: number | null;
      radChunkPublishActiveListVersion: number | null;
      radChunkSelectionIdValue: number;
      radChunkLastInvalidationReasonValue: string | null;
      pageTableDisplayGeneration: number;
      pageTableDrawBudget: number;
      pageTableSeq: number;
    };
    const pages = new Map<number, number>([[0, 0], [1, 1]]);
    inner.radChunkResidency = true;
    inner.radChunkAllocator = {
      chunkSize: 4,
      residentCount: 2,
      capacityPages: 2,
      pageOf: (file) => pages.get(file),
      poolSlots: (globals) => {
        const slots = new Uint32Array(globals.length);
        for (let i = 0; i < globals.length; i++) {
          const global = globals[i] as number;
          const page = pages.get(Math.floor(global / 4));
          if (page === undefined) return null;
          slots[i] = page * 4 + (global % 4);
        }
        return slots;
      },
    };
    inner.radChunkPages.set(0, { lastUsed: 0 });
    inner.radChunkPages.set(1, { lastUsed: 0 });
    return { inner, pages };
  }

  function chunkPlan(generation: number, revision: number, globals: number[]) {
    return {
      type: 'plan' as const,
      seq: generation,
      moveSlots: new Uint32Array(0),
      moves: { count: 0 },
      appendStart: 0,
      appends: { count: 0 },
      degenerateStart: 0,
      degenerateCount: 0,
      touched: new Uint32Array(0),
      residentCount: globals.length,
      displayCount: globals.length,
      candidateGeneration: generation,
      candidateRevision: revision,
      candidateComplete: true,
      selectionGlobals: Uint32Array.from(globals),
      planGeneration: generation,
      planBudget: globals.length,
      solvedLimit: 0,
      gatherMissing: 0,
      dropped: 0,
      evicted: new Uint32Array(0),
      capacity: 8192,
      converged: true,
      cacheBytes: 0,
      cacheLimitBytes: 1024,
    };
  }

  function demand(
    revision: number,
    wants: FrontierDemandReply['wants'],
    complete = true,
  ): FrontierDemandReply {
    return {
      type: 'demand',
      generation: revision,
      wants,
      complete,
      revision,
      traversalId: complete ? 1 : 0,
    };
  }

  it('merges incomplete demand without cancelling omitted requests', () => {
    const inner = fixture();
    const requested = vi.spyOn(inner, 'requestChunk').mockImplementation(() => {});
    const old = new AbortController();
    inner.fetching.set(3, { controller: old, kind: 'priority' });
    inner.demandGeneration = 1;
    inner.applyDemand(demand(1, [{ file: 4, tier: 0, priority: 2 }], false));
    expect(old.signal.aborted).toBe(false);
    expect(requested).toHaveBeenCalledWith(4, 'priority');
    inner.applyDemand(demand(1, [{ file: 5, tier: 0, priority: 3 }], true));
    expect(old.signal.aborted).toBe(true);
  });

  it('ignores obsolete camera demand and still applies a later pager plan', () => {
    const inner = fixture();
    const apply = vi.spyOn(inner, 'applyFrontierPlan').mockImplementation(() => {});
    inner.demandGeneration = 2;
    inner.handleFrontierMessage(demand(1, []));
    const plan = { type: 'plan' as const };
    inner.handleFrontierMessage(plan);
    expect(apply).toHaveBeenCalledExactlyOnceWith(plan);
  });

  it('refills request slots from current wants without waiting for a render plan', () => {
    const inner = fixture();
    const started: number[] = [];
    vi.spyOn(inner, 'requestChunk').mockImplementation((file) => {
      started.push(file);
    });
    inner.demandGeneration = 1;
    inner.applyDemand(
      demand(1, [
        { file: 2, tier: 0, priority: 8 },
        { file: 9, tier: 2, priority: 1 },
      ]),
    );
    expect(started).toEqual(expect.arrayContaining([2, 9]));
  });

  it('re-sorts merged provisional demand by projected importance', () => {
    const inner = fixture();
    const started: number[] = [];
    vi.spyOn(inner, 'requestChunk').mockImplementation((file) => {
      started.push(file);
    });
    inner.demandGeneration = 1;
    inner.applyDemand(demand(1, [{ file: 9, tier: 0, priority: 1 }], false));
    inner.applyDemand(demand(1, [{ file: 2, tier: 0, priority: 8 }], false));
    expect(inner.demandWants.map((want) => want.file)).toEqual([2, 9]);
    expect(started[0]).toBe(9);
    expect(started).toContain(2);
  });

  it('preserves first-touch order and lets chunk-page requests finish in flight', () => {
    const inner = fixture();
    inner.radChunkResidency = true;
    const started: number[] = [];
    vi.spyOn(inner, 'requestChunk').mockImplementation((file) => {
      started.push(file);
    });
    const old = new AbortController();
    inner.fetching.set(3, { controller: old, kind: 'priority' });
    inner.demandGeneration = 1;
    inner.applyDemand(
      demand(1, [
        { file: 9, tier: 0, priority: 1 },
        { file: 2, tier: 0, priority: 8 },
      ]),
    );
    expect(inner.demandWants.map((want) => want.file)).toEqual([9, 2]);
    expect(started).toEqual([9, 2]);
    expect(old.signal.aborted).toBe(false);
  });

  it('publishes a complete resident cut while camera demand is newer', () => {
    const { inner } = chunkPagesFixture();
    inner.demandGeneration = 2;
    inner.demandNeedsNewRevision = true;
    inner.applyFrontierPlan(chunkPlan(1, 1, [0, 1]));
    expect(inner.radChunkPendingGlobals).toEqual(new Uint32Array([0, 1]));
    expect(inner.radChunkSelectionIdValue).toBe(1);

    inner.applyFrontierPlan(chunkPlan(2, 2, [4, 5]));
    expect(inner.radChunkPendingGlobals).toEqual(new Uint32Array([0, 1]));
    expect(inner.radChunkSelectionIdValue).toBe(1);

    const version = inner.radChunkPublishActiveListVersion;
    expect(version).not.toBeNull();
    inner.onActiveListReady(version as number);
    inner.onActiveListRendered(version as number);
    expect(inner.radChunkDisplayedGlobals).toEqual(new Uint32Array([0, 1]));
    expect(inner.radChunkPendingGlobals).toBeNull();
  });

  it('bulk-copies chunk-page selections without rebuilding the reverse slot map', () => {
    const { inner } = chunkPagesFixture();
    const reverseBefore = inner.activeSlotByPoolIndex.slice(0, 7);
    inner.replaceActiveIndices(Uint32Array.from([0, 5, 6]));

    expect(inner.activeCount).toBe(3);
    expect(inner.sourceIndexAttribute.array.slice(0, 3)).toEqual(new Uint32Array([0, 5, 6]));
    expect(inner.activeSlotByPoolIndex.slice(0, 7)).toEqual(reverseBefore);
  });

  it('rejects an unsafe chunk-page candidate when its page identity changes', () => {
    const { inner, pages } = chunkPagesFixture();
    inner.applyFrontierPlan(chunkPlan(1, 1, [0, 1]));
    pages.set(0, 1);
    const version = inner.radChunkPublishActiveListVersion;
    inner.onActiveListReady(version as number);
    expect(inner.radChunkPendingGlobals).toBeNull();
    expect(inner.radChunkLastInvalidationReasonValue).toBe('page-identity-changed');
  });

  it('does not stage a chunk-page selection above the current draw budget', () => {
    const { inner } = chunkPagesFixture();
    inner.pageTableDrawBudget = 1;
    inner.applyFrontierPlan(chunkPlan(1, 1, [0, 1]));
    expect(inner.radChunkPendingGlobals).toBeNull();
    expect(inner.radChunkLastInvalidationReasonValue).toBe('draw-budget');
  });

  it('keeps the newest camera while the worker is busy without dropping live demand', () => {
    const inner = fixture();
    vi.spyOn(inner, 'requestChunk').mockImplementation(() => {});
    inner.pageTableInFlight = false;
    const origin = new THREE.Vector3();
    const forward = new THREE.Vector3(0, 0, -1);
    const frustum = new THREE.Frustum();
    inner.reschedulePageTable(
      origin,
      forward,
      frustum,
      1000,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    );
    const posted = inner.frontierWorker.posted.filter(
      (message) => (message as { type?: string }).type === 'reschedule',
    );
    expect(posted).toHaveLength(1);
    const revision = inner.demandGeneration;
    inner.applyDemand(demand(revision, [{ file: 4, tier: 0, priority: 5 }]));
    inner.reschedulePageTable(
      new THREE.Vector3(2, 0, 0),
      forward,
      frustum,
      1010,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    );
    expect(inner.demandGeneration).toBe(revision);
    expect(inner.demandNeedsNewRevision).toBe(true);
    expect(inner.demandWants.map((want) => want.file)).toEqual([4]);
    expect(
      inner.frontierWorker.posted.filter(
        (message) => (message as { type?: string }).type === 'reschedule',
      ),
    ).toHaveLength(1);
    inner.applyDemand(demand(revision, [{ file: 5, tier: 0, priority: 9 }]));
    expect(inner.demandWants.map((want) => want.file)).toEqual([5]);
    inner.pageTableInFlight = false;
    inner.reschedulePageTable(
      new THREE.Vector3(2, 0, 0),
      forward,
      frustum,
      1020,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    );
    expect(inner.demandGeneration).toBe(revision + 1);
  });

  it('treats a projection-only change as a new configuration after the in-flight walk', () => {
    const inner = fixture();
    inner.pageTableInFlight = false;
    const origin = new THREE.Vector3();
    const forward = new THREE.Vector3(0, 0, -1);
    const frustum = new THREE.Frustum();
    inner.reschedulePageTable(
      origin,
      forward,
      frustum,
      1000,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    );
    inner.pageTableInFlight = false;
    inner.reschedulePageTable(
      origin,
      forward,
      frustum,
      1010,
      [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    );
    expect(inner.demandGeneration).toBe(2);
    const last = [...inner.frontierWorker.posted]
      .reverse()
      .find((message) => (message as { type?: string }).type === 'reschedule') as {
      revision?: number;
    };
    expect(last?.revision).toBe(2);
  });

  it('requests last-plan touches while current-revision demand is still incomplete', () => {
    const inner = fixture();
    const started: number[] = [];
    vi.spyOn(inner, 'requestChunk').mockImplementation((file) => {
      started.push(file);
    });
    inner.demandGeneration = 2;
    inner.demandReadyGeneration = 1;
    inner.pageTableFetchPriority = [6, 8];
    inner.reconcileDemand(false);
    expect(started).toEqual(expect.arrayContaining([6, 8]));
  });

  it('acknowledges unified publication of the live active list after a rebuild', () => {
    const inner = fixture();
    inner.indexedPublishGeneration = 3;
    inner.indexedPendingDisplaySlots = new Uint32Array([0]);
    inner.indexedPublishActiveListVersion = inner.activeListVersion;
    inner.notifyUnifiedPublication();
    expect(
      inner.frontierWorker.posted.some(
        (message) =>
          (message as { type?: string; generation?: number }).type === 'published' &&
          (message as { generation?: number }).generation === 3,
      ),
    ).toBe(true);
  });

  it('does not acknowledge a standalone publication before a matching sort', () => {
    const inner = fixture() as ReturnType<typeof fixture> & {
      onActiveListReady: (activeListVersion: number) => void;
    };
    inner.indexedPublishGeneration = 4;
    inner.indexedPendingDisplaySlots = new Uint32Array([0]);
    inner.indexedPublishActiveListVersion = inner.activeListVersion;
    inner.onActiveListReady(inner.activeListVersion);
    expect(
      inner.frontierWorker.posted.some(
        (message) => (message as { type?: string }).type === 'published',
      ),
    ).toBe(false);
  });

  it('acknowledges a standalone indexed publication after a matching sort', () => {
    const inner = fixture() as ReturnType<typeof fixture> & {
      onActiveListReady: (activeListVersion: number) => void;
      onActiveListRendered: (activeListVersion: number) => void;
    };
    inner.indexedPublishGeneration = 4;
    inner.indexedPendingDisplaySlots = new Uint32Array([0]);
    inner.indexedPublishActiveListVersion = inner.activeListVersion;
    inner.onActiveListReady(inner.activeListVersion);
    expect(
      inner.frontierWorker.posted.some(
        (message) =>
          (message as { type?: string; generation?: number }).type === 'published' &&
          (message as { generation?: number }).generation === 4,
      ),
    ).toBe(false);
    inner.onActiveListRendered(inner.activeListVersion);
    expect(
      inner.frontierWorker.posted.some(
        (message) =>
          (message as { type?: string; generation?: number }).type === 'published' &&
          (message as { generation?: number }).generation === 4,
      ),
    ).toBe(true);
    expect(inner.pendingWork).toBe(true);
  });

  it('reschedules immediately after the matching publication acknowledgement', () => {
    const inner = fixture() as ReturnType<typeof fixture> & {
      onActiveListRendered: (activeListVersion: number) => void;
      reschedulePageTable: (...args: unknown[]) => void;
      lastPostedCamera: readonly [number, number, number] | null;
      lastPostedForward: readonly [number, number, number] | null;
      lastPostedProjection: readonly number[] | null;
    };
    inner.indexedPublishGeneration = 5;
    inner.indexedPendingDisplaySlots = new Uint32Array([0]);
    inner.indexedPublishActiveListVersion = inner.activeListVersion;
    inner.pageTableInFlight = false;
    inner.lastPostedCamera = [0, 0, 0];
    inner.lastPostedForward = [0, 0, -1];
    inner.lastPostedProjection = [];
    const reschedule = vi.spyOn(inner, 'reschedulePageTable').mockImplementation(() => {});

    inner.onActiveListRendered(inner.activeListVersion);

    expect(reschedule).toHaveBeenCalledOnce();
    expect(reschedule.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ x: 0, y: 0, z: 0 }));
    expect(reschedule.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ x: 0, y: 0, z: -1 }));
  });

  it('reschedules after rejecting a complete candidate from an older revision', () => {
    const inner = fixture();
    const empty = {
      count: 0,
      globals: new Uint32Array(0),
      positions: new Float32Array(0),
      colors: new Uint8Array(0),
      covariances: new Float32Array(0),
    };
    inner.demandGeneration = 2;
    inner.applyFrontierPlan({
      type: 'plan',
      seq: 1,
      moveSlots: new Uint32Array(0),
      moves: empty,
      appendStart: 0,
      appends: empty,
      writeSlots: new Uint32Array(0),
      degenerateStart: 0,
      degenerateCount: 0,
      touched: new Uint32Array(0),
      residentCount: 1,
      displayCount: 1,
      displayGeneration: 1,
      gatherMissing: 0,
      dropped: 0,
      evicted: new Uint32Array(0),
      solvedLimit: 0.02,
      capacity: 8192,
      converged: true,
      pendingFrontierSplats: 0,
      staleResidentSplats: 0,
      cacheBytes: 0,
      cacheLimitBytes: 1024,
      candidateGeneration: 1,
      candidateRevision: 1,
      candidateComplete: true,
      candidateSlots: Uint32Array.from([0]),
    });
    expect(inner.pendingWork).toBe(true);
    expect(inner.demandNeedsNewRevision).toBe(true);
  });

  it('ignores a stale publication callback after a newer candidate active list exists', () => {
    const inner = fixture();
    inner.indexedPublishGeneration = 7;
    inner.indexedPendingDisplaySlots = new Uint32Array([0]);
    inner.indexedPublishActiveListVersion = inner.activeListVersion;

    inner.rebuildActiveList();
    const current = inner.indexedPublishActiveListVersion;
    inner.onActiveListRendered(current - 1);

    expect(inner.indexedPublishGeneration).toBe(7);
    expect(inner.indexedPendingDisplaySlots).not.toBeNull();
    expect(
      inner.frontierWorker.posted.some(
        (message) => (message as { type?: string }).type === 'published',
      ),
    ).toBe(false);
  });

  it('keeps the startup traversal camera through rotation and releases after one-unit translation', () => {
    const inner = fixture() as ReturnType<typeof fixture> & {
      refreshStartupMainRadLodHold: (camera: THREE.Camera) => void;
      startupMainRadLodHold?: { camera: THREE.Camera; settledPosition?: THREE.Vector3 };
    };
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(4, 2, -3);
    camera.updateMatrixWorld(true);
    inner.startupMainRadLodHold = {
      camera: camera.clone(),
      settledPosition: camera.position.clone(),
    };

    camera.rotateY(Math.PI / 2);
    camera.updateMatrixWorld(true);
    inner.refreshStartupMainRadLodHold(camera);
    expect(inner.startupMainRadLodHold).toBeDefined();

    camera.position.x += 1.01;
    camera.updateMatrixWorld(true);
    inner.refreshStartupMainRadLodHold(camera);
    expect(inner.startupMainRadLodHold).toBeUndefined();
  });
});
