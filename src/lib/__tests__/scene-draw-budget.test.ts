import { describe, expect, it, vi } from 'vitest';
import { SceneDrawBudget } from '../streaming/scene-draw-budget';

describe('SceneDrawBudget', () => {
  it.each([4_000_000, 7_000_000])('shares pending admission across sources at %s', (budget) => {
    const scene = new SceneDrawBudget({ budget });
    const a = scene.register({ limit: budget });
    const b = scene.register({ limit: budget });
    const first = a.reserve(budget * 0.6)!;
    expect(first).not.toBeNull();
    expect(b.reserve(budget * 0.5)).toBeNull();
    const second = b.reserve(budget * 0.4)!;
    expect(second.commit()).toBe(true);
    expect(first.commit()).toBe(true);
    expect(scene.activeUsage).toBe(budget);
    expect(scene.target).toBe(budget * 0.85);
  });

  it('releases cancellation, disposal and stale results without losing current usage', () => {
    const scene = new SceneDrawBudget({ budget: 1000 });
    const a = scene.register({ limit: 1000 });
    const pending = a.reserve(900)!;
    pending.cancel();
    expect(scene.reservedUsage).toBe(0);
    expect(pending.commit()).toBe(false);
    const replacement = a.reserve(900)!;
    scene.setBudget(800);
    expect(replacement.valid()).toBe(false);
    replacement.cancel();
    a.reserve(700)!.commit();
    const delayed = a.reserve(800)!;
    a.dispose();
    expect(delayed.valid()).toBe(false);
    expect(scene.activeUsage).toBe(0);
  });

  it('retains old coverage until a complete reduction is published', () => {
    const scene = new SceneDrawBudget({ budget: 1000 });
    const a = scene.register({ count: 700, limit: 1000 });
    const b = scene.register({ count: 300, limit: 1000 });
    const reduction = a.reserve(500)!;
    expect(scene.activeUsage).toBe(1000);
    expect(b.reserve(500)).toBeNull();
    expect(reduction.commit()).toBe(true);
    expect(b.reserve(500)!.commit()).toBe(true);
    expect(scene.activeUsage).toBe(1000);
  });

  it('does not charge hidden stored data, and admits activation with both crossfade sides', () => {
    const scene = new SceneDrawBudget({ budget: 1000 });
    const outgoing = scene.register({ count: 850, limit: 1000 });
    const incoming = scene.register({ visible: false, limit: 1000 });
    incoming.reserve(300)!.commit();
    expect(scene.activeUsage).toBe(850);
    expect(incoming.setVisible(true)).toBe(false);
    outgoing.reserve(700)!.commit();
    expect(incoming.setVisible(true)).toBe(true);
    expect(scene.activeUsage).toBe(1000);
    outgoing.setVisible(false);
    expect(scene.activeUsage).toBe(300);
  });

  it.each([4_000_000, 7_000_000])(
    'grants only shared 105%% with prepared relief and one foreground deadline at %s',
    (budget) => {
      const scene = new SceneDrawBudget({ budget });
      const a = scene.register({ count: budget * 0.49, limit: budget });
      const b = scene.register({ count: budget * 0.49, limit: budget });
      scene.beginFrame(500);
      const reliefA = {
        reduction: budget * 0.04,
        publish: vi.fn(() => budget * 0.49),
        release: vi.fn(),
      };
      const reliefB = {
        reduction: budget * 0.03,
        publish: vi.fn(() => budget * 0.49),
        release: vi.fn(),
      };
      a.reserve(budget * 0.53, reliefA)!.commit();
      scene.beginFrame(250);
      b.reserve(budget * 0.52, reliefB)!.commit();
      expect(scene.activeUsage).toBe(budget * 1.05);
      expect(scene.snapshot().temporaryRemainingMs).toBe(750);
      expect(a.reserve(budget * 0.54, reliefA)).toBeNull();
      scene.beginFrame(0); // background/wake-up gaps do not age the allowance
      expect(scene.snapshot().temporaryRemainingMs).toBe(750);
      scene.beginFrame(750);
      expect(scene.activeUsage).toBe(budget * 0.98);
      expect(reliefA.publish).toHaveBeenCalledOnce();
      expect(reliefB.publish).toHaveBeenCalledOnce();
      expect(a.reserve(budget * 0.53, reliefA)).toBeNull();
      scene.beginFrame(499);
      expect(a.reserve(budget * 0.53, reliefA)).toBeNull();
      scene.beginFrame(1);
      expect(a.reserve(budget * 0.53, reliefA)).not.toBeNull();
    },
  );

  it('requires actual headroom below 100 percent throughout cooldown', () => {
    const scene = new SceneDrawBudget({ budget: 1000 });
    const source = scene.register({ count: 1000, limit: 1100 });
    const relief = { reduction: 100, publish: () => 950, release: () => {} };
    scene.beginFrame(1000);
    expect(source.reserve(1050, relief)).toBeNull();
    source.reserve(950)!.commit();
    scene.beginFrame(499);
    expect(source.reserve(1050, relief)).toBeNull();
    scene.beginFrame(1);
    expect(source.reserve(1050, relief)).not.toBeNull();
  });

  it('never grants temporary headroom without a prepared lower-cost complete cut', () => {
    const scene = new SceneDrawBudget({ budget: 1000 });
    const source = scene.register({ count: 1000, limit: 1100 });
    scene.beginFrame(500);
    expect(source.reserve(1050)).toBeNull();
    expect(
      source.reserve(1050, { reduction: 20, publish: () => 1030, release: () => {} }),
    ).toBeNull();
  });

  it('honors constrained-device and physical limits above temporary scene headroom', () => {
    const scene = new SceneDrawBudget({ budget: 1000, hardLimit: 1000 });
    const source = scene.register({ count: 1000, limit: 1000 });
    scene.beginFrame(500);
    source.setCoverageFloor(1100);
    expect(
      source.reserve(1050, { reduction: 50, publish: () => 1000, release: () => {} }),
    ).toBeNull();
    expect(scene.target).toBe(850);
  });

  it('reports minimum coverage above the activity target and blocks further refinement', () => {
    const scene = new SceneDrawBudget({ budget: 1000 });
    const source = scene.register({ limit: 1000 });
    source.setCoverageFloor(900);
    source.reserve(900)!.commit();
    expect(scene.snapshot().coverageFloorException).toBe(true);
    expect(source.reserve(950)).toBeNull();
    scene.setTargetFactor(0.9);
    expect(scene.snapshot().coverageFloorException).toBe(false);
  });

  it('counts fixed/environment content before streamed detail and reports minimum coverage', () => {
    const scene = new SceneDrawBudget({ budget: 1000 });
    scene.setFixedUsage(200);
    expect(scene.availableTarget).toBe(650);
    const main = scene.register({ limit: 1500 });
    main.setCoverageFloor(900);
    expect(main.reserve(900)!.commit()).toBe(true);
    expect(scene.snapshot().coverageFloorException).toBe(true);
    expect(main.reserve(950)).toBeNull();
    expect(scene.activeUsage).toBe(1100);
    scene.setBudget(800);
    expect(main.count).toBe(900);
  });

  it('shares three milliseconds of staging and rotates the first source', () => {
    const scene = new SceneDrawBudget({ budget: 1000 });
    const a = scene.register({ limit: 1000 });
    const b = scene.register({ limit: 1000 });
    scene.beginFrame();
    expect(a.canStage()).toBe(true);
    a.chargeStaging(3);
    expect(b.canStage()).toBe(false);
    scene.beginFrame();
    // The host visits a first again, but b owns this frame's first batch.
    expect(a.canStage()).toBe(false);
    expect(b.canStage()).toBe(true);
    b.chargeStaging(2);
    expect(a.canStage()).toBe(true);
    a.chargeStaging(1);
    expect(a.canStage()).toBe(false);
    expect(b.canStage()).toBe(false);
  });
});
