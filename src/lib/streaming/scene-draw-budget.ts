/** Shared admission of complete streamed publications; storage is owned by meshes. */
export interface SceneDrawBudgetOptions {
  /** Configured scene ceiling before activity weighting. */
  budget: number;
  /** Device/GPU ceiling, which temporary headroom cannot exceed. */
  hardLimit?: number;
  /** False vetoes scene excess on constrained devices. Defaults to true. */
  allowTemporaryExcess?: boolean;
}

/** A complete lower-cost cut kept in storage until a temporary allowance ends. */
export interface PreparedDrawRelief {
  /** Splats released by restoring this complete cut. */
  reduction: number;
  /** Restores coverage and returns the source's resulting active count. */
  publish: () => number;
  /** Releases the retained hidden data once no longer needed. */
  release: () => void;
}

/** Pending publication ownership. Always cancel on failure or supersession. */
export interface SceneDrawReservation {
  /** Rechecks current ceilings, including changes while a sort worker was busy. */
  valid: () => boolean;
  /** Publishes the reserved count; false means keep the previous complete cut. */
  commit: () => boolean;
  /** Releases admission without changing the displayed count. */
  cancel: () => void;
}

/** Per-source usage; both crossfade participants must be visible concurrently. */
export interface SceneDrawSource {
  /** Actual admitted usage (hidden stored replacements are excluded). */
  readonly count: number;
  /** Admission visibility, independent of hidden pool storage. */
  readonly visible: boolean;
  /** Reserves a complete replacement, never a truncated index list. */
  reserve: (count: number, relief?: PreparedDrawRelief) => SceneDrawReservation | null;
  /** Visibility changes also acquire admission; false leaves the source hidden. */
  setVisible: (visible: boolean) => boolean;
  /** Known minimum complete coverage. Exceptions block refinement, not coverage. */
  setCoverageFloor: (count: number) => void;
  /** Fair cooperative staging, sharing one three-ms allowance each host frame. */
  canStage: () => boolean;
  /** Charge the elapsed cost of one bounded upload batch. */
  chargeStaging: (ms: number) => void;
  /** Releases all pending admission and retained relief data. */
  dispose: () => void;
}

interface SourceState {
  count: number;
  visible: boolean;
  limit: number;
  floor: number;
  pending: { count: number; relief?: PreparedDrawRelief; cancelled: boolean } | null;
  relief: PreparedDrawRelief | null;
  stageMs: number;
  wantsStage: boolean;
}

/** Opt-in scene-wide draw admission, with coverage-preserving temporary relief. */
export class SceneDrawBudget {
  private budget: number;
  private readonly hardLimit: number;
  private targetFactor = 0.85;
  private readonly allowTemporaryExcess: boolean;
  private fixed = 0;
  private readonly sources = new Set<SourceState>();
  private foregroundMs = 0;
  private deadline: number | null = null;
  private belowSince: number | null = 0;
  private stagingMs = 0;
  private stageCursor = 0;
  private stageFirst: SourceState | undefined;

  constructor(options: SceneDrawBudgetOptions) {
    this.budget = positive(options.budget);
    this.allowTemporaryExcess = options.allowTemporaryExcess !== false;
    this.hardLimit = options.hardLimit === undefined ? Infinity : positive(options.hardLimit);
  }

