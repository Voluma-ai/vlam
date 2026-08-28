import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { StreamedSplatMesh } from '../streaming/streamed-splat-mesh';
import { writeCovariance, type SplatData } from '../core/splat-data';
import { runKey, type LodRun } from '../streaming/lod-scheduler';

/**
 * Classic `.lcc` startup hold: `initialReveal: 'hold-near-l0'` with
 * `neverRetireCoverageEarly` freezes the camera's home coverage group (L0 when
 * it fits, else coarsened), fetches only those files, commits per-slice while
 * the mesh is hidden, and releases once that set is resident.
 */

const WIDTH = 2048;

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

function makeChunk(count: number): SplatData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i;
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

function run(
  partial: Omit<LodRun, 'offset' | 'count'> & { offset?: number; count?: number },
): LodRun {
  return {
    offset: 0,
    count: 100,
    ...partial,
  };
}

type CachedChunk = { data: SplatData; bytes: number; lastUsed: number };

type Internals = {
  cache: Map<number, CachedChunk>;
  resident: Map<string, { run: LodRun }>;
  staged: Map<string, { run: LodRun; uploadedCount: number }>;
  fetching: Map<number, { kind: string }>;
  neededFiles: Set<number>;
  failedFiles: Set<number>;
  pendingWork: boolean;
  activeCount: number;
  cacheBytesTotal: number;
  freeSplatCapacity: number;
  initialRevealPhase: 'off' | 'capture' | 'holding' | 'released';
  frozenCriticalRuns: LodRun[] | null;
  reschedule: (camera: THREE.Camera, now: number) => unknown;
  requestChunk: (file: number, kind: string) => void;
  evictChunks: (now: number) => void;
  scene: {
    source: {
      computeDesiredRuns: (...args: unknown[]) => LodRun[];
      coarsestRunsFor: (from: number, to: number) => LodRun[];
      coverageRunsFor?: (cameraLocal: THREE.Vector3, frustum: THREE.Frustum) => LodRun[];
      lodBaseDistance: number;
    };
    pinnedFiles: Set<number>;
  };
};

function internals(mesh: StreamedSplatMesh): Internals {
  return mesh as unknown as Internals;
}

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.updateMatrixWorld(true);

interface MeshConfig {
  desired: LodRun[];
  /** Full LOD ladder for {@link LodSource.runsAtLevelFor}; defaults to `desired`. */
  levelRuns?: LodRun[];
  coarsest?: LodRun[];
  /** In-view coarsest cover for `'hold-coverage'`; omit to leave the hook unset. */
  coverage?: LodRun[];
  capacity?: number;
  reveal?: 'hold-near-l0' | 'hold-coverage' | 'progressive';
  neverRetire?: boolean;
  maxSplatsPerSwap?: number;
  /** Chunk-file index of an always-resident environment tile. */
  environment?: number;
  environmentEnabled?: boolean;
}

function makeMesh(config: MeshConfig): StreamedSplatMesh {
  const coarsest = config.coarsest ?? [];
  const levelRuns = config.levelRuns ?? config.desired;
  const coverage = config.coverage;
  const capacity = config.capacity ?? 4 * WIDTH;
  const scene = {
    source: {
      budget: 4 * WIDTH,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => config.desired,
      coarsestRunsFor: (from: number, to: number) =>
        coarsest.filter((r) => r.leafStart < to && r.leafEnd > from),
      runsAtLevelFor: (from: number, to: number, level: number) =>
        levelRuns.filter((r) => r.level === level && r.leafStart < to && r.leafEnd > from),
      ...(coverage === undefined ? {} : { coverageRunsFor: () => coverage }),
    },
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set([
      ...coarsest.map((r) => r.file),
      ...(config.environment === undefined ? [] : [config.environment]),
    ]),
    maxResidentSplats: 4 * WIDTH,
    chunkUrls: [] as string[],
    ...(config.environment === undefined ? {} : { environment: { file: config.environment } }),
  };
  // Ensure chunkUrls covers every file index used.
  const maxFile = Math.max(
    0,
    ...config.desired.map((r) => r.file),
    ...levelRuns.map((r) => r.file),
    ...coarsest.map((r) => r.file),
    ...(config.coverage ?? []).map((r) => r.file),
    ...(config.environment === undefined ? [] : [config.environment]),
  );
  scene.chunkUrls = Array.from({ length: maxFile + 1 }, (_, f) => `https://host/data.bin#${f}`);

  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
    worker: unknown,
    neverRetireCoverageEarly: boolean,
  ) => StreamedSplatMesh;
  return new Ctor(
    scene,
    capacity,
    capacity,
    {
      initialReveal: config.reveal ?? 'hold-near-l0',
      maxSplatsPerSwap: config.maxSplatsPerSwap,
      experimentalStagedSwaps: true,
      ...(config.environmentEnabled === undefined
        ? {}
        : { environmentEnabled: config.environmentEnabled }),
    },
    undefined,
    config.neverRetire ?? true,
  );
}

