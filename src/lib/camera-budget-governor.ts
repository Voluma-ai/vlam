/**
 * Camera-driven splat-budget weighting across several streamed meshes.
 *
 * {@link BudgetGovernor} splits one total by *priority*, which a host must
 * choose and maintain. That is the wrong axis for a scene of additional meshes:
 * what makes a mesh worth splats is that the camera is near it, and that changes
 * every frame. Splitting a pool evenly instead (`pool / N`) gives the mesh
 * you fly up to a quarter of the budget it needs while three meshes nobody is
 * looking at hold the rest.
 *
 * {@link CameraBudgetGovernor} closes that loop: each update it measures every
 * member's projected size from the camera, multiplies in the host's priority
 * tier, and writes the resulting weights to a `BudgetGovernor` in one batch.
 * Approaching one of four additional meshes pulls budget off the far ones automatically.
 *
 * This is Spark's model, reached differently. Spark shares one `lodSplatCount`
 * and biases meshes with a per-mesh `lodScale` (focused 2, adjacent 0.25,
 * hidden 0); its GPU traversal then favors near, on-screen detail on its own.
 * VLAM's meshes each own a pool, so the near/far bias has to be applied to the
 * *budget* - which is what this class does, with `priority` playing the part of
 * `lodScale`. (For a `.rad` page-table mesh, `StreamedSplatMesh.lodScale` is
 * also available and is Spark's knob exactly.)
 *
 * Composition, not inheritance: `BudgetGovernor` stays a pure allocation
 * policy with no camera and no frame lifecycle, and a host that wants fixed
 * weights keeps using it directly.
 */

import * as THREE from 'three/webgpu';

import {
  BudgetGovernor,
  type BudgetGovernedMember,
  type BudgetGovernorOptions,
} from './budget-governor';

/**
 * A governed member this class can measure. Every `SplatMesh` (and so every
 * `StreamedSplatMesh`) satisfies it structurally - there is no extra host
 * plumbing to write.
 */
export interface CameraBudgetMember extends BudgetGovernedMember {
  /**
   * The member's splat bounds in its own local frame. `StreamedSplatMesh`
   * overrides this to the whole scene's bounds, which are known from the
   * manifest - so weighting is correct from the first frame, before a single
   * chunk has loaded.
   */
  computeSplatBounds(): THREE.Box3;
  /** Local→world transform, read after {@link updateWorldMatrix}. */
  readonly matrixWorld: THREE.Matrix4;
  /** `Object3D.updateWorldMatrix`; called so a fresh member is placed correctly. */
  updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void;
  /**
   * `Object3D.visible`. A hidden member is suspended (weight 0) - it draws
   * nothing, so it should hold no budget. This is the member's own flag, not an
   * ancestor walk: a host hiding a whole group should set `priority: 0`.
   */
  readonly visible: boolean;
  /**
   * The visibility that actually decides whether the member's splats reach the
   * screen, when that differs from `visible`. `SplatMesh` provides it: a
   * `UnifiedSplatRenderer` forces `visible = false` on every source it owns
   * (only to keep the regular scene draw from double-drawing them) while the
   * source may be fully on screen through the unified draw - without this, the
   * governor would suspend every unified source and freeze its streaming.
   * When present it wins over `visible`.
   */
  readonly effectiveVisibility?: boolean;
}

