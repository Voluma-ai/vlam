import * as THREE from 'three/webgpu';
import type { LodLeaf, LodManifest } from './lod-manifest';
import type { LodSource } from './lod-source';

/**
 * A contiguous splat range within one chunk file, at one LOD level - the
 * unit the pool activates. Adjacent manifest leaves that resolve to the same
 * `(file, level)` and whose ranges abut are coalesced into one run, so the
 * pool sees a handful of large ranges instead of thousands of tiny leaves.
 */
export interface LodRun {
  readonly file: number;
  readonly level: number;
  readonly offset: number;
  readonly count: number;
  /** First manifest-leaf index this run covers. */
  readonly leafStart: number;
  /** One past the last covered leaf index. */
  readonly leafEnd: number;
  /**
   * Physical-coverage identity when several manifest leaves form one region.
   * A classic LCC cell may be split into fetch-sized leaves, but its slices
   * must still swap as one visible unit. Undefined retains interval-based
   * grouping for hierarchical sources.
   */
  readonly coverageGroup?: number;
  /**
   * Camera distance (mesh-local) of the nearest leaf in this run, from the
   * last {@link LodScheduler.computeDesiredRuns} pass. Streamed meshes use it
   * to fetch near detail before far coarse coverage. Absent on sources that
   * do not track per-leaf distance.
   */
  readonly distance?: number;
  /**
   * True when any leaf in this run intersects the view frustum (with the
   * scheduler's edge margin). Used to rank classic-path fetches so in-view
   * detail beats behind-camera work; absent when the source does not track it.
   */
  readonly inView?: boolean;
  /**
   * Fetch-only angular distance from the camera's forward axis. Smaller values
   * are nearer the screen centre. It never affects LOD selection or budget.
   */
  readonly screenImportance?: number;
  /**
   * True when this run only exists to keep a not-yet-decoded chunk in the
   * fetch pipe. Prefix-reader `.rad` appends these ahead of the resident
   * frontier; they are not part of the drawable cut and never block publishing
   * that cut when their speculative fetch does not land.
   */
  readonly fetchIntent?: boolean;
}

/** Stable identity of a run, for diffing desired vs. resident sets. */
export function runKey(run: LodRun): string {
  return `${run.file}:${run.level}:${run.offset}:${run.count}`;
}

/** Sentinel level meaning "this leaf is currently dropped (renders nothing)". */
const DROPPED = -1;

/**
 * Maximum splats in one run. Large contiguous regions are split into several
 * runs so no single pool append (and thus no single frame) does an unbounded
 * amount of copy + upload work. Split runs stay contiguous, so they still
 * upload as one coalesced rectangle.
 */
const MAX_RUN_SPLATS = 128_000;

/** Hysteresis dead-band around each LOD distance threshold. */
const THRESHOLD_MARGIN = 0.1;
/** Minimum time a leaf must hold a level before changing again, ms. */
const DWELL_MS = 500;
/** Frustum test margin, as a fraction of each leaf's own size. */
const FRUSTUM_MARGIN = 0.1;
/**
 * Out-of-frustum leaves act this many times farther away instead of being
 * hard-coarsened. Rotating the camera then re-ranks leaves smoothly (and
 * dwell applies), rather than mass-flipping edge leaves every frame -
 * PlayCanvas uses the same behind-camera-penalty idea.
 */
const FRUSTUM_PENALTY = 3;

/**
 * Chooses a level of detail per spatial leaf from the camera, keeps the
 * total within a splat budget, and coalesces the result into runs.
 *
 * The scheduler is pure with respect to rendering: it takes a camera
 * position and frustum (both in the mesh's local space) and returns the set
 * of runs that should be resident. It owns only the small amount of state
 * needed for temporal stability (each leaf's current level and when it last
 * changed), so it is straightforward to drive from a test harness.
 *
 * LOD distance model (PlayCanvas-compatible): level 0 is used within
 * `lodBaseDistance`; each successive level covers a band `lodMultiplier`×
 * farther out. By default out-of-frustum leaves act {@link FRUSTUM_PENALTY}×
 * farther away. Formats with broad spatial cells can disable that bias so an
 * orbit does not churn already-refined cells at the frustum edges.
 *
 * The distance model only sets the *floor* and the *priority*: when the
 * distance-chosen set leaves budget unused, {@link fillBudget} promotes
 * in-frustum leaves nearest-first until its configured headroom target is
 * spent (90% by default). Formats can cap that optional refinement and avoid
 * a full-finest cut even when an explicitly large budget could hold it. The
 * budget
 * therefore decides how far refinement reaches - a desktop budget yields
 * full detail even with the whole scene in view, a mobile budget refines
 * only near the camera.
 */
