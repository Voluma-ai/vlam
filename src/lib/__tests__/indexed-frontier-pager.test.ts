import { describe, expect, it } from 'vitest';
import { IndexedFrontierPager } from '../formats/rad/indexed-frontier-pager';

// Two roots: 0→[2,3], 1→[4,5]. Every published cut must cover both
// regions exactly once; the old prefix pager exposed [0,2,3] on a capped
// replacement, simultaneously overlapping one region and leaving out the other.
const leaves: Record<number, readonly number[]> = {
  0: [2, 3],
  1: [4, 5],
  2: [2],
  3: [3],
  4: [4],
  5: [5],
};

function assertCover(slots: Uint32Array, backing: Map<number, number>): void {
  const covered = new Set<number>();
  for (const slot of slots) {
    const global = backing.get(slot);
    expect(global).toBeDefined();
    for (const leaf of leaves[global as number] ?? []) {
      expect(covered.has(leaf)).toBe(false);
      covered.add(leaf);
    }
  }
  expect(covered).toEqual(new Set([2, 3, 4, 5]));
}

function stageAll(
  pager: IndexedFrontierPager,
  generation: number,
  backing: Map<number, number>,
  cap: number,
): void {
  for (let tick = 0; tick < 20; tick++) {
    const stage = pager.stage(generation, cap);
    expect(stage).not.toBeNull();
    for (let i = 0; i < stage!.slots.length; i++) {
      backing.set(stage!.slots[i] as number, stage!.globals[i] as number);
    }
    if (stage!.complete) return;
    // A staged child is never drawn beside its published ancestor.
    if (pager.displaySlots.length) assertCover(pager.displaySlots, backing);
  }
  throw new Error('Candidate did not finish staging.');
}

describe('IndexedFrontierPager', () => {
  it('publishes only complete cuts, including capped writes and a disjoint replacement', () => {
    const pager = new IndexedFrontierPager(8); // 2× the largest drawn frontier
    const backing = new Map<number, number>();
    for (const cut of [
      [0, 1],
      [2, 3, 4, 5],
      [0, 1],
      [2, 3, 4, 5],
    ]) {
      const generation = pager.select(cut);
      stageAll(pager, generation, backing, 1);
      const publication = pager.beginPublication(generation);
      expect(publication?.count).toBe(cut.length);
      assertCover(publication!.slots, backing);
      expect(pager.acknowledge(generation)).toBe(true);
    }
  });

  it('reuses unchanged splats without writing them and protects retired slots until ack', () => {
    const pager = new IndexedFrontierPager(8);
    const backing = new Map<number, number>();
    let generation = pager.select([0, 1]);
    stageAll(pager, generation, backing, 1);
    pager.beginPublication(generation);
    pager.acknowledge(generation);
    const first = pager.displaySlots;

    generation = pager.select([0, 4, 5]);
    const staged = pager.stage(generation, 2)!;
    expect(staged.globals).toEqual(Uint32Array.from([4, 5]));
    const publication = pager.beginPublication(generation)!;
    expect(publication.slots[0]).toBe(first[0]);
    expect(() => pager.select([2, 3, 4, 5])).toThrow(/acknowledgment/);
    expect(pager.acknowledge(generation - 1)).toBe(false);
    expect(pager.acknowledge(generation)).toBe(true);
  });

  it('rejects stale work and cancels only candidate-owned slots on a camera change', () => {
    const pager = new IndexedFrontierPager(8);
    const backing = new Map<number, number>();
    let generation = pager.select([0, 1]);
    stageAll(pager, generation, backing, 2);
    pager.beginPublication(generation);
    pager.acknowledge(generation);
    const old = pager.displaySlots;
    const stale = pager.select([2, 3, 4, 5]);
    pager.stage(stale, 1);
    generation = pager.select([0, 1]);
    expect(pager.stage(stale, 2)).toBeNull();
    stageAll(pager, generation, backing, 1);
    expect(pager.beginPublication(stale)).toBeNull();
    expect(pager.beginPublication(generation)?.slots).toEqual(old);
    assertCover(pager.displaySlots, backing);
    pager.acknowledge(generation);
  });

  it('waits when capacity is insufficient instead of corrupting the displayed cover', () => {
    const pager = new IndexedFrontierPager(4);
    const backing = new Map<number, number>();
    let generation = pager.select([2, 3, 4, 5]);
    stageAll(pager, generation, backing, 4);
    pager.beginPublication(generation);
    pager.acknowledge(generation);

    generation = pager.select([0, 1]);
    const blocked = pager.stage(generation, 4)!;
    expect(blocked.complete).toBe(false);
    expect(blocked.globals.length).toBe(0);
    expect(pager.beginPublication(generation)).toBeNull();
    assertCover(pager.displaySlots, backing);
  });

  it('protects both generations from cache eviction until publication is acknowledged', () => {
    const pager = new IndexedFrontierPager(4, 2);
    let generation = pager.select([0, 1]);
    pager.stage(generation, 2);
    pager.beginPublication(generation);
    pager.acknowledge(generation);

    generation = pager.select([2, 3]);
    pager.stage(generation, 2);
    expect(pager.hasResidentIn(0)).toBe(true);
    expect(pager.hasResidentIn(1)).toBe(true);
    pager.beginPublication(generation);
    expect(pager.hasResidentIn(0)).toBe(true);
    expect(pager.acknowledge(generation - 1)).toBe(false);
    pager.acknowledge(generation);
    expect(pager.hasResidentIn(0)).toBe(false);
    expect(pager.hasResidentIn(1)).toBe(true);
  });
});
