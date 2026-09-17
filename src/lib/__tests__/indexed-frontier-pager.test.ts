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
    if (pager.displaySlots.length) assertCover(pager.displaySlots, backing);
  }
  throw new Error('Candidate did not finish staging.');
}

describe('IndexedFrontierPager', () => {
  it('publishes only complete cuts, including capped writes and a disjoint replacement', () => {
    const pager = new IndexedFrontierPager(8);
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

  it('restores the displayed cut when an unacknowledged publication is superseded', () => {
    const pager = new IndexedFrontierPager(8);
    const backing = new Map<number, number>();
    let generation = pager.select([0, 1]);
    stageAll(pager, generation, backing, 2);
    pager.beginPublication(generation);
    pager.acknowledge(generation);
    const oldSlots = pager.displaySlots;

    generation = pager.select([2, 3, 4, 5]);
    stageAll(pager, generation, backing, 4);
    expect(pager.beginPublication(generation)).not.toBeNull();
    expect(pager.awaitingPublication).toBe(true);
    expect(pager.cancelUnpublishedPublication()).toBe(true);
    expect(pager.awaitingPublication).toBe(false);
    expect(pager.displaySlots).toEqual(oldSlots);
    expect(pager.acknowledge(generation)).toBe(false);
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

  it('checks acknowledged storage before accepting an atomic replacement', () => {
    const pager = new IndexedFrontierPager(4);
    let generation = pager.select([0, 1]);
    pager.stage(generation, 2);
    pager.beginPublication(generation);
    pager.acknowledge(generation);

    expect(pager.canStage([0, 1], 2)).toBe(true);
    expect(pager.canStage([2, 3], 2)).toBe(false);
    expect(pager.canStage([0, 2], 2)).toBe(false);
    expect(pager.canStage([0, 1, 2], 2)).toBe(false);
    expect(pager.canStage([2, 3], 4)).toBe(true);

    generation = pager.select([2, 3]);
    expect(pager.canStage([0, 1], 4)).toBe(false);
    pager.stage(generation, 2);
    pager.beginPublication(generation);
    expect(pager.canStage([0, 1], 4)).toBe(false);
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

  it('matches an unpublished candidate so a later publish gate can resume it', () => {
    const pager = new IndexedFrontierPager(8);
    const generation = pager.select([0, 1]);
    pager.stage(generation, 2);
    expect(pager.matchesCandidate([0, 1])).toBe(true);
    expect(pager.matchesCandidate([0, 1, 2])).toBe(false);
    pager.cancel();
    expect(pager.matchesCandidate([0, 1])).toBe(false);
    expect(pager.canStage([2, 3, 4, 5], 8)).toBe(true);
  });

  it('shrinks only after publication releases unused tail slots', () => {
    const pager = new IndexedFrontierPager(8);
    const generation = pager.select([0, 1]);
    pager.stage(generation, 2);
    pager.beginPublication(generation);
    expect(pager.shrinkIfSafe(2)).toBe(false);
    pager.acknowledge(generation);
    expect(pager.shrinkIfSafe(2)).toBe(true);
    expect(pager.capacity).toBe(2);
  });

  it('ignores a superseded shrink acknowledgment', () => {
    const pager = new IndexedFrontierPager(8);
    const fill = pager.select([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(pager.stage(fill, 8)?.complete).toBe(true);
    pager.beginPublication(fill);
    pager.acknowledge(fill);
    expect(pager.requestShrink(4)).toBe(false);
    const smaller = pager.select([0, 1, 2, 3], 4);
    expect(pager.stage(smaller, 8)?.complete).toBe(true);
    pager.beginPublication(smaller);
    expect(pager.requestShrink(2)).toBe(false);
    expect(pager.acknowledge(smaller)).toBe(true);
    expect(pager.capacity).toBe(8);
    expect(pager.consumeResizeSafeCapacity()).toBeNull();
    const finest = pager.select([0, 1], 2);
    expect(pager.stage(finest, 8)?.complete).toBe(true);
    pager.beginPublication(finest);
    expect(pager.acknowledge(finest)).toBe(true);
    expect(pager.capacity).toBe(2);
    expect(pager.consumeResizeSafeCapacity()).toBe(2);
  });
});
