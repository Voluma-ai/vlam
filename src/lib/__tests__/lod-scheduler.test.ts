import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { LodScheduler, type LodRun } from '../streaming/lod-scheduler';
import type { LodLeaf, LodManifest } from '../streaming/lod-manifest';

/**
 * Tests for the pure scheduler core: hysteresis dead-band, dwell,
 * budget enforcement, out-of-frustum coverage, and run coalescing.
 * The scheduler is driven entirely with synthetic manifests, explicit
 * camera positions/frustums, and fake monotonic timestamps - no timers.
 */

// These must match the constants in lod-scheduler.ts. They are internal
// tuning values, so the tests restate them here rather than exporting them.
const MAX_RUN_SPLATS = 128_000;
const FRUSTUM_PENALTY = 3;

/**
 * A manifest of `leafCount` unit-cube leaves along +x, `spacing` apart.
 * Every leaf has every level; within a level the ranges are contiguous in
 * one chunk file (leaf i covers [i·count, (i+1)·count)) so adjacent leaves
 * at the same level coalesce, exactly like a real tree-ordered manifest.
 */
function makeManifest(leafCount: number, levelCounts: number[], spacing = 4): LodManifest {
  const leaves: LodLeaf[] = [];
  for (let i = 0; i < leafCount; i++) {
    leaves.push({
      bounds: new THREE.Box3(
        new THREE.Vector3(i * spacing, 0, 0),
        new THREE.Vector3(i * spacing + 1, 1, 1),
      ),
      lods: levelCounts.map((count, _level) => ({ file: 0, offset: i * count, count })),
    });
  }
  return {
    leaves,
    chunkUrls: ['https://example.test/0_0/'],
    counts: levelCounts.map((count) => count * leafCount),
    lodLevels: levelCounts.length,
    bounds: new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3((leafCount - 1) * spacing + 1, 1, 1),
    ),
  };
}

/** Camera position + view frustum (local space == world space here). */
function viewFrom(
  position: THREE.Vector3,
  target: THREE.Vector3,
): { position: THREE.Vector3; frustum: THREE.Frustum } {
  const camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 100_000);
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  return { position: position.clone(), frustum };
}

/**
 * A view in which the single test leaf (bounds [0,1]³) sits behind the
 * camera at box distance `effective / FRUSTUM_PENALTY`, so the scheduler's
 * effective distance is `effective`. Out-of-frustum leaves are exempt from
 * budget promotion, which makes the emitted level the pure distance-chosen
 * hysteresis state.
 */
function awayView(effective: number): { position: THREE.Vector3; frustum: THREE.Frustum } {
  const x = 1 + effective / FRUSTUM_PENALTY;
  return viewFrom(new THREE.Vector3(x, 0.5, 0.5), new THREE.Vector3(x + 10, 0.5, 0.5));
}

function totalSplats(runs: LodRun[]): number {
  return runs.reduce((sum, run) => sum + run.count, 0);
}

/**
 * Structural invariants of a coalesced run list: sorted and disjoint over
 * leaf indices, each run within the max size, and each run's [offset,
 * offset+count) exactly the concatenation of its leaves' ranges at its level.
 */
function checkRuns(runs: LodRun[], leaves: readonly LodLeaf[]): void {
  let previousEnd = 0;
  for (const run of runs) {
    expect(run.leafStart).toBeGreaterThanOrEqual(previousEnd);
    expect(run.leafEnd).toBeGreaterThan(run.leafStart);
    expect(run.leafEnd).toBeLessThanOrEqual(leaves.length);
    expect(run.count).toBeGreaterThan(0);
    expect(run.count).toBeLessThanOrEqual(MAX_RUN_SPLATS);

    let offset = run.offset;
    let count = 0;
    for (let i = run.leafStart; i < run.leafEnd; i++) {
      const range = (leaves[i] as LodLeaf).lods[run.level];
      expect(range).toBeDefined();
      expect(range!.file).toBe(run.file);
      expect(range!.offset).toBe(offset);
      offset += range!.count;
      count += range!.count;
    }
    expect(count).toBe(run.count);
    previousEnd = run.leafEnd;
  }
}

