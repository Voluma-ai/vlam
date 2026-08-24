import { describe, expect, it } from 'vitest';
import { FrontierPager, type PagerPlan } from '../formats/rad/frontier-pager';

/** Deterministic PRNG (mulberry32) for the property tests. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A model of the main thread's `applyFrontierPlan`: a slot → global slab that
 * only ever sees the plan's ops (moves, appends, active-prefix count), exactly
 * as `StreamedSplatMesh` memcpys them into the GPU pool. Used to prove that a
 * fully-applied plan always leaves the slab prefix identical to the pager's
 * resident set - i.e. the plan protocol admits no partial/corrupt outcome.
 */
class SlabModel {
  readonly slots: Int32Array;
  count = 0;
  constructor(capacity: number) {
    this.slots = new Int32Array(capacity).fill(-1);
  }
  apply(plan: PagerPlan): void {
    for (const m of plan.moves) this.slots[m.slot] = m.global;
    for (let j = 0; j < plan.appends.length; j++) {
      this.slots[plan.appendStart + j] = plan.appends[j] as number;
    }
    for (let s = plan.degenerateStart; s < plan.degenerateStart + plan.degenerateCount; s++) {
      this.slots[s] = -1;
    }
    this.count = plan.count;
  }
  /**
   * `applyFrontierPlan`'s handling of a plan built before a resize landed: every
   * op is applied, truncated at the slots that now exist. Mirrors the clamping
   * in `StreamedSplatMesh.applyFrontierPlan`.
   */
  applyClamped(plan: PagerPlan, limit: number): void {
    for (const m of plan.moves) if (m.slot < limit) this.slots[m.slot] = m.global;
    for (let j = 0; j < plan.appends.length; j++) {
      if (plan.appendStart + j < limit)
        this.slots[plan.appendStart + j] = plan.appends[j] as number;
    }
    const degenerateEnd = Math.min(plan.degenerateStart + plan.degenerateCount, limit);
    for (let s = plan.degenerateStart; s < degenerateEnd; s++) this.slots[s] = -1;
    this.count = Math.min(plan.count, limit);
  }
  /** The live prefix as a set of globals; throws on duplicates or holes. */
  residentSet(): Set<number> {
    const set = new Set<number>();
    for (let s = 0; s < this.count; s++) {
      const g = this.slots[s] as number;
      expect(g).toBeGreaterThanOrEqual(0); // no hole inside the live prefix
      expect(set.has(g)).toBe(false); // no double-resident global
      set.add(g);
    }
    return set;
  }
}