  /** Configured ceiling subject to device limits. */
  get configuredBudget(): number {
    return Math.min(this.budget, this.hardLimit);
  }
  /** Detail target, applied once before the host's weighted distribution. */
  get target(): number {
    return Math.floor(this.configuredBudget * this.targetFactor);
  }
  /** Fixed content is deducted before distributing streamed detail. */
  get availableTarget(): number {
    return Math.max(1, this.target - this.fixed);
  }
  /** Active scene usage, counting every visible source once across split panes. */
  get activeUsage(): number {
    let total = this.fixed;
    for (const source of this.sources) if (source.visible) total += source.count;
    return total;
  }
  /** Usage promised to publications in flight, retaining their previous cuts. */
  get reservedUsage(): number {
    let total = this.fixed;
    for (const source of this.sources) {
      if (source.visible) total += Math.max(source.count, source.pending?.count ?? 0);
    }
    return total;
  }
  /** Updates authored policy without changing storage. */
  setBudget(budget: number): void {
    this.budget = positive(budget);
    this.finishRelief();
  }
  /** Explicit recovery steps are host policy, independent of governor hysteresis. */
  setTargetFactor(factor: number): void {
    if (![0.85, 0.9, 0.95, 1].includes(factor)) throw new RangeError('Invalid draw target factor.');
    this.targetFactor = factor;
  }
  /** Accounts for visible static content in a mixed scene. */
  setFixedUsage(count: number): void {
    this.fixed = nonNegative(count);
    this.finishRelief();
  }

  /** Begins one frame (once for both split panes), using foreground render time only. */
  beginFrame(foregroundDeltaMs = 0): void {
    this.foregroundMs += nonNegative(foregroundDeltaMs);
    this.stagingMs = 0;
    const sources = [...this.sources];
    const waiting = sources.filter((source) => source.wantsStage);
    const eligible = waiting.length ? waiting : sources;
    this.stageFirst = eligible[this.stageCursor++ % Math.max(1, eligible.length)];
    for (const source of sources) {
      source.stageMs = 0;
      source.wantsStage = false;
    }
    if (this.deadline !== null && this.foregroundMs >= this.deadline) this.finishRelief(true);
    this.finishRelief();
  }

  /** Registers one participating mesh, including its environment in its count. */
  register(options: { count?: number; visible?: boolean; limit: number }): SceneDrawSource {
    const source: SourceState = {
      count: nonNegative(options.count ?? 0),
      visible: options.visible ?? true,
      limit: positive(options.limit),
      floor: 0,
      pending: null,
      relief: null,
      stageMs: 0,
      wantsStage: false,
    };
    this.sources.add(source);
    this.finishRelief();
    return {
      get count() {
        return source.count;
      },
      get visible() {
        return source.visible;
      },
      reserve: (count, relief) => this.reserve(source, nonNegative(count), relief),
      setVisible: (visible) => {
        if (visible === source.visible) return true;
        if (
          visible &&
          this.reservedUsage + source.count > this.configuredBudget &&
          source.count > source.floor
        )
          return false;
        source.visible = visible;
        if (!visible && source.pending) {
          source.pending.cancelled = true;
          source.pending.relief?.release();
          source.pending = null;
        }
        this.finishRelief();
        return true;
      },
      setCoverageFloor: (count) => {
        source.floor = nonNegative(count);
      },
      canStage: () => {
        source.wantsStage = true;
        // Give the rotating waiter first opportunity even when host update order
        // is fixed. One expensive indivisible batch cannot starve later meshes.
        if (this.stageFirst && source !== this.stageFirst && this.stageFirst.stageMs === 0)
          return false;
        return (
          this.stagingMs < 3 &&
          (source.stageMs < 3 / Math.max(1, this.sources.size) || source === this.stageFirst)
        );
      },
      chargeStaging: (ms) => {
        const cost = nonNegative(ms);
        source.stageMs += cost;
        this.stagingMs += cost;
      },
      dispose: () => {
        if (source.pending) {
          source.pending.cancelled = true;
          source.pending.relief?.release();
        }
        source.relief?.release();
        source.pending = null;
        source.relief = null;
        this.sources.delete(source);
        this.finishRelief();
      },
    };
  }

