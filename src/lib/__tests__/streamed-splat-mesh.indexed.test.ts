import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { createStreamedMeshFixture } from './helpers/streamed-mesh-fixture';
import { StreamedSplatMesh } from '../streaming/streamed-splat-mesh';
import { experiments } from '../internal/experiments';
import { writeCovariance } from '../core/splat-data';
import type { FrontierPlanMessage, PlanSplats } from '../formats/rad/frontier-worker-protocol';

class RecordingWorker {
  static last: RecordingWorker | undefined;
  readonly posted: Record<string, unknown>[] = [];
  onmessage: unknown = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  terminated = false;
  constructor() {
    RecordingWorker.last = this;
  }
  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
}

function splats(globals: number[], withSh = false): PlanSplats {
  const count = globals.length;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = globals[i] as number;
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  const shPacked = withSh
    ? {
        bands: 1 as const,
        packed: Uint32Array.from(
          globals.flatMap((global) => [global * 100 + 1, global * 100 + 2, global * 100 + 3]),
        ),
        range: { min: [-1, -1, -1] as const, max: [1, 1, 1] as const },
      }
    : undefined;
  return {
    count,
    globals: Uint32Array.from(globals),
    positions,
    colors,
    covariances,
    ...(shPacked ? { shPacked } : {}),
  };
}

const empty = (): PlanSplats => splats([]);

function plan(
  generation: number,
  globals: number[],
  writeSlots: number[],
  candidateSlots?: number[],
  withSh = false,
): FrontierPlanMessage {
  return {
    type: 'plan',
    seq: generation,
    moveSlots: new Uint32Array(0),
    moves: empty(),
    appendStart: 0,
    appends: splats(globals, withSh),
    writeSlots: Uint32Array.from(writeSlots),
    candidateGeneration: generation,
    ...(candidateSlots ? { candidateSlots: Uint32Array.from(candidateSlots) } : {}),
    degenerateStart: 0,
    degenerateCount: 0,
    touched: new Uint32Array(0),
    residentCount: 2 + globals.length,
    displayCount: candidateSlots?.length ?? 2,
    gatherMissing: 0,
    dropped: 0,
    evicted: new Uint32Array(0),
    solvedLimit: 0.02,
    capacity: 8,
    converged: candidateSlots !== undefined,
    cacheBytes: 0,
    cacheLimitBytes: 1024,
  };
}

function makeMesh(): StreamedSplatMesh {
  const previous = experiments.radPager;
  experiments.radPager = 'indexed';
  try {
    return createStreamedMeshFixture(
      {
        source: { budget: 4 } as unknown,
        chunkUrls: [] as string[],
        chunkKind: 'file' as const,
        bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(10, 1, 1)),
        pinnedFiles: new Set<number>(),
        maxResidentSplats: 4,
        chunkSize: 4,
        foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 },
      },
      4,
      8,
      { foveationMode: 'page-table', foveationDrawBudget: 4, maxBudget: 4, shBands: 1 },
      RecordingWorker,
    );
  } finally {
    experiments.radPager = previous;
  }
}