describe('StreamedSplatMesh initial reveal (hold-near-l0)', () => {
  const meshes: StreamedSplatMesh[] = [];

  /** Builds a mesh, records every fetch, and never touches the network. */
  function setup(config: MeshConfig): {
    mesh: StreamedSplatMesh;
    inner: Internals;
    requested: { file: number; kind: string }[];
  } {
    const mesh = makeMesh(config);
    meshes.push(mesh);
    const inner = internals(mesh);
    const requested: { file: number; kind: string }[] = [];
    // Deterministic: capture requests instead of issuing real range fetches.
    inner.requestChunk = (file, kind) => {
      requested.push({ file, kind });
    };
    return { mesh, inner, requested };
  }

  function cache(inner: Internals, file: number, count: number): void {
    inner.cache.set(file, { data: makeChunk(count), bytes: 0, lastUsed: 0 });
  }

  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });

  it('reports ready after the first reschedule when no near-L0 is resolved', () => {
    const far = run({
      file: 0,
      level: 5,
      leafStart: 0,
      leafEnd: 1,
      distance: 200,
      inView: true,
      coverageGroup: 1,
    });
    const { mesh, inner } = setup({ desired: [far] });

    inner.reschedule(camera, 0);

    expect(mesh.initialRevealState.status).toBe('ready');
    expect(inner.initialRevealPhase).toBe('released');
  });

  it('freezes the critical set once; a later camera cut cannot change it', () => {
    const near = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
    });
    const { inner, requested } = setup({ desired: [near] });

    inner.reschedule(camera, 0);
    expect(inner.initialRevealPhase).toBe('holding');
    expect(inner.frozenCriticalRuns?.map((r) => r.file)).toEqual([0]);

    // Camera moved: the schedule now resolves an entirely different near cell.
    const moved = run({
      file: 5,
      level: 0,
      leafStart: 5,
      leafEnd: 6,
      distance: 0,
      inView: true,
      coverageGroup: 9,
    });
    inner.scene.source.computeDesiredRuns = () => [moved];
    requested.length = 0;
    inner.reschedule(camera, 1);

    expect(inner.frozenCriticalRuns?.map((r) => r.file)).toEqual([0]);
    expect(requested.every((r) => r.file === 0)).toBe(true);
    expect(requested.some((r) => r.file === 5)).toBe(false);
  });

  it('fetches only the critical L0 files, never neighbours / coarse / far', () => {
    const near = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
    });
    const neighbourL1 = run({
      file: 1,
      level: 1,
      leafStart: 1,
      leafEnd: 2,
      distance: 0,
      inView: true,
      coverageGroup: 2,
    });
    const coarse = run({
      file: 2,
      level: 5,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 3,
    });
    const farL0 = run({
      file: 3,
      level: 0,
      leafStart: 2,
      leafEnd: 3,
      distance: 200,
      inView: true,
      coverageGroup: 4,
    });
    const { inner, requested } = setup({ desired: [near, neighbourL1, coarse, farL0] });

    inner.reschedule(camera, 0);

    expect(inner.frozenCriticalRuns?.map((r) => r.file)).toEqual([0]);
    expect(requested.map((r) => r.file)).toEqual([0]);
    expect(requested.some((r) => r.file === 1)).toBe(false);
    expect(requested.some((r) => r.file === 2)).toBe(false);
    expect(requested.some((r) => r.file === 3)).toBe(false);
  });

  it('holds only the home cell, not screen-facing neighbours', () => {
    const near = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
    });
    const facingNeighbour = run({
      file: 1,
      level: 2,
      leafStart: 1,
      leafEnd: 2,
      distance: 15,
      inView: true,
      screenImportance: 0.1,
      coverageGroup: 2,
    });
    const peripheralNeighbour = run({
      file: 2,
      level: 1,
      leafStart: 2,
      leafEnd: 3,
      distance: 15,
      inView: true,
      screenImportance: 2,
      coverageGroup: 3,
    });
    const { inner, requested } = setup({ desired: [near, facingNeighbour, peripheralNeighbour] });

    inner.reschedule(camera, 0);

    expect(inner.frozenCriticalRuns?.map((run) => run.file)).toEqual([0]);
    expect(requested.map((request) => request.file)).toEqual([0]);
  });

  it('prefers an out-of-view home cell over a screen-filling neighbour', () => {
    // HiRes: camera inside the tile looking out - home fails frustum, facade wins screen.
    const home = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: false,
      coverageGroup: 1,
      count: 100,
    });
    const facade = run({
      file: 1,
      level: 1,
      leafStart: 1,
      leafEnd: 2,
      distance: 8,
      inView: true,
      screenImportance: 0.01,
      coverageGroup: 2,
      count: 100,
    });
    const { inner, requested } = setup({ desired: [facade, home], capacity: 2_000_000 });

    inner.reschedule(camera, 0);

    expect(inner.frozenCriticalRuns?.map((run) => run.file)).toEqual([0]);
    expect(requested.map((request) => request.file)).toEqual([0]);
    expect(requested.some((request) => request.file === 1)).toBe(false);
  });

  it('holds only the nearest L0 cell when several are within base distance', () => {
    const home = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 1,
      inView: true,
      coverageGroup: 1,
    });
    const homeSlice = run({
      file: 1,
      level: 0,
      leafStart: 1,
      leafEnd: 2,
      distance: 1.5,
      inView: true,
      coverageGroup: 1,
    });
    const otherNear = run({
      file: 2,
      level: 0,
      leafStart: 2,
      leafEnd: 3,
      distance: 3,
      inView: true,
      coverageGroup: 2,
    });
    const { inner, requested } = setup({ desired: [otherNear, homeSlice, home] });

    inner.reschedule(camera, 0);

    expect(inner.frozenCriticalRuns?.map((r) => r.file).sort()).toEqual([0, 1]);
    expect(requested.some((r) => r.file === 2)).toBe(false);
  });

  it('ignores neighbour volume when choosing the home hold set', () => {
    const near = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
    });
    const neighbours = [1, 2, 3, 4, 5, 6].map((i) =>
      run({
        file: i,
        level: 1,
        leafStart: i,
        leafEnd: i + 1,
        distance: 15,
        inView: true,
        screenImportance: 0.05 * i,
        coverageGroup: 10 + i,
      }),
    );
    const { inner } = setup({
      desired: [near, ...neighbours],
      capacity: 16 * WIDTH,
    });

    inner.reschedule(camera, 0);

    expect(inner.frozenCriticalRuns?.map((r) => r.file)).toEqual([0]);
  });

  it('stages and commits a cached hold slice while its sibling is still missing', () => {
    const fine0 = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 7,
    });
    const fine1 = run({
      file: 1,
      level: 0,
      leafStart: 1,
      leafEnd: 2,
      distance: 0,
      inView: true,
      coverageGroup: 7,
    });
    const { mesh, inner, requested } = setup({ desired: [fine0, fine1] });
    cache(inner, 0, 100);

    inner.reschedule(camera, 0);

    // Hold commits per-slice (mesh is invisible), so a ready sibling lands in
    // the pool without waiting on the rest of the cell.
    expect(inner.resident.has(runKey(fine0))).toBe(true);
    expect(inner.resident.size).toBe(1);
    expect(mesh.initialRevealState.status).toBe('pending');
    expect(requested.some((r) => r.file === 1)).toBe(true);
  });

  it('skips a missing earlier file and stages a later available one', () => {
    const fine0 = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 7,
    });
    const fine1 = run({
      file: 1,
      level: 0,
      leafStart: 1,
      leafEnd: 2,
      distance: 0,
      inView: true,
      coverageGroup: 7,
    });
    const { inner } = setup({ desired: [fine0, fine1] });
    cache(inner, 1, 100); // later sibling ready, earlier one absent

    inner.reschedule(camera, 0);

    expect(inner.resident.has(runKey(fine1))).toBe(true);
    expect(inner.resident.has(runKey(fine0))).toBe(false);
  });

  it('drops a fully staged file from neededFiles so the CPU cache may reclaim it', () => {
    const fine0 = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 7,
    });
    const fine1 = run({
      file: 1,
      level: 0,
      leafStart: 1,
      leafEnd: 2,
      distance: 0,
      inView: true,
      coverageGroup: 7,
    });
    const { inner } = setup({ desired: [fine0, fine1] });
    cache(inner, 0, 100);

    // Tick 1 commits file 0 (neededFiles is rebuilt before staging, so the
    // exclusion only shows once staging from a prior tick has landed).
    inner.reschedule(camera, 0);
    inner.reschedule(camera, 1);

    expect(inner.resident.has(runKey(fine0))).toBe(true);
    expect(inner.neededFiles.has(0)).toBe(false);
    expect(inner.neededFiles.has(1)).toBe(true);
  });

  it('completes a group larger than the append cap across frames', () => {
    const fine = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 7,
      count: 100,
    });
    const { mesh, inner } = setup({ desired: [fine], maxSplatsPerSwap: 50 });
    cache(inner, 0, 100);

    inner.reschedule(camera, 0);
    // Half staged, nothing committed yet.
    expect(inner.resident.size).toBe(0);
    expect(inner.staged.get(runKey(fine))?.uploadedCount).toBe(50);
    expect(mesh.initialRevealState.status).toBe('pending');

    inner.reschedule(camera, 1);
    expect(inner.resident.size).toBe(1);
    expect(inner.activeCount).toBe(100);
    expect(mesh.initialRevealState.status).toBe('ready');
    expect(inner.initialRevealPhase).toBe('released');
  });

  it('keeps the hold while a home-cell L0 sibling is still missing', () => {
    const cellA0 = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
    });
    const cellA1 = run({
      file: 1,
      level: 0,
      leafStart: 1,
      leafEnd: 2,
      distance: 0,
      inView: true,
      coverageGroup: 1,
    });
    const { mesh, inner } = setup({ desired: [cellA0, cellA1] });
    cache(inner, 0, 100); // first home slice resident; sibling missing

    inner.reschedule(camera, 0);

    expect(inner.resident.has(runKey(cellA0))).toBe(true);
    expect(inner.resident.has(runKey(cellA1))).toBe(false);
    expect(inner.initialRevealPhase).toBe('holding');
    expect(mesh.initialRevealState.status).toBe('pending');
  });

  it('holds every L0 slice of a Quality mega-cell', () => {
    const slices = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      run({
        file: i,
        level: 0,
        leafStart: i,
        leafEnd: i + 1,
        distance: 0,
        inView: true,
        coverageGroup: 1,
        count: 128_000,
      }),
    );
    const { inner } = setup({
      desired: slices,
      capacity: 8_000_000,
    });

    inner.reschedule(camera, 0);

    const frozen = inner.frozenCriticalRuns ?? [];
    const total = frozen.reduce((sum, r) => sum + r.count, 0);
    expect(frozen.length).toBe(8);
    expect(total).toBe(1_024_000);
    expect(frozen.map((r) => r.file)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('degrades to progressive reveal after the complete nearby cut times out', () => {
    const fine = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
    });
    const { mesh, inner } = setup({ desired: [fine] });

    inner.reschedule(camera, 0);
    inner.reschedule(camera, 60_000);

    expect(mesh.initialRevealState).toMatchObject({ status: 'degraded', reason: 'timeout' });
    expect(inner.initialRevealPhase).toBe('released');
  });

  it('degrades to capacity when the critical set exceeds the pool', () => {
    const fine0 = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
      count: 100,
    });
    const fine1 = run({
      file: 1,
      level: 0,
      leafStart: 1,
      leafEnd: 2,
      distance: 0,
      inView: true,
      coverageGroup: 1,
      count: 100,
    });
    // One row (2048) cannot hold two row-aligned home-cell runs (2 × 2048).
    // No L1 alternative is offered, so capacity degrade still fires.
    const { mesh, inner } = setup({ desired: [fine0, fine1], capacity: WIDTH });

    inner.reschedule(camera, 0);

    expect(mesh.initialRevealState).toMatchObject({ status: 'degraded', reason: 'capacity' });
    expect(inner.initialRevealPhase).toBe('released');
  });

  it('falls back to nearby L1 when L0 overflows the pool', () => {
    const fine = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
      count: 3000,
    });
    const mid = run({
      file: 1,
      level: 1,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
      count: 100,
    });
    // Schedule only resolved L0 (as LodScheduler does). L1 comes from the ladder.
    const { mesh, inner, requested } = setup({
      desired: [fine],
      levelRuns: [fine, mid],
      capacity: WIDTH,
    });
    cache(inner, 1, 100);

    inner.reschedule(camera, 0);

    expect(mesh.initialRevealState.status).toBe('ready');
    expect(inner.activeCount).toBe(100);
    expect(inner.resident.has(runKey(mid))).toBe(true);
    expect(inner.resident.has(runKey(fine))).toBe(false);
    expect(requested).not.toContain(0);
  });

  it('falls back to L2 home-only when L1 still overflows', () => {
    const fine = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
      count: 3000,
    });
    const mid = run({
      file: 1,
      level: 1,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
      count: 2500,
    });
    const coarse = run({
      file: 2,
      level: 2,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
      count: 100,
    });
    const { mesh, inner } = setup({
      desired: [fine],
      levelRuns: [fine, mid, coarse],
      capacity: WIDTH,
    });
    cache(inner, 2, 100);

    inner.reschedule(camera, 0);

    expect(mesh.initialRevealState.status).toBe('ready');
    expect(inner.resident.has(runKey(coarse))).toBe(true);
    expect(inner.resident.has(runKey(fine))).toBe(false);
    expect(inner.resident.has(runKey(mid))).toBe(false);
  });

  it('degrades to fetch-failed when a critical file gives up', () => {
    const fine = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
    });
    const { mesh, inner } = setup({ desired: [fine] });
    inner.failedFiles.add(0);

    inner.reschedule(camera, 0);

    expect(mesh.initialRevealState).toMatchObject({ status: 'degraded', reason: 'fetch-failed' });
    expect(inner.initialRevealPhase).toBe('released');
  });

  it('resumes normal fetching once the hold releases', () => {
    const fine = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
    });
    const { mesh, inner, requested } = setup({ desired: [fine] });
    cache(inner, 0, 100);

    inner.reschedule(camera, 0);
    expect(mesh.initialRevealState.status).toBe('ready');
    expect(inner.initialRevealPhase).toBe('released');
    expect(inner.activeCount).toBe(100);

    // Camera walks so a neighbour L1 cut becomes desired - normal streaming.
    const neighbourL1 = run({
      file: 1,
      level: 1,
      leafStart: 1,
      leafEnd: 2,
      distance: 15,
      inView: true,
      coverageGroup: 2,
    });
    inner.scene.source.computeDesiredRuns = () => [neighbourL1];
    requested.length = 0;
    inner.reschedule(camera, 1);

    expect(requested.some((r) => r.file === 1)).toBe(true);
  });

  it('is disabled when hold-near-l0 is set without neverRetireCoverageEarly', () => {
    const near = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
    });
    const { mesh, inner } = setup({ desired: [near], neverRetire: false });
    expect(mesh.initialRevealState.status).toBe('disabled');
    expect(inner.initialRevealPhase).toBe('off');

    cache(inner, 0, 100);
    inner.reschedule(camera, 0);

    // No hold: a cached cell paints immediately under progressive reveal.
    expect(inner.initialRevealPhase).toBe('off');
    expect(mesh.initialRevealState.status).toBe('disabled');
    expect(inner.activeCount).toBe(100);
  });

  it('recaptures the classic-LCC hold after a host applies its final camera pose', () => {
    const near = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      inView: true,
      coverageGroup: 1,
    });
    const { mesh, inner } = setup({ desired: [near] });

    inner.reschedule(camera, 0);
    expect(inner.initialRevealPhase).toBe('holding');

    mesh.recaptureInitialReveal();
    expect(inner.initialRevealPhase).toBe('capture');
    expect(inner.frozenCriticalRuns).toBeNull();
    expect(mesh.initialRevealState.status).toBe('pending');
  });

  it('keeps a near-band resolved cell when the strict screen threshold selects nothing', () => {
    const neighbour = run({
      file: 4,
      level: 1,
      leafStart: 1,
      leafEnd: 2,
      distance: 15,
      inView: true,
      screenImportance: 1.2,
      coverageGroup: 4,
    });
    const { inner } = setup({ desired: [neighbour] });

    inner.reschedule(camera, 0);

    expect(inner.frozenCriticalRuns).toEqual([neighbour]);
  });
});

