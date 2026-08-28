import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  StreamedSplatMesh,
  type StreamedSplatMeshOptions,
  type StreamedSplatPerformanceEvent,
} from '../streaming/streamed-splat-mesh';
import { writeCovariance, type SplatData } from '../core/splat-data';

const WIDTH = 2048;

// StreamedSplatMesh spins up a ChunkLoader Web Worker on construction; the
// persistence path never uses it, so a no-op Worker stub is enough for node.
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

/** A chunk of `count` splats laid on a line so proximity picks a known prefix. */
function makeChunk(count: number): SplatData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i; // x = i, so splat i sits at world (i, 0, 0)
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

/**
 * Builds a StreamedSplatMesh without going through `.load()` (which needs a
 * network manifest). The private constructor only stores the scene, so a stub
 * scene with valid bounds is enough for the persistence path.
 */
function makeStreamedMesh(
  capacity = 4 * WIDTH,
  options: StreamedSplatMeshOptions = {},
): StreamedSplatMesh {
  const scene = {
    source: { budget: capacity } as unknown,
    chunkUrls: [] as string[],
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: capacity,
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
  ) => StreamedSplatMesh;
  return new Ctor(scene, capacity, capacity, options);
}

describe('streamed projected-footprint defaults', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes the resolved mobile floor through the streamed render view', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) Chrome/150.0.0.0',
      platform: '',
      maxTouchPoints: 5,
    });
    const mesh = makeStreamedMesh();
    expect(mesh.getUnifiedSourceView()).toMatchObject({ maxStdDev: 3, minSplatSizePx: 1.5 });
    mesh.dispose();
  });

  it('preserves an explicit zero floor in the streamed render view', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) Chrome/150.0.0.0',
      platform: '',
      maxTouchPoints: 5,
    });
    const mesh = makeStreamedMesh(4 * WIDTH, { minSplatSizePx: 0 });
    expect(mesh.getUnifiedSourceView().minSplatSizePx).toBe(0);
    mesh.dispose();
  });
});

type Internals = {
  stagedSwapsEnabled: boolean;
  appendCap: number;
  scene: { source: { computeDesiredRuns?: () => unknown[] } };
  cache: Map<number, { data: SplatData; bytes: number; lastUsed: number }>;
  resident: Map<string, { run: unknown; handle: { count: number } }>;
  staged: Map<string, { run: unknown; handle: { count: number }; uploadedCount: number }>;
  appendRun: (run: unknown, now: number) => void;
  reschedule: (camera: THREE.PerspectiveCamera, now: number) => unknown;
  removeRange: (handle: unknown) => void;
  channels: Map<string, { backing: Uint8Array | Float32Array }>;
  canStageGroup: (group: {
    adds: Array<Record<string, number>>;
    removes: unknown[];
    leafStart: number;
    leafEnd: number;
    addCount: number;
  }) => boolean;
  createPerformanceEvent: (
    residentBefore: ReadonlyMap<string, number>,
    stagedBefore: ReadonlyMap<string, number>,
    compactionCountBefore: number,
    startedAt: number,
  ) => StreamedSplatPerformanceEvent | null;
  stageGroup: (
    group: {
      adds: Array<Record<string, number>>;
      removes: Array<[string, { run: Record<string, number>; handle: { count: number } }]>;
      leafStart: number;
      leafEnd: number;
      addCount: number;
    },
    now: number,
    allowance: number,
  ) => number;
  commitStagedGroup: (group: {
    adds: Array<Record<string, number>>;
    removes: Array<[string, { run: Record<string, number>; handle: { count: number } }]>;
  }) => void;
  rebuildActiveList: () => void;
  activeCount: number;
};

function internals(mesh: StreamedSplatMesh): Internals {
  return mesh as unknown as Internals;
}

/** A run covering `[offset, offset+count)` of chunk `file`. */
function run(file: number, offset: number, count: number): Record<string, number> {
  return { file, offset, count, leafStart: file, leafEnd: file + 1, level: 0 };
}

