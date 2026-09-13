import { describe, expect, it } from 'vitest';
import { buildSwapGroups, groupPriority } from '../streaming/streamed-splat-mesh';
import type { LodRun } from '../streaming/lod-scheduler';

/**
 * The RAD wave stages cached adds hidden, then commits them with retirements.
 * Additive groups still sort first so staging happens before the wave decides
 * whether every cached replacement has landed.
 */

function run(level: number, leafStart: number, leafEnd: number): LodRun {
  return { file: 0, offset: 0, count: leafEnd - leafStart, level, leafStart, leafEnd };
}

function group(adds: LodRun[], removeCount: number) {
  return {
    adds,
    removes: Array.from({ length: removeCount }, (_, i) => [
      `r${i}`,
      { run: run(0, i, i + 1), handle: { count: 1 } },
    ]) as never,
    leafStart: 0,
    leafEnd: 1,
    addCount: adds.reduce((total, add) => total + add.count, 0),
  };
}

describe('swap group ordering', () => {
  it('splits L0 LCC slices into per-leaf swap groups', () => {
    const cellRun = (offset: number, level: number): LodRun => ({
      file: 0,
      level,
      offset,
      count: 100,
      leafStart: offset / 100,
      leafEnd: offset / 100 + 1,
      coverageGroup: 42,
    });
    const oldA = cellRun(0, 2);
    const oldB = cellRun(100, 2);
    const nextA = cellRun(0, 0);
    const nextB = cellRun(100, 0);

    const groups = buildSwapGroups(
      [nextA, nextB],
      [
        ['old-a', { run: oldA, handle: { count: 100 } }],
        ['old-b', { run: oldB, handle: { count: 100 } }],
      ],
    );

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.adds)).toEqual([[nextA], [nextB]]);
    expect(groups.every((g) => g.removes.length === 1)).toBe(true);
  });

  it('splits L1+ LCC slices into per-leaf swap groups', () => {
    const cellRun = (offset: number, level: number): LodRun => ({
      file: 0,
      level,
      offset,
      count: 100,
      leafStart: offset / 100,
      leafEnd: offset / 100 + 1,
      coverageGroup: 42,
    });
    const oldA = cellRun(0, 2);
    const oldB = cellRun(100, 2);
    const nextA = cellRun(0, 1);
    const nextB = cellRun(100, 1);

    const groups = buildSwapGroups(
      [nextA, nextB],
      [
        ['old-a', { run: oldA, handle: { count: 100 } }],
        ['old-b', { run: oldB, handle: { count: 100 } }],
      ],
    );

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.adds)).toEqual([[nextA], [nextB]]);
    expect(groups.every((g) => g.removes.length === 1)).toBe(true);
  });

  it('replaces a shared coarse LCC run with all overlapping slices in one transaction', () => {
    const coarse: LodRun = {
      file: 0,
      level: 2,
      offset: 0,
      count: 30,
      leafStart: 0,
      leafEnd: 3,
      coverageGroup: 42,
    };
    const finer = [0, 1, 2].map((leaf): LodRun => ({
      file: leaf + 1,
      level: 1,
      offset: 0,
      count: 100,
      leafStart: leaf,
      leafEnd: leaf + 1,
      coverageGroup: 42,
    }));
    const groups = buildSwapGroups(finer, [['coarse', { run: coarse, handle: { count: 30 } }]]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.adds).toEqual(finer);
    expect(groups[0]?.removes.map(([key]) => key)).toEqual(['coarse']);
    expect(groups[0]).toMatchObject({ leafStart: 0, leafEnd: 3 });

    const reverse = buildSwapGroups(
      [coarse],
      finer.map((run, leaf) => [`fine-${leaf}`, { run, handle: { count: 100 } }]),
    );
    expect(reverse).toHaveLength(1);
    expect(reverse[0]?.adds).toEqual([coarse]);
    expect(reverse[0]?.removes).toHaveLength(3);
  });

  it('keeps a parent in the same group as non-overlapping children it contains', () => {
    const parent = run(5, 0, 20);
    const left = run(0, 0, 5);
    const right = run(0, 5, 10);
    const groups = buildSwapGroups(
      [left, right],
      [['old', { run: parent, handle: { count: parent.count } }]],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.adds).toEqual([left, right]);
    expect(groups[0]?.removes).toHaveLength(1);
  });

  it('runs purely additive groups before any group that retires coverage', () => {
    const additive = group([run(0, 0, 100)], 0);
    const retiring = group([run(4, 0, 100)], 1);
    // Even though the retiring group is coarser - which otherwise wins - it
    // sorts after, so the gate knows whether the replacements have landed.
    expect(groupPriority(additive)).toBeLessThan(groupPriority(retiring));
  });

  it('keeps coarse-before-fine among purely additive groups', () => {
    // A higher `level` is the coarser one, so it sorts first.
    const coarse = group([run(4, 0, 100)], 0);
    const fine = group([run(0, 0, 100)], 0);
    expect(groupPriority(coarse)).toBeLessThan(groupPriority(fine));
  });

  it('runs pure removals last, where they relieve the over-draw', () => {
    const others = [group([run(0, 0, 100)], 0), group([run(4, 0, 100)], 2)];
    const pureRemoval = group([], 3);
    for (const other of others) {
      expect(groupPriority(other)).toBeLessThan(groupPriority(pureRemoval));
    }
  });
});