describe('StreamedSplatMesh initial reveal (hold-coverage)', () => {
  const meshes: StreamedSplatMesh[] = [];

  function setup(config: MeshConfig): {
    mesh: StreamedSplatMesh;
    inner: Internals;
    requested: { file: number; kind: string }[];
  } {
    const mesh = makeMesh({ neverRetire: false, reveal: 'hold-coverage', ...config });
    meshes.push(mesh);
    const inner = internals(mesh);
    const requested: { file: number; kind: string }[] = [];
    inner.requestChunk = (file, kind) => {
      requested.push({ file, kind });
    };
    return { mesh, inner, requested };
  }

  function cache(inner: Internals, file: number, count: number): void {
    inner.cache.set(file, { data: makeChunk(count), bytes: 0, lastUsed: 0 });
  }

  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });

  const finestInView = run({ file: 10, level: 0, leafStart: 0, leafEnd: 4 });
  const finestOutOfView = run({ file: 11, level: 0, leafStart: 4, leafEnd: 8 });
  const coarseInView = run({ file: 0, level: 5, leafStart: 0, leafEnd: 4 });
  const coarseOutOfView = run({ file: 1, level: 5, leafStart: 4, leafEnd: 8 });

  it('is disabled when hold-coverage is set without coverageRunsFor', () => {
    const { mesh, inner } = setup({
      desired: [finestInView],
      reveal: 'hold-coverage',
      neverRetire: false,
    });
    expect(mesh.initialRevealState.status).toBe('disabled');
    expect(inner.initialRevealPhase).toBe('off');
  });

  it('freezes coarsest in-view runs, not the live finest cut', () => {
    const { mesh, inner, requested } = setup({
      desired: [finestInView, finestOutOfView],
      coverage: [coarseInView],
      coarsest: [coarseInView, coarseOutOfView],
    });

    inner.reschedule(camera, 0);

    expect(inner.initialRevealPhase).toBe('holding');
    expect(inner.frozenCriticalRuns?.map((r) => r.file)).toEqual([0]);
    expect(mesh.initialRevealState).toMatchObject({
      status: 'pending',
      totalGroups: 1,
      totalSplats: 100,
    });
    expect(requested.every((r) => r.file === 0)).toBe(true);
    expect(requested.some((r) => r.file === 10 || r.file === 11 || r.file === 1)).toBe(false);
  });

  it('releases when coverage runs are resident, then the live cut may request finest', () => {
    const { mesh, inner, requested } = setup({
      desired: [finestInView],
      coverage: [coarseInView],
    });
    cache(inner, 0, 100);

    inner.reschedule(camera, 0);

    expect(mesh.initialRevealState.status).toBe('ready');
    expect(inner.initialRevealPhase).toBe('released');
    expect(inner.resident.has(runKey(coarseInView))).toBe(true);
    expect(requested.some((r) => r.file === 10)).toBe(false);

    requested.length = 0;
    inner.reschedule(camera, 1);
    expect(requested.some((r) => r.file === 10)).toBe(true);
    // Coarsest in-view cover stays until the live finest cut is actually resident.
    expect(inner.resident.has(runKey(coarseInView))).toBe(true);
  });

  it('replaces released coverage atomically after the complete fine cut is cached', () => {
    const fineLeft = run({ file: 10, level: 0, leafStart: 0, leafEnd: 2 });
    const fineRight = run({ file: 11, level: 0, leafStart: 2, leafEnd: 4 });
    const { mesh, inner } = setup({
      desired: [fineLeft, fineRight],
      coverage: [coarseInView],
    });
    cache(inner, 0, 100);
    inner.reschedule(camera, 0);

    expect(mesh.initialRevealState.status).toBe('ready');
    expect(inner.resident.has(runKey(coarseInView))).toBe(true);

    cache(inner, fineLeft.file, fineLeft.count);
    inner.reschedule(camera, 1);

    // A partial replacement stays inactive, avoiding coarse + fine overdraw.
    expect(inner.resident.has(runKey(coarseInView))).toBe(true);
    expect(inner.resident.has(runKey(fineLeft))).toBe(false);

    cache(inner, fineRight.file, fineRight.count);
    inner.reschedule(camera, 2);

    expect(inner.resident.has(runKey(coarseInView))).toBe(false);
    expect(inner.resident.has(runKey(fineLeft))).toBe(true);
    expect(inner.resident.has(runKey(fineRight))).toBe(true);
  });

  it('recaptures the coverage hold without neverRetireCoverageEarly', () => {
    const { mesh, inner } = setup({
      desired: [finestInView],
      coverage: [coarseInView],
    });

    inner.reschedule(camera, 0);
    expect(inner.initialRevealPhase).toBe('holding');

    mesh.recaptureInitialReveal();
    expect(inner.initialRevealPhase).toBe('capture');
    expect(inner.frozenCriticalRuns).toBeNull();
    expect(mesh.initialRevealState.status).toBe('pending');
  });

  it('fetches the environment tile at priority during the coverage hold', () => {
    const envFile = 99;
    const { mesh, inner, requested } = setup({
      desired: [finestInView],
      coverage: [coarseInView],
      environment: envFile,
    });

    inner.reschedule(camera, 0);

    expect(mesh.initialRevealState.status).toBe('pending');
    expect(requested[0]).toEqual({ file: envFile, kind: 'priority' });
    expect(requested.some((r) => r.file === 0)).toBe(true);
    expect(requested.some((r) => r.file === 10)).toBe(false);
  });

  it('waits for the environment tile even when coverage is already cached', () => {
    const envFile = 99;
    const { mesh, inner } = setup({
      desired: [finestInView],
      coverage: [coarseInView],
      environment: envFile,
    });
    cache(inner, 0, 100);

    inner.reschedule(camera, 0);

    expect(mesh.initialRevealState.status).toBe('pending');
    expect(inner.initialRevealPhase).toBe('holding');
    expect(inner.resident.has(runKey(coarseInView))).toBe(false);
    expect(mesh.environmentSplatCount).toBe(0);

    cache(inner, envFile, 50);
    inner.reschedule(camera, 1);

    expect(mesh.environmentSplatCount).toBe(50);
    expect(mesh.initialRevealState.status).toBe('ready');
    expect(inner.initialRevealPhase).toBe('released');
    expect(inner.resident.has(runKey(coarseInView))).toBe(true);
  });

  it('does not wait for a disabled or failed environment tile', () => {
    const envFile = 99;
    const { mesh, inner } = setup({
      desired: [finestInView],
      coverage: [coarseInView],
      environment: envFile,
      environmentEnabled: false,
    });
    cache(inner, 0, 100);

    inner.reschedule(camera, 0);

    expect(mesh.initialRevealState.status).toBe('ready');
    expect(mesh.environmentSplatCount).toBe(0);

    const failed = setup({
      desired: [finestInView],
      coverage: [coarseInView],
      environment: envFile,
    });
    cache(failed.inner, 0, 100);
    failed.inner.failedFiles.add(envFile);
    failed.inner.reschedule(camera, 0);

    expect(failed.mesh.initialRevealState.status).toBe('ready');
    expect(failed.mesh.environmentSplatCount).toBe(0);
  });
});