describe('FrontierPager', () => {
  it('appends newcomers contiguously at the tail on first update', () => {
    const p = new FrontierPager(16);
    const plan = p.update([1, 2, 3]);
    expect(plan.moves).toEqual([]);
    expect(plan.appendStart).toBe(0);
    expect(Array.from(plan.appends).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(plan.count).toBe(3);
    expect(plan.degenerateCount).toBe(0);
    expect(plan.dropped).toBe(0);
    expect(p.residentCount).toBe(3);
    expect(p.has(2)).toBe(true);
  });

  it('is a no-op when the frontier is unchanged', () => {
    const p = new FrontierPager(16);
    p.update([1, 2, 3]);
    const plan = p.update([1, 2, 3]);
    expect(plan.moves).toEqual([]);
    expect(plan.appends.length).toBe(0);
    expect(plan.degenerateCount).toBe(0);
    expect(plan.count).toBe(3);
  });

  it('swap-removes a middle leaver with one tail move', () => {
    const p = new FrontierPager(16);
    p.update([1, 2, 3]); // slots: 1→0, 2→1, 3→2
    const plan = p.update([1, 3]); // 2 leaves; tail 3 fills its slot
    expect(plan.moves).toEqual([{ slot: 1, global: 3 }]);
    expect(plan.appends.length).toBe(0);
    expect(plan.count).toBe(2);
    expect(plan.degenerateStart).toBe(2);
    expect(plan.degenerateCount).toBe(1);
    expect(p.has(2)).toBe(false);
    expect(p.has(1) && p.has(3)).toBe(true);
  });

  it('drops a tail leaver without a move', () => {
    const p = new FrontierPager(16);
    p.update([1, 2, 3]);
    p.update([1, 3]); // now 1→0, 3→1
    const plan = p.update([1]); // 3 is the tail → removed, no move
    expect(plan.moves).toEqual([]);
    expect(plan.count).toBe(1);
    expect(plan.degenerateCount).toBe(1);
  });

  it('handles two leavers where the pulled-in tail is itself a leaver', () => {
    const p = new FrontierPager(16);
    p.update([1, 2, 3]);
    const plan = p.update([1]); // 2 and 3 both leave; no survivor to move
    expect(plan.moves).toEqual([]);
    expect(plan.count).toBe(1);
    expect(p.has(1)).toBe(true);
    expect(p.has(2) || p.has(3)).toBe(false);
  });

  it('combines removes and adds: leaver slot reused only after compaction', () => {
    const p = new FrontierPager(16);
    p.update([1, 2, 3, 4]); // 1→0,2→1,3→2,4→3
    const plan = p.update([1, 4, 5, 6]); // 2,3 leave; 5,6 enter
    // 2 leaves at slot1 → tail 4 moves in (slot1); 3 leaves at slot2 → tail (now 3? ) ...
    expect(plan.count).toBe(4);
    // survivors 1 and 4 occupy [0,2); 5,6 appended at [2,4)
    expect(plan.appendStart).toBe(2);
    expect(Array.from(plan.appends).sort((a, b) => a - b)).toEqual([5, 6]);
    expect(p.has(2) || p.has(3)).toBe(false);
    expect([1, 4, 5, 6].every((g) => p.has(g))).toBe(true);
  });

  it('drops newcomers that exceed capacity and reports the count', () => {
    const p = new FrontierPager(2);
    const plan = p.update([1, 2, 3, 4]);
    expect(plan.count).toBe(2);
    expect(plan.dropped).toBe(2);
    expect(p.residentCount).toBe(2);
  });

  it('plan minimality: no redundant ops across randomized frontier churn', () => {
    // E7 invariant: a plan never re-loads a resident splat, never moves a
    // leaver, never evicts (degenerates) a slot still in the selected cut, and
    // its op count is bounded by the frontier delta - never the whole frontier.
    const rand = rng(0xe7);
    const capacity = 64;
    const p = new FrontierPager(capacity);
    let prevResident = new Set<number>();
    for (let step = 0; step < 200; step++) {
      const desired = new Set<number>();
      const n = Math.floor(rand() * capacity);
      for (let k = 0; k < n; k++) desired.add(Math.floor(rand() * 128));
      const plan = p.update(desired);

      const appended = new Set(plan.appends);
      expect(appended.size).toBe(plan.appends.length); // no duplicate appends
      for (const g of appended) {
        expect(desired.has(g)).toBe(true); // never load an unselected splat
        expect(prevResident.has(g)).toBe(false); // never re-load a resident splat
      }
      const leavers = [...prevResident].filter((g) => !desired.has(g)).length;
      const enters = [...desired].filter((g) => !prevResident.has(g)).length;
      expect(plan.appends.length + plan.dropped).toBe(enters);
      expect(plan.moves.length).toBeLessThanOrEqual(leavers); // ∝ delta, not frontier
      for (const m of plan.moves) {
        expect(desired.has(m.global)).toBe(true); // moved splats are survivors
        expect(prevResident.has(m.global)).toBe(true);
        expect(m.slot).toBeLessThan(plan.appendStart); // moves land in the compacted head
        expect(appended.has(m.global)).toBe(false); // never both moved and appended
      }
      // Degenerated slots are exactly the vacated tail - never live-cut slots.
      expect(plan.degenerateStart).toBe(plan.count);
      expect(plan.count).toBe(Math.min(desired.size, capacity));

      prevResident = new Set<number>();
      for (const g of desired) if (p.has(g)) prevResident.add(g);
      expect(prevResident.size).toBe(plan.count);
    }
  });

  it('apply atomicity: a fully-applied plan keeps the slab exactly the resident set', () => {
    // E7 invariant: the main thread applies each plan whole, in message order
    // (one reschedule outstanding; the worker owns the pager). Under that
    // protocol the slab prefix must equal the pager's resident set after every
    // plan - no duplicate slots, no holes, no stale survivors - including
    // across capacity-overflow drops and a clear() (scene-reload) rebuild.
    const rand = rng(0xa70);
    const capacity = 32;
    const p = new FrontierPager(capacity);
    const slab = new SlabModel(capacity);
    for (let step = 0; step < 150; step++) {
      if (step === 75) {
        // Scene reload: pager clears; the slab is rebuilt by the next plan's
        // appends (count truncation hides any stale tail).
        p.clear();
        slab.count = 0;
      }
      const desired = new Set<number>();
      const n = Math.floor(rand() * (capacity * 1.5)); // sometimes overflows capacity
      for (let k = 0; k < n; k++) desired.add(Math.floor(rand() * 100));
      const plan = p.update(desired);
      slab.apply(plan);
      const resident = slab.residentSet();
      expect(resident.size).toBe(p.residentCount);
      for (const g of resident) {
        expect(p.has(g)).toBe(true);
        expect(desired.has(g)).toBe(true); // slab holds only selected splats
      }
      if (desired.size <= capacity) {
        expect(resident.size).toBe(desired.size); // full cut resident when it fits
        expect(plan.dropped).toBe(0);
      }
    }
  });

  it('emits moves in strictly ascending slot order', () => {
    // `StreamedSplatMesh.applyFrontierPlan` groups consecutive move slots into
    // runs so one pool write covers many splats. That is only correct while the
    // slots come out ascending - assert the swap-remove loop keeps it that way,
    // including under the randomized churn that produces the longest runs.
    const rand = rng(0x51075);
    const p = new FrontierPager(128);
    p.update(Array.from({ length: 128 }, (_v, i) => i));
    for (let round = 0; round < 200; round++) {
      const desired: number[] = [];
      for (let g = 0; g < 200; g++) if (rand() < 0.5) desired.push(g);
      const plan = p.update(desired);
      for (let i = 1; i < plan.moves.length; i++) {
        expect(plan.moves[i]!.slot).toBeGreaterThan(plan.moves[i - 1]!.slot);
      }
    }
  });

  describe('maxAppends (bounded per-plan cost)', () => {
    const CAP = 50;

    it('bounds appends and moves, and reaches the uncapped frontier by repeating', () => {
      // The whole point of the cap: a hard camera cut must not arrive as one
      // huge plan, but must still converge to exactly the frontier an uncapped
      // pager would have reached in one step.
      const p = new FrontierPager(600);
      const slab = new SlabModel(600);
      slab.apply(p.update(Array.from({ length: 500 }, (_v, i) => i)));

      // Total churn: a disjoint frontier of the same size (the sideways-camera
      // case a traversal-budget ramp cannot bound, because nothing *grows*).
      const next = Array.from({ length: 500 }, (_v, i) => 1000 + i);
      let rounds = 0;
      let plan = p.update(next, { maxAppends: CAP });
      for (;;) {
        expect(plan.appends.length).toBeLessThanOrEqual(CAP);
        expect(plan.moves.length).toBeLessThanOrEqual(CAP);
        expect(plan.dropped).toBe(0);
        slab.apply(plan);
        expect(slab.residentSet().size).toBe(plan.count); // no holes, no dupes
        if (!plan.truncated) break;
        expect(++rounds).toBeLessThan(100); // must make progress every round
        plan = p.update(next, { maxAppends: CAP });
      }
      expect(slab.residentSet()).toEqual(new Set(next));
    });

    it('defers rather than drops: every intermediate frontier stays a valid cover', () => {
      // Deferred leavers stay resident, so an intermediate set is always a
      // superset of (old ∩ new) - never a set with content missing from both.
      const p = new FrontierPager(600);
      const before = Array.from({ length: 400 }, (_v, i) => i);
      p.update(before);
      const next = [...before.slice(200), ...Array.from({ length: 200 }, (_v, i) => 5000 + i)];
      const plan = p.update(next, { maxAppends: CAP });
      expect(plan.truncated).toBe(true);
      for (const g of before.slice(200)) expect(p.has(g)).toBe(true); // survivors held
      // Nothing the new frontier still wants was evicted to make room.
      expect(plan.count).toBeGreaterThanOrEqual(before.length);
    });

    it('is a no-op when the plan already fits under the cap', () => {
      const p = new FrontierPager(100);
      p.update([1, 2, 3]);
      const plan = p.update([1, 2, 3, 4], { maxAppends: CAP });
      expect(plan.truncated).toBe(false);
      expect(Array.from(plan.appends)).toEqual([4]);
    });

    it('still converges when the slab is full, by pacing evictions with appends', () => {
      // No headroom: progress requires evicting, and the cap must bound that too
      // or the "moves" half of the cost is unbounded.
      const p = new FrontierPager(200);
      const slab = new SlabModel(200);
      slab.apply(p.update(Array.from({ length: 200 }, (_v, i) => i)));
      const next = Array.from({ length: 200 }, (_v, i) => 900 + i);
      for (let round = 0; round < 100; round++) {
        const plan = p.update(next, { maxAppends: CAP });
        expect(plan.appends.length).toBeLessThanOrEqual(CAP);
        expect(plan.moves.length).toBeLessThanOrEqual(CAP);
        slab.apply(plan);
        expect(slab.residentSet().size).toBe(plan.count);
        if (!plan.truncated) break;
      }
      expect(slab.residentSet()).toEqual(new Set(next));
    });
  });

  describe('drain (finishing a truncated plan without re-diffing)', () => {
    const CAP = 50;

    it('reaches the same frontier as repeated update, without the desired set', () => {
      // The reason drain exists: re-passing `desired` costs a full O(frontier)
      // diff per plan, which on a 4M-splat frontier is ~66 of them. Draining
      // must land on exactly the state those repeated updates would.
      const desired = Array.from({ length: 500 }, (_v, i) => 1000 + i);

      const viaUpdate = new FrontierPager(600);
      const updateSlab = new SlabModel(600);
      updateSlab.apply(viaUpdate.update(Array.from({ length: 500 }, (_v, i) => i)));
      for (let round = 0; round < 100; round++) {
        const plan = viaUpdate.update(desired, { maxAppends: CAP });
        updateSlab.apply(plan);
        if (!plan.truncated) break;
      }

      const viaDrain = new FrontierPager(600);
      const drainSlab = new SlabModel(600);
      drainSlab.apply(viaDrain.update(Array.from({ length: 500 }, (_v, i) => i)));
      let plan = viaDrain.update(desired, { maxAppends: CAP });
      drainSlab.apply(plan);
      let rounds = 0;
      while (plan.truncated) {
        expect(viaDrain.hasPendingDrain).toBe(true);
        plan = viaDrain.drain(CAP);
        expect(plan.appends.length).toBeLessThanOrEqual(CAP);
        expect(plan.moves.length).toBeLessThanOrEqual(CAP);
        drainSlab.apply(plan);
        expect(drainSlab.residentSet().size).toBe(plan.count); // no holes, no dupes
        expect(++rounds).toBeLessThan(100);
      }
      expect(viaDrain.hasPendingDrain).toBe(false);
      expect(drainSlab.residentSet()).toEqual(new Set(desired));
      expect(drainSlab.residentSet()).toEqual(updateSlab.residentSet());
    });

    it('drains a growth ramp into free slots with no moves at all', () => {
      // The cold-load case from `cest_ca.rad`: nothing to evict, so the whole
      // cost is appends and the slab only ever grows.
      const p = new FrontierPager(600);
      const slab = new SlabModel(600);
      const desired = Array.from({ length: 500 }, (_v, i) => i);
      let plan = p.update(desired, { maxAppends: CAP });
      expect(plan.truncated).toBe(true);
      slab.apply(plan);
      while (plan.truncated) {
        plan = p.drain(CAP);
        expect(plan.moves).toEqual([]);
        expect(plan.appendStart).toBe(slab.count);
        slab.apply(plan);
      }
      expect(slab.residentSet()).toEqual(new Set(desired));
    });

    it('delivers queued newcomers in traversal order, biggest-on-screen first', () => {
      // The traversal emits the frontier largest-first; drain must not reorder
      // it, or the early plans page in the least visible detail.
      const p = new FrontierPager(600);
      const desired = Array.from({ length: 200 }, (_v, i) => i);
      const seen: number[] = [];
      let plan = p.update(desired, { maxAppends: CAP });
      seen.push(...plan.appends);
      while (plan.truncated) {
        plan = p.drain(CAP);
        seen.push(...plan.appends);
      }
      expect(seen).toEqual(desired);
    });

    it('a new update mid-drain discards the queue and re-diffs', () => {
      // A camera move invalidates the deferred work: the pager must forget it
      // rather than page in splats the new cut never selected.
      const p = new FrontierPager(600);
      const slab = new SlabModel(600);
      const first = Array.from({ length: 400 }, (_v, i) => i);
      slab.apply(p.update(first, { maxAppends: CAP }));
      expect(p.hasPendingDrain).toBe(true);

      const second = Array.from({ length: 300 }, (_v, i) => 9000 + i);
      let plan = p.update(second, { maxAppends: CAP });
      slab.apply(plan);
      while (plan.truncated) {
        plan = p.drain(CAP);
        slab.apply(plan);
      }
      expect(slab.residentSet()).toEqual(new Set(second));
      // None of the first frontier's deferred newcomers leaked in.
      for (const g of first) expect(p.has(g)).toBe(false);
    });

    it('a resize mid-drain discards the queue', () => {
      const p = new FrontierPager(600);
      p.update(
        Array.from({ length: 500 }, (_v, i) => i),
        { maxAppends: CAP },
      );
      expect(p.hasPendingDrain).toBe(true);
      p.resize(700);
      expect(p.hasPendingDrain).toBe(false);
      // Draining an empty queue is inert, not a corrupt plan.
      const plan = p.drain(CAP);
      expect(plan.appends.length).toBe(0);
      expect(plan.moves).toEqual([]);
      expect(plan.truncated).toBe(false);
    });

    it('drops queued newcomers that can never be seated, and reports them', () => {
      // Capacity, not the cap, is the binding limit - the excess must be
      // reported rather than leaving a queue that can never finish.
      const p = new FrontierPager(100);
      const slab = new SlabModel(100);
      const desired = Array.from({ length: 300 }, (_v, i) => i);
      let plan = p.update(desired, { maxAppends: CAP });
      slab.apply(plan);
      let dropped = plan.dropped;
      let rounds = 0;
      while (plan.truncated) {
        plan = p.drain(CAP);
        slab.apply(plan);
        dropped += plan.dropped;
        expect(++rounds).toBeLessThan(50);
      }
      expect(p.residentCount).toBe(100);
      expect(dropped).toBe(200);
      expect(slab.residentSet().size).toBe(100);
    });

    it('drains deferred leavers when the frontier shrank and has no newcomers', () => {
      // Nothing to append, so the cap's second term is what retires the
      // leftovers; without it the frontier would sit permanently truncated.
      const p = new FrontierPager(600);
      const slab = new SlabModel(600);
      slab.apply(p.update(Array.from({ length: 400 }, (_v, i) => i)));
      const next = Array.from({ length: 100 }, (_v, i) => i);
      let plan = p.update(next, { maxAppends: CAP });
      slab.apply(plan);
      let rounds = 0;
      while (plan.truncated) {
        plan = p.drain(CAP);
        slab.apply(plan);
        expect(slab.residentSet().size).toBe(plan.count);
        expect(++rounds).toBeLessThan(50);
      }
      expect(slab.residentSet()).toEqual(new Set(next));
    });

    it('keeps every occupied slot describing written content across a drain ramp', () => {
      // The invariant the cap was built around: no slot inside the drawn prefix
      // may ever hold content the host was not told to write.
      const rand = rng(0xd7a1);
      const p = new FrontierPager(400);
      const slab = new SlabModel(400);
      slab.apply(p.update(Array.from({ length: 300 }, (_v, i) => i)));
      for (let round = 0; round < 8; round++) {
        const desired: number[] = [];
        for (let g = 0; g < 600; g++) if (rand() < 0.5) desired.push(g);
        let plan = p.update(desired.slice(0, 350), { maxAppends: CAP });
        slab.apply(plan);
        let guard = 0;
        while (plan.truncated) {
          plan = p.drain(CAP);
          expect(plan.moves.length + plan.appends.length).toBeLessThanOrEqual(2 * CAP);
          slab.apply(plan);
          expect(slab.residentSet().size).toBe(plan.count);
          expect(++guard).toBeLessThan(100);
        }
        expect(slab.residentSet()).toEqual(new Set(desired.slice(0, 350)));
      }
    });
  });

  describe('a plan that raced a resize', () => {
    // The host builds a plan at one capacity and can only apply it after a
    // resize has landed. The pager has already mutated itself as if the whole
    // plan ran, so the plan must still be applied - clamped to the surviving
    // slots - or the two desynchronize and the un-applied slots keep stale
    // content underneath a live resident count.
    function resident(p: FrontierPager, slab: SlabModel): void {
      const set = slab.residentSet();
      expect(set.size).toBe(p.residentCount);
      for (const g of set) expect(p.has(g)).toBe(true);
    }

    it('leaves the slab agreeing with the pager after a shrink', () => {
      const p = new FrontierPager(512);
      const slab = new SlabModel(512);
      slab.apply(p.update(Array.from({ length: 400 }, (_v, i) => i)));
      // Plan built at 512; the resize to 300 lands before it is applied.
      const raced = p.update(Array.from({ length: 400 }, (_v, i) => 200 + i));
      p.resize(300);
      slab.applyClamped(raced, 300);
      resident(p, slab);
      // And the next plan converges from there with no lasting damage.
      const next = Array.from({ length: 250 }, (_v, i) => 500 + i);
      slab.apply(p.update(next));
      expect(slab.residentSet()).toEqual(new Set(next));
    });

    it('leaves the slab agreeing with the pager after a grow', () => {
      const p = new FrontierPager(256);
      const slab = new SlabModel(1024);
      slab.apply(p.update(Array.from({ length: 200 }, (_v, i) => i)));
      const raced = p.update(Array.from({ length: 240 }, (_v, i) => 100 + i));
      p.resize(1024); // grow keeps every resident slot in place
      slab.applyClamped(raced, 1024);
      resident(p, slab);
    });
  });

  describe('resident chunk protection', () => {
    // The worker's cache eviction consults `hasResidentIn` so it never drops a
    // chunk whose splats are still in the slab. If the accounting drifts, the
    // gather for the next swap-remove writes zeros into a drawn slot - the dark
    // speckle a refining region showed.
    const CHUNK = 100;
    /** Every chunk that owns at least one splat currently in the slab. */
    function residentChunks(slab: SlabModel): Set<number> {
      const files = new Set<number>();
      for (let slot = 0; slot < slab.count; slot++) {
        const g = slab.slots[slot] as number;
        if (g >= 0) files.add(Math.floor(g / CHUNK));
      }
      return files;
    }
    function expectAgrees(p: FrontierPager, slab: SlabModel): void {
      const actual = residentChunks(slab);
      // Anything the slab still draws must be protected. (The pager may protect
      // a little more than the slab shows, never less.)
      for (const file of actual) expect(p.hasResidentIn(file)).toBe(true);
      for (let file = 0; file < 40; file++) {
        if (!actual.has(file)) expect(p.hasResidentIn(file)).toBe(false);
      }
    }

    it('protects chunks of deferred leavers held back by the append cap', () => {
      const p = new FrontierPager(400, CHUNK);
      const slab = new SlabModel(400);
      // Frontier entirely in chunks 0-2, then replaced by one in chunks 10-12.
      slab.apply(p.update(Array.from({ length: 300 }, (_v, i) => i)));
      const next = Array.from({ length: 300 }, (_v, i) => 1000 + i);
      let sawTruncated = false;
      for (let round = 0; round < 100; round++) {
        const plan = p.update(next, { maxAppends: 32 });
        slab.apply(plan);
        if (plan.truncated) sawTruncated = true;
        // Mid-transition the slab holds both old and new chunks; every one of
        // them must read as resident, or the worker would evict it.
        expectAgrees(p, slab);
        if (!plan.truncated) break;
      }
      expect(sawTruncated).toBe(true);
      expect(p.hasResidentIn(0)).toBe(false); // fully retired once converged
      expect(p.hasResidentIn(10)).toBe(true);
    });

    it('tracks chunks through random churn, resize and clear', () => {
      const p = new FrontierPager(256, CHUNK);
      const slab = new SlabModel(256);
      const random = rng(7);
      for (let round = 0; round < 40; round++) {
        const desired = new Set<number>();
        const size = 1 + Math.floor(random() * 200);
        for (let i = 0; i < size; i++) desired.add(Math.floor(random() * 2000));
        slab.apply(p.update([...desired]));
        expectAgrees(p, slab);
      }
      const evicted = p.resize(64);
      slab.count = Math.min(slab.count, 64);
      for (let slot = evicted.start; slot < evicted.start + evicted.count; slot++) {
        slab.slots[slot] = -1;
      }
      expectAgrees(p, slab);
      p.clear();
      for (let file = 0; file < 40; file++) expect(p.hasResidentIn(file)).toBe(false);
    });
  });

  it('every occupied slot after a churn maps back to a desired global', () => {
    const p = new FrontierPager(64);
    p.update([10, 11, 12, 13, 14, 15]);
    p.update([12, 15, 20, 21]); // heavy churn
    const desired = new Set([12, 15, 20, 21]);
    expect(p.residentCount).toBe(4);
    for (const g of desired) expect(p.has(g)).toBe(true);
    expect(p.has(10)).toBe(false);
  });
});
