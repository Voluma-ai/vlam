/**
 * Delta page-table bookkeeping for the frontier renderer.
 *
 * Holds the currently-resident frontier splats packed into a fixed slab of pool
 * slots `[0, count)`, keyed by global `.rad` splat index. Each reschedule it
 * diffs a new frontier selection against the resident set and emits a minimal
 * {@link PagerPlan} - swap-remove the leavers (each hole filled by one tail
 * survivor, so moves are proportional to the *delta*, never the whole frontier),
 * append the newcomers contiguously at the tail, and degenerate the vacated tail.
 * The caller executes the plan against the GPU pool (gather + write / degenerate).
 *
 * Pure bookkeeping - no THREE, no pool - so it is fully unit-testable. The slab
 * is fixed-size (= the frontier budget); the frontier selection is budget-capped
 * to fit, so slots never overflow (excess newcomers are dropped and reported).
 */

/** One splat relocated from `fromSlot` to `slot` (its data must be rewritten). */
export interface PagerMove {
  readonly slot: number;
  readonly global: number;
}

/** A minimal set of pool operations to realize one frontier update. */
export interface PagerPlan {
  /** Survivors relocated by swap-remove: rewrite `slot` from source `global`. */
  readonly moves: PagerMove[];
  /** Newcomers appended contiguously at `[appendStart, appendStart + appends.length)`. */
  readonly appendStart: number;
  readonly appends: Uint32Array; // global indices, in slot order
  /** Slots `[degenerateStart, degenerateStart + degenerateCount)` are now free and
   * must be made invisible (they are beyond the new `count` but were occupied). */
  readonly degenerateStart: number;
  readonly degenerateCount: number;
  /** Occupied slot count after the update (`[0, count)` are live). */
  readonly count: number;
  /** Newcomers dropped because the slab was full (selection exceeded capacity). */
  readonly dropped: number;
  /**
   * True when `maxAppends` held this plan short of the requested frontier, so
   * the resident set is an approximation and the caller must reschedule to
   * finish converging. See {@link PagerUpdateOptions.maxAppends}.
   */
  readonly truncated: boolean;
}

export interface PagerUpdateOptions {
  /**
   * Most newcomers this plan may append, bounding what the caller has to write
   * in one tick.
   *
   * A hard camera cut can want hundreds of thousands of new splats at once, and
   * the caller applies a plan whole - a single freeze. Capping the appends alone
   * would not be enough, because reaching the new frontier also *evicts*, and
   * every eviction can relocate a survivor (swap-remove); so the cap doubles as
   * an eviction budget: leavers are evicted only as fast as the appends need
   * room. That bounds `moves + appends.length` at `2 × maxAppends`, and when the
   * slab has headroom nothing is evicted at all and `moves` is empty.
   *
   * Deferred leavers stay resident for another plan or two. They are valid
   * content at a coarser (or finer) cut than the frontier now wants - briefly
   * drawn alongside their replacements - which is a far cheaper artifact than
   * the stall, and is the same trade Spark makes by paging incrementally.
   */
  readonly maxAppends?: number;
}

export class FrontierPager {
  capacity: number;
  /** Occupied slots are `[0, count)`. */
  private count = 0;
  /** global index → slot, for the resident frontier. */
  private readonly slotOf = new Map<number, number>();
  /** slot → global index (valid for `[0, count)`). */
  private slotGlobal: Int32Array;
  /** chunk file → how many of its splats are resident. Never holds a zero. */
  private readonly residentPerFile = new Map<number, number>();
  private readonly chunkSize: number;

  /**
   * Leftover work from a truncated {@link update}, so {@link drain} can finish
   * it without re-diffing.
   *
   * Recomputing the whole desired set to deliver the next `maxAppends` splats is
   * what made a cold 4 M-splat frontier take ~66 full traversals plus ~66 full
   * O(frontier) diffs - quadratic, and minutes of "stuck at 1.3 M" on
   * `cest_ca.rad`. The leftovers are already computed during the truncation, so
   * keeping them turns the ramp into one O(maxAppends) step per frame.
   *
   * Newcomers stay in the order the traversal emitted them (biggest-on-screen
   * first), so the earliest drains deliver the most visible detail.
   */
  private queuedNewcomers: number[] = [];
  private queuedNewcomerIndex = 0;
  /** Stale residents this plan deferred, in the slot order they were found. */
  private queuedStale: number[] = [];
  private queuedStaleIndex = 0;

