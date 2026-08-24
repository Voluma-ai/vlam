/**
 * Shared splat-budget governance across multiple streamed meshes.
 *
 * A single `StreamedSplatMesh` keeps itself within a per-device budget, but a
 * host that shows several streamed scenes at once (a main capture plus marker
 * or inset meshes) must not let each mesh claim the whole device budget -
 * their pools are separate, so the costs add. Historically hosts hand-tuned
 * this ("shrink the main mesh to 0.7 when markers exist"); the
 * {@link BudgetGovernor} makes it a first-class policy: register each mesh
 * with a priority weight and the governor splits one total budget across the
 * members, reallocating when membership, weights, or the total change.
 *
 * The governor steers members exclusively through their public
 * `setBudget`, so every downstream consumer of a member's budget - the
 * flat-leaf `LodScheduler`, the LCC2 octree cut, and the RAD page-table draw
 * target - sees the governed value through the exact path an explicit host
 * `setBudget` call would take. Meshes never registered with a governor are
 * completely unaffected.
 */

import { resolveSplatBudget } from './splat-budget';

/**
 * Anything the governor can steer. `StreamedSplatMesh` satisfies this
 * structurally; a custom member only needs the same clamp-and-report
 * `setBudget` contract.
 */
export interface BudgetGovernedMember {
  /** The member's current effective active-splat budget. */
  readonly budget: number;
  /**
   * Applies a budget and returns the value actually in effect - which may be
   * lower than asked when the member clamps to a fixed ceiling (for
   * `StreamedSplatMesh`, its `maxBudget`).
   */
  setBudget(budget: number): number;
  /**
   * The ceiling `setBudget` clamps to, when the member knows one
   * (`StreamedSplatMesh.maxBudget`). **Advisory only** - allocation still
   * discovers real caps from `setBudget`'s return value, so a member that
   * omits this is governed exactly as well.
   */
  readonly maxBudget?: number;
}

/** Options for {@link BudgetGovernor}. */
export interface BudgetGovernorOptions {
  /**
   * Total active-splat budget shared by all members. Defaults to the
   * per-device {@link resolveSplatBudget} - i.e. the group as a whole gets
   * what one mesh alone would get today.
   */
  totalBudget?: number;
  /**
   * Grow dead-band as a fraction of a member's current budget (default
   * `0.1`). A reallocation that would *raise* a member's budget by no more
   * than this fraction is skipped, so brief membership churn (a marker mesh
   * appearing for a moment) does not thrash LOD schedules. Shrinks always
   * apply immediately - that is what keeps `sum(member budgets) ≤ total` an
   * invariant rather than a goal.
   */
  hysteresis?: number;
}

/**
 * The budget a suspended (`weight: 0`) member is held at.
 *
 * Not 0: a member's `setBudget` may reject a non-positive budget outright
 * (`StreamedSplatMesh` routes through `resolveSplatBudget`, which throws
 * `RangeError` on `<= 0`). 1 splat is the smallest legal value and matches the
 * floor the weighted split already uses.
 */
const SUSPENDED_BUDGET = 1;

interface MemberEntry {
  member: BudgetGovernedMember;
  weight: number;
  /** Budget the member reported after the governor's last applied call. */
  applied: number;
  /** The member's budget at registration, restored on unregister/dispose. */
  restoreBudget: number;
}

/**
 * Splits one total splat budget across registered members by priority weight.
 *
 * Allocation is weighted and cap-aware: a member whose `setBudget` clamps
 * below its weighted share (a small scene, or a mesh with a small pool)
 * releases the difference to the remaining members, so the total is spent
 * where it can buy detail. Reallocation runs automatically on
 * register/unregister and on weight or total changes.
 *
 * A member at `weight: 0` is **suspended**: held at
 * {@link SUSPENDED_BUDGET}, excluded from the weighted split, and its whole
 * share released to the others - Spark's `lodScale: 0` hidden tier, without
 * unregistering (so the mesh stays warm and re-weighting it costs nothing).
 * Note that a suspended member is not *free*: its pool was allocated at
 * construction and is never released, and a streamed mesh keeps its pinned
 * coarse shell resident, so it consumes ≈0 of the budget rather than exactly 0.
 * To give the memory back, dispose the mesh.
 *
 * For camera-driven weights - nearby meshes automatically taking a larger
 * share - see `CameraBudgetGovernor`, which drives this class.
 *
 * Invariant: the sum of budgets the governor has applied to active members
 * never exceeds {@link totalBudget}.
 */
export class BudgetGovernor {
  private readonly entries = new Map<BudgetGovernedMember, MemberEntry>();
  private total: number;
  private readonly hysteresis: number;

  constructor(options: BudgetGovernorOptions = {}) {
    this.total = resolveSplatBudget(options.totalBudget);
    const hysteresis = options.hysteresis ?? 0.1;
    if (!Number.isFinite(hysteresis) || hysteresis < 0) {
      throw new RangeError('BudgetGovernor hysteresis must be a non-negative finite number.');
    }
    this.hysteresis = hysteresis;
  }

  /** The shared budget currently being split across members. */
  get totalBudget(): number {
    return this.total;
  }

  /** Replaces the shared total and reallocates. */
  setTotalBudget(totalBudget: number): void {
    const next = resolveSplatBudget(totalBudget);
    if (next === this.total) return;
    this.total = next;
    this.reallocate();
  }