export class LodScheduler implements LodSource {
  /** World-unit distance inside which the finest level (0) is used. */
  lodBaseDistance: number;
  /** Distance ratio between successive LOD levels. */
  lodMultiplier: number;
  /** Maximum active splats; the desired set is demoted to fit. */
  budget: number;

  private readonly leaves: readonly LodLeaf[];
  private readonly coarsest: number;
  /** Per leaf: lowest/highest LOD level that has data. */
  private readonly minLevel: Int32Array;
  private readonly maxLevel: Int32Array;
  /**
   * Per leaf: the distance *ambition* - the finest level the camera distance
   * asks for, with hysteresis/dwell applied. This is the hysteresis *state*:
   * only {@link selectLevels} writes it, so budget demotion can never feed
   * back into the dead-band/dwell logic and oscillate. With `fillPastDistance`
   * false, {@link fillBudget} restores {@link resolved} only up to here.
   */
  private readonly level: Int32Array;
  /**
   * Per leaf: the resolved target - the ambition capped to fit the budget by
   * {@link enforceBudget}, then refilled from leftover headroom by
   * {@link fillBudget} (or DROPPED). This is what {@link coalesceRuns} emits.
   */
  private readonly resolved: Int32Array;
  /** Per leaf: timestamp of the last distance-level change, for dwell. */
  private readonly changedAt: Float64Array;

  private readonly distance: Float64Array;
  private readonly inFrustum: Uint8Array;
  /** Leaves that must move through the budget cut together. */
  private readonly budgetGroups: readonly Uint32Array[];
  /** Per-leaf physical coverage group, when the manifest defines one. */
  private readonly coverageGroups: Int32Array;
  /** Whether view-frustum membership affects distance and fill priority. */
  private readonly frustumAware: boolean;
  /** Fraction of the usable budget that optional refinement may consume. */
  private readonly budgetFillFraction: number;
  /** Absolute cap on optional refinement; distance-selected detail may exceed it. */
  private readonly budgetFillCap: number;
  /** Whether a budget that holds every finest leaf forces a full-finest cut. */
  private readonly forceFinestWhenFits: boolean;
  /**
   * Leaves at or inside this camera distance always resolve to their finest
   * available level (no hysteresis climb). Classic LCC uses a multi-band
   * radius so adjacent broad cells do not paint coarse discs at startup.
   */
  private readonly forceFinestWithin: number | undefined;
  /**
   * When false, {@link fillBudget} only restores toward each leaf's
   * distance-selected {@link level} - never finer. Classic LCC sets this so
   * a mid-range cell does not fetch L0 only to demote to L1 once the cut
   * settles.
   */
  private readonly fillPastDistance: boolean;

  /**
   * What the last cut actually decided, for the HUD.
   *
   * The resident splat count alone cannot distinguish "the scheduler asked for
   * this" from "the scheduler asked for more and the mesh could not apply it",
   * and those have opposite fixes. Measured rather than inferred after a
   * zoomed-out `sandwijck` sat at exactly its coarsest total (190,730) with a
   * 600k budget - 68% of the budget unspent, with no way to see which stage
   * declined to spend it.
   */
  readonly stats = {
    /** Leaves the frustum test accepted - `fillBudget`'s candidate set. */
    inFrustum: 0,
    /** Total leaves in the tree. */
    leaves: 0,
    /** Splats implied by the resolved cut, before the mesh applies anything. */
    desired: 0,
    /** Splats `fillBudget` added on top of the distance-chosen levels. */
    filled: 0,
  };

  private readonly scratchBox = new THREE.Box3();
  private readonly scratchSize = new THREE.Vector3();
  private readonly scratchCenter = new THREE.Vector3();
  private readonly screenImportance: Float32Array;
  /** Whether the last selection pass received a camera-forward vector. */
  private hasScreenImportance = false;
  /**
   * Persistent leaf-index ordering scratch for {@link enforceBudget} and
   * {@link fillBudget}, sorted in place per call instead of allocating a
   * fresh `[...keys]` array. Comparators break ties on the index itself so
   * the order is identical to the stable `Array#sort` this replaces
   * (`TypedArray#sort` stability is not guaranteed).
   */
  private readonly orderScratch: Uint32Array;