  constructor(capacity: number, chunkSize = 65536) {
    this.capacity = capacity;
    this.chunkSize = chunkSize;
    this.slotGlobal = new Int32Array(capacity).fill(-1);
  }

  /** Whether a truncated plan left work {@link drain} can still deliver. */
  get hasPendingDrain(): boolean {
    return (
      this.queuedNewcomerIndex < this.queuedNewcomers.length ||
      this.queuedStaleIndex < this.queuedStale.length
    );
  }

  /** Forgets any deferred work, so the next plan re-diffs from scratch. */
  private clearQueue(): void {
    this.queuedNewcomers = [];
    this.queuedNewcomerIndex = 0;
    this.queuedStale = [];
    this.queuedStaleIndex = 0;
  }

  /**
   * Swap-removes `global` if resident, appending the resulting relocation to
   * `moves`. Shared by {@link update}'s leaver pass and {@link drain}.
   */
  private evictGlobal(global: number, moves: PagerMove[]): void {
    const slot = this.slotOf.get(global);
    if (slot === undefined) return;
    this.slotOf.delete(global);
    this.release(global);
    const last = this.count - 1;
    if (slot !== last) {
      const tailGlobal = this.slotGlobal[last] as number;
      this.slotGlobal[slot] = tailGlobal;
      this.slotOf.set(tailGlobal, slot);
      // Emitted even when the tail is itself queued for eviction: the slot stays
      // inside the drawn prefix until that eviction lands, so it must describe
      // real content in the meantime.
      moves.push({ slot, global: tailGlobal });
    }
    this.slotGlobal[last] = -1;
    this.count = last;
  }

  /**
   * Continues a truncated {@link update} - evicts the next deferred leavers and
   * appends the next `maxAppends` deferred newcomers - with no diff against the
   * resident set. Only valid while the frontier that produced the queue is still
   * the one being asked for; any new {@link update}, {@link resize} or
   * {@link clear} discards it.
   */
  drain(maxAppends: number): PagerPlan {
    const prevCount = this.count;
    const moves: PagerMove[] = [];
    const remainingNew = this.queuedNewcomers.length - this.queuedNewcomerIndex;
    const remainingStale = this.queuedStale.length - this.queuedStaleIndex;
    const headroom = this.capacity - this.count;

    // Newcomers past the slab's total future capacity can never be seated, so
    // report them now rather than leaving the queue permanently unfinishable.
    const seatable = headroom + remainingStale;
    const dropped = Math.max(0, remainingNew - seatable);
    if (dropped > 0) this.queuedNewcomers.length -= dropped;

    const admitted = Math.min(remainingNew - dropped, maxAppends, seatable);
    // Same coupling as `update`: evict only what the appends need, then spend
    // whatever is left of the cap retiring the rest, so a queue with no
    // newcomers left still drains its deferred leavers.
    const evictCount = Math.min(
      remainingStale,
      Math.max(admitted - headroom, maxAppends - admitted),
    );

    for (let k = 0; k < evictCount; k++) {
      this.evictGlobal(this.queuedStale[this.queuedStaleIndex + k] as number, moves);
    }
    this.queuedStaleIndex += evictCount;

    const survivors = this.count;
    const appends = new Uint32Array(admitted);
    for (let j = 0; j < admitted; j++) {
      const g = this.queuedNewcomers[this.queuedNewcomerIndex + j] as number;
      const slot = survivors + j;
      this.slotGlobal[slot] = g;
      this.slotOf.set(g, slot);
      this.retain(g);
      appends[j] = g;
    }
    this.queuedNewcomerIndex += admitted;
    this.count = survivors + admitted;

    for (let s = this.count; s < prevCount; s++) this.slotGlobal[s] = -1;

    const truncated = this.hasPendingDrain;
    if (!truncated) this.clearQueue();
    return {
      moves,
      appendStart: survivors,
      appends,
      degenerateStart: this.count,
      degenerateCount: Math.max(0, prevCount - this.count),
      count: this.count,
      dropped,
      truncated,
    };
  }

