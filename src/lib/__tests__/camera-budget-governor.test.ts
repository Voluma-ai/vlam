import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';

import { BudgetGovernor } from '../streaming/budget-governor';
import { CameraBudgetGovernor, type CameraBudgetMember } from '../streaming/camera-budget-governor';

/**
 * Acceptance tests for the multi-mesh budget behavior: with one shared
 * total, the member the camera approaches must take budget off the far ones,
 * hidden members must give theirs up, and none of it may break the underlying
 * governor's "applied budgets never exceed the total" invariant.
 *
 * `FakeMember` mirrors `StreamedSplatMesh`'s governed contract - clamp to a
 * ceiling and report what took effect - plus the three things the camera helper
 * measures. No GPU, no scene graph.
 */
class FakeMember implements CameraBudgetMember {
  budget: number;
  visible = true;
  /** `SplatMesh.effectiveVisibility`: set while a unified renderer owns the draw. */
  effectiveVisibility?: boolean;
  readonly matrixWorld = new THREE.Matrix4();
  setBudgetCalls = 0;
  private readonly bounds: THREE.Box3;

  constructor(
    /** Where the mesh sits, and how big it is - the weighting inputs. */
    center: THREE.Vector3,
    radius: number,
    budget: number,
    readonly maxBudget = Infinity,
  ) {
    this.budget = budget;
    this.bounds = new THREE.Box3().setFromCenterAndSize(
      center,
      new THREE.Vector3(radius * 2, radius * 2, radius * 2),
    );
  }

  /** Bounds are pre-placed in world space, so `matrixWorld` stays identity. */
  computeSplatBounds(): THREE.Box3 {
    return this.bounds.clone();
  }
  updateWorldMatrix(): void {}
  setBudget(budget: number): number {
    this.setBudgetCalls++;
    this.budget = Math.min(Math.floor(budget), this.maxBudget);
    return this.budget;
  }
}

/** An empty-bounds member - a dynamic mesh with nothing appended yet. */
class EmptyMember extends FakeMember {
  override computeSplatBounds(): THREE.Box3 {
    return new THREE.Box3(); // isEmpty()
  }
}

const TOTAL = 4_000_000;
/** Four members on a ring, far enough apart that one is clearly nearest. */
const RING = 200;

function camera(x: number, y: number, z: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 10_000);
  cam.position.set(x, y, z);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

/**
 * An overhead view that holds all four members inside the frustum, so a test
 * comparing their shares is measuring *distance* and not the off-screen
 * penalty. At 420 units up, a member on the 200-unit ring sits 25.5° off axis,
 * inside the 30° half-FOV; the 1-unit Z offset keeps `lookAt`'s up vector from
 * being parallel to the view direction.
 */
function overheadCamera(): THREE.PerspectiveCamera {
  return camera(0, 420, 1);
}

/** Four members at ±RING on X and Z, each 10 units in radius. */
function makeMembers(maxBudget = Infinity): FakeMember[] {
  return [
    new THREE.Vector3(RING, 0, 0),
    new THREE.Vector3(-RING, 0, 0),
    new THREE.Vector3(0, 0, RING),
    new THREE.Vector3(0, 0, -RING),
  ].map((center) => new FakeMember(center, 10, 100_000, maxBudget));
}

function sumBudgets(members: FakeMember[]): number {
  return members.reduce((sum, m) => sum + m.budget, 0);
}

