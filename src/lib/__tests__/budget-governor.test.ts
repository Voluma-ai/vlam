import { describe, expect, it } from 'vitest';

import { BudgetGovernor, type BudgetGovernedMember } from '../budget-governor';

/** A minimal member mirroring StreamedSplatMesh's clamp-and-report contract. */
class FakeMesh implements BudgetGovernedMember {
  budget: number;
  setBudgetCalls = 0;
  constructor(
    budget: number,
    private readonly maximumBudget = Infinity,
  ) {
    this.budget = budget;
  }
  setBudget(budget: number): number {
    this.setBudgetCalls++;
    this.budget = Math.min(Math.floor(budget), this.maximumBudget);
    return this.budget;
  }
}

function sumBudgets(meshes: FakeMesh[]): number {
  return meshes.reduce((sum, m) => sum + m.budget, 0);
}

describe('BudgetGovernor', () => {
  it('gives a sole member the whole total', () => {
    const governor = new BudgetGovernor({ totalBudget: 1_000_000 });
    const mesh = new FakeMesh(400_000);
    governor.register(mesh);
    expect(mesh.budget).toBe(1_000_000);
    expect(governor.budgetOf(mesh)).toBe(1_000_000);
  });

  it('splits by priority weight (the old 0.7 host split)', () => {
    const governor = new BudgetGovernor({ totalBudget: 1_000_000 });
    const main = new FakeMesh(1_000_000);
    const marker = new FakeMesh(1_000_000);
    governor.register(main, { weight: 7 });
    governor.register(marker, { weight: 3 });
    expect(main.budget).toBe(700_000);
    expect(marker.budget).toBe(300_000);
  });

  it('never lets the applied sum exceed the total across churn', () => {
    const total = 2_000_000;
    const governor = new BudgetGovernor({ totalBudget: total });
    const meshes = [
      new FakeMesh(3_000_000),
      new FakeMesh(3_000_000, 250_000),
      new FakeMesh(3_000_000),
    ];
    governor.register(meshes[0]!, { weight: 5 });
    expect(meshes[0]!.budget).toBeLessThanOrEqual(total);
    governor.register(meshes[1]!, { weight: 2 });
    expect(sumBudgets(meshes.slice(0, 2))).toBeLessThanOrEqual(total);
    governor.register(meshes[2]!, { weight: 1 });
    expect(sumBudgets(meshes)).toBeLessThanOrEqual(total);
    governor.setWeight(meshes[2]!, 10);
    expect(sumBudgets(meshes)).toBeLessThanOrEqual(total);
    governor.setTotalBudget(600_000);
    expect(sumBudgets(meshes)).toBeLessThanOrEqual(600_000);
    governor.unregister(meshes[1]!);
    expect(meshes[0]!.budget + meshes[2]!.budget).toBeLessThanOrEqual(600_000);
  });

  it("redistributes a capped member's slack to higher-capacity members", () => {
    const governor = new BudgetGovernor({ totalBudget: 1_000_000 });
    const small = new FakeMesh(100_000, 100_000); // clamps at 100k
    const large = new FakeMesh(500_000);
    governor.register(small); // equal weights
    governor.register(large);
    // small caps at 100k; large receives the released 400k on the next pass.
    expect(small.budget).toBe(100_000);
    expect(large.budget).toBe(900_000);
    expect(small.budget + large.budget).toBeLessThanOrEqual(1_000_000);
  });

  it('applies shrinks immediately but dead-bands small grows', () => {
    const governor = new BudgetGovernor({ totalBudget: 1_000_000, hysteresis: 0.1 });
    const main = new FakeMesh(1_000_000);
    const marker = new FakeMesh(200_000);
    governor.register(main, { weight: 9 });
    expect(main.budget).toBe(1_000_000);
    // Marker appears: main must shrink at once (invariant), marker's grow
    // from 200k to ~100k is a shrink too.
    governor.register(marker, { weight: 1 });
    expect(main.budget).toBe(900_000);
    expect(marker.budget).toBe(100_000);
    // A tiny weight nudge that would grow main by ≤10% is suppressed…
    const callsBefore = main.setBudgetCalls;
    governor.setWeight(marker, 0.9); // main share → ~909k: +1% grow, skipped
    expect(main.setBudgetCalls).toBe(callsBefore);
    expect(main.budget).toBe(900_000);
    // …while a large change still applies.
    governor.setWeight(marker, 9);
    expect(main.budget).toBe(500_000);
  });

  it("restores a member's original budget on unregister", () => {
    const governor = new BudgetGovernor({ totalBudget: 1_000_000 });
    const main = new FakeMesh(800_000);
    const marker = new FakeMesh(300_000);
    governor.register(main, { weight: 3 });
    governor.register(marker, { weight: 1 });
    expect(main.budget).toBe(750_000);
    governor.unregister(marker);
    expect(marker.budget).toBe(300_000); // back to its pre-registration value
    expect(main.budget).toBe(1_000_000); // sole member reclaims the total
    expect(governor.size).toBe(1);
    // Unregistering an unknown member is a no-op.
    governor.unregister(marker);
    expect(governor.size).toBe(1);
  });

  it('dispose restores every member and empties the governor', () => {
    const governor = new BudgetGovernor({ totalBudget: 1_000_000 });
    const a = new FakeMesh(600_000);
    const b = new FakeMesh(400_000);
    governor.register(a);
    governor.register(b);
    governor.dispose();
    expect(a.budget).toBe(600_000);
    expect(b.budget).toBe(400_000);
    expect(governor.size).toBe(0);
    // Still usable after dispose.
    governor.register(a);
    expect(a.budget).toBe(1_000_000);
  });

  it('suspends a weight-0 member and releases its whole share', () => {
    const governor = new BudgetGovernor({ totalBudget: 1_000_000 });
    const a = new FakeMesh(1_000_000);
    const b = new FakeMesh(1_000_000);
    governor.register(a);
    governor.register(b);
    expect(a.budget).toBe(500_000);

    // Spark's hidden tier: still registered, but holding ~nothing.
    governor.setWeight(a, 0);
    expect(a.budget).toBe(1); // the floor - 0 is not a legal budget
    expect(b.budget).toBe(1_000_000);
    expect(governor.size).toBe(2);
    expect(a.budget + b.budget).toBeLessThanOrEqual(1_000_000 + 1);

    // Resuming it takes the share back.
    governor.setWeight(a, 1);
    expect(a.budget).toBe(500_000);
  });

  it('registers a member suspended', () => {
    const governor = new BudgetGovernor({ totalBudget: 1_000_000 });
    const active = new FakeMesh(1_000_000);
    const hidden = new FakeMesh(400_000);
    governor.register(active);
    governor.register(hidden, { weight: 0 });
    expect(hidden.budget).toBe(1);
    expect(active.budget).toBe(1_000_000);
    // Unregistering restores what it had before joining, not the floor.
    governor.unregister(hidden);
    expect(hidden.budget).toBe(400_000);
  });

  it('does not divide by zero when every member is suspended', () => {
    const governor = new BudgetGovernor({ totalBudget: 1_000_000 });
    const a = new FakeMesh(600_000);
    const b = new FakeMesh(400_000);
    governor.register(a, { weight: 0 });
    governor.register(b, { weight: 0 });
    expect(a.budget).toBe(1);
    expect(b.budget).toBe(1);
    expect(Number.isFinite(a.budget)).toBe(true);
    // And the group recovers when one resumes.
    governor.setWeight(b, 1);
    expect(b.budget).toBe(1_000_000);
  });

  it('setWeights writes a batch and reallocates once', () => {
    const governor = new BudgetGovernor({ totalBudget: 1_000_000 });
    const a = new FakeMesh(1_000_000);
    const b = new FakeMesh(1_000_000);
    const c = new FakeMesh(1_000_000);
    for (const mesh of [a, b, c]) governor.register(mesh);
    const before = [a, b, c].map((m) => m.setBudgetCalls);

    governor.setWeights([
      [a, 6],
      [b, 3],
      [c, 1],
    ]);
    expect(a.budget).toBe(600_000);
    expect(b.budget).toBe(300_000);
    expect(c.budget).toBe(100_000);
    // One reallocation: each member saw at most one setBudget, not three.
    for (const [i, mesh] of [a, b, c].entries()) {
      expect(mesh.setBudgetCalls - (before[i] as number)).toBeLessThanOrEqual(1);
    }

    // A batch of unchanged weights does no work at all.
    const steady = [a, b, c].map((m) => m.setBudgetCalls);
    governor.setWeights([
      [a, 6],
      [b, 3],
    ]);
    expect([a, b, c].map((m) => m.setBudgetCalls)).toEqual(steady);
  });

  it('setWeights validates the whole batch before applying any of it', () => {
    const governor = new BudgetGovernor({ totalBudget: 1_000_000 });
    const a = new FakeMesh(1_000_000);
    const b = new FakeMesh(1_000_000);
    governor.register(a, { weight: 1 });
    governor.register(b, { weight: 1 });
    const stranger = new FakeMesh(1_000_000);

    expect(() =>
      governor.setWeights([
        [a, 9],
        [stranger, 1],
      ]),
    ).toThrow(/not registered/);
    expect(() =>
      governor.setWeights([
        [a, 9],
        [b, -1],
      ]),
    ).toThrow(RangeError);
    // Neither weight moved: a partial reweight is never left behind.
    expect(a.budget).toBe(500_000);
    expect(b.budget).toBe(500_000);
  });

  it('validates weights, totals, and double registration', () => {
    const governor = new BudgetGovernor({ totalBudget: 1_000_000 });
    const mesh = new FakeMesh(1);
    governor.register(mesh);
    expect(() => governor.register(mesh)).toThrow(/already registered/);
    expect(() => governor.register(new FakeMesh(1), { weight: -1 })).toThrow(RangeError);
    expect(() => governor.register(new FakeMesh(1), { weight: NaN })).toThrow(RangeError);
    expect(() => governor.setWeight(mesh, -1)).toThrow(RangeError);
    expect(() => governor.setWeight(new FakeMesh(1), 2)).toThrow(/not registered/);
    expect(() => governor.setTotalBudget(0)).toThrow(RangeError);
    expect(() => new BudgetGovernor({ hysteresis: -0.5 })).toThrow(RangeError);
    expect(governor.budgetOf(new FakeMesh(1))).toBeUndefined();
  });
});
