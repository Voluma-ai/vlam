import { describe, expect, it } from 'vitest';
import { buildSwapGroups, groupPriority } from '../streamed-splat-mesh';
import type { LodRun } from '../lod-scheduler';

/**
 * The wave gate in `reschedule` holds a group that retires coverage until every
 * purely additive group has landed, so a `.rad` region never draws with its
 * coarse splats gone and their replacements still uploading. That gate can only
 * decide correctly if the additive groups have already had their turn, which is
 * what this ordering guarantees.
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