  constructor(
    manifest: LodManifest,
    options: {
      budget: number;
      lodBaseDistance: number;
      lodMultiplier: number;
      frustumAware?: boolean;
      budgetFillFraction?: number;
      budgetFillCap?: number;
      forceFinestWhenFits?: boolean;
      forceFinestWithin?: number;
      /**
       * When false, leftover-budget fill never refines past the distance-
       * selected level (see {@link fillPastDistance}). Default true.
       */
      fillPastDistance?: boolean;
    },
  ) {
    this.leaves = manifest.leaves;
    this.coarsest = manifest.lodLevels - 1;
    this.budget = options.budget;
    this.lodBaseDistance = options.lodBaseDistance;
    this.lodMultiplier = options.lodMultiplier;
    this.frustumAware = options.frustumAware !== false;
    this.budgetFillFraction = options.budgetFillFraction ?? 0.9;
    this.budgetFillCap = options.budgetFillCap ?? Number.POSITIVE_INFINITY;
    this.forceFinestWhenFits = options.forceFinestWhenFits !== false;
    this.forceFinestWithin = options.forceFinestWithin;
    this.fillPastDistance = options.fillPastDistance !== false;
    if (this.budgetFillFraction <= 0 || this.budgetFillFraction > 1) {
      throw new RangeError('LodScheduler budgetFillFraction must be in (0, 1].');
    }
    if (!(this.budgetFillCap > 0)) {
      throw new RangeError('LodScheduler budgetFillCap must be positive.');
    }
    if (this.forceFinestWithin !== undefined && !(this.forceFinestWithin >= 0)) {
      throw new RangeError('LodScheduler forceFinestWithin must be >= 0.');
    }

    const n = this.leaves.length;
    this.minLevel = new Int32Array(n);
    this.maxLevel = new Int32Array(n);
    this.level = new Int32Array(n).fill(this.coarsest);
    this.resolved = new Int32Array(n).fill(this.coarsest);
    this.changedAt = new Float64Array(n);
    this.distance = new Float64Array(n);
    this.inFrustum = new Uint8Array(n);
    this.screenImportance = new Float32Array(n);
    this.orderScratch = new Uint32Array(n);
    this.coverageGroups = new Int32Array(n).fill(-1);

    const groups: number[][] = [];
    const explicitGroups = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const key = (this.leaves[i] as LodLeaf).budgetGroup;
      if (key === undefined) {
        groups.push([i]);
        continue;
      }
      let groupIndex = explicitGroups.get(key);
      if (groupIndex === undefined) {
        groupIndex = groups.length;
        explicitGroups.set(key, groupIndex);
        groups.push([]);
      }
      (groups[groupIndex] as number[]).push(i);
      this.coverageGroups[i] = key;
    }
    this.budgetGroups = groups.map((members) => Uint32Array.from(members));