/** Options for {@link CameraBudgetGovernor}. */
export interface CameraBudgetGovernorOptions extends BudgetGovernorOptions {
  /**
   * An existing governor to drive, when the host already has one (or wants to
   * mix camera-weighted and fixed-weight members). By default one is built
   * from the inherited {@link BudgetGovernorOptions}.
   */
  governor?: BudgetGovernor;
  /**
   * Minimum milliseconds between reweights. Default `250`, matching
   * `StreamedSplatMesh`'s own idle reschedule interval: a mesh cannot act on a
   * budget change faster than it reschedules, so reweighting more often buys
   * nothing and costs a forced reschedule on every member. Membership and
   * priority changes bypass it.
   */
  minIntervalMs?: number;
  /**
   * Relative weight change below which a reweight is skipped entirely, as a
   * fraction of the weight in effect. Default `0.15`.
   *
   * This sits *above* `BudgetGovernor`'s grow dead-band and does a different
   * job: that one damps budget churn on a member, this one suppresses the
   * reallocation altogether so an idling camera does no work at all.
   */
  weightDeadband?: number;
  /**
   * Exponent on projected size. `1` (default) weights by angular size -
   * halving the distance doubles the share. `2` weights by projected *area*,
   * which concentrates the budget harder on the nearest member.
   */
  falloff?: number;
  /**
   * Weight multiplier for a member outside the view frustum. Default `0.25`:
   * suppressed, never starved. Off-screen members must keep enough budget for
   * their coarse shell, or turning the camera exposes an unpainted region -
   * the same foveate-don't-cull policy the `.rad` frontier traversal follows.
   */
  offScreenWeight?: number;
  /** Floor on the projected-size term, so a very distant member still holds a
   * coarse shell. Default `0.05`. */
  minWeight?: number;
  /** Ceiling on the projected-size term, so a member the camera is inside
   * cannot take the entire total. Default `8`. */
  maxWeight?: number;
}

/** Per-member options for {@link CameraBudgetGovernor.register}. */
export interface CameraBudgetMemberOptions {
  /**
   * Host priority multiplied into the camera term - Spark's `lodScale` tiers:
   * focused `2`, default `1`, adjacent `0.25`, hidden `0`. Default `1`.
   * `0` suspends the member (see {@link BudgetGovernor}).
   */
  priority?: number;
  /**
   * Pins this member's weight, opting it out of camera weighting while it still
   * competes for the same total. Use it for a main scene that should hold a
   * steady share while additional meshes fight over the rest - e.g. `fixedWeight: 4`
   * against extras averaging `1`.
   */
  fixedWeight?: number;
}

interface CameraEntry {
  member: CameraBudgetMember;
  priority: number;
  fixedWeight: number | undefined;
  /**
   * Weight currently written to the governor - seeded at registration, so a
   * member never reads back as "unweighted". `register` forces the next update
   * regardless, which is what makes the seed safe to compare against.
   */
  applied: number;
}

/** Reused across updates - this runs every frame and must not allocate. */
const _cameraPos = new THREE.Vector3();
const _projScreen = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();

/**
 * Weights a {@link BudgetGovernor}'s members by how large each one projects
 * from the camera, so nearby meshes take budget from distant ones.
 *
 * ```js
 * const governor = new CameraBudgetGovernor({ totalBudget: 4_000_000 });
 * governor.register(main, { fixedWeight: 4 }); // steady share
 * governor.register(extraA); // camera-weighted, priority 1
 * governor.register(extraB);
 *
 * // once per frame, after the scene graph is up to date:
 * governor.update(camera);
 * ```
 *
 * Every guarantee of the underlying governor still holds - most importantly
 * that the applied budgets never sum above the total, and that unregistering a
 * member restores the budget it had when it joined.
 *
 * **A member can only grow into a budget its pool can hold.** A streamed mesh
 * allocates its pool once, from its construction budget, and clamps `setBudget`
 * to it - so a mesh built at a quarter of the total can never be given more
 * than a quarter, however close the camera gets. Construct governed meshes with
 * `maxBudget` set to the largest share they should ever reach, and price those
 * ceilings with `estimateSplatPoolBytes` first: the pools cost their ceilings
 * whatever the budget is split to.
 */
export class CameraBudgetGovernor {
  private readonly entries = new Map<CameraBudgetMember, CameraEntry>();
  private readonly budgetGovernor: BudgetGovernor;
  private readonly minIntervalMs: number;
  private readonly weightDeadband: number;
  private readonly falloff: number;
  private readonly offScreenWeight: number;
  private readonly minWeight: number;
  private readonly maxWeight: number;
  private lastUpdateAt = -Infinity;
  /** Set by membership/priority changes: the next update ignores both damps. */
  private forceNext = true;

