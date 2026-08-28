import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { buildLccScene } from '../formats/lcc/lcc';
import { httpDatasetSource } from '../streaming/dataset-source';
import type { StreamedChunkOptions } from '../streaming/lod-source';
import type { LccChunkParams } from '../formats/lcc/parse-lcc';

afterEach(() => {
  vi.unstubAllGlobals();
});

const LEVELS = 3;
const CELLS = 2;

/** A `.lcc` manifest shaped like the real captures, small enough to assert on. */
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: '5.0',
    totalSplats: 700,
    totalLevel: LEVELS,
    cellLengthX: 30,
    cellLengthY: 30,
    indexDataSize: 4 + LEVELS * 16,
    offset: [0, 0, 0],
    shift: [0, 0, 0],
    scale: [1, 1, 1],
    epsg: 0,
    // level 0 = 400 (200+200), level 1 = 200, level 2 = 100
    splats: [400, 200, 100],
    boundingBox: { min: [-30, -15, -5], max: [30, 15, 5] },
    encoding: 'COMPRESS',
    fileType: 'Portable',
    attributes: [
      { name: 'scale', min: [0.1, 0.2, 0.3], max: [1, 2, 3] },
      { name: 'shcoef', min: [-3, -3, -3], max: [3, 3, 3] },
      { name: 'envscale', min: [1, 1, 1], max: [50, 50, 50] },
      { name: 'envshcoef', min: [-1, -1, -1], max: [1, 1, 1] },
    ],
    ...overrides,
  };
}

/**
 * Builds an `index.bin` for two cells × three levels, laid out cell-major and
 * contiguously, exactly as the real captures are.
 */
function indexBin(): ArrayBuffer {
  const recordSize = 4 + LEVELS * 16;
  const buffer = new ArrayBuffer(CELLS * recordSize);
  const view = new DataView(buffer);
  // per-cell, per-level counts summing to the manifest's `splats`
  const counts = [
    [200, 100, 50],
    [200, 100, 50],
  ];
  let byteOffset = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    const base = cell * recordSize;
    view.setUint16(base, cell, true); // cellX: 0, 1
    view.setUint16(base + 2, 0, true); // cellY
    for (let level = 0; level < LEVELS; level++) {
      const at = base + 4 + level * 16;
      const count = counts[cell]![level]!;
      view.setUint32(at, count, true);
      view.setBigUint64(at + 4, BigInt(byteOffset), true);
      view.setUint32(at + 12, count * 32, true);
      byteOffset += count * 32;
    }
  }
  return buffer;
}