  /** Globals a truncated plan still intends to append, so the caller can keep
   * their chunks cached - gathering an evicted one would write zeros into a slot
   * inside the drawn prefix. */
  pendingAppendGlobals(): readonly number[] {
    return this.queuedNewcomerIndex === 0
      ? this.queuedNewcomers
      : this.queuedNewcomers.slice(this.queuedNewcomerIndex);
  }

  /** Records `global` as resident (its chunk gains a reference). */
  private retain(global: number): void {
    const file = Math.floor(global / this.chunkSize);
    this.residentPerFile.set(file, (this.residentPerFile.get(file) ?? 0) + 1);
  }

  /** Drops `global` from the resident set (its chunk loses a reference). */
  private release(global: number): void {
    const file = Math.floor(global / this.chunkSize);
    const next = (this.residentPerFile.get(file) ?? 0) - 1;
    if (next > 0) this.residentPerFile.set(file, next);
    else this.residentPerFile.delete(file);
  }

  /**
   * True while any splat from chunk `file` is still resident in the slab.
   *
   * The worker's cache eviction must consult this: protecting only the chunks
   * the *current* frontier selects is not enough, because `maxAppends` leaves
   * deferred leavers resident and drawn for another plan or two. Evicting one of
   * their chunks makes the next {@link gatherGlobals} of that splat - a
   * swap-remove relocation - write zeros into a slot inside the drawn prefix,
   * which shows as dark speckle in the region being refined.
   */
  hasResidentIn(file: number): boolean {
    return this.residentPerFile.has(file);
  }

  /**
   * Changes how many slots this pager may fill.
   *
   * The host grows and shrinks the storage behind these slots with the mesh's
   * budget - a near mesh climbs, a distant one gives its pages back - so the
   * pager has to follow. Growing keeps the resident frontier untouched;
   * shrinking evicts the slots past the new capacity and reports them so the
   * host can stop drawing them.
   *
   * @returns the slot range that was evicted, empty when growing.
   */
  resize(capacity: number): { start: number; count: number } {
    if (capacity === this.capacity) return { start: 0, count: 0 };
    // The slab moved under the deferred work; re-diff rather than drain against
    // a layout the queue was not built for.
    this.clearQueue();
    const next = new Int32Array(capacity).fill(-1);
    const keep = Math.min(this.count, capacity);
    next.set(this.slotGlobal.subarray(0, keep));
    // Forget everything beyond the new capacity: those globals are no longer
    // resident, so a later frontier asking for them must re-append rather than
    // find a stale slot.
    for (let slot = keep; slot < this.count; slot++) {
      const global = this.slotGlobal[slot] as number;
      if (global >= 0 && this.slotOf.delete(global)) this.release(global);
    }
    const evicted = { start: keep, count: Math.max(0, this.count - keep) };
    this.slotGlobal = next;
    this.capacity = capacity;
    this.count = keep;
    return evicted;
  }

  /** Current resident frontier size. */
  get residentCount(): number {
    return this.count;
  }

  /** True iff `global` is currently resident. */
  has(global: number): boolean {
    return this.slotOf.has(global);
  }

