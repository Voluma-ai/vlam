import { describe, expect, it } from 'vitest';
import type { SplatData } from '../../lib/core';
import { createSeparationState } from '../separation-state';

/**
 * The separation demo's restore-point / parts-lifetime rules. These encode the
 * distinction that a naive "did the tool cause this swap?" flag got wrong: an
 * effect rebuild re-mounts the scene from the host's `splatData`, which after a
 * separation is the *outside* half - adopting it as the restore point loses the
 * full cloud, and discarding the parts loses the separated region outright.
 */

/** A distinguishable stand-in; only identity matters to the state machine. */
function fakeData(count: number): SplatData {
  return {
    count,
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4),
    covariances: new Float32Array(count * 6),
  };
}

describe('createSeparationState', () => {
  it('adopts the first scene as the restore point', () => {
    const state = createSeparationState();
    const full = fakeData(100);
    expect(state.onScene(full, 'external')).toBe(true);
    expect(state.restorePoint).toBe(full);
    expect(state.currentData).toBe(full);
    expect(state.usable).toBe(true);
  });

  it('keeps the restore point and the parts across the tools own swap', () => {
    const state = createSeparationState();
    const full = fakeData(100);
    const outside = fakeData(90);
    state.onScene(full, 'external');
    state.onSeparated(outside);
    // The separate swap re-mounts the outside half through the normal path.
    expect(state.onScene(outside, 'self')).toBe(false);
    expect(state.restorePoint).toBe(full);
    expect(state.currentData).toBe(outside);
  });

  it('keeps the full cloud restorable across an effect rebuild after separating', () => {
    // The regression: an effect switch re-mounts from the host's splatData,
    // which is the outside half by then.
    const state = createSeparationState();
    const full = fakeData(100);
    const outside = fakeData(90);
    state.onScene(full, 'external');
    state.onSeparated(outside);
    state.onScene(outside, 'self');
    // An effect rebuild is a re-mount of the same scene, not a new one.
    expect(state.onScene(outside, 'self')).toBe(false);
    expect(state.restorePoint).toBe(full);
  });

  it('re-baselines on a genuinely new scene', () => {
    const state = createSeparationState();
    const full = fakeData(100);
    const dropped = fakeData(7);
    state.onScene(full, 'external');
    state.onSeparated(fakeData(90));
    expect(state.onScene(dropped, 'external')).toBe(true);
    expect(state.restorePoint).toBe(dropped);
    expect(state.currentData).toBe(dropped);
  });

  it('restores back to the full cloud and re-baselines there', () => {
    const state = createSeparationState();
    const full = fakeData(100);
    state.onScene(full, 'external');
    state.onSeparated(fakeData(90));
    state.onRestored(full);
    expect(state.restorePoint).toBe(full);
    expect(state.currentData).toBe(full);
  });

  it('marks a streamed scene unusable and forgets the previous restore point', () => {
    const state = createSeparationState();
    state.onScene(fakeData(100), 'external');
    expect(state.onScene(null, 'external')).toBe(true);
    expect(state.usable).toBe(false);
    expect(state.restorePoint).toBeNull();
    // A later static scene must baseline on itself, not on the pre-stream data.
    const next = fakeData(5);
    state.onScene(next, 'external');
    expect(state.restorePoint).toBe(next);
  });

  it('captures a restore point when the first mount arrives as a self swap', () => {
    const state = createSeparationState();
    const full = fakeData(100);
    expect(state.onScene(full, 'self')).toBe(false);
    expect(state.restorePoint).toBe(full);
  });
});