/** Stubs the sidecar fetches `buildLccScene` makes: index.bin and environment.bin. */
function stubFetch(
  options: {
    index?: ArrayBuffer;
    environmentBytes?: number | null;
    /** Present `collision.lci` size; omit/null = absent. */
    collisionBytes?: number | null;
    /** Which collision filename answers the size probe. */
    collisionName?: 'collision.lci' | 'Collision.lci';
  } = {},
) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('index.bin')) {
        return Promise.resolve(new Response(options.index ?? indexBin(), { status: 200 }));
      }
      if (url.endsWith('environment.bin')) {
        const bytes = options.environmentBytes;
        if (bytes === null || bytes === undefined) {
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        return Promise.resolve(
          new Response(null, { status: 200, headers: { 'content-length': String(bytes) } }),
        );
      }
      const collisionName = options.collisionName ?? 'collision.lci';
      if (url.endsWith('collision.lci') || url.endsWith('Collision.lci')) {
        const bytes = options.collisionBytes;
        if (bytes === null || bytes === undefined || !url.endsWith(collisionName)) {
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        return Promise.resolve(
          new Response(null, { status: 200, headers: { 'content-length': String(bytes) } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
  return calls;
}

const OPTIONS = { budget: 1_000_000, lodBaseDistance: 10, lodMultiplier: 2 };
/** Stands in for the manifest URL these datasets resolve their siblings against. */
const BASE = httpDatasetSource('https://example.test/capture/scene.lcc');

function lccOf(chunk: StreamedChunkOptions | undefined): LccChunkParams {
  expect(chunk?.format).toBe('lcc-bin');
  return chunk!.lcc!;
}

describe('buildLccScene', () => {
  it('maps every (cell, level) to a chunk with the index byte range', async () => {
    stubFetch();
    const scene = await buildLccScene(manifest(), BASE, OPTIONS);

    // 2 cells × 3 levels = 6 chunks, no environment. Every chunk points at the
    // one shared data.bin, tagged for debugging.
    expect(scene.chunkKind).toBe('file');
    for (const url of scene.chunkUrls) {
      expect(url.startsWith('https://example.test/capture/data.bin#')).toBe(true);
    }
    expect(scene.chunkUrls).toEqual([
      'https://example.test/capture/data.bin#c0_0-l0',
      'https://example.test/capture/data.bin#c0_0-l1',
      'https://example.test/capture/data.bin#c0_0-l2',
      'https://example.test/capture/data.bin#c1_0-l0',
      'https://example.test/capture/data.bin#c1_0-l1',
      'https://example.test/capture/data.bin#c1_0-l2',
    ]);

    // Ranges follow index.bin, laid out cell-major and contiguous: each
    // (cell, level) slice, 32 bytes per splat.
    const ranges = scene.chunkOptions!.map((chunk) => {
      const lcc = lccOf(chunk);
      return [lcc.start, lcc.length];
    });
    expect(ranges).toEqual([
      [0, 200 * 32],
      [6400, 100 * 32],
      [9600, 50 * 32],
      [11200, 200 * 32],
      [17600, 100 * 32],
      [20800, 50 * 32],
    ]);
  });

  it('offers every leaf its ladder, so the scheduler coarsens rather than drops', async () => {
    stubFetch();
    // A budget too small to hold both cells at their finest (200 each) but
    // ample for coarser levels: the far cell must coarsen, not vanish.
    const scene = await buildLccScene(manifest(), BASE, { ...OPTIONS, budget: 260 });
    const runs = scene.source.computeDesiredRuns(
      new THREE.Vector3(-15, 0, 5), // inside cell 0; cell 1 is farther
      new THREE.Frustum(),
      1000,
    );
    // Both cells stay covered (nothing dropped)...
    const levelByLeaf = new Map<number, number>();
    for (const run of runs)
      for (let i = run.leafStart; i < run.leafEnd; i++) levelByLeaf.set(i, run.level);
    expect(levelByLeaf.get(0)).toBeDefined();
    expect(levelByLeaf.get(1)).toBeDefined();
    // ...and at least one rides a coarser level than 0 - the ladder is in use.
    expect(Math.max(...runs.map((r) => r.level))).toBeGreaterThan(0);
  });

  it('sizes the pool and the coverage floor from the manifest', async () => {
    stubFetch();
    const scene = await buildLccScene(manifest(), BASE, OPTIONS);
    // Worst case is every cell at its finest level.
    expect(scene.maxResidentSplats).toBe(400);
    // The coverage floor is each cell's coarsest level (50 + 50).
    expect(scene.minimumCoverageSplats).toBe(100);
  });

  it('pins each cell’s coarsest level as substitute coverage', async () => {
    stubFetch();
    const scene = await buildLccScene(manifest(), BASE, OPTIONS);
    // The l2 chunk of each cell: indices 2 and 5 in the 6-chunk layout.
    expect([...scene.pinnedFiles].sort((a, b) => a - b)).toEqual([2, 5]);
  });

  it('lays leaves out on the cell grid, clamped to the scene bounds', async () => {
    stubFetch();
    const scene = await buildLccScene(manifest(), BASE, OPTIONS);
    const runs = scene.source.computeDesiredRuns(
      new THREE.Vector3(0, 0, 100),
      new THREE.Frustum(),
      0,
    );
    // Both cells resolve to some run - the scene is never empty.
    expect(runs.length).toBeGreaterThan(0);
    expect(scene.bounds.min.toArray()).toEqual([-30, -15, -5]);
    expect(scene.bounds.max.toArray()).toEqual([30, 15, 5]);
  });

  it('adds an always-resident environment chunk when environment.bin exists', async () => {
    stubFetch({ environmentBytes: 96 * 32 }); // Portable stride is 32 → 96 splats
    const scene = await buildLccScene(manifest(), BASE, OPTIONS);

    expect(scene.chunkUrls).toHaveLength(CELLS * LEVELS + 1);
    const envFile = scene.chunkUrls.length - 1;
    expect(scene.chunkUrls[envFile]).toBe('https://example.test/capture/environment.bin#env');
    const env = lccOf(scene.chunkOptions![envFile]);
    expect(env.kind).toBe('environment');
    expect(env.start).toBe(0);
    expect(env.length).toBe(96 * 32);
    // Env splats use the envscale range, not the scene's scale range.
    expect(env.scale.max).toEqual([50, 50, 50]);
    // Pinned, and counted into the pool + coverage floor (100 coarse + 96 sky).
    expect(scene.pinnedFiles.has(envFile)).toBe(true);
    expect(scene.maxResidentSplats).toBe(400 + 96);
    expect(scene.minimumCoverageSplats).toBe(100 + 96);
  });

  it('declares collision when collision.lci is present', async () => {
    stubFetch({ collisionBytes: 1024 });
    const scene = await buildLccScene(manifest(), BASE, OPTIONS);
    expect(scene.collision?.meshes).toEqual([
      { url: 'https://example.test/capture/collision.lci' },
    ]);
  });

  it('finds Collision.lci when the lowercase name is absent', async () => {
    stubFetch({ collisionBytes: 2048, collisionName: 'Collision.lci' });
    const scene = await buildLccScene(manifest(), BASE, OPTIONS);
    expect(scene.collision?.meshes).toEqual([
      { url: 'https://example.test/capture/Collision.lci' },
    ]);
  });

  it('omits collision when no .lci sidecar exists', async () => {
    stubFetch();
    const scene = await buildLccScene(manifest(), BASE, OPTIONS);
    expect(scene.collision).toBeUndefined();
  });

  it('uses the 96-byte environment stride for a Quality capture', async () => {
    stubFetch({ environmentBytes: 96 * 10 });
    const scene = await buildLccScene(manifest({ fileType: 'Quality' }), BASE, OPTIONS);
    const env = lccOf(scene.chunkOptions![scene.chunkUrls.length - 1]);
    expect(env.length).toBe(96 * 10); // 10 splats, not 30
    expect(env.stride).toBe(96);
  });

  it('keeps the environment stride tied to fileType, not to shBands', async () => {
    // Reading a Quality environment at the Portable stride would decode 3x
    // the splats out of the SH bytes - the stride is a property of the file.
    stubFetch({ environmentBytes: 96 * 10 });
    const scene = await buildLccScene(manifest({ fileType: 'Quality' }), BASE, {
      ...OPTIONS,
      shBands: 0,
    });
    const env = lccOf(scene.chunkOptions![scene.chunkUrls.length - 1]);
    expect(env.stride).toBe(96);
    expect(env.length).toBe(96 * 10);
    expect(env.sh).toBeUndefined();

    stubFetch({ environmentBytes: 32 * 10 });
    const portable = await buildLccScene(manifest(), BASE, OPTIONS);
    expect(lccOf(portable.chunkOptions![portable.chunkUrls.length - 1]).stride).toBe(32);
  });

  it('rejects an environment.bin whose size does not fit the record stride', async () => {
    stubFetch({ environmentBytes: 96 * 10 + 5 });
    await expect(buildLccScene(manifest(), BASE, OPTIONS)).rejects.toThrow(/not a multiple/);
  });

  it('tolerates a missing environment.bin', async () => {
    stubFetch({ environmentBytes: null });
    const scene = await buildLccScene(manifest(), BASE, OPTIONS);
    expect(scene.chunkUrls).toHaveLength(CELLS * LEVELS);
  });

  it('streams every band a Quality capture carries by default', async () => {
    stubFetch({ environmentBytes: 96 * 10 }); // Quality env stride is 96
    const scene = await buildLccScene(manifest({ fileType: 'Quality' }), BASE, OPTIONS);
    expect(scene.shBands).toBe(3);
    expect(lccOf(scene.chunkOptions![0]).sh).toEqual({
      bands: 3,
      range: { min: [-3, -3, -3], max: [3, 3, 3] },
      source: 'sidecar',
      url: 'https://example.test/capture/shcoef.bin',
    });
    // The environment's SH rides inline in its 96-byte records, not the sidecar.
    const env = lccOf(scene.chunkOptions![scene.chunkUrls.length - 1]);
    expect(env.sh?.source).toBe('inline');
    // It quantizes against its own range but is re-encoded into the base range,
    // so the whole scene decodes through one pool uniform.
    expect(env.sh?.range).toEqual({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect(env.sh?.requantizeTo).toEqual({ min: [-3, -3, -3], max: [3, 3, 3] });
  });

  it('never fetches SH for a Portable capture, whatever is asked for', async () => {
    stubFetch();
    for (const shBands of [undefined, 3] as const) {
      const scene = await buildLccScene(manifest(), BASE, { ...OPTIONS, shBands });
      expect(scene.shBands).toBe(0);
      expect(lccOf(scene.chunkOptions![0]).sh).toBeUndefined();
    }
  });

  it('honors an explicit band count, including 0 to force SH off', async () => {
    stubFetch();
    const off = await buildLccScene(manifest({ fileType: 'Quality' }), BASE, {
      ...OPTIONS,
      shBands: 0,
    });
    expect(off.shBands).toBe(0);
    expect(lccOf(off.chunkOptions![0]).sh).toBeUndefined();

    const two = await buildLccScene(manifest({ fileType: 'Quality' }), BASE, {
      ...OPTIONS,
      shBands: 2,
    });
    expect(two.shBands).toBe(2);
    expect(lccOf(two.chunkOptions![0]).sh?.bands).toBe(2);
  });

  describe('sub-chunking', () => {
    // One cell whose finest level crosses the 128k sub-chunk target → K = 3.
    // The builder never reads data.bin, so large counts cost nothing.
    const BIG = { levels: [300_000, 60_000, 10] };
    function bigManifest(counts = BIG.levels) {
      return manifest({
        splats: counts,
        totalSplats: counts.reduce((a, b) => a + b, 0),
      });
    }
    /** index.bin for a single cell with the given per-level counts. */
    function bigIndex(counts = BIG.levels): ArrayBuffer {
      const recordSize = 4 + LEVELS * 16;
      const buffer = new ArrayBuffer(recordSize);
      const view = new DataView(buffer);
      view.setUint16(0, 0, true);
      view.setUint16(2, 0, true);
      let byteOffset = 0;
      for (let level = 0; level < LEVELS; level++) {
        const at = 4 + level * 16;
        view.setUint32(at, counts[level]!, true);
        view.setBigUint64(at + 4, BigInt(byteOffset), true);
        view.setUint32(at + 12, counts[level]! * 32, true);
        byteOffset += counts[level]! * 32;
      }
      return buffer;
    }

    it('partitions every level of a big cell into K disjoint tiling slices', async () => {
      stubFetch({ index: bigIndex() });
      const scene = await buildLccScene(bigManifest(), BASE, OPTIONS);

      // K = ceil(300k / 128k) = 3 sub-leaves; every present level splits
      // 3 ways with a dedicated chunk per (level, sub) - labels carry `.i`.
      expect(scene.chunkUrls).toEqual([
        'https://example.test/capture/data.bin#c0_0-l0.0',
        'https://example.test/capture/data.bin#c0_0-l1.0',
        'https://example.test/capture/data.bin#c0_0-l2.0',
        'https://example.test/capture/data.bin#c0_0-l0.1',
        'https://example.test/capture/data.bin#c0_0-l1.1',
        'https://example.test/capture/data.bin#c0_0-l2.1',
        'https://example.test/capture/data.bin#c0_0-l0.2',
        'https://example.test/capture/data.bin#c0_0-l1.2',
        'https://example.test/capture/data.bin#c0_0-l2.2',
      ]);

      // Per level: slices are 32-byte aligned, contiguous, disjoint, and tile
      // the index range exactly (counts partition).
      const levelStart = [0, 300_000 * 32, 360_000 * 32];
      for (let level = 0; level < LEVELS; level++) {
        const slices = scene.chunkUrls
          .map((url, file) => ({ url, file }))
          .filter(({ url }) => url.includes(`-l${level}.`))
          .map(({ file }) => lccOf(scene.chunkOptions![file]));
        let cursor = levelStart[level]!;
        let total = 0;
        for (const slice of slices) {
          expect(slice.start).toBe(cursor);
          expect(slice.start % 32).toBe(0);
          expect(slice.length % 32).toBe(0);
          cursor = slice.start + slice.length;
          total += slice.length / 32;
        }
        expect(total).toBe(BIG.levels[level]);
      }
    });

    it('keeps the pool size and coverage floor sums identical to unsplit', async () => {
      stubFetch({ index: bigIndex() });
      const scene = await buildLccScene(bigManifest(), BASE, OPTIONS);
      expect(scene.maxResidentSplats).toBe(300_000);
      // Coarsest level (10 splats) splits 3/3/4 across the sub-leaves; each
      // slice is pinned and the floor sums back to the unsplit total.
      expect(scene.minimumCoverageSplats).toBe(10);
      const pinnedLabels = [...scene.pinnedFiles].map((f) => scene.chunkUrls[f]);
      expect(pinnedLabels.sort()).toEqual([
        'https://example.test/capture/data.bin#c0_0-l2.0',
        'https://example.test/capture/data.bin#c0_0-l2.1',
        'https://example.test/capture/data.bin#c0_0-l2.2',
      ]);
    });

    it('lets a sub-leaf missing a tiny coarse level pin its finest present slice', async () => {
      // Level 1 has 2 splats against K = 3: floor boundaries leave sub-leaf 0
      // without a level-1 slice, so its coarsest present level is its level-0
      // slice - pinned bytes can exceed the coarsest-level total, but coverage
      // never has a hole.
      stubFetch({ index: bigIndex([300_000, 2, 0]) });
      const scene = await buildLccScene(bigManifest([300_000, 2, 0]), BASE, OPTIONS);
      expect(scene.chunkUrls).toEqual([
        'https://example.test/capture/data.bin#c0_0-l0.0',
        'https://example.test/capture/data.bin#c0_0-l0.1',
        'https://example.test/capture/data.bin#c0_0-l1.1',
        'https://example.test/capture/data.bin#c0_0-l0.2',
        'https://example.test/capture/data.bin#c0_0-l1.2',
      ]);
      const pinnedLabels = [...scene.pinnedFiles].map((f) => scene.chunkUrls[f]);
      expect(pinnedLabels.sort()).toEqual([
        'https://example.test/capture/data.bin#c0_0-l0.0', // no l1 slice: pins its l0
        'https://example.test/capture/data.bin#c0_0-l1.1',
        'https://example.test/capture/data.bin#c0_0-l1.2',
      ]);
      expect(scene.minimumCoverageSplats).toBe(100_000 + 1 + 1);
    });

    it('keeps a split cell on one LOD under budget pressure', async () => {
      stubFetch({ index: bigIndex() });
      // Budget holds one fine slice (100k) plus coarse slices, not the whole
      // 300k level 0. Spatially ordered captures would show a rectangular hole
      // if the scheduler mixed levels within this physical cell.
      const scene = await buildLccScene(bigManifest(), BASE, { ...OPTIONS, budget: 150_000 });
      // Advance past the 500 ms dwell so the per-leaf levels settle.
      let runs: ReturnType<typeof scene.source.computeDesiredRuns> = [];
      for (const now of [0, 1000, 2000]) {
        runs = scene.source.computeDesiredRuns(
          new THREE.Vector3(0, 0, 0),
          new THREE.Frustum(),
          now,
        );
      }
      const coveredLeaves = new Set<number>();
      const levels = new Set<number>();
      for (const run of runs) {
        // Dedicated files per (level, sub-leaf): every run spans one leaf.
        expect(run.leafEnd - run.leafStart).toBe(1);
        for (let i = run.leafStart; i < run.leafEnd; i++) coveredLeaves.add(i);
        levels.add(run.level);
      }
      expect(coveredLeaves.size).toBe(3); // nothing dropped
      expect(levels.size).toBe(1);
      expect(levels).toEqual(new Set([1]));
      const total = runs.reduce((sum, run) => sum + run.count, 0);
      expect(total).toBeLessThanOrEqual(150_000);
    });
  });

  it('rejects an index whose per-level totals fall far short of the manifest', async () => {
    stubFetch();
    await expect(
      buildLccScene(manifest({ splats: [500, 200, 100] }), BASE, OPTIONS),
    ).rejects.toThrow(/level 0 totals 400 splats, but the manifest declares 500/);
  });

  it('rejects an index whose per-level totals exceed the manifest', async () => {
    stubFetch();
    await expect(
      buildLccScene(manifest({ splats: [400, 199, 100] }), BASE, OPTIONS),
    ).rejects.toThrow(/level 1 totals 200 splats, but the manifest declares 199/);
  });

  it('tolerates a manifest that over-declares by a few splats, as the v4 writer does', async () => {
    // conferencehall.lcc (v4.0) declares 2 and 1 more splats on levels 0/1
    // than index.bin holds; index.bin is authoritative for byte ranges.
    stubFetch();
    const scene = await buildLccScene(
      manifest({ version: '4.0', splats: [402, 201, 100] }),
      BASE,
      OPTIONS,
    );
    expect(scene.chunkUrls).toHaveLength(CELLS * LEVELS);
    // Sizing still reads the manifest - a hair generous, never short.
    expect(scene.maxResidentSplats).toBe(402);
  });
});