  /** Existing debug information can expose policy and exceptional minimum coverage. */
  snapshot() {
    let floor = this.fixed;
    for (const source of this.sources) if (source.visible) floor += source.floor;
    return {
      configuredBudget: this.configuredBudget,
      target: this.target,
      activeUsage: this.activeUsage,
      reservedUsage: this.reservedUsage,
      temporaryAllowance:
        this.deadline === null ? 0 : Math.max(0, this.reservedUsage - this.configuredBudget),
      temporaryRemainingMs:
        this.deadline === null ? 0 : Math.max(0, this.deadline - this.foregroundMs),
      coverageFloorException: floor > this.target,
    };
  }

  private reserve(
    source: SourceState,
    count: number,
    relief?: PreparedDrawRelief,
  ): SceneDrawReservation | null {
    if (!this.sources.has(source) || source.pending || count > source.limit) return null;
    const pending = { count, relief, cancelled: false };
    const admissible = () => {
      if (pending.cancelled || !this.sources.has(source) || count > source.limit) return false;
      // A reduction never removes arbitrary splats: callers prepare the whole cut first.
      if (!source.visible || count <= source.count) return true;
      if (this.snapshot().coverageFloorException) return count <= source.floor;
      const resulting =
        this.reservedUsage - Math.max(source.count, source.pending?.count ?? 0) + count;
      if (resulting <= this.configuredBudget) return true;
      if (count <= source.floor) return true;
      if (!this.allowTemporaryExcess || source.relief || !relief || relief.reduction <= 0)
        return false;
      if (resulting > Math.min(this.hardLimit, Math.floor(this.configuredBudget * 1.05)))
        return false;
      let reduction = relief.reduction;
      for (const entry of this.sources)
        if (entry !== source && entry.visible)
          reduction += entry.relief?.reduction ?? entry.pending?.relief?.reduction ?? 0;
      if (resulting - reduction > this.configuredBudget) return false;
      if (this.deadline !== null) return this.foregroundMs < this.deadline;
      return this.belowSince !== null && this.foregroundMs - this.belowSince >= 500;
    };
    if (!admissible()) return null;
    source.pending = pending;
    // All requests share this deadline; a second source cannot restart the clock.
    if (
      source.visible &&
      this.reservedUsage > this.configuredBudget &&
      count > source.count &&
      count > source.floor &&
      this.deadline === null
    ) {
      this.deadline = this.foregroundMs + 1000;
    }
    return {
      valid: admissible,
      commit: () => {
        if (source.pending !== pending || !admissible()) return false;
        source.count = count;
        source.pending = null;
        pending.cancelled = true;
        if (relief && this.deadline !== null) source.relief = relief;
        else relief?.release();
        this.finishRelief();
        return true;
      },
      cancel: () => {
        if (pending.cancelled) return;
        pending.cancelled = true;
        pending.relief?.release();
        if (source.pending === pending) source.pending = null;
        this.finishRelief();
      },
    };
  }

  private finishRelief(expired = false): void {
    if (expired) {
      for (const source of this.sources) {
        if (source.pending && source.pending.count > source.count) {
          source.pending.cancelled = true;
          source.pending.relief?.release();
          source.pending = null;
        }
      }
      // These callbacks restore prepared complete coverage; expiry never hides a source.
      for (const source of this.sources) {
        if (this.activeUsage <= this.configuredBudget) break;
        if (!source.relief) continue;
        const relief = source.relief;
        source.relief = null;
        source.count = nonNegative(relief.publish());
        relief.release();
      }
    }
    if (this.reservedUsage <= this.configuredBudget) {
      // Cooldown requires headroom strictly below 100%, even after relief ends.
      if (this.reservedUsage < this.configuredBudget) this.belowSince ??= this.foregroundMs;
      else this.belowSince = null;
      this.deadline = null;
      for (const source of this.sources) {
        source.relief?.release();
        source.relief = null;
      }
    } else {
      this.belowSince = null;
    }
  }
}

function positive(value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError('Draw budget must be positive and finite.');
  return Math.floor(value);
}
function nonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError('Draw count/time must be non-negative and finite.');
  return value;
}