describe('CameraBudgetGovernor', () => {
  it('gives the near member the larger share and takes it off the far ones', () => {
    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL });
    const members = makeMembers();
    for (const member of members) governor.register(member);

    // Overhead: every member is equidistant and on screen, so shares match.
    governor.update(overheadCamera(), 0);
    const centred = members.map((m) => governor.budgetOf(m) ?? 0);
    const baseline = centred[0] as number;
    for (const budget of centred) {
      expect(Math.abs(budget - baseline) / baseline).toBeLessThan(0.1);
    }

    // Fly to member 0 (at +X). Its share must rise, the others' must fall.
    governor.update(camera(RING + 15, 0, 0), 1000);
    const near = governor.budgetOf(members[0]!) ?? 0;
    expect(near).toBeGreaterThan(baseline);
    for (const far of members.slice(1)) {
      const budget = governor.budgetOf(far) ?? 0;
      expect(budget).toBeLessThan(baseline);
      // The whole point: near is not merely ahead, it dominates.
      expect(near).toBeGreaterThan(4 * budget);
    }
    expect(sumBudgets(members)).toBeLessThanOrEqual(TOTAL);
  });

  it('holds the sum invariant across a camera walk', () => {
    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL, minIntervalMs: 0 });
    const members = makeMembers();
    const main = new FakeMember(new THREE.Vector3(0, 0, 0), 300, 1_000_000);
    governor.register(main, { fixedWeight: 4 });
    for (const member of members) governor.register(member);

    // A deterministic orbit-and-dive path, sampled every step.
    for (let step = 0; step < 300; step++) {
      const angle = (step / 300) * Math.PI * 4;
      const distance = 20 + ((step * 7) % 400);
      governor.update(
        camera(Math.cos(angle) * distance, ((step % 40) - 20) * 3, Math.sin(angle) * distance),
        step * 100,
      );
      expect(sumBudgets([main, ...members])).toBeLessThanOrEqual(TOTAL);
    }
  });

  it('suspends a hidden member and releases its share', () => {
    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL, minIntervalMs: 0 });
    const members = makeMembers();
    for (const member of members) governor.register(member);
    governor.update(overheadCamera(), 0);
    const before = governor.budgetOf(members[1]!) ?? 0;

    members[0]!.visible = false;
    governor.update(overheadCamera(), 100);

    expect(governor.weightOf(members[0]!)).toBe(0);
    expect(members[0]!.budget).toBeLessThanOrEqual(1);
    // Still governed - the mesh stays warm, it just holds no budget.
    expect(governor.size).toBe(4);
    expect(governor.budgetOf(members[1]!) ?? 0).toBeGreaterThan(before);
    expect(sumBudgets(members)).toBeLessThanOrEqual(TOTAL);

    // Showing it again recovers a share.
    members[0]!.visible = true;
    governor.update(overheadCamera(), 200);
    expect(members[0]!.budget).toBeGreaterThan(1);
  });

  it('weighs a unified-owned source by effectiveVisibility, not Object3D.visible', () => {
    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL, minIntervalMs: 0 });
    const members = makeMembers();
    for (const member of members) governor.register(member);
    governor.update(overheadCamera(), 0);
    const before = governor.budgetOf(members[0]!) ?? 0;

    // A UnifiedSplatMesh takes ownership: it forces `visible = false` on
    // every source (to keep the scene draw from double-drawing) while the
    // source stays on screen through the unified draw. The governor must keep
    // weighting it - this is the regression that froze member streaming at
    // whatever detail was resident when the unified renderer attached.
    for (const member of members) {
      member.visible = false;
      member.effectiveVisibility = true;
    }
    governor.update(overheadCamera(), 100);
    expect(governor.weightOf(members[0]!)).toBeGreaterThan(0);
    expect(governor.budgetOf(members[0]!) ?? 0).toBeCloseTo(before, -1);

    // Hiding the source *through the unified renderer* still suspends it.
    members[0]!.effectiveVisibility = false;
    governor.update(overheadCamera(), 200);
    expect(governor.weightOf(members[0]!)).toBe(0);
    expect(members[0]!.budget).toBeLessThanOrEqual(1);
    expect(sumBudgets(members)).toBeLessThanOrEqual(TOTAL);
  });

  it('suspends a priority-0 member the same way', () => {
    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL, minIntervalMs: 0 });
    const members = makeMembers();
    for (const member of members) governor.register(member);
    governor.update(overheadCamera(), 0);

    governor.setPriority(members[0]!, 0);
    governor.update(overheadCamera(), 10); // forced: bypasses the interval
    expect(members[0]!.budget).toBeLessThanOrEqual(1);

    governor.setPriority(members[0]!, 1);
    governor.update(overheadCamera(), 20);
    expect(members[0]!.budget).toBeGreaterThan(1);
  });

  it("releases a capped member's slack even when it is the nearest", () => {
    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL, minIntervalMs: 0 });
    // The near member's pool tops out at 250k - the rest must go elsewhere.
    const near = new FakeMember(new THREE.Vector3(RING, 0, 0), 10, 100_000, 250_000);
    const far = new FakeMember(new THREE.Vector3(-RING, 0, 0), 10, 100_000);
    governor.register(near);
    governor.register(far);

    governor.update(camera(RING + 15, 0, 0), 0);
    expect(near.budget).toBe(250_000);
    expect(far.budget).toBeGreaterThan(250_000);
    expect(near.budget + far.budget).toBeLessThanOrEqual(TOTAL);
  });

  it('throttles to minIntervalMs and forces through on membership change', () => {
    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL, minIntervalMs: 250 });
    const members = makeMembers();
    for (const member of members) governor.register(member);
    const spy = vi.spyOn(governor.governor, 'setWeights');

    // First call is forced by registration.
    expect(governor.update(overheadCamera(), 1000)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    // Nine more calls inside the interval, each from a genuinely new camera.
    for (let i = 1; i < 10; i++) {
      expect(governor.update(camera(RING + i * 5, 0, 0), 1000 + i * 20)).toBe(false);
    }
    expect(spy).toHaveBeenCalledTimes(1);

    // Past the interval it reweights again.
    expect(governor.update(camera(RING + 15, 0, 0), 1300)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('does not force a reweight when setPriority re-asserts the same tier', () => {
    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL, minIntervalMs: 250 });
    const members = makeMembers();
    for (const member of members) governor.register(member);
    governor.update(overheadCamera(), 1000);

    // Hosts re-assert tiers from sync loops; an unchanged priority must not
    // bypass the interval, or the governor reweights (and reschedules every
    // member) on each sync tick.
    governor.setPriority(members[0]!, 1);
    expect(governor.update(overheadCamera(), 1010)).toBe(false);

    // A real tier change still forces through.
    governor.setPriority(members[0]!, 2);
    expect(governor.update(overheadCamera(), 1020)).toBe(true);
  });

  it('skips a reweight when no weight moved past the dead-band', () => {
    const governor = new CameraBudgetGovernor({
      totalBudget: TOTAL,
      minIntervalMs: 0,
      weightDeadband: 0.15,
    });
    const members = makeMembers();
    for (const member of members) governor.register(member);
    governor.update(overheadCamera(), 0);

    const callsBefore = members.map((m) => m.setBudgetCalls);
    // A 2 cm nudge at 420 units out: nowhere near a 15% weight change.
    expect(governor.update(camera(0, 420.02, 1), 100)).toBe(false);
    expect(members.map((m) => m.setBudgetCalls)).toEqual(callsBefore);

    // A real move does reweight.
    expect(governor.update(camera(RING + 15, 0, 0), 200)).toBe(true);
  });

  it('keeps fixedWeight members out of camera weighting but still in the split', () => {
    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL, minIntervalMs: 0 });
    const main = new FakeMember(new THREE.Vector3(0, 0, 0), 300, 1_000_000);
    const member = new FakeMember(new THREE.Vector3(RING, 0, 0), 10, 100_000);
    governor.register(main, { fixedWeight: 4 });
    governor.register(member);

    governor.update(overheadCamera(), 0);
    expect(governor.weightOf(main)).toBe(4);
    const mainFar = main.budget;

    // Flying to the member must not change main's weight, but must shrink its
    // budget - the member's rising weight is what takes the share.
    governor.update(camera(RING + 15, 0, 0), 100);
    expect(governor.weightOf(main)).toBe(4);
    expect(main.budget).toBeLessThan(mainFar);
  });

  it('suppresses off-screen members without starving them', () => {
    const governor = new CameraBudgetGovernor({
      totalBudget: TOTAL,
      minIntervalMs: 0,
      offScreenWeight: 0.25,
    });
    const ahead = new FakeMember(new THREE.Vector3(0, 0, -RING), 10, 100_000);
    const behind = new FakeMember(new THREE.Vector3(0, 0, RING), 10, 100_000);
    governor.register(ahead);
    governor.register(behind);

    // Looking down -Z: `ahead` is in frustum, `behind` is not, both equidistant.
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 10_000);
    cam.position.set(0, 0, 0);
    cam.lookAt(0, 0, -1);
    cam.updateMatrixWorld(true);
    governor.update(cam, 0);

    expect(governor.weightOf(behind)).toBeLessThan(governor.weightOf(ahead) as number);
    // Coarse, not culled: it keeps a real share so turning finds pixels there.
    expect(behind.budget).toBeGreaterThan(1);
  });

  it('holds the floor for a member with no measurable bounds yet', () => {
    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL, minIntervalMs: 0 });
    const empty = new EmptyMember(new THREE.Vector3(0, 0, 0), 10, 100_000);
    const sized = new FakeMember(new THREE.Vector3(0, 0, 0), 10, 100_000);
    governor.register(empty);
    governor.register(sized);
    governor.update(camera(0, 0, 30), 0);

    // minWeight default 0.05 × priority 1 - positive and finite, not NaN.
    expect(governor.weightOf(empty)).toBeCloseTo(0.05, 10);
    expect(empty.budget).toBeGreaterThan(0);
    expect(empty.budget + sized.budget).toBeLessThanOrEqual(TOTAL);
  });

  it('drives a governor supplied by the host, leaving its own members alone', () => {
    const shared = new BudgetGovernor({ totalBudget: TOTAL });
    const fixed = new FakeMember(new THREE.Vector3(0, 0, 0), 300, 1_000_000);
    shared.register(fixed, { weight: 4 }); // host-managed, not camera-weighted
    const governor = new CameraBudgetGovernor({ governor: shared });
    const member = new FakeMember(new THREE.Vector3(RING, 0, 0), 10, 100_000);
    governor.register(member);

    governor.update(camera(RING + 15, 0, 0), 0);
    expect(shared.size).toBe(2);
    expect(fixed.budget + member.budget).toBeLessThanOrEqual(TOTAL);

    // dispose only takes back what this helper registered.
    governor.dispose();
    expect(shared.size).toBe(1);
    expect(shared.budgetOf(fixed)).toBeDefined();
  });

  it('restores pre-registration budgets on dispose', () => {
    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL, minIntervalMs: 0 });
    const members = makeMembers();
    for (const member of members) governor.register(member);
    governor.update(overheadCamera(), 0);
    governor.dispose();

    for (const member of members) expect(member.budget).toBe(100_000);
    expect(governor.size).toBe(0);
    // Still usable afterwards.
    governor.register(members[0]!);
    expect(members[0]!.budget).toBe(TOTAL);
  });

  it('validates options, member options, and membership', () => {
    expect(() => new CameraBudgetGovernor({ falloff: 0 })).toThrow(RangeError);
    expect(() => new CameraBudgetGovernor({ minIntervalMs: -1 })).toThrow(RangeError);
    expect(() => new CameraBudgetGovernor({ weightDeadband: -0.1 })).toThrow(RangeError);
    expect(() => new CameraBudgetGovernor({ minWeight: 2, maxWeight: 1 })).toThrow(RangeError);

    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL });
    const member = new FakeMember(new THREE.Vector3(), 1, 1);
    governor.register(member);
    expect(() => governor.register(member)).toThrow(/already registered/);
    expect(() => governor.setPriority(new FakeMember(new THREE.Vector3(), 1, 1), 1)).toThrow(
      /not registered/,
    );
    expect(() => governor.setPriority(member, -1)).toThrow(RangeError);
    expect(() =>
      governor.register(new FakeMember(new THREE.Vector3(), 1, 1), { priority: NaN }),
    ).toThrow(RangeError);
    // Unregistering an unknown member is a no-op, like BudgetGovernor's.
    governor.unregister(new FakeMember(new THREE.Vector3(), 1, 1));
    expect(governor.size).toBe(1);
    expect(governor.weightOf(new FakeMember(new THREE.Vector3(), 1, 1))).toBeUndefined();
  });

  it('does nothing with no members', () => {
    const governor = new CameraBudgetGovernor({ totalBudget: TOTAL });
    expect(governor.update(overheadCamera(), 0)).toBe(false);
    expect(governor.totalBudget).toBe(TOTAL);
    governor.setTotalBudget(1_000_000);
    expect(governor.totalBudget).toBe(1_000_000);
  });
});