  constructor(options: CameraBudgetGovernorOptions = {}) {
    this.budgetGovernor = options.governor ?? new BudgetGovernor(options);
    this.minIntervalMs = nonNegative(options.minIntervalMs ?? 250, 'minIntervalMs');
    this.weightDeadband = nonNegative(options.weightDeadband ?? 0.15, 'weightDeadband');
    this.falloff = positive(options.falloff ?? 1, 'falloff');
    this.offScreenWeight = positive(options.offScreenWeight ?? 0.25, 'offScreenWeight');
    this.minWeight = positive(options.minWeight ?? 0.05, 'minWeight');
    this.maxWeight = positive(options.maxWeight ?? 8, 'maxWeight');
    if (this.maxWeight < this.minWeight) {
      throw new RangeError('CameraBudgetGovernor maxWeight must be >= minWeight.');
    }
  }

  /** The governor this drives; use it for fixed-weight members and diagnostics. */
  get governor(): BudgetGovernor {
    return this.budgetGovernor;
  }

  /** The shared total being split, from the underlying governor. */
  get totalBudget(): number {
    return this.budgetGovernor.totalBudget;
  }

  /** Replaces the shared total (e.g. the presenting budget on `sessionstart`). */
  setTotalBudget(totalBudget: number): void {
    this.budgetGovernor.setTotalBudget(totalBudget);
  }

  /** Number of camera-weighted members. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Adds a member, registers it with the underlying governor, and forces a
   * reweight on the next {@link update}.
   *
   * @throws {Error} if the member is already registered here.
   * @throws {RangeError} if `priority` or `fixedWeight` is invalid.
   */
  register(member: CameraBudgetMember, options: CameraBudgetMemberOptions = {}): void {
    if (this.entries.has(member)) {
      throw new Error('CameraBudgetGovernor: member is already registered.');
    }
    const priority = nonNegative(options.priority ?? 1, 'priority');
    const fixedWeight =
      options.fixedWeight === undefined
        ? undefined
        : nonNegative(options.fixedWeight, 'fixedWeight');
    // Register at the weight this member will hold anyway, so the very first
    // allocation is already roughly right rather than an even split that the
    // first update immediately overwrites.
    const initial = fixedWeight ?? priority;
    this.budgetGovernor.register(member, { weight: initial });
    this.entries.set(member, { member, priority, fixedWeight, applied: initial });
    this.forceNext = true;
  }

  /**
   * Removes a member from this helper and the underlying governor, restoring
   * the budget it had when it joined. No-op for an unknown member.
   */
  unregister(member: CameraBudgetMember): void {
    if (!this.entries.delete(member)) return;
    this.budgetGovernor.unregister(member);
    this.forceNext = true;
  }

  /**
   * Changes a member's priority tier. Takes effect on the next {@link update},
   * which is forced - a deliberate focus change should not wait out the
   * interval or be swallowed by the dead-band.
   *
   * @throws {Error} if the member is not registered here.
   * @throws {RangeError} if `priority` is negative or not finite.
   */
  setPriority(member: CameraBudgetMember, priority: number): void {
    const entry = this.entries.get(member);
    if (entry === undefined) {
      throw new Error('CameraBudgetGovernor: member is not registered.');
    }
    const next = nonNegative(priority, 'priority');
    // No-op on an unchanged tier. Hosts re-assert tiers from sync loops, and an
    // unconditional force would bypass the interval *and* the dead-band on the
    // next update - every reallocation pushes setBudget to every member, and a
    // streamed mesh answers each one with a forced LOD reschedule.
    if (next === entry.priority) return;
    entry.priority = next;
    this.forceNext = true;
  }

  /**
   * Recomputes every member's weight from the camera and applies them in one
   * batch. Call once per frame, after the scene graph is up to date.
   *
   * Needs no renderer: weights are a ratio, so viewport size cancels out.
   *
   * Skipped - returning `false` - when called inside `minIntervalMs` of the
   * last reweight, or when no member's weight moved by more than
   * `weightDeadband`. Membership and priority changes force it through both.
   *
   * @param camera - The view detail should follow. In an immersive session pass
   * the head/`ArrayCamera`, not the idle application camera.
   * @param now - Timestamp in ms on the `performance.now` clock; defaults to it.
   * @returns whether weights were reapplied.
   */
  update(camera: THREE.Camera, now: number = performance.now()): boolean {
    if (this.entries.size === 0) return false;
    const forced = this.forceNext;
    if (!forced && now - this.lastUpdateAt < this.minIntervalMs) return false;

    camera.updateMatrixWorld();
    camera.getWorldPosition(_cameraPos);
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);