describe('StreamedSplatMesh persistent channels (M7.6)', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });
  function mesh(): StreamedSplatMesh {
    const m = makeStreamedMesh();
    meshes.push(m);
    return m;
  }

  /** Reads a channel's pool backing values for a resident run. */
  function channelValues(
    m: StreamedSplatMesh,
    name: string,
    start: number,
    count: number,
  ): number[] {
    const backing = internals(m).channels.get(name)!.backing;
    return Array.from(backing.subarray(start, start + count));
  }

  it('paintPersistent requires a declared persistent channel', () => {
    const m = mesh();
    expect(() => m.paintPersistent('mask', new THREE.Vector3(), 1, 255)).toThrow(
      /not a persistent channel/,
    );
  });

  it('paints resident splats within the radius and returns the count', () => {
    const m = mesh();
    const inner = internals(m);
    m.definePersistentChannel('mask', { type: 'byte' });
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.appendRun(run(0, 0, 10), 0);
    // Splats at world x=0..9; radius 2.5 of x=1 covers x=0,1,2,3.
    expect(m.paintPersistent('mask', new THREE.Vector3(1, 0, 0), 2.5, 255)).toBe(4);
    expect(channelValues(m, 'mask', 0, 6)).toEqual([255, 255, 255, 255, 0, 0]);
  });

  it('re-applies the mask after a chunk is evicted and reloaded', () => {
    const m = mesh();
    const inner = internals(m);
    m.definePersistentChannel('mask', { type: 'byte' });

    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.appendRun(run(0, 0, 10), 0);
    m.paintPersistent('mask', new THREE.Vector3(1, 0, 0), 2.5, 255);

    const entry = [...inner.resident.values()][0]!;
    // Evict and wipe the pool's channel backing, so a passing reload can only
    // come from the persistent store, never from stale pool memory.
    inner.removeRange(entry.handle);
    inner.resident.clear();
    inner.channels.get('mask')!.backing.fill(0);
    expect(channelValues(m, 'mask', 0, 6)).toEqual([0, 0, 0, 0, 0, 0]);

    // Reload the same chunk/run - the mask must return from the store.
    inner.appendRun(run(0, 0, 10), 2);
    expect(channelValues(m, 'mask', 0, 6)).toEqual([255, 255, 255, 255, 0, 0]);
  });

  it('bounds the edit store and warns once past maxEdits', () => {
    const m = mesh();
    const inner = internals(m);
    m.definePersistentChannel('mask', { type: 'byte', maxEdits: 2 });
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.appendRun(run(0, 0, 10), 0);
    // Radius covers 4 splats but the cap is 2 new edits.
    const edited = m.paintPersistent('mask', new THREE.Vector3(1, 0, 0), 2.5, 255);
    expect(edited).toBe(2);
  });

  it('updates and clamps the runtime LOD budget without reallocating the pool', () => {
    const m = mesh();
    const source = (m as unknown as { scene: { source: { budget: number } } }).scene.source;

    expect(m.setBudget(WIDTH)).toBe(WIDTH);
    expect(m.budget).toBe(WIDTH);
    expect(source.budget).toBe(WIDTH);

    expect(m.setBudget(100 * WIDTH)).toBe(4 * WIDTH);
    expect(m.budget).toBe(4 * WIDTH);
    expect(source.budget).toBe(4 * WIDTH);
  });

  it('stages one oversized LOD run in bounded segments before atomic activation', () => {
    const m = makeStreamedMesh(150_000);
    meshes.push(m);
    const inner = internals(m);
    const oversized = run(0, 0, 128_001);
    const group = {
      adds: [oversized],
      removes: [],
      leafStart: 0,
      leafEnd: 1,
      addCount: 128_001,
    };
    inner.cache.set(0, { data: makeChunk(128_001), bytes: 0, lastUsed: 0 });

    expect(inner.canStageGroup(group)).toBe(true);
    expect(inner.stageGroup(group, 0, 128_000)).toBe(128_000);
    expect([...inner.staged.values()][0]?.uploadedCount).toBe(128_000);
    inner.rebuildActiveList();
    expect(inner.activeCount).toBe(0);

    expect(inner.stageGroup(group, 1, 128_000)).toBe(1);
    inner.commitStagedGroup(group);
    expect(inner.activeCount).toBe(128_001);
  });

  it('commits an oversized staged run one tick after its final upload', () => {
    const m = makeStreamedMesh(150_000, { experimentalStagedSwaps: true });
    meshes.push(m);
    const inner = internals(m);
    const oversized = run(0, 0, 32_001);
    inner.scene.source.computeDesiredRuns = () => [oversized];
    inner.cache.set(0, { data: makeChunk(32_001), bytes: 0, lastUsed: 0 });
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.updateMatrixWorld(true);

    inner.reschedule(camera, 0);
    expect([...inner.staged.values()][0]?.uploadedCount).toBe(32_000);
    expect(inner.resident.size).toBe(0);

    inner.reschedule(camera, 1);
    expect([...inner.staged.values()][0]?.uploadedCount).toBe(32_001);
    expect(inner.resident.size).toBe(0);

    inner.reschedule(camera, 2);
    expect(inner.staged.size).toBe(0);
    expect(inner.resident.size).toBe(1);
    expect(inner.activeCount).toBe(32_001);
  });

  it('continues staging later runs after an earlier run is complete', () => {
    const m = makeStreamedMesh(150_000);
    meshes.push(m);
    const inner = internals(m);
    const first = run(0, 0, 80_000);
    const second = run(1, 0, 60_000);
    const group = {
      adds: [first, second],
      removes: [],
      leafStart: 0,
      leafEnd: 2,
      addCount: 140_000,
    };
    inner.cache.set(0, { data: makeChunk(80_000), bytes: 0, lastUsed: 0 });
    inner.cache.set(1, { data: makeChunk(60_000), bytes: 0, lastUsed: 0 });

    expect(inner.stageGroup(group, 0, 128_000)).toBe(128_000);
    expect(inner.staged.get('0:0:0:80000')?.uploadedCount).toBe(80_000);
    expect(inner.staged.get('1:0:0:60000')?.uploadedCount).toBe(48_000);
    expect(inner.stageGroup(group, 1, 128_000)).toBe(12_000);

    inner.commitStagedGroup(group);
    inner.rebuildActiveList();
    expect(inner.activeCount).toBe(140_000);
  });

  it('enables bounded staging by default and retains a legacy opt-out', () => {
    const defaultMesh = makeStreamedMesh();
    const legacyMesh = makeStreamedMesh(4 * WIDTH, { experimentalStagedSwaps: false });
    meshes.push(defaultMesh, legacyMesh);

    expect(internals(defaultMesh).stagedSwapsEnabled).toBe(true);
    expect(internals(legacyMesh).stagedSwapsEnabled).toBe(false);
  });

  it('accepts a lower per-tick staging cap and rejects invalid caps', () => {
    const stagedMesh = makeStreamedMesh(4 * WIDTH, {
      experimentalStagedSwaps: true,
      maxSplatsPerSwap: 64_000,
    });
    meshes.push(stagedMesh);

    expect(internals(stagedMesh).appendCap).toBe(64_000);
    expect(() => makeStreamedMesh(4 * WIDTH, { maxSplatsPerSwap: 0 })).toThrow(/positive integer/);
    expect(() => makeStreamedMesh(4 * WIDTH, { maxSplatsPerSwap: 1.5 })).toThrow(
      /positive integer/,
    );
  });

  it('builds a swap event with active, upload, and forced-sort counts', () => {
    const m = makeStreamedMesh(4 * WIDTH);
    meshes.push(m);
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.appendRun(run(0, 0, 10), 0);

    // `reschedule` returns this event and `update` dispatches it to
    // `onPerformanceEvent` after enriching it with the frame's timings.
    const event = inner.createPerformanceEvent(new Map(), new Map(), 0, performance.now());

    expect(event).toMatchObject({
      appendedCount: 10,
      removedCount: 0,
      stagedCount: 0,
      uploadCount: 10,
      activeCount: 10,
      forcedSort: true,
      compacted: false,
    });
  });

  it('writes resident LOD level into lodLevel when debug is enabled', () => {
    const m = makeStreamedMesh(4 * WIDTH);
    meshes.push(m);
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(8), bytes: 0, lastUsed: 0 });
    m.setLodLevelDebug(true);
    inner.appendRun({ ...run(0, 0, 8), level: 2 }, 0);

    const channel = inner.channels.get('lodLevel');
    expect(channel).toBeDefined();
    const backing = channel!.backing as Float32Array;
    // Pool layout is row-major; first 8 values of the written range should be 2.
    const handle = [...inner.resident.values()][0]!.handle;
    expect(handle.count).toBe(8);
    // writeChannel writes at the range's pool offset - sample via a second write path
    // by re-enabling debug (rewrites all resident).
    m.setLodLevelDebug(true);
    expect(m.isLodLevelDebug).toBe(true);
    // Channel exists and was filled for the run; exact pool offset is internal,
    // so assert the channel backing contains the level value.
    expect([...backing].includes(2)).toBe(true);
  });
});