  /** Number of registered members. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Adds a member and reallocates the shared budget. The member's current
   * budget is remembered and restored when it leaves the governor.
   *
   * @param member - The mesh (or compatible object) to govern.
   * @param options - `weight` (default `1`): the member's share is
   * proportional to its weight - e.g. main mesh `7`, marker `3` reproduces
   * the old 0.7 host split. `0` registers the member suspended.
   */
  register(member: BudgetGovernedMember, options: { weight?: number } = {}): void {
    if (this.entries.has(member)) {
      throw new Error('BudgetGovernor: member is already registered.');
    }
    const weight = validateWeight(options.weight ?? 1);
    this.entries.set(member, {
      member,
      weight,
      applied: member.budget,
      restoreBudget: member.budget,
    });
    this.reallocate();
  }

  /**
   * Removes a member, restores the budget it had when it registered, and
   * reallocates the total across the remaining members. No-op for a member
   * that is not registered (so disposing hosts need not track membership).
   */
  unregister(member: BudgetGovernedMember): void {
    const entry = this.entries.get(member);
    if (entry === undefined) return;
    this.entries.delete(member);
    entry.member.setBudget(entry.restoreBudget);
    this.reallocate();
  }

  /**
   * Changes a member's priority weight and reallocates. `0` suspends the
   * member (see the class doc); any positive weight resumes it.
   */
  setWeight(member: BudgetGovernedMember, weight: number): void {
    const entry = this.entryOf(member);
    const next = validateWeight(weight);
    if (next === entry.weight) return;
    entry.weight = next;
    this.reallocate();
  }

  /**
   * Writes several weights, then reallocates **once**.
   *
   * Prefer this to a loop of {@link setWeight} whenever more than one weight
   * changes together - as a camera-driven reweight does. Each reallocation
   * pushes `setBudget` to every member, and for a streamed mesh that forces an
   * LOD reschedule, so N separate calls cost N passes over the whole group to
   * reach a state one pass would have produced.
   *
   * @param weights - `[member, weight]` pairs. Every member must be registered;
   * unlisted members keep their current weight.
   * @throws {Error} if any member is not registered - checked before anything
   * is written, so a bad pair leaves every weight untouched.
   * @throws {RangeError} if any weight is not a non-negative finite number.
   */
  setWeights(weights: Iterable<readonly [BudgetGovernedMember, number]>): void {
    // Validate the whole batch first: a partially applied reweight would leave
    // the group in a state no caller asked for.
    const pending = [...weights].map(
      ([member, weight]) => [this.entryOf(member), validateWeight(weight)] as const,
    );
    let changed = false;
    for (const [entry, weight] of pending) {
      if (entry.weight === weight) continue;
      entry.weight = weight;
      changed = true;
    }
    if (changed) this.reallocate();
  }

  /** The budget the governor last applied to a member, if registered. */
  budgetOf(member: BudgetGovernedMember): number | undefined {
    return this.entries.get(member)?.applied;
  }

  /**
   * Recomputes and applies every member's share. Called automatically by all
   * mutators; call it manually only if a member's internal ceiling changed
   * outside the governor's view.
   */
  reallocate(): void {
    // Suspended members first, so the share they release is available to the
    // waterfill below in the same pass. Held at the floor rather than skipped:
    // a member that was carrying a large budget when it was suspended must
    // actually give it up, or the sum invariant breaks.
    let pool: MemberEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.weight === 0) this.applyTarget(entry, SUSPENDED_BUDGET);
      else pool.push(entry);
    }
    let budget = this.total;
    // Cap-aware waterfill: give each member its weighted share of what is
    // left; a member that clamps below its share is finalized at its cap and
    // releases the difference to the others on the next pass. Terminates in at
    // most `size` passes (each non-final pass finalizes at least one member).
    // An all-suspended group leaves `pool` empty and skips the loop, so the
    // weight sum is never 0 here.
    while (pool.length > 0) {
      const weightSum = pool.reduce((sum, entry) => sum + entry.weight, 0);
      const capped: MemberEntry[] = [];
      let cappedSpend = 0;
      for (const entry of pool) {
        const target = Math.max(1, Math.floor((budget * entry.weight) / weightSum));
        if (this.applyTarget(entry, target)) {
          capped.push(entry);
          cappedSpend += entry.applied;
        }
      }
      if (capped.length === 0) break;
      budget = Math.max(0, budget - cappedSpend);
      pool = pool.filter((entry) => !capped.includes(entry));
    }
  }

  /**
   * Restores every member's pre-registration budget and empties the governor.
   * The governor itself stays usable (dispose is just "unregister everyone").
   */
  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.member.setBudget(entry.restoreBudget);
    }
    this.entries.clear();
  }

  /** The entry for a registered member, or a thrown error naming the problem. */
  private entryOf(member: BudgetGovernedMember): MemberEntry {
    const entry = this.entries.get(member);
    if (entry === undefined) {
      throw new Error('BudgetGovernor: member is not registered.');
    }
    return entry;
  }

  /**
   * Pushes `target` to a member, with the grow dead-band. Returns true when
   * the member clamped below its target (it is capped and cannot absorb more).
   */
  private applyTarget(entry: MemberEntry, target: number): boolean {
    if (target > entry.applied) {
      // Grows within the dead-band are skipped: staying low never violates
      // the sum invariant, and the skipped headroom is reclaimed by the next
      // meaningful reallocation.
      if (target - entry.applied <= this.hysteresis * entry.applied) return false;
    } else if (target === entry.applied) {
      return false;
    }
    entry.applied = entry.member.setBudget(target);
    return entry.applied < target;
  }
}

/** Validates a member weight: any non-negative finite number, `0` = suspended. */
function validateWeight(weight: number): number {
  if (!Number.isFinite(weight) || weight < 0) {
    throw new RangeError(
      'BudgetGovernor member weight must be a non-negative finite number (0 suspends the member).',
    );
  }
  return weight;
}
