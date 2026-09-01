import { describe, expect, it } from 'vitest';
import { liftBudgetToFinestLevel } from '../core/splat-budget';

const FOVEATION_LEAF_THRESHOLD = 6_000_000;

/** Mirrors `buildRadScene` foveate selection for unit tests. */
const resolveRadFoveate = (budget: number, leafCount: number, budgetLifts: boolean): boolean => {
  const effectiveBudget = budgetLifts
    ? liftBudgetToFinestLevel(budget, leafCount)
    : budget;
  return leafCount > FOVEATION_LEAF_THRESHOLD || leafCount > effectiveBudget;
};

const resolveBudgetLifts = (options: {
  allowFinestLevelLift?: boolean;
  budget?: number;
  maxBudget?: number;
  budgetCap?: number;
}): boolean =>
  options.allowFinestLevelLift === true
    ? options.budgetCap === undefined
    : options.budget === undefined &&
      options.maxBudget === undefined &&
      options.budgetCap === undefined;

describe('allowFinestLevelLift strategy selection', () => {
  it('defaults to legacy lift disabled when budget or maxBudget is pinned', () => {
    expect(resolveBudgetLifts({ budget: 58_000, maxBudget: 3_500_000 })).toBe(false);
    expect(resolveBudgetLifts({ maxBudget: 3_500_000 })).toBe(false);
    expect(resolveBudgetLifts({ budgetCap: 1_000_000 })).toBe(false);
  });

  it('enables lift when allowFinestLevelLift is set unless budgetCap vetoes', () => {
    expect(resolveBudgetLifts({ allowFinestLevelLift: true, budget: 58_000, maxBudget: 3_500_000 })).toBe(
      true,
    );
    expect(
      resolveBudgetLifts({ allowFinestLevelLift: true, budget: 58_000, maxBudget: 3_500_000, budgetCap: 1_000_000 }),
    ).toBe(false);
  });

  it('uses prefix path for leaf counts between host ceiling and 6M when lift is enabled', () => {
    const ceiling = 3_500_000;
    const leafCount = 4_000_000;
    expect(resolveRadFoveate(ceiling, leafCount, false)).toBe(true);
    expect(resolveRadFoveate(ceiling, leafCount, true)).toBe(false);
  });

  it('still foveates captures above the foveation leaf threshold', () => {
    const ceiling = 8_000_000;
    const leafCount = 7_000_000;
    expect(resolveRadFoveate(ceiling, leafCount, true)).toBe(true);
  });

  it('uses prefix path when the capture fits under the host ceiling', () => {
    const ceiling = 3_500_000;
    const leafCount = 2_500_000;
    expect(resolveRadFoveate(ceiling, leafCount, false)).toBe(false);
    expect(resolveRadFoveate(ceiling, leafCount, true)).toBe(false);
  });
});