    const next: [CameraBudgetMember, number][] = [];
    let significant = false;
    for (const entry of this.entries.values()) {
      const weight = this.weightFor(entry);
      next.push([entry.member, weight]);
      if (!significant && this.isSignificant(entry.applied, weight)) significant = true;
    }
    if (!forced && !significant) return false;

    // One batched write: N separate setWeight calls would each reallocate and
    // force an LOD reschedule on every member.
    this.budgetGovernor.setWeights(next);
    for (const [member, weight] of next) {
      const entry = this.entries.get(member);
      if (entry !== undefined) entry.applied = weight;
    }
    this.lastUpdateAt = now;
    this.forceNext = false;
    return true;
  }

  /** The weight currently written for a member, if registered here. */
  weightOf(member: CameraBudgetMember): number | undefined {
    return this.entries.get(member)?.applied;
  }

  /** The budget the underlying governor last applied to a member. */
  budgetOf(member: CameraBudgetMember): number | undefined {
    return this.budgetGovernor.budgetOf(member);
  }

  /**
   * Unregisters every member, restoring the budget each had when it joined.
   * The helper stays usable afterwards. A governor passed in by the host keeps
   * any members the host registered on it directly.
   */
  dispose(): void {
    for (const member of [...this.entries.keys()]) this.budgetGovernor.unregister(member);
    this.entries.clear();
    this.lastUpdateAt = -Infinity;
    this.forceNext = true;
  }

  /**
   * A member's weight: `priority × clamp((radius / distance) ^ falloff) ×
   * offScreen`.
   *
   * `radius / distance` is the tangent of the member's half angular size - the
   * same `size / distance` measure Spark's `pixel_scale` traversal ranks nodes
   * by, one level up at whole-mesh granularity. Distance is measured to the
   * bounding sphere's *surface*, so a large mesh is not penalized for having a
   * distant center, and is floored so a camera inside the bounds saturates at
   * `maxWeight` rather than dividing by zero.
   */
  private weightFor(entry: CameraEntry): number {
    if (entry.fixedWeight !== undefined) return entry.fixedWeight;
    const { member, priority } = entry;
    if (priority === 0 || !(member.effectiveVisibility ?? member.visible)) return 0;

    member.updateWorldMatrix(true, false);
    _box.copy(member.computeSplatBounds());
    // Nothing measurable yet (a dynamic mesh with no appended ranges): hold the
    // floor rather than reporting an infinite or NaN size.
    if (_box.isEmpty()) return priority * this.minWeight;
    _box.applyMatrix4(member.matrixWorld).getBoundingSphere(_sphere);

    const radius = _sphere.radius;
    if (!(radius > 0)) return priority * this.minWeight;
    // Floor the distance relative to the member's own size, so the saturation
    // point scales with the scene instead of being a fixed world distance.
    const surface = _sphere.center.distanceTo(_cameraPos) - radius;
    const distance = Math.max(surface, radius * 1e-3, 1e-6);
    const projected = clamp((radius / distance) ** this.falloff, this.minWeight, this.maxWeight);
    if (!Number.isFinite(projected)) return priority * this.minWeight;

    const onScreen = _frustum.intersectsSphere(_sphere) ? 1 : this.offScreenWeight;
    return priority * projected * onScreen;
  }

  /** Whether a weight moved enough to be worth a reallocation. */
  private isSignificant(applied: number, next: number): boolean {
    // Crossing into or out of suspension always matters, however small the
    // absolute change: it decides whether the member holds budget at all.
    if (applied === 0 || next === 0) return applied !== next;
    return Math.abs(next - applied) > this.weightDeadband * applied;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`CameraBudgetGovernor ${name} must be a non-negative finite number.`);
  }
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`CameraBudgetGovernor ${name} must be a positive finite number.`);
  }
  return value;
}