/** Asserts the runs cover every leaf exactly once with no gaps. */
function checkFullCoverage(runs: LodRun[], leafCount: number): void {
  let previousEnd = 0;
  for (const run of runs) {
    expect(run.leafStart).toBe(previousEnd);
    previousEnd = run.leafEnd;
  }
  expect(previousEnd).toBe(leafCount);
}

/** Deterministic PRNG (mulberry32) for the camera sweep. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('LodScheduler', () => {
  describe('hysteresis dead-band', () => {
    // base = 10, multiplier = 2, margin 0.1: the level-0/1 boundary at
    // distance 10 refines only at <= 9 and coarsens only at > 11; the
    // level-1/2 boundary at 20 refines at <= 18 and coarsens at > 22.
    //
    // A decoy leaf keeps finestTotal above `budget` so the full-finest
    // short-circuit (Casino rotate guard) does not hide hysteresis here.
    function makeScheduler(): LodScheduler {
      const base = makeManifest(1, [100, 50, 10]);
      const decoy: LodLeaf = {
        bounds: new THREE.Box3(new THREE.Vector3(1000, 0, 0), new THREE.Vector3(1001, 1, 1)),
        lods: [
          { file: 1, offset: 0, count: 10_000 },
          { file: 1, offset: 10_000, count: 100 },
          { file: 1, offset: 10_100, count: 10 },
        ],
      };
      const manifest: LodManifest = {
        ...base,
        leaves: [...base.leaves, decoy],
      };
      return new LodScheduler(manifest, {
        budget: 1000,
        lodBaseDistance: 10,
        lodMultiplier: 2,
      });
    }

    function levelAt(scheduler: LodScheduler, effective: number, now: number): number {
      const { position, frustum } = awayView(effective);
      const runs = scheduler.computeDesiredRuns(position, frustum, now);
      const run = runs.find((r) => r.leafStart <= 0 && r.leafEnd > 0);
      expect(run).toBeDefined();
      return (run as LodRun).level;
    }

    it('a change smaller than the dead-band does not change the level', () => {
      const scheduler = makeScheduler();
      expect(levelAt(scheduler, 8, 1000)).toBe(0); // well inside level 0
      // 10.5 crosses the raw threshold (10) but stays inside (9, 11]: hold.
      expect(levelAt(scheduler, 10.5, 2000)).toBe(0);
      expect(levelAt(scheduler, 11.5, 3000)).toBe(1); // past the band: coarsen
      // 19 is inside the (18, 22] band around the level-1/2 boundary: hold.
      expect(levelAt(scheduler, 19, 4000)).toBe(1);
      expect(levelAt(scheduler, 23, 5000)).toBe(2);
      expect(levelAt(scheduler, 21, 6000)).toBe(2); // refine needs <= 18
      expect(levelAt(scheduler, 8, 7000)).toBe(0);
    });

    it('dwell: an over-threshold change cannot flip a leaf twice within the window', () => {
      const scheduler = makeScheduler();
      expect(levelAt(scheduler, 8, 1000)).toBe(0); // change lands, dwell restarts
      // A huge move immediately after must be held for DWELL_MS (500 ms).
      expect(levelAt(scheduler, 200, 1300)).toBe(0);
      expect(levelAt(scheduler, 200, 1499)).toBe(0);
      // Once the dwell window has elapsed the pending change applies.
      expect(levelAt(scheduler, 200, 1600)).toBe(2);
      // And the new level immediately re-enters its own dwell window.
      expect(levelAt(scheduler, 8, 1700)).toBe(2);
      expect(levelAt(scheduler, 8, 2200)).toBe(0);
    });

    it('cold start snaps from coarsest to the distance band without waiting on dwell', () => {
      const scheduler = makeScheduler();
      // now=0 would fail the dwell check (changedAt starts at 0); cold snap
      // still jumps straight to the L1 band at ~15 m.
      expect(levelAt(scheduler, 15, 0)).toBe(1);
    });
  });

  it('budget: selections never exceed the budget across a camera sweep', () => {
    const leafCount = 64;
    const spacing = 5;
    const manifest = makeManifest(leafCount, [1000, 250, 50], spacing);
    const budget = 8000;
    const scheduler = new LodScheduler(manifest, {
      budget,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });

    const random = mulberry32(20260716);
    for (let step = 0; step < 25; step++) {
      const position = new THREE.Vector3(
        random() * (leafCount * spacing + 40) - 20,
        1 + random() * 39,
        random() * 80 - 40,
      );
      const targetLeaf = Math.floor(random() * leafCount);
      const target = new THREE.Vector3(targetLeaf * spacing + 0.5, 0.5, 0.5);
      const { frustum } = viewFrom(position, target);

      const runs = scheduler.computeDesiredRuns(position, frustum, 1000 + step * 600);
      expect(totalSplats(runs)).toBeLessThanOrEqual(budget);
      checkRuns(runs, manifest.leaves);
      // The coarsest levels (64 × 50 = 3200) always fit this budget, so no
      // leaf is ever dropped: coverage stays complete through the sweep.
      checkFullCoverage(runs, leafCount);
    }
  });

  it('out-of-frustum leaves keep coverage (never uncovered)', () => {
    const leafCount = 16;
    const manifest = makeManifest(leafCount, [100, 40, 10], 5);
    const scheduler = new LodScheduler(manifest, {
      budget: 100_000,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });

    // Camera past the last leaf, looking away: every leaf is out of frustum.
    const { position, frustum } = viewFrom(
      new THREE.Vector3(leafCount * 5 + 10, 0.5, 0.5),
      new THREE.Vector3(leafCount * 5 + 100, 0.5, 0.5),
    );
    const runs = scheduler.computeDesiredRuns(position, frustum, 1000);
    checkRuns(runs, manifest.leaves);
    checkFullCoverage(runs, leafCount);
  });

  it('fillBudget uses the full budget when it holds every leaf finest', () => {
    // Casino-style: budget == finest total, but distance alone would leave
    // far leaves coarse. Without the 100% fill those would stay on coarse
    // discs under the old 90% headroom.
    const leafCount = 8;
    const levelCounts = [1000, 100, 20];
    const finestTotal = levelCounts[0]! * leafCount;
    const manifest = makeManifest(leafCount, levelCounts, 4);
    const scheduler = new LodScheduler(manifest, {
      budget: finestTotal,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });

    const { position, frustum } = viewFrom(
      new THREE.Vector3(14, 80, 0.5),
      new THREE.Vector3(14, 0.5, 0.5),
    );
    const runs = scheduler.computeDesiredRuns(position, frustum, 1000);
    checkRuns(runs, manifest.leaves);
    checkFullCoverage(runs, leafCount);
    expect(totalSplats(runs)).toBe(finestTotal);
    for (const run of runs) expect(run.level).toBe(0);
  });

  it('keeps every leaf finest across a rotate when the budget holds the whole set', () => {
    // Reproduce the Casino rotate flash: look at the row (all fine), then
    // look away so every leaf is out of frustum. Frustum penalty would
    // coarsen without the full-finest short-circuit.
    const leafCount = 8;
    const levelCounts = [1000, 100, 20];
    const finestTotal = levelCounts[0]! * leafCount;
    const manifest = makeManifest(leafCount, levelCounts, 4);
    const scheduler = new LodScheduler(manifest, {
      budget: finestTotal,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });

    const looking = viewFrom(new THREE.Vector3(14, 5, 20), new THREE.Vector3(14, 0.5, 0.5));
    const away = viewFrom(
      new THREE.Vector3(leafCount * 4 + 10, 0.5, 0.5),
      new THREE.Vector3(leafCount * 4 + 100, 0.5, 0.5),
    );

    const first = scheduler.computeDesiredRuns(looking.position, looking.frustum, 1000);
    expect(totalSplats(first)).toBe(finestTotal);
    for (const run of first) expect(run.level).toBe(0);

    // Past dwell so a coarsen would land if the short-circuit were missing.
    const second = scheduler.computeDesiredRuns(away.position, away.frustum, 2000);
    checkRuns(second, manifest.leaves);
    checkFullCoverage(second, leafCount);
    expect(totalSplats(second)).toBe(finestTotal);
    for (const run of second) expect(run.level).toBe(0);
  });

  it('budget demotion breaks distance ties deterministically by ascending leaf index', () => {
    // spacing 0 stacks all leaves on the same bounds, so every leaf ties on
    // distance and frustum state. Budget 240 with levels [100, 10] forces
    // exactly two demotions; the in-place index sort must resolve the tie the
    // same way the stable `[...keys].sort` it replaced did: lowest index first.
    const select = (): number[] => {
      const manifest = makeManifest(4, [100, 10], 0);
      const scheduler = new LodScheduler(manifest, {
        budget: 240,
        lodBaseDistance: 10,
        lodMultiplier: 2,
      });
      const { position, frustum } = viewFrom(
        new THREE.Vector3(0.5, 0.5, 5),
        new THREE.Vector3(0.5, 0.5, 0.5),
      );
      const runs = scheduler.computeDesiredRuns(position, frustum, 1000);
      checkRuns(runs, manifest.leaves);
      checkFullCoverage(runs, 4);
      const levels: number[] = [];
      for (const run of runs) {
        for (let leaf = run.leafStart; leaf < run.leafEnd; leaf++) levels.push(run.level);
      }
      return levels;
    };
    const first = select();
    expect(first).toEqual([1, 1, 0, 0]);
    expect(select()).toEqual(first);
  });

  it('budgets grouped leaves as one spatial cut', () => {
    const base = makeManifest(4, [100, 10], 0);
    const manifest: LodManifest = {
      ...base,
      leaves: base.leaves.map((leaf) => ({ ...leaf, budgetGroup: 7 })),
    };
    const scheduler = new LodScheduler(manifest, {
      // One or two fine slices would fit, but the whole physical region does
      // not. The scheduler must keep every slice coarse instead of exposing a
      // spatially ordered subset as a rectangular hole.
      budget: 240,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });
    const { position, frustum } = viewFrom(
      new THREE.Vector3(0.5, 0.5, 5),
      new THREE.Vector3(0.5, 0.5, 0.5),
    );
    const runs = scheduler.computeDesiredRuns(position, frustum, 1000);

    checkRuns(runs, manifest.leaves);
    checkFullCoverage(runs, 4);
    expect(totalSplats(runs)).toBe(40);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.level).toBe(1);
  });

  it('can keep a partial-budget cut stable across camera rotation', () => {
    const manifest = makeManifest(2, [100, 10], 20);
    const scheduler = new LodScheduler(manifest, {
      budget: 120,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      frustumAware: false,
    });
    const levels = (runs: LodRun[]): number[] => {
      const result = new Array<number>(2);
      for (const run of runs) {
        for (let leaf = run.leafStart; leaf < run.leafEnd; leaf++) result[leaf] = run.level;
      }
      return result;
    };
    const position = new THREE.Vector3(0.5, 0.5, 5);
    const lookingAtLeaves = viewFrom(position, new THREE.Vector3(10.5, 0.5, 0.5));
    const lookingAway = viewFrom(position, new THREE.Vector3(-20, 0.5, 5));

    const first = scheduler.computeDesiredRuns(position, lookingAtLeaves.frustum, 1000);
    expect(levels(first)).toEqual([0, 1]);
    const rotated = scheduler.computeDesiredRuns(position, lookingAway.frustum, 2000);
    expect(levels(rotated)).toEqual([0, 1]);
  });

  it('frustumAware false: keeps a near behind-camera cell finer than a far in-view cell', () => {
    // Large LCC tiles often sit mostly behind the camera while d is small.
    // Demoting out-of-frustum first would coarsen that cell and let thinner
    // cells ahead keep finest - the backwards load. Distance-only demotion
    // (classic LCC) keeps the nearer cell.
    const near: LodLeaf = {
      bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -8), new THREE.Vector3(1, 1, -2)),
      lods: [
        { file: 0, offset: 0, count: 1000 },
        { file: 0, offset: 1000, count: 100 },
      ],
    };
    const far: LodLeaf = {
      bounds: new THREE.Box3(new THREE.Vector3(-1, -1, 5), new THREE.Vector3(1, 1, 7)),
      lods: [
        { file: 1, offset: 0, count: 1000 },
        { file: 1, offset: 1000, count: 100 },
      ],
    };
    const bounds = new THREE.Box3().setFromPoints([
      near.bounds.min,
      near.bounds.max,
      far.bounds.min,
      far.bounds.max,
    ]);
    const manifest: LodManifest = {
      leaves: [near, far],
      chunkUrls: ['n', 'f'],
      counts: [2000, 200],
      lodLevels: 2,
      bounds,
    };
    // Both within forceFinestWithin so the cut starts at finest for each;
    // budget fits only one finest + one coarse.
    const opts = {
      budget: 1100,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      forceFinestWithin: 10,
    };
    const { position, frustum } = viewFrom(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 30));

    const aware = new LodScheduler(manifest, { ...opts, frustumAware: true });
    const awareRuns = aware.computeDesiredRuns(position, frustum, 1000);
    const awareLevels = [0, 1].map(
      (i) => awareRuns.find((r) => r.leafStart <= i && r.leafEnd > i)?.level,
    );
    // Out-of-frustum near cell is demoted first → far keeps finest.
    expect(awareLevels).toEqual([1, 0]);

    const classic = new LodScheduler(manifest, { ...opts, frustumAware: false });
    const classicRuns = classic.computeDesiredRuns(position, frustum, 1000);
    const classicLevels = [0, 1].map(
      (i) => classicRuns.find((r) => r.leafStart <= i && r.leafEnd > i)?.level,
    );
    // Distance-only: nearer (behind) keeps finest; farther in-view coarsens.
    expect(classicLevels).toEqual([0, 1]);
  });

  it('run coalescing: disjoint, sorted, exact coverage, and split at the max run size', () => {
    const leafCount = 300;
    const levelCounts = [4000, 1000];
    const manifest = makeManifest(leafCount, levelCounts, 2);
    const scheduler = new LodScheduler(manifest, {
      budget: 400_000,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });

    // All leaves behind the camera: everything stays at the coarsest level
    // (1000 splats each), giving one 300 000-splat contiguous region that
    // must split into MAX_RUN_SPLATS-bounded runs (128 leaves per run).
    const { position, frustum } = viewFrom(
      new THREE.Vector3(leafCount * 2 + 10, 0.5, 0.5),
      new THREE.Vector3(leafCount * 2 + 100, 0.5, 0.5),
    );
    const runs = scheduler.computeDesiredRuns(position, frustum, 1000);

    checkRuns(runs, manifest.leaves);
    checkFullCoverage(runs, leafCount);
    for (const run of runs) expect(run.level).toBe(1);
    expect(runs.map((run) => run.count)).toEqual([128_000, 128_000, 44_000]);

    // coarsestRunsFor covers an arbitrary sub-interval at the always-cached
    // coarsest level, coalesced the same way.
    const coarsest = scheduler.coarsestRunsFor(10, 50);
    expect(coarsest).toEqual([
      {
        file: 0,
        level: 1,
        offset: 10_000,
        count: 40_000,
        leafStart: 10,
        leafEnd: 50,
        distance: expect.any(Number),
        inView: expect.any(Boolean),
      },
    ]);
  });

  it('forceFinestWithin snaps nearby leaves to finest without a hysteresis climb', () => {
    const leaf: LodLeaf = {
      bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)),
      lods: [
        { file: 0, offset: 0, count: 1000 },
        { file: 0, offset: 1000, count: 100 },
        { file: 0, offset: 1100, count: 10 },
      ],
    };
    const scheduler = new LodScheduler(
      {
        leaves: [leaf],
        chunkUrls: ['x'],
        counts: [1000, 100, 10],
        lodLevels: 3,
        bounds: leaf.bounds,
      },
      { budget: 10_000, lodBaseDistance: 10, lodMultiplier: 2, forceFinestWithin: 40 },
    );
    // Without the force, d=25 would sit at a coarser band; with it, finest.
    const { position, frustum } = (() => {
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
      camera.position.set(25, 0.5, 0.5);
      camera.lookAt(0.5, 0.5, 0.5);
      camera.updateMatrixWorld(true);
      const proj = new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      return {
        position: camera.position.clone(),
        frustum: new THREE.Frustum().setFromProjectionMatrix(proj),
      };
    })();
    const runs = scheduler.computeDesiredRuns(position, frustum, 1000);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.level).toBe(0);
  });

  it('fillPastDistance false keeps the distance band even with fill headroom', () => {
    // Mid-range (d≈15 → L1 with base=10, m=2). Huge budget would otherwise
    // promote to L0 via fill, then demote once more of the scene fills in.
    const leaf: LodLeaf = {
      bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)),
      lods: [
        { file: 0, offset: 0, count: 1000 },
        { file: 0, offset: 1000, count: 100 },
        { file: 0, offset: 1100, count: 10 },
      ],
    };
    const manifest = {
      leaves: [leaf],
      chunkUrls: ['x'],
      counts: [1000, 100, 10],
      lodLevels: 3,
      bounds: leaf.bounds,
    };
    const opts = {
      budget: 100_000,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      forceFinestWhenFits: false,
    };
    // d = 15: outside forceFinestWithin, inside L1 band.
    const { position, frustum } = viewFrom(
      new THREE.Vector3(16, 0.5, 0.5),
      new THREE.Vector3(0.5, 0.5, 0.5),
    );

    const overshoot = new LodScheduler(manifest, { ...opts, fillPastDistance: true });
    expect(overshoot.computeDesiredRuns(position, frustum, 1000)[0]!.level).toBe(0);

    const capped = new LodScheduler(manifest, { ...opts, fillPastDistance: false });
    expect(capped.computeDesiredRuns(position, frustum, 1000)[0]!.level).toBe(1);
  });

  it('fillPastDistance false: ambition L0 can stay demoted when budget is tight', () => {
    // Eight leaves at the L0 distance band would be 8000; budget holds ~4.5k.
    // Desired runs stay at the budget-resolved levels across stationary frames
    // (ambition remains L0; resolved does not oscillate).
    const leaves: LodLeaf[] = [];
    for (let i = 0; i < 8; i++) {
      leaves.push({
        bounds: new THREE.Box3(new THREE.Vector3(i * 2, 0, 0), new THREE.Vector3(i * 2 + 1, 1, 1)),
        lods: [
          { file: i, offset: 0, count: 1000 },
          { file: i, offset: 1000, count: 100 },
          { file: i, offset: 1100, count: 10 },
        ],
      });
    }
    const manifest = {
      leaves,
      chunkUrls: leaves.map((_, i) => `f${i}`),
      counts: [8000, 800, 80],
      lodLevels: 3,
      bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(16, 1, 1)),
    };
    const scheduler = new LodScheduler(manifest, {
      budget: 4500,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      forceFinestWhenFits: false,
      fillPastDistance: false,
    });
    const { position, frustum } = viewFrom(
      new THREE.Vector3(0.5, 0.5, 0.5),
      new THREE.Vector3(20, 0.5, 0.5),
    );

    const levelOf = (runs: LodRun[], leaf: number): number =>
      runs.find((r) => r.leafStart <= leaf && r.leafEnd > leaf)?.level ?? -1;

    const first = scheduler.computeDesiredRuns(position, frustum, 1000);
    expect(totalSplats(first)).toBeLessThanOrEqual(4500);
    expect(levelOf(first, 0)).toBe(0);
    const demoted = [0, 1, 2, 3, 4].filter((i) => levelOf(first, i) > 0);
    expect(demoted.length).toBeGreaterThan(0);

    const second = scheduler.computeDesiredRuns(position, frustum, 2000);
    for (let i = 0; i < 8; i++) {
      expect(levelOf(second, i)).toBe(levelOf(first, i));
    }
    expect(totalSplats(second)).toBe(totalSplats(first));
  });

  it('fillPastDistance false: L1-band neighbor never resolves to L0', () => {
    const near: LodLeaf = {
      bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)),
      lods: [
        { file: 0, offset: 0, count: 100 },
        { file: 0, offset: 100, count: 50 },
        { file: 0, offset: 150, count: 10 },
      ],
    };
    const mid: LodLeaf = {
      bounds: new THREE.Box3(new THREE.Vector3(14, 0, 0), new THREE.Vector3(15, 1, 1)),
      lods: [
        { file: 1, offset: 0, count: 100 },
        { file: 1, offset: 100, count: 50 },
        { file: 1, offset: 150, count: 10 },
      ],
    };
    const scheduler = new LodScheduler(
      {
        leaves: [near, mid],
        chunkUrls: ['a', 'b'],
        counts: [200, 100, 20],
        lodLevels: 3,
        bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(15, 1, 1)),
      },
      {
        budget: 10_000,
        lodBaseDistance: 10,
        lodMultiplier: 2,
        forceFinestWhenFits: false,
        fillPastDistance: false,
      },
    );
    // Camera at near leaf; mid leaf at d≈13 → L1 band.
    const { position, frustum } = viewFrom(
      new THREE.Vector3(0.5, 0.5, 0.5),
      new THREE.Vector3(20, 0.5, 0.5),
    );
    const runs = scheduler.computeDesiredRuns(position, frustum, 1000);
    const midLevel = runs.find((r) => r.leafStart <= 1 && r.leafEnd > 1)?.level;
    expect(midLevel).toBe(1);
  });

  it('classic cold start snaps ambition to the distance band without dwell', () => {
    const leaf: LodLeaf = {
      bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)),
      lods: [
        { file: 0, offset: 0, count: 1000 },
        { file: 0, offset: 1000, count: 100 },
        { file: 0, offset: 1100, count: 10 },
      ],
    };
    const scheduler = new LodScheduler(
      {
        leaves: [leaf],
        chunkUrls: ['x'],
        counts: [1000, 100, 10],
        lodLevels: 3,
        bounds: leaf.bounds,
      },
      {
        budget: 10_000,
        lodBaseDistance: 10,
        lodMultiplier: 2,
        forceFinestWhenFits: false,
        fillPastDistance: false,
      },
    );
    // d≈15 → L1 in one cold snap (not stepwise via dwell).
    const { position, frustum } = viewFrom(
      new THREE.Vector3(16, 0.5, 0.5),
      new THREE.Vector3(0.5, 0.5, 0.5),
    );
    expect(scheduler.computeDesiredRuns(position, frustum, 1)[0]!.level).toBe(1);
    expect(scheduler.computeDesiredRuns(position, frustum, 2)[0]!.level).toBe(1);
  });
});