describe('StreamedSplatMesh indexed RAD publication', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
    RecordingWorker.last = undefined;
  });

  it('keeps parents displayed while children stage, then acknowledges unified publication', () => {
    const mesh = makeMesh();
    meshes.push(mesh);
    const inner = mesh as unknown as {
      applyFrontierPlan: (message: FrontierPlanMessage) => void;
    };

    inner.applyFrontierPlan(plan(1, [0, 1], [0, 1], [0, 1]));
    expect(mesh.activeSplatCount).toBe(2);
    expect(RecordingWorker.last?.posted.filter((message) => message.type === 'published')).toEqual(
      [],
    );
    expect(mesh.getUnifiedSourceView().activeCount).toBe(2);
    expect(RecordingWorker.last?.posted.at(-1)).toEqual({
      type: 'published',
      generation: 1,
      activeListVersion: 1,
    });

    inner.applyFrontierPlan(plan(2, [2, 3], [2, 3]));
    expect(mesh.activeSplatCount).toBe(2);
    expect(mesh.getUnifiedSourceView().activeCount).toBe(2);
    expect(RecordingWorker.last?.posted.at(-1)).toEqual({
      type: 'published',
      generation: 1,
      activeListVersion: 1,
    });

    inner.applyFrontierPlan(plan(2, [4, 5], [4, 5], [2, 3, 4, 5]));
    expect(mesh.activeSplatCount).toBe(4);
    expect(RecordingWorker.last?.posted.filter((message) => message.type === 'published')).toEqual([
      { type: 'published', generation: 1, activeListVersion: 1 },
    ]);
    const view = mesh.getUnifiedSourceView();
    expect(view.activeCount).toBe(4);
    expect(Array.from((view.sourceIndex.array as Uint32Array).subarray(0, 4))).toEqual([
      2, 3, 4, 5,
    ]);
    expect(RecordingWorker.last?.posted.at(-1)).toEqual({
      type: 'published',
      generation: 2,
      activeListVersion: 2,
    });
  });

  it('keeps sparse SH and persistent channel values attached to stable slots', () => {
    const mesh = makeMesh();
    meshes.push(mesh);
    mesh.definePersistentChannel('mask', { type: 'byte' });
    const inner = mesh as unknown as {
      applyFrontierPlan: (message: FrontierPlanMessage) => void;
      slabPages: unknown[];
      pageTableGlobals: Uint32Array;
      channels: Map<string, { backing: Uint8Array }>;
      poolRangeBacking: (page: unknown) => {
        start: number;
        backing: { shPacked: Uint32Array[] };
      };
    };

    inner.applyFrontierPlan(plan(1, [0, 1], [0, 1], [0, 1], true));
    mesh.getUnifiedSourceView();
    inner.applyFrontierPlan(plan(2, [2, 3], [2, 3], undefined, true));
    expect(mesh.paintPersistent('mask', new THREE.Vector3(2.5, 0, 0), 0.6, 7)).toBe(2);
    inner.applyFrontierPlan(plan(2, [4, 5], [4, 5], [2, 3, 4, 5], true));
    mesh.getUnifiedSourceView();

    const { start, backing } = inner.poolRangeBacking(inner.slabPages[0]);
    const channel = inner.channels.get('mask')!.backing;
    expect(Array.from(channel.subarray(start + 2, start + 6))).toEqual([7, 7, 0, 0]);
    for (const slot of [2, 3, 4, 5]) {
      const global = slot;
      for (let coefficient = 0; coefficient < 3; coefficient++) {
        expect(backing.shPacked[0]![(start + slot) * 4 + coefficient]).toBe(
          global * 100 + coefficient + 1,
        );
      }
    }

    // Slots retired by generation 2 can be reused only after its ACK. A new
    // occupant outside the stored stroke starts with a cleared channel value.
    inner.applyFrontierPlan(plan(3, [6, 7], [0, 1], [0, 1], true));
    mesh.getUnifiedSourceView();
    expect(Array.from(channel.subarray(start, start + 2))).toEqual([0, 0]);
    expect(Array.from(inner.pageTableGlobals.subarray(0, 6))).toEqual([
      6, 7, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff,
    ]);
  });

  it('does not acknowledge a pending candidate after disposal', () => {
    const mesh = makeMesh();
    const worker = RecordingWorker.last!;
    const inner = mesh as unknown as {
      applyFrontierPlan: (message: FrontierPlanMessage) => void;
      onActiveListPublished: (version: number) => void;
    };
    inner.applyFrontierPlan(plan(1, [0, 1], [0, 1], [0, 1]));
    mesh.dispose();
    inner.onActiveListPublished(1);
    expect(worker.terminated).toBe(true);
    expect(worker.posted.filter((message) => message.type === 'published')).toEqual([]);
  });

  it('does not let an older sort publication acknowledge a newer candidate', () => {
    const mesh = makeMesh();
    meshes.push(mesh);
    const worker = RecordingWorker.last!;
    const inner = mesh as unknown as {
      applyFrontierPlan: (message: FrontierPlanMessage) => void;
      onActiveListPublished: (version: number) => void;
    };

    inner.applyFrontierPlan(plan(1, [0, 1], [0, 1], [0, 1]));
    // Before generation 1 crosses its sort boundary, generation 2 replaces
    // the active list. A stale reply for version 1 must not retire generation
    // 2's displayed slots.
    inner.applyFrontierPlan(plan(2, [2, 3], [2, 3], [2, 3]));
    inner.onActiveListPublished(1);
    expect(worker.posted.filter((message) => message.type === 'published')).toEqual([]);

    inner.onActiveListPublished(2);
    expect(worker.posted.at(-1)).toEqual({
      type: 'published',
      generation: 2,
      activeListVersion: 2,
    });
  });

  it('requires the full 2x reservation and otherwise initializes the classic pager', () => {
    const previous = experiments.radPager;
    experiments.radPager = 'indexed';
    try {
      const mesh = createStreamedMeshFixture(
        {
          source: { budget: 4 } as unknown,
          chunkUrls: [],
          chunkKind: 'file',
          bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(10, 1, 1)),
          pinnedFiles: new Set<number>(),
          maxResidentSplats: 4,
          foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 },
        },
        4,
        6,
        { foveationMode: 'page-table', foveationDrawBudget: 4, maxBudget: 4 },
        RecordingWorker,
      );
      meshes.push(mesh);
      expect(RecordingWorker.last?.posted[0]).toMatchObject({ pagerMode: 'classic' });
    } finally {
      experiments.radPager = previous;
    }
  });
});
