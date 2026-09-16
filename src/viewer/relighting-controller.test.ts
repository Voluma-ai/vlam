import { describe, expect, it } from 'vitest';
import { RELIGHTING_PRESSURE_DWELL_MS, RelightingController } from './relighting-controller';

describe('relighting tier controller', () => {
  it('keeps unconstrained defaults high with per-frame updates', () => {
    const controller = new RelightingController({ constrainedDevice: false });
    expect(controller.tier).toBe('high');
    expect(controller.settings.shadowMapSizes).toEqual([2048, 2048, 4096, 2048]);
  });
  it('falls to performance after sustained pressure', () => {
    const controller = new RelightingController({ constrainedDevice: true });
    let transition;
    for (let now = 0; now <= RELIGHTING_PRESSURE_DWELL_MS + 100; now += 100) {
      transition ??= controller.observe(33.4, now);
    }
    expect(transition).toMatchObject({
      oldTier: 'balanced',
      newTier: 'performance',
      reason: 'pressure',
    });
    expect(controller.settings.shadowMapSizes).toEqual([1024, 1024, 2048, 1024]);
  });

  it('also protects an unconstrained device when a dense LOD misses frame rate', () => {
    const controller = new RelightingController({ constrainedDevice: false });
    let transition;
    for (let now = 0; now <= RELIGHTING_PRESSURE_DWELL_MS + 100; now += 100) {
      transition ??= controller.observe(50, now);
    }
    expect(transition).toMatchObject({
      oldTier: 'high',
      newTier: 'performance',
      reason: 'pressure',
    });
  });

  it('recognizes a 30 Hz deadline pattern with interleaved fast callbacks', () => {
    const controller = new RelightingController({ constrainedDevice: true });
    let transition;
    for (let now = 0; now <= 3_000 && transition === undefined; now += 50) {
      transition = controller.observe(now % 100 === 0 ? 33.4 : 16.7, now);
    }
    expect(transition).toMatchObject({
      oldTier: 'balanced',
      newTier: 'performance',
      reason: 'pressure',
    });
  });

  it('keeps the screen-space factor map at full resolution under pressure', () => {
    const controller = new RelightingController({ constrainedDevice: true });
    for (let now = 0; now <= RELIGHTING_PRESSURE_DWELL_MS + 100; now += 100) {
      controller.observe(33.4, now);
    }
    expect(controller.settings.factorMapScale).toBe(1);
  });

  it('keeps the selected performance tier after frame rate recovers', () => {
    const controller = new RelightingController({ constrainedDevice: true });
    for (let now = 0; now <= RELIGHTING_PRESSURE_DWELL_MS + 100; now += 100) {
      controller.observe(33.4, now);
    }
    for (let now = 1_200; now < 30_000; now += 100) controller.observe(16.7, now);
    expect(controller.tier).toBe('performance');
  });

  it('does not adapt a pinned tier', () => {
    const controller = new RelightingController({
      constrainedDevice: true,
      pinnedTier: 'high',
    });
    for (let now = 0; now < 5_000; now += 100) controller.observe(33.4, now);
    expect(controller.tier).toBe('high');
  });
});
