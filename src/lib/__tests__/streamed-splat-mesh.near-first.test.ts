import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  StreamedSplatMesh,
  classicFetchKindForDesired,
  compareClassicSwapGroups,
  compareClassicFetches,
  stampClassicFetchGroups,
  type ClassicFetchWant,
  type SwapGroup,
} from '../streaming/streamed-splat-mesh';
import { writeCovariance, type SplatData } from '../core/splat-data';
import type { LodRun } from '../streaming/lod-scheduler';
import { runKey } from '../streaming/lod-scheduler';

/**
 * Classic LCC near-first streaming: fetch nearest/finest before far coarse
 * pins, and skip coarsest substitute paint next to the camera.
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

function want(
  partial: Partial<ClassicFetchWant> &
    Pick<ClassicFetchWant, 'kind' | 'distance' | 'level' | 'inView'>,
): ClassicFetchWant {
  const phase =
    partial.phase ??
    (partial.level === 0
      ? 'finest-target'
      : partial.kind === 'base'
        ? 'background'
        : partial.level >= 5
          ? 'coverage'
          : 'target');
  return {
    coverageGroup: -1,
    leafStart: 0,
    leafEnd: 1,
    screenImportance: Number.POSITIVE_INFINITY,
    groupDistance: partial.distance,
    groupPending: 1,
    groupInView: partial.inView,
    groupScreenImportance: Number.POSITIVE_INFINITY,
    groupFinest: partial.phase === 'finest-target' || partial.level === 0,
    groupId: `file:${partial.coverageGroup ?? -1}`,
    groupClass: partial.inView ? 0 : 2,
    ...partial,
    phase,
  };
}

describe('classic fetch ranking helpers', () => {
  it('commits a ready screen-centre L1+ slice before unrelated coarse shells', () => {
    const visibleTarget: SwapGroup = {
      adds: [
        run({
          file: 10,
          level: 1,
          leafStart: 10,
          leafEnd: 11,
          distance: 12,
          inView: true,
          screenImportance: 0.05,
          coverageGroup: 2,
        }),
      ],
      removes: [],
      leafStart: 10,
      leafEnd: 11,
      addCount: 100,
    };
    const peripheralCoverage: SwapGroup = {
      adds: [
        run({
          file: 20,
          level: 5,
          leafStart: 0,
          leafEnd: 1,
          distance: 2,
          inView: true,
          screenImportance: 2,
          coverageGroup: 3,
        }),
      ],
      removes: [],
      leafStart: 0,
      leafEnd: 1,
      addCount: 50,
    };
    expect(compareClassicSwapGroups(visibleTarget, peripheralCoverage)).toBeLessThan(0);
  });

  it('puts an L0 cell ahead of coverage, then keeps L1+ slice work contiguous', () => {
    const pending = new Map<number, ClassicFetchWant>([
      [
        20,
        want({
          kind: 'priority',
          distance: 8,
          level: 5,
          inView: true,
          phase: 'coverage',
          coverageGroup: 2,
        }),
      ],
      [
        21,
        want({
          kind: 'priority',
          distance: 8,
          level: 1,
          inView: true,
          phase: 'target',
          coverageGroup: 2,
        }),
      ],
      [
        22,
        want({
          kind: 'priority',
          distance: 8,
          level: 0,
          inView: true,
          phase: 'finest-target',
          coverageGroup: 2,
        }),
      ],
      [
        30,
        want({
          kind: 'priority',
          distance: 12,
          level: 5,
          inView: true,
          phase: 'coverage',
          coverageGroup: 3,
        }),
      ],
      [
        31,
        want({
          kind: 'priority',
          distance: 12,
          level: 1,
          inView: true,
          phase: 'target',
          coverageGroup: 3,
        }),
      ],
    ]);
    stampClassicFetchGroups(pending, 10);
    const ordered = [...pending.entries()].sort((a, b) =>
      compareClassicFetches(a[1], b[1], a[0], b[0]),
    );
    expect(ordered.map(([file]) => file)).toEqual([22, 20, 21, 30, 31]);
  });

  it('prioritizes visible groups over nearer out-of-view groups', () => {
    const pending = new Map<number, ClassicFetchWant>([
      [
        1,
        want({
          kind: 'priority',
          distance: 3,
          level: 0,
          inView: false,
          phase: 'finest-target',
          coverageGroup: 1,
        }),
      ],
      [
        2,
        want({
          kind: 'priority',
          distance: 9,
          level: 5,
          inView: true,
          phase: 'coverage',
          coverageGroup: 2,
        }),
      ],
      [
        3,
        want({
          kind: 'priority',
          distance: 9,
          level: 1,
          inView: true,
          phase: 'target',
          coverageGroup: 2,
        }),
      ],
    ]);
    stampClassicFetchGroups(pending, 10);
    const ordered = [...pending.entries()].sort((a, b) =>
      compareClassicFetches(a[1], b[1], a[0], b[0]),
    );
    expect(ordered.map(([file]) => file)).toEqual([2, 3, 1]);
  });

  it('uses screen-centre rank when broad LCC bounds mark every slice in view', () => {
    const pending = new Map<number, ClassicFetchWant>([
      [
        10,
        want({
          kind: 'priority',
          distance: 2,
          level: 1,
          inView: true,
          phase: 'target',
          coverageGroup: 4,
          leafStart: 0,
          leafEnd: 1,
          screenImportance: 1.5,
        }),
      ],
      [
        20,
        want({
          kind: 'priority',
          distance: 12,
          level: 1,
          inView: true,
          phase: 'target',
          coverageGroup: 5,
          leafStart: 1,
          leafEnd: 2,
          screenImportance: 0.05,
        }),
      ],
    ]);
    stampClassicFetchGroups(pending, 10);
    const ordered = [...pending.entries()].sort((a, b) =>
      compareClassicFetches(a[1], b[1], a[0], b[0]),
    );
    expect(ordered.map(([file]) => file)).toEqual([20, 10]);
  });

  it('does not make one visible L1+ slice wait for its same-cell siblings', () => {
    const pending = new Map<number, ClassicFetchWant>([
      [
        10,
        want({
          kind: 'priority',
          distance: 8,
          level: 1,
          inView: true,
          phase: 'target',
          coverageGroup: 4,
          leafStart: 0,
          leafEnd: 1,
          screenImportance: 1,
        }),
      ],
      [
        11,
        want({
          kind: 'priority',
          distance: 8,
          level: 1,
          inView: true,
          phase: 'target',
          coverageGroup: 4,
          leafStart: 1,
          leafEnd: 2,
          screenImportance: 0.1,
        }),
      ],
    ]);
    stampClassicFetchGroups(pending, 10);
    const ordered = [...pending.entries()].sort((a, b) =>
      compareClassicFetches(a[1], b[1], a[0], b[0]),
    );
    expect(ordered.map(([file]) => file)).toEqual([11, 10]);
    expect(pending.get(10)?.groupId).not.toBe(pending.get(11)?.groupId);
  });

  it('finishes a dense near coverage group before a thin neighbor at the same distance', () => {
    const pending = new Map<number, ClassicFetchWant>([
      // Neighbor cell: two slices, lower file indices (old index-order winner).
      [10, want({ kind: 'priority', distance: 0, level: 0, inView: true, coverageGroup: 2 })],
      [11, want({ kind: 'priority', distance: 0, level: 0, inView: true, coverageGroup: 2 })],
      // Camera cell: four slices, higher file indices - must still win.
      [20, want({ kind: 'priority', distance: 0, level: 0, inView: true, coverageGroup: 1 })],
      [21, want({ kind: 'priority', distance: 0, level: 0, inView: true, coverageGroup: 1 })],
      [22, want({ kind: 'priority', distance: 0, level: 0, inView: true, coverageGroup: 1 })],
      [23, want({ kind: 'priority', distance: 0, level: 0, inView: true, coverageGroup: 1 })],
    ]);
    stampClassicFetchGroups(pending);
    const ordered = [...pending.entries()].sort((a, b) =>
      compareClassicFetches(a[1], b[1], a[0], b[0]),
    );
    expect(ordered.map(([file]) => file)).toEqual([20, 21, 22, 23, 10, 11]);
  });

  it('maps visible groups to priority and out-of-view groups to base', () => {
    const pending = new Map<number, ClassicFetchWant>([
      [
        10,
        want({
          kind: 'priority',
          distance: 6,
          level: 1,
          inView: true,
          phase: 'target',
          coverageGroup: 10,
        }),
      ],
      [
        11,
        want({
          kind: 'priority',
          distance: 6,
          level: 1,
          inView: false,
          phase: 'target',
          coverageGroup: 11,
        }),
      ],
      [
        12,
        want({
          kind: 'priority',
          distance: 30,
          level: 1,
          inView: false,
          phase: 'background',
          coverageGroup: 12,
        }),
      ],
    ]);
    stampClassicFetchGroups(pending, 10);
    expect(pending.get(10)?.kind).toBe('priority');
    expect(pending.get(11)?.kind).toBe('base');
    expect(pending.get(12)?.kind).toBe('base');
  });

  it('keeps short-range fetches on priority only during startup hold', () => {
    const pending = new Map<number, ClassicFetchWant>([
      [
        1,
        want({
          kind: 'priority',
          distance: 2,
          level: 0,
          inView: false,
          phase: 'finest-target',
          coverageGroup: 1,
        }),
      ],
      [
        2,
        want({
          kind: 'priority',
          distance: 40,
          level: 2,
          inView: false,
          phase: 'background',
          coverageGroup: 2,
        }),
      ],
    ]);
    stampClassicFetchGroups(pending, 10, true);
    expect(pending.get(1)?.kind).toBe('priority');
    expect(pending.get(2)?.kind).toBe('base');
  });

  it('retains classic kind helper behavior for desired run classification', () => {
    expect(
      classicFetchKindForDesired(
        {
          file: 0,
          level: 0,
          offset: 0,
          count: 1,
          leafStart: 0,
          leafEnd: 1,
          distance: 0,
          inView: false,
        },
        10,
      ),
    ).toBe('priority');
    expect(
      classicFetchKindForDesired(
        {
          file: 1,
          level: 1,
          offset: 0,
          count: 1,
          leafStart: 0,
          leafEnd: 1,
          distance: 15,
          inView: true,
        },
        10,
      ),
    ).toBe('priority');
    expect(
      classicFetchKindForDesired(
        {
          file: 2,
          level: 2,
          offset: 0,
          count: 1,
          leafStart: 0,
          leafEnd: 1,
          distance: 40,
          inView: false,
        },
        10,
      ),
    ).toBe('base');
  });
});

type Internals = {
  cache: Map<number, { data: SplatData; bytes: number; lastUsed: number }>;
  fetching: Map<number, { kind: string }>;
  reschedule: (camera: THREE.PerspectiveCamera, now: number) => unknown;
  requestChunk: (file: number, kind: string) => void;
  resident: Map<string, { run: LodRun }>;
  activeCount: number;
  fetchCounts: { priority: number; base: number };
  scene: {
    source: {
      computeDesiredRuns: () => LodRun[];
      coarsestRunsFor: (from: number, to: number) => LodRun[];
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

function makeMesh(desired: LodRun[], coarsest: LodRun[]): StreamedSplatMesh {
  const scene = {
    source: {
      budget: 4 * WIDTH,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => desired,
      coarsestRunsFor: (from: number, to: number) =>
        coarsest.filter((r) => r.leafStart < to && r.leafEnd > from),
    },
    chunkUrls: desired
      .concat(coarsest)
      .map((r) => r.file)
      .filter((f, i, all) => all.indexOf(f) === i)
      .sort((a, b) => a - b)
      .map((f) => `https://host/data.bin#${f}`),
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set(coarsest.map((r) => r.file)),
    maxResidentSplats: 4 * WIDTH,
  };
  // Ensure chunkUrls covers every file index used.
  const maxFile = Math.max(0, ...desired.map((r) => r.file), ...coarsest.map((r) => r.file));
  scene.chunkUrls = Array.from({ length: maxFile + 1 }, (_, f) => `https://host/data.bin#${f}`);

  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
  ) => StreamedSplatMesh;
  return new Ctor(scene, 4 * WIDTH, 4 * WIDTH, {});
}

describe('StreamedSplatMesh near-first classic path', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });

  it('requests near finest as priority before far desired cuts', () => {
    const nearFine = run({ file: 10, level: 0, leafStart: 0, leafEnd: 1, distance: 0 });
    const farFine = run({ file: 11, level: 0, leafStart: 1, leafEnd: 2, distance: 200 });
    const farCoarse = run({ file: 1, level: 5, leafStart: 1, leafEnd: 2, distance: 200 });
    // Far cell desires coarsest; near desires finest. Index order would fetch
    // file 1 before 10 - ranking must reverse that.
    const m = makeMesh(
      [nearFine, farCoarse],
      [farCoarse, run({ file: 0, level: 5, leafStart: 0, leafEnd: 1, distance: 0 })],
    );
    meshes.push(m);
    const inner = internals(m);
    const order: { file: number; kind: string }[] = [];
    const original = inner.requestChunk.bind(m);
    inner.requestChunk = (file, kind) => {
      order.push({ file, kind });
      original(file, kind);
    };

    inner.reschedule(camera, 0);

    expect(order.length).toBeGreaterThan(0);
    expect(order[0]).toEqual({ file: 10, kind: 'priority' });
    expect(inner.fetchCounts.priority).toBeGreaterThan(0);
    expect(order.find((o) => o.file === 1)?.kind).toBe('priority');
    expect(order.findIndex((o) => o.file === 10)).toBeLessThan(
      order.findIndex((o) => o.file === 1),
    );
    void farFine;
  });

  it('does not paint or fetch coarsest substitute for a near finest gap', () => {
    const nearFine = run({ file: 0, level: 0, leafStart: 0, leafEnd: 1, distance: 0 });
    const nearCoarse = run({ file: 2, level: 5, leafStart: 0, leafEnd: 1, distance: 0 });
    const m = makeMesh([nearFine], [nearCoarse]);
    meshes.push(m);
    const inner = internals(m);
    // Coarsest already decoded - old path would paint it as substitute.
    inner.cache.set(2, { data: makeChunk(50), bytes: 0, lastUsed: 0 });

    const requested: number[] = [];
    const original = inner.requestChunk.bind(m);
    inner.requestChunk = (file, kind) => {
      requested.push(file);
      original(file, kind);
    };

    inner.reschedule(camera, 0);

    expect(inner.activeCount).toBe(0);
    expect([...inner.resident.keys()]).toEqual([]);
    expect(requested).toContain(0);
    expect(requested).not.toContain(2);
    expect(inner.fetchCounts.priority).toBeGreaterThan(0);
  });

  it('keeps already-resident coarser LOD while waiting on near target', () => {
    // Cold load never fetches that shell for near cells. If coarser coverage
    // is already resident (e.g. from a prior far desire), leave it until the
    // target can swap - do not clear just to punch a hole.
    const nearFine = run({ file: 0, level: 0, leafStart: 0, leafEnd: 1, distance: 0, count: 100 });
    const farCoarse = run({
      file: 2,
      level: 5,
      leafStart: 0,
      leafEnd: 1,
      distance: 200,
      count: 50,
    });
    const nearCoarsePin = run({
      file: 2,
      level: 5,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      count: 50,
    });
    const m = makeMesh([farCoarse], [farCoarse]);
    meshes.push(m);
    const inner = internals(m);
    inner.cache.set(2, { data: makeChunk(50), bytes: 0, lastUsed: 0 });

    inner.reschedule(camera, 0);
    expect(inner.activeCount).toBe(50);

    inner.scene.source.computeDesiredRuns = () => [nearFine];
    inner.scene.source.coarsestRunsFor = () => [nearCoarsePin];
    const requested: number[] = [];
    const original = inner.requestChunk.bind(m);
    inner.requestChunk = (file, kind) => {
      requested.push(file);
      original(file, kind);
    };
    inner.reschedule(camera, 1);
    expect(inner.activeCount).toBe(50);
    expect(requested).toContain(0);
    expect(requested).not.toContain(2);

    inner.cache.set(0, { data: makeChunk(100), bytes: 0, lastUsed: 1 });
    inner.reschedule(camera, 2);
    expect(inner.activeCount).toBe(100);
  });

  it('applies a near non-finest cut when the scheduler demotes under budget', () => {
    // Short-range cells can resolve to L1+ when the budget cannot keep L0.
    // The mesh must apply that cut - refusing left a stale L0 (or a hole)
    // after the scheduler had already given up on finest.
    const nearBand = run({ file: 2, level: 1, leafStart: 0, leafEnd: 1, distance: 0, count: 50 });
    const m = makeMesh([nearBand], [nearBand]);
    meshes.push(m);
    const inner = internals(m);
    inner.cache.set(2, { data: makeChunk(50), bytes: 0, lastUsed: 0 });

    inner.reschedule(camera, 0);

    expect(inner.activeCount).toBe(50);
    expect(inner.resident.size).toBe(1);
  });

  it('paints a per-slice coarse substitute while a non-finest target is missing', () => {
    const mid = run({
      file: 0,
      level: 1,
      leafStart: 0,
      leafEnd: 1,
      distance: 25,
      count: 100,
      inView: true,
      coverageGroup: 3,
    });
    const coarse = run({
      file: 2,
      level: 5,
      leafStart: 0,
      leafEnd: 1,
      distance: 25,
      count: 50,
      inView: true,
      coverageGroup: 3,
    });
    const m = makeMesh([mid], [coarse]);
    meshes.push(m);
    const inner = internals(m);
    inner.cache.set(2, { data: makeChunk(50), bytes: 0, lastUsed: 0 });

    inner.reschedule(camera, 0);
    expect(inner.activeCount).toBe(50);
    expect([...inner.resident.keys()]).toEqual([
      `${coarse.file}:${coarse.level}:${coarse.offset}:${coarse.count}`,
    ]);
  });

  it('does not enqueue mid-LOD files when near desires finest only', () => {
    const nearFine = run({ file: 0, level: 0, leafStart: 0, leafEnd: 1, distance: 0 });
    const mid = run({ file: 1, level: 2, leafStart: 0, leafEnd: 1, distance: 0 });
    const coarse = run({ file: 2, level: 5, leafStart: 0, leafEnd: 1, distance: 0 });
    const m = makeMesh([nearFine], [coarse]);
    meshes.push(m);
    const inner = internals(m);
    const requested: number[] = [];
    vi.spyOn(inner, 'requestChunk').mockImplementation((file: number) => {
      requested.push(file);
    });

    inner.reschedule(camera, 0);

    expect(requested).toEqual([0]);
    expect(requested).not.toContain(mid.file);
    expect(requested).not.toContain(coarse.file);
  });

  it('applies a ready finest slice while its sibling is still fetching', () => {
    // Per-slice L0: land detail as each subchunk arrives instead of waiting for
    // the whole Quality cell (which stalled near cameras on mega-cells).
    const fine0 = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      coverageGroup: 7,
      count: 100,
    });
    const fine1 = run({
      file: 1,
      level: 0,
      leafStart: 1,
      leafEnd: 2,
      distance: 0,
      coverageGroup: 7,
      count: 100,
    });
    const coarse0 = run({
      file: 2,
      level: 5,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      coverageGroup: 7,
      count: 50,
    });
    const coarse1 = run({
      file: 3,
      level: 5,
      leafStart: 1,
      leafEnd: 2,
      distance: 0,
      coverageGroup: 7,
      count: 50,
    });
    const m = makeMesh([fine0, fine1], [coarse0, coarse1]);
    meshes.push(m);
    const inner = internals(m);
    inner.cache.set(2, { data: makeChunk(50), bytes: 0, lastUsed: 0 });
    inner.cache.set(3, { data: makeChunk(50), bytes: 0, lastUsed: 0 });
    inner.cache.set(0, { data: makeChunk(100), bytes: 0, lastUsed: 0 });

    inner.reschedule(camera, 0);
    // Cold start: no coarsest stand-in while holding for finest, but the ready
    // slice commits on its own.
    expect(inner.activeCount).toBe(100);
    expect(inner.resident.has(runKey(fine0))).toBe(true);
    expect(inner.resident.has(runKey(fine1))).toBe(false);

    inner.cache.set(1, { data: makeChunk(100), bytes: 0, lastUsed: 1 });
    inner.reschedule(camera, 1);
    expect(inner.activeCount).toBe(200);
    expect(inner.resident.size).toBe(2);
  });

  it('refines one finest slice without clearing its sibling coarse coverage', () => {
    const fine0 = run({
      file: 0,
      level: 0,
      leafStart: 0,
      leafEnd: 1,
      distance: 0,
      coverageGroup: 7,
      count: 100,
    });
    const fine1 = run({
      file: 1,
      level: 0,
      leafStart: 1,
      leafEnd: 2,
      distance: 0,
      coverageGroup: 7,
      count: 100,
    });
    const coarse0 = run({
      file: 2,
      level: 5,
      leafStart: 0,
      leafEnd: 1,
      distance: 25,
      coverageGroup: 7,
      count: 50,
    });
    const coarse1 = run({
      file: 3,
      level: 5,
      leafStart: 1,
      leafEnd: 2,
      distance: 25,
      coverageGroup: 7,
      count: 50,
    });
    // Start mid-range on coarsest, then walk in and ask for finest.
    const m = makeMesh([coarse0, coarse1], [coarse0, coarse1]);
    meshes.push(m);
    const inner = internals(m);
    inner.cache.set(2, { data: makeChunk(50), bytes: 0, lastUsed: 0 });
    inner.cache.set(3, { data: makeChunk(50), bytes: 0, lastUsed: 0 });
    inner.reschedule(camera, 0);
    expect(inner.activeCount).toBe(100);

    inner.scene.source.computeDesiredRuns = () => [fine0, fine1];
    inner.cache.set(0, { data: makeChunk(100), bytes: 0, lastUsed: 1 });
    inner.reschedule(camera, 1);
    // Ready slice swaps; sibling keeps its coarse coverage until its fine lands.
    expect(inner.resident.has(runKey(fine0))).toBe(true);
    expect(inner.resident.has(runKey(coarse1))).toBe(true);
    expect(inner.activeCount).toBe(150);

    inner.cache.set(1, { data: makeChunk(100), bytes: 0, lastUsed: 2 });
    inner.reschedule(camera, 2);
    expect(inner.activeCount).toBe(200);
  });

  it('applies a mid-range distance-band cut when the group is complete', () => {
    // ~15 m → L1 is desired; short-range hold must not refuse it.
    const mid = run({
      file: 0,
      level: 1,
      leafStart: 0,
      leafEnd: 1,
      distance: 15,
      count: 100,
      inView: true,
    });
    const coarse = run({
      file: 2,
      level: 5,
      leafStart: 0,
      leafEnd: 1,
      distance: 15,
      count: 50,
    });
    const m = makeMesh([mid], [coarse]);
    meshes.push(m);
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(100), bytes: 0, lastUsed: 0 });
    inner.cache.set(2, { data: makeChunk(50), bytes: 0, lastUsed: 0 });

    inner.reschedule(camera, 0);
    expect(inner.activeCount).toBe(100);
  });
});