    for (let i = 0; i < n; i++) {
      const lods = (this.leaves[i] as LodLeaf).lods;
      let min = this.coarsest;
      let max = 0;
      for (let l = 0; l < lods.length; l++) {
        if (lods[l] === undefined) continue;
        min = Math.min(min, l);
        max = Math.max(max, l);
      }
      this.minLevel[i] = min;
      this.maxLevel[i] = max;
      this.level[i] = max; // start coarse
    }
  }

  /**
   * Recomputes the desired resident run set for the current camera.
   *
   * @param cameraLocal - Camera position in the mesh's local space.
   * @param frustum - View frustum in the mesh's local space.
   * @param now - Monotonic timestamp (ms) for dwell hysteresis.
   */
  computeDesiredRuns(
    cameraLocal: THREE.Vector3,
    frustum: THREE.Frustum,
    now: number,
    cameraForward?: THREE.Vector3,
  ): LodRun[] {
    this.selectLevels(cameraLocal, frustum, now, cameraForward);
    // When the budget already holds every leaf's finest level, skip distance /
    // frustum demotion entirely. Otherwise a small rotate marks leaves
    // out-of-frustum (×{@link FRUSTUM_PENALTY}), coarsens them, and the mesh
    // aborts fine fetches / swaps to coarse LCC discs - then has to climb
    // back when they re-enter the view.
    if (this.forceFinestWhenFits && this.budget >= this.finestTotal()) {
      for (let i = 0; i < this.leaves.length; i++) {
        this.resolved[i] = this.minLevel[i] as number;
      }
      this.stats.desired = this.activeTotal();
      this.stats.filled = 0;
      return this.coalesceRuns();
    }
    // Copy the ambition into the resolved target, cap it to the budget, then
    // refill leftover headroom. Budget stages touch only `resolved`, never the
    // ambition/hysteresis state - a stationary camera therefore resolves the
    // same cut every pass instead of oscillating red↔orange.
    this.resolved.set(this.level);
    this.enforceBudget();
    const beforeFill = this.activeTotal();
    this.fillBudget();
    this.stats.desired = this.activeTotal();
    this.stats.filled = this.stats.desired - beforeFill;
    return this.coalesceRuns();
  }

  /** Total active splats implied by the current resolved levels. */
  private activeTotal(): number {
    let total = 0;
    for (let i = 0; i < this.leaves.length; i++) {
      const level = this.resolved[i] as number;
      if (level === DROPPED) continue;
      total += (this.leaves[i] as LodLeaf).lods[level]?.count ?? 0;
    }
    return total;
  }

  /** Splats if every leaf sat at its finest available level (none dropped). */
  private finestTotal(): number {
    let total = 0;
    for (let i = 0; i < this.leaves.length; i++) {
      const level = this.minLevel[i] as number;
      total += (this.leaves[i] as LodLeaf).lods[level]?.count ?? 0;
    }
    return total;
  }

  private selectLevels(
    cameraLocal: THREE.Vector3,
    frustum: THREE.Frustum,
    now: number,
    cameraForward?: THREE.Vector3,
  ): void {
    const { lodBaseDistance: base, lodMultiplier: m } = this;
    this.hasScreenImportance = cameraForward !== undefined;
    let visibleCount = 0;
    this.stats.leaves = this.leaves.length;
    for (let i = 0; i < this.leaves.length; i++) {
      const leaf = this.leaves[i] as LodLeaf;
      const d = leaf.bounds.distanceToPoint(cameraLocal);
      this.distance[i] = d;

      const visible = this.leafIntersectsFrustum(frustum, i);
      this.inFrustum[i] = visible ? 1 : 0;
      if (visible) visibleCount++;

      // Fetch-only. Distance still chooses LOD. Near-band cells (inside
      // lodBaseDistance and in front) rank by distance so a 30 m neighbour
      // 5 m away is not starved by a far cell whose centre sits on the look
      // axis. Farther cells keep the closest-point angular metric.
      if (cameraForward) {
        const inFront = d === 0 || this.boxPokesForward(leaf.bounds, cameraLocal, cameraForward);
        if (!inFront) {
          this.screenImportance[i] = Number.POSITIVE_INFINITY;
        } else if (d <= this.lodBaseDistance) {
          this.screenImportance[i] = -1 + d / (this.lodBaseDistance + 1);
        } else {
          leaf.bounds.clampPoint(cameraLocal, this.scratchCenter).sub(cameraLocal);
          const depth = this.scratchCenter.dot(cameraForward);
          const lateralSquared = Math.max(0, this.scratchCenter.lengthSq() - depth * depth);
          this.screenImportance[i] =
            depth > 0
              ? Math.sqrt(lateralSquared) / Math.max(depth, 0.25)
              : Number.POSITIVE_INFINITY;
        }
      } else {
        this.screenImportance[i] = 0;
      }

      const current = this.level[i] as number;
      // Blanket force-finest only when fill may still climb past the distance
      // band (octree / page-table). Classic LCC never uses this path.
      if (
        this.fillPastDistance &&
        this.forceFinestWithin !== undefined &&
        d <= this.forceFinestWithin
      ) {
        const finest = this.minLevel[i] as number;
        if (current !== finest) {
          this.level[i] = finest;
          this.changedAt[i] = now;
        }
        continue;
      }

      const effectiveDistance = !this.frustumAware || visible ? d : d * FRUSTUM_PENALTY;

      // Classic LCC: the ambition tracks the pure distance band only. Budget
      // demotions live in `resolved`, never here, so they cannot feed back
      // into hysteresis. A cold cell snaps straight to its band (no dwell
      // climb through intermediate LODs); afterward only a band *crossing*
      // moves the ambition - a stationary camera in the same band holds,
      // even if the budget just demoted its resolved level.
      if (!this.fillPastDistance) {
        const band = this.distanceBandLevel(i, effectiveDistance, base, m);
        const coldStart =
          (this.changedAt[i] as number) === 0 && current === (this.maxLevel[i] as number);
        if (coldStart) {
          if (band !== current) {
            this.level[i] = band;
            this.changedAt[i] = now;
          }
          continue;
        }
        if (band === current) continue;
        const proposed = this.hysteresisLevel(i, effectiveDistance, base, m, current);
        if (proposed === current) continue;
        // Coarsen immediately (moving away should not linger over budget);
        // only refinement waits out the dwell window.
        const coarsening = proposed > current;
        if (coarsening || now - (this.changedAt[i] as number) >= DWELL_MS) {
          this.level[i] = proposed;
          this.changedAt[i] = now;
        }
        continue;
      }

      const proposed = this.hysteresisLevel(i, effectiveDistance, base, m, current);
      if (proposed === current) continue;
      const coldSnap =
        (this.changedAt[i] as number) === 0 && current === (this.maxLevel[i] as number);
      if (coldSnap || now - (this.changedAt[i] as number) >= DWELL_MS) {
        this.level[i] = proposed;
        this.changedAt[i] = now;
      }
    }
    this.stats.inFrustum = visibleCount;
  }

  /**
   * Pure distance→level band (independent of the leaf's current level), so a
   * classic LCC cut never has to dwell through intermediate rungs.
   */
  private distanceBandLevel(index: number, d: number, base: number, m: number): number {
    const min = this.minLevel[index] as number;
    const max = this.maxLevel[index] as number;
    let level = min;
    while (level < max && d > base * m ** level * (1 + THRESHOLD_MARGIN)) level++;
    return this.resolveAvailable(index, level);
  }

  /**
   * Stable level from distance: coarsen only past `threshold·(1 + margin)`,
   * refine only within `threshold·(1 − margin)`. The available-level clamp
   * keeps leaves that lack a level on their nearest coarser one.
   */
  private hysteresisLevel(
    index: number,
    d: number,
    base: number,
    m: number,
    current: number,
  ): number {
    const min = this.minLevel[index] as number;
    const max = this.maxLevel[index] as number;
    let level = Math.min(max, Math.max(min, current));
    // threshold(L) = base·m^L is the boundary between level L and L+1.
    while (level < max && d > base * m ** level * (1 + THRESHOLD_MARGIN)) level++;
    while (level > min && d <= base * m ** (level - 1) * (1 - THRESHOLD_MARGIN)) level--;
    // Resolve to the nearest available level (prefer coarser) if this exact
    // one has no data (leaves need not carry every level).
    return this.resolveAvailable(index, level);
  }

  private resolveAvailable(index: number, target: number): number {
    const lods = (this.leaves[index] as LodLeaf).lods;
    for (let l = target; l <= (this.maxLevel[index] as number); l++) if (lods[l]) return l;
    for (let l = target - 1; l >= (this.minLevel[index] as number); l--) if (lods[l]) return l;
    return this.maxLevel[index] as number;
  }

  /** Demotes/drops lowest-priority leaves until the total fits the budget. */
  private enforceBudget(): void {
    let total = this.activeTotal();
    if (total <= this.budget) return;

    // Demote lowest priority first. When frustum-aware: out-of-frustum before
    // in-frustum, then farthest. Classic LCC sets frustumAware false - broad
    // XY cells often sit mostly behind the camera while the user stands in
    // them (d≈0); frustum demotion would coarsen that cell first and let
    // thinner cells ahead keep fine detail (backwards load). Distance only.
    const order = this.orderScratch.subarray(0, this.budgetGroups.length);
    for (let i = 0; i < order.length; i++) order[i] = i;
    order.sort((a, b) => {
      const ia = (this.budgetGroups[a] as Uint32Array)[0] as number;
      const ib = (this.budgetGroups[b] as Uint32Array)[0] as number;
      if (this.frustumAware) {
        const fa = this.inFrustum[ia] as number;
        const fb = this.inFrustum[ib] as number;
        if (fa !== fb) return fa - fb; // out-of-frustum (0) first
      }
      return (this.distance[ib] as number) - (this.distance[ia] as number) || ia - ib;
    });

    // Pass 1: coarsen toward the coarsest available level.
    for (const groupIndex of order) {
      const group = this.budgetGroups[groupIndex] as Uint32Array;
      while (total > this.budget) {
        let reduction = 0;
        let changed = false;
        for (const i of group) {
          const current = this.resolved[i] as number;
          if (current >= (this.maxLevel[i] as number)) continue;
          const lods = (this.leaves[i] as LodLeaf).lods;
          const nextLevel = this.resolveAvailable(i, current + 1);
          if (nextLevel === current) continue;
          reduction += (lods[current]?.count ?? 0) - (lods[nextLevel]?.count ?? 0);
          this.resolved[i] = nextLevel;
          changed = true;
        }
        if (!changed) break;
        total -= reduction;
      }
      if (total <= this.budget) return;
    }

    // Pass 2 (last resort): drop groups entirely, lowest priority first.
    for (const groupIndex of order) {
      if (total <= this.budget) return;
      for (const i of this.budgetGroups[groupIndex] as Uint32Array) {
        if ((this.resolved[i] as number) === DROPPED) continue;
        total -= (this.leaves[i] as LodLeaf).lods[this.resolved[i] as number]?.count ?? 0;
        this.resolved[i] = DROPPED;
      }
    }
  }

  /**
   * Uses leftover budget to restore detail after {@link enforceBudget}
   * demoted leaves, nearest first, while the total stays under the fill
   * target. By default this may also refine *past* the distance-chosen level
   * when headroom remains (octree / page-table streams). With
   * {@link fillPastDistance} false (classic LCC), fill never goes finer than
   * each leaf's distance-selected level - so a cell at the L1 band does not
   * fetch L0 only to demote moments later with the camera still.
   */
  private fillBudget(): void {
    const target =
      this.forceFinestWhenFits && this.budget >= this.finestTotal()
        ? this.budget
        : Math.min(this.budget, this.budgetFillCap) * this.budgetFillFraction;
    let total = this.activeTotal();
    if (total >= target) return;

    // Candidate in-frustum groups, nearest first (ties keep manifest order),
    // packed into the front of the shared index scratch.
    let candidateCount = 0;
    for (let groupIndex = 0; groupIndex < this.budgetGroups.length; groupIndex++) {
      const first = (this.budgetGroups[groupIndex] as Uint32Array)[0] as number;
      if (
        (!this.frustumAware || this.inFrustum[first] === 1) &&
        (this.resolved[first] as number) !== DROPPED
      ) {
        this.orderScratch[candidateCount++] = groupIndex;
      }
    }
    const order = this.orderScratch.subarray(0, candidateCount);
    order.sort((a, b) => {
      const ia = (this.budgetGroups[a] as Uint32Array)[0] as number;
      const ib = (this.budgetGroups[b] as Uint32Array)[0] as number;
      return (this.distance[ia] as number) - (this.distance[ib] as number) || ia - ib;
    });

    // Nearest groups refine first (up to the distance floor when capped).
    for (const groupIndex of order) {
      const group = this.budgetGroups[groupIndex] as Uint32Array;
      while (true) {
        let growth = 0;
        let canPromote = false;
        for (const i of group) {
          const current = this.resolved[i] as number;
          const floor = this.fillPastDistance
            ? (this.minLevel[i] as number)
            : (this.level[i] as number);
          if (current <= floor) continue;
          const leaf = this.leaves[i] as LodLeaf;
          let finer = current - 1;
          while (finer > floor && !leaf.lods[finer]) finer--;
          if (finer < floor || !leaf.lods[finer]) continue;
          growth += (leaf.lods[finer]?.count ?? 0) - (leaf.lods[current]?.count ?? 0);
          canPromote = true;
        }
        if (!canPromote || total + growth > target) break;
        for (const i of group) {
          const current = this.resolved[i] as number;
          const floor = this.fillPastDistance
            ? (this.minLevel[i] as number)
            : (this.level[i] as number);
          if (current <= floor) continue;
          const leaf = this.leaves[i] as LodLeaf;
          let finer = current - 1;
          while (finer > floor && !leaf.lods[finer]) finer--;
          if (finer >= floor && leaf.lods[finer]) this.resolved[i] = finer;
        }
        total += growth;
      }
    }
  }

  private coalesceRuns(): LodRun[] {
    return this.buildRuns(0, this.leaves.length, (i) => this.resolved[i] as number);
  }

  /**
   * Runs covering [from, to) at each leaf's coarsest available level - used
   * to substitute always-cached coverage while a finer level is fetching.
   */
  coarsestRunsFor(from: number, to: number): LodRun[] {
    return this.buildRuns(from, to, (i) => this.maxLevel[i] as number);
  }

  /**
   * Covering runs for physical coverage groups currently in the camera frustum
   * (or containing the camera). Classic LCC cells that split into sub-leaves
   * share a group, so one in-view slice holds the whole cell. Leaves without a
   * coverage group (Streamed SOG, the environment tile) are ignored. An empty
   * frustum falls back to the nearest group so a skyward start still paints
   * something.
   *
   * Classic cells tile X/Y and span the full scene Z. An AABB frustum test
   * (especially with {@link FRUSTUM_MARGIN} on that diagonal) then hits the
   * whole grid from any indoor pose. Unpadded intersection plus an AABB vs
   * forward half-space test (support vertex along `cameraForward`) keeps the
   * hold to cells that poke in front of the camera, including a neighbour
   * whose centre sits behind the look. Cells within `lodBaseDistance` that
   * poke forward are held even when the unpadded frustum misses — a 30 m
   * PentHouse column 5 m away can fill the frame while the look is 60° off
   * its face.
   *
   * Nearby groups (`distance ≤ lodBaseDistance · lodMultiplier`) freeze at
   * finest+1 (L1 when L0 exists). Farther in-view groups freeze at coarsest.
   * Startup never waits for L0.
   */
  coverageRunsFor(
    cameraLocal: THREE.Vector3,
    frustum: THREE.Frustum,
    cameraForward?: THREE.Vector3,
  ): LodRun[] {
    const n = this.leaves.length;
    const picked = new Set<number>();
    let nearestLeaf = -1;
    let nearestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const group = this.coverageGroups[i] as number;
      if (group < 0) continue;
      const leaf = this.leaves[i] as LodLeaf;
      const d = leaf.bounds.distanceToPoint(cameraLocal);
      if (d < nearestDist) {
        nearestDist = d;
        nearestLeaf = i;
      }
      // Camera-inside is load-bearing: HiRes tiles often fail the frustum test
      // when most of the cell sits behind the camera looking out.
      if (d === 0) {
        picked.add(group);
        continue;
      }
      // 30 m classic cells: the camera can stand 5 m from a neighbour that
      // fills the frame while the unpadded frustum misses the AABB (look 60°+
      // off the face). Still hold that neighbour when it pokes forward.
      const near = d <= this.lodBaseDistance;
      if (!near && !frustum.intersectsBox(leaf.bounds)) continue;
      if (cameraForward && !this.boxPokesForward(leaf.bounds, cameraLocal, cameraForward)) {
        continue;
      }
      picked.add(group);
    }
    if (picked.size === 0) {
      if (nearestLeaf < 0) return [];
      picked.add(this.coverageGroups[nearestLeaf] as number);
    }
    const nearHorizon = this.lodBaseDistance * this.lodMultiplier;
    const runs: LodRun[] = [];
    let i = 0;
    while (i < n) {
      const group = this.coverageGroups[i] as number;
      if (group < 0 || !picked.has(group)) {
        i++;
        continue;
      }
      let end = i + 1;
      while (end < n && (this.coverageGroups[end] as number) === group) end++;
      let groupDist = Number.POSITIVE_INFINITY;
      let groupFinest = this.minLevel[i] as number;
      for (let j = i; j < end; j++) {
        const d = (this.leaves[j] as LodLeaf).bounds.distanceToPoint(cameraLocal);
        if (d < groupDist) groupDist = d;
        const finest = this.minLevel[j] as number;
        if (finest < groupFinest) groupFinest = finest;
      }
      if (groupDist <= nearHorizon) {
        runs.push(...this.runsAtLevelFor(i, end, groupFinest + 1));
      } else {
        runs.push(...this.coarsestRunsFor(i, end));
      }
      i = end;
    }
    return runs;
  }

  /**
   * True when any point of `box` sits strictly in front of the camera plane
   * (`origin` + `forward`). Uses the AABB support vertex along `forward`, so a
   * cell that straddles the camera still counts if it pokes into the view.
   */
  private boxPokesForward(box: THREE.Box3, origin: THREE.Vector3, forward: THREE.Vector3): boolean {
    const x = forward.x >= 0 ? box.max.x : box.min.x;
    const y = forward.y >= 0 ? box.max.y : box.min.y;
    const z = forward.z >= 0 ? box.max.z : box.min.z;
    return (x - origin.x) * forward.x + (y - origin.y) * forward.y + (z - origin.z) * forward.z > 0;
  }

  /** Leaf AABB expanded by {@link FRUSTUM_MARGIN}, written into scratch. */
  private expandLeafBox(index: number): THREE.Box3 {
    const leaf = this.leaves[index] as LodLeaf;
    this.scratchBox.copy(leaf.bounds);
    leaf.bounds.getSize(this.scratchSize);
    this.scratchBox.expandByScalar(this.scratchSize.length() * FRUSTUM_MARGIN);
    return this.scratchBox;
  }

  private leafIntersectsFrustum(frustum: THREE.Frustum, index: number): boolean {
    return frustum.intersectsBox(this.expandLeafBox(index));
  }

  /**
   * Runs covering [from, to) at `level`, clamped per leaf to an available rung
   * (prefer the requested level, else the next coarser, else the next finer).
   */
  runsAtLevelFor(from: number, to: number, level: number): LodRun[] {
    const wanted = Math.floor(level);
    return this.buildRuns(from, to, (i) => this.clampLeafLevel(i, wanted));
  }

  /** Prefer `wanted`, else next coarser, else next finer; {@link DROPPED} if none. */
  private clampLeafLevel(leafIndex: number, wanted: number): number {
    const leaf = this.leaves[leafIndex] as LodLeaf;
    if (leaf.lods[wanted]) return wanted;
    for (let l = wanted + 1; l < leaf.lods.length; l++) {
      if (leaf.lods[l]) return l;
    }
    for (let l = wanted - 1; l >= 0; l--) {
      if (leaf.lods[l]) return l;
    }
    return DROPPED;
  }

  /** Coalesces leaves [from, to) at `levelOf(leaf)` into contiguous runs. */
  private buildRuns(from: number, to: number, levelOf: (index: number) => number): LodRun[] {
    const runs: LodRun[] = [];
    let file = -1;
    let level = -1;
    let offset = 0;
    let count = 0;
    let leafStart = -1;
    let leafEnd = -1;
    let coverageGroup = -1;
    let distance = Number.POSITIVE_INFINITY;
    let inView = false;
    let screenImportance = Number.POSITIVE_INFINITY;
    const flush = (): void => {
      if (count > 0) {
        runs.push({
          file,
          level,
          offset,
          count,
          leafStart,
          leafEnd,
          distance,
          inView,
          ...(this.hasScreenImportance ? { screenImportance } : {}),
          ...(coverageGroup >= 0 ? { coverageGroup } : {}),
        });
      }
      count = 0;
    };

    for (let i = from; i < to; i++) {
      const l = levelOf(i);
      if (l === DROPPED) {
        flush();
        continue;
      }
      const range = (this.leaves[i] as LodLeaf).lods[l];
      if (!range) {
        flush();
        continue;
      }
      const leafCoverageGroup = this.coverageGroups[i] as number;
      const leafDistance = this.distance[i] as number;
      const leafInView = (this.inFrustum[i] as number) === 1;
      if (
        count > 0 &&
        range.file === file &&
        l === level &&
        leafCoverageGroup === coverageGroup &&
        range.offset === offset + count &&
        count + range.count <= MAX_RUN_SPLATS
      ) {
        count += range.count; // extend the current run
        leafEnd = i + 1;
        if (leafDistance < distance) distance = leafDistance;
        if (leafInView) inView = true;
        screenImportance = Math.min(screenImportance, this.screenImportance[i] as number);
      } else {
        flush();
        file = range.file;
        level = l;
        offset = range.offset;
        count = range.count;
        leafStart = i;
        leafEnd = i + 1;
        coverageGroup = leafCoverageGroup;
        distance = leafDistance;
        inView = leafInView;
        screenImportance = this.screenImportance[i] as number;
      }
    }
    flush();
    return runs;
  }
}
