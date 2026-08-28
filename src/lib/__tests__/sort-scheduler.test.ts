import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  WebGpuSortScheduler,
  automaticSortIntervalMs,
  validateSortIntervalMs,
} from '../core/sort-scheduler';

function pose(x: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(x, 0, 0);
}

describe('WebGpuSortScheduler', () => {
  it('reports accepted-sort diagnostics without counting rejected requests', () => {
    const scheduler = new WebGpuSortScheduler();
    expect(scheduler.snapshot()).toEqual({ acceptedCount: 0, lastAcceptedAt: -Infinity });
    scheduler.markAccepted(12.5);
    scheduler.markAccepted(29);
    expect(scheduler.snapshot()).toEqual({ acceptedCount: 2, lastAcceptedAt: 29 });
  });

  it('uses the active-count tier boundaries', () => {
    expect(automaticSortIntervalMs(1_999_999)).toBe(0);
    expect(automaticSortIntervalMs(2_000_000)).toBe(50);
    expect(automaticSortIntervalMs(4_999_999)).toBe(50);
    expect(automaticSortIntervalMs(5_000_000)).toBe(100);
    expect(automaticSortIntervalMs(7_999_999)).toBe(100);
    expect(automaticSortIntervalMs(8_000_000)).toBeCloseTo(166.6667, 3);
  });

  it('keeps a cadence floor on mobile, where no sort is free', () => {
    expect(automaticSortIntervalMs(1_999_999, true)).toBe(33);
    expect(automaticSortIntervalMs(2_000_000, true)).toBe(66);
    expect(automaticSortIntervalMs(4_999_999, true)).toBe(66);
    expect(automaticSortIntervalMs(5_000_000, true)).toBe(133);
    expect(automaticSortIntervalMs(7_999_999, true)).toBe(133);
    expect(automaticSortIntervalMs(8_000_000, true)).toBeCloseTo(166.6667, 3);
  });

  it('throttles a small moving mobile scene that desktop would sort every frame', () => {
    const scheduler = new WebGpuSortScheduler(undefined, true);
    const accepted = pose(0);
    expect(scheduler.shouldSubmit(pose(1), accepted, 1_000_000, 0)).toBe(true);
    scheduler.markAccepted(0);
    accepted.copy(pose(1));

    // Desktop returns 0 here (every changed frame); mobile holds for 33 ms.
    expect(scheduler.shouldSubmit(pose(2), accepted, 1_000_000, 16)).toBe(false);
    expect(scheduler.shouldSubmit(pose(3), accepted, 1_000_000, 33)).toBe(true);
  });

  it('still sorts a settled mobile camera immediately, despite the floor', () => {
    const scheduler = new WebGpuSortScheduler(undefined, true);
    const accepted = pose(0);
    expect(scheduler.shouldSubmit(pose(1), accepted, 1_000_000, 0)).toBe(true);
    scheduler.markAccepted(0);
    accepted.copy(pose(1));

    // Moving: throttled. Then the pose stops changing - the settle bypasses
    // the floor, so a stationary view is never left in a stale order.
    const finalPose = pose(2);
    expect(scheduler.shouldSubmit(finalPose, accepted, 1_000_000, 1)).toBe(false);
    expect(scheduler.shouldSubmit(finalPose, accepted, 1_000_000, 2)).toBe(true);
  });

  it('validates fixed interval overrides', () => {
    expect(validateSortIntervalMs(undefined)).toBeUndefined();
    expect(validateSortIntervalMs(0)).toBe(0);
    expect(validateSortIntervalMs(25)).toBe(25);
    for (const invalid of [-1, Number.NaN, Infinity, -Infinity]) {
      expect(() => validateSortIntervalMs(invalid)).toThrow(RangeError);
    }
  });

  it('throttles continuous movement and allows the interval boundary', () => {
    const scheduler = new WebGpuSortScheduler();
    const accepted = pose(0);
    expect(scheduler.shouldSubmit(pose(1), accepted, 5_000_000, 0)).toBe(true);
    scheduler.markAccepted(0);
    accepted.copy(pose(1));

    expect(scheduler.shouldSubmit(pose(2), accepted, 5_000_000, 99)).toBe(false);
    expect(scheduler.shouldSubmit(pose(3), accepted, 5_000_000, 100)).toBe(true);
  });

  it('submits the final stationary pose immediately after meaningful motion', () => {
    const scheduler = new WebGpuSortScheduler(1000);
    const accepted = pose(0);
    expect(scheduler.shouldSubmit(pose(1), accepted, 10_000_000, 0)).toBe(true);
    scheduler.markAccepted(0);
    accepted.copy(pose(1));

    const finalPose = pose(2);
    expect(scheduler.shouldSubmit(finalPose, accepted, 10_000_000, 10)).toBe(false);
    expect(scheduler.shouldSubmit(finalPose, accepted, 10_000_000, 11)).toBe(true);
  });

  it('does not final-sort matrix noise within the settling epsilon', () => {
    const scheduler = new WebGpuSortScheduler(1000);
    const accepted = pose(0);
    expect(scheduler.shouldSubmit(pose(1), accepted, 10_000_000, 0)).toBe(true);
    scheduler.markAccepted(0);
    accepted.copy(pose(1));

    const noise = pose(1 + 5e-7);
    expect(scheduler.shouldSubmit(noise, accepted, 10_000_000, 1)).toBe(false);
  });

  it('keeps invalidation pending until a request is accepted', () => {
    const scheduler = new WebGpuSortScheduler(1000);
    const accepted = pose(0);
    expect(scheduler.shouldSubmit(pose(1), accepted, 10_000_000, 0)).toBe(true);
    scheduler.markAccepted(0);
    accepted.copy(pose(1));

    scheduler.invalidate();
    expect(scheduler.shouldSubmit(pose(1), accepted, 10_000_000, 1)).toBe(true);
    // Simulate sorter rejection by intentionally not calling markAccepted().
    expect(scheduler.shouldSubmit(pose(1), accepted, 10_000_000, 2)).toBe(true);
    scheduler.markAccepted(2);
    expect(scheduler.shouldSubmit(pose(1), accepted, 10_000_000, 3)).toBe(false);
  });

  it('forces a content change immediately, regardless of its size', () => {
    const scheduler = new WebGpuSortScheduler(100);
    const accepted = pose(0);
    expect(scheduler.shouldSubmit(accepted, accepted, 1_000, 0)).toBe(true);
    scheduler.markAccepted(0);

    scheduler.invalidateContent();
    expect(scheduler.shouldSubmit(accepted, accepted, 1_000, 10)).toBe(true);
  });

  it('honors zero and fixed overrides independently of active count', () => {
    const everyFrame = new WebGpuSortScheduler(0);
    const fixed = new WebGpuSortScheduler(25);
    const acceptedEveryFrame = pose(0);
    const acceptedFixed = pose(0);

    expect(everyFrame.shouldSubmit(pose(1), acceptedEveryFrame, 20_000_000, 0)).toBe(true);
    everyFrame.markAccepted(0);
    acceptedEveryFrame.copy(pose(1));
    expect(everyFrame.shouldSubmit(pose(2), acceptedEveryFrame, 20_000_000, 1)).toBe(true);

    expect(fixed.shouldSubmit(pose(1), acceptedFixed, 1, 0)).toBe(true);
    fixed.markAccepted(0);
    acceptedFixed.copy(pose(1));
    expect(fixed.shouldSubmit(pose(2), acceptedFixed, 1, 24)).toBe(false);
    expect(fixed.shouldSubmit(pose(3), acceptedFixed, 1, 25)).toBe(true);
  });
});