  /**
   * Diffs `desired` (the new frontier, as global indices) against the resident
   * set and returns the plan to realize it. Mutates internal state to the new
   * frontier as if the plan were applied, so the caller must execute every
   * returned op. `desired` may be any iterable; duplicates are ignored.
   */
  update(desired: Iterable<number>, options?: PagerUpdateOptions): PagerPlan {
    let desiredSet = new Set<number>(desired);
    const prevCount = this.count;
    const moves: PagerMove[] = [];
    // A fresh desired set supersedes whatever the last plan deferred.
    this.clearQueue();

    // 0. Optionally hold the plan to `maxAppends` newcomers by rewriting the
    //    desired set into an intermediate one: every resident is kept except the
    //    few that must go to make room, plus the first `maxAppends` newcomers.
    //    The result is still a valid frontier - a superset of the previous one
    //    plus part of the next - so no slot is ever left describing content the
    //    caller did not write.
    let truncated = false;
    const maxAppends = options?.maxAppends ?? Infinity;
    if (Number.isFinite(maxAppends)) {
      const newcomers: number[] = [];
      for (const g of desiredSet) if (!this.slotOf.has(g)) newcomers.push(g);
      // Stale residents, in slot order - the eviction candidates.
      const stale: number[] = [];
      for (let slot = 0; slot < this.count; slot++) {
        const g = this.slotGlobal[slot] as number;
        if (!desiredSet.has(g)) stale.push(g);
      }
      // Room for newcomers comes from free slots first, evictions second. Never
      // evict more than the appends actually need.
      const headroom = this.capacity - this.count;
      const admitted = Math.min(newcomers.length, maxAppends, headroom + stale.length);
      // Evict enough to seat the admitted newcomers, and spend whatever is left
      // of the cap draining the rest. Without that second term a plan with no
      // newcomers left to add would never retire the deferred leavers, and the
      // frontier would sit permanently truncated.
      const evictCount = Math.min(
        stale.length,
        Math.max(admitted - headroom, maxAppends - admitted),
      );
      truncated = admitted < newcomers.length || evictCount < stale.length;
      if (truncated) {
        const keep = new Set<number>();
        for (let i = evictCount; i < stale.length; i++) keep.add(stale[i] as number);
        for (const g of desiredSet) if (this.slotOf.has(g)) keep.add(g);
        for (let i = 0; i < admitted; i++) keep.add(newcomers[i] as number);
        desiredSet = keep;
        // Hand the remainder to `drain`, which finishes it without ever
        // rebuilding this set. Both keep their original order: newcomers as the
        // traversal emitted them (biggest-on-screen first), leavers by slot.
        this.queuedNewcomers = newcomers.slice(admitted);
        this.queuedStale = stale.slice(evictCount);
      }
    }

    // 1. Swap-remove leavers, compacting survivors into `[0, survivors)`. Each
    //    leaver slot is filled by pulling the live tail in - so at most one move
    //    per leaver (delta), never a survivor-shift over the whole frontier.
    let n = this.count; // exclusive live boundary; shrinks as the tail is consumed
    let i = 0;
    while (i < n) {
      const g = this.slotGlobal[i] as number;
      if (desiredSet.has(g)) {
        i++; // survivor already in place
        continue;
      }
      this.slotOf.delete(g); // leaver at slot i
      this.release(g);
      n--;
      if (i < n) {
        const tailGlobal = this.slotGlobal[n] as number;
        this.slotGlobal[i] = tailGlobal;
        if (desiredSet.has(tailGlobal)) {
          this.slotOf.set(tailGlobal, i); // survivor relocated from the tail
          moves.push({ slot: i, global: tailGlobal });
          i++;
        }
        // else the pulled-in tail is itself a leaver - re-check slot i next loop.
      }
    }
    const survivors = n;

    // 2. Append newcomers (desired but not resident) contiguously at the tail.
    const newcomers: number[] = [];
    for (const g of desiredSet) if (!this.slotOf.has(g)) newcomers.push(g);
    const appendCount = Math.min(newcomers.length, this.capacity - survivors);
    const appends = new Uint32Array(appendCount);
    for (let j = 0; j < appendCount; j++) {
      const g = newcomers[j] as number;
      const slot = survivors + j;
      this.slotGlobal[slot] = g;
      this.slotOf.set(g, slot);
      this.retain(g); // a genuine newcomer; relocations above keep their count
      appends[j] = g;
    }
    this.count = survivors + appendCount;

    // 3. Degenerate the vacated tail `[count, prevCount)`.
    for (let s = this.count; s < prevCount; s++) this.slotGlobal[s] = -1;

    return {
      moves,
      appendStart: survivors,
      appends,
      degenerateStart: this.count,
      degenerateCount: Math.max(0, prevCount - this.count),
      count: this.count,
      dropped: newcomers.length - appendCount,
      truncated,
    };
  }

  /** Resets to empty (e.g. on scene reload). */
  clear(): void {
    this.clearQueue();
    this.slotOf.clear();
    this.residentPerFile.clear();
    this.slotGlobal.fill(-1);
    this.count = 0;
  }
}
