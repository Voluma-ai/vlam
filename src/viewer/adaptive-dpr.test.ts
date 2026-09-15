import { describe, expect, it } from 'vitest';
import {
  ADAPTIVE_DPR_RECOVERY_FRAMES,
  createAdaptiveDprState,
  updateAdaptiveDpr,
} from './adaptive-dpr';

describe('adaptive DPR controller', () => {
  it('recovers from 0.8 at a normal 16.7–16.8 ms cadence only after the dwell', () => {
    let state = createAdaptiveDprState(0.8, 0);
    for (let frame = 1; frame <= ADAPTIVE_DPR_RECOVERY_FRAMES; frame++) {
      const result = updateAdaptiveDpr(state, { frameMs: 16.8, max: 1, min: 0.8 });
      state = result.state;
      expect(result.changed).toBe(frame === ADAPTIVE_DPR_RECOVERY_FRAMES);
    }
    expect(state.pixelRatio).toBe(1);
  });

  it('applies pressure reductions immediately', () => {
    const result = updateAdaptiveDpr(createAdaptiveDprState(1, 0), {
      frameMs: 30,
      max: 1,
      min: 0.8,
    });
    expect(result.changed).toBe(true);
    expect(result.state.pixelRatio).toBe(0.8);
  });

  it('requires consecutive upward requests and resets the dwell on a neutral frame', () => {
    let state = createAdaptiveDprState(0.8, 0);
    for (let frame = 1; frame < ADAPTIVE_DPR_RECOVERY_FRAMES; frame++) {
      state = updateAdaptiveDpr(state, { frameMs: 16.8, max: 1, min: 0.8 }).state;
    }
    state = updateAdaptiveDpr(state, { frameMs: 40, max: 1, min: 0.8 }).state;
    let framesAfterReset = 0;
    let changed = false;
    while (!changed && framesAfterReset < 200) {
      framesAfterReset++;
      const result = updateAdaptiveDpr(state, { frameMs: 16.8, max: 1, min: 0.8 });
      state = result.state;
      changed = result.changed;
    }
    expect(changed).toBe(true);
    expect(framesAfterReset).toBeGreaterThan(ADAPTIVE_DPR_RECOVERY_FRAMES);
  });

  it('starts a fresh scene with a clean recovery state', () => {
    const state = createAdaptiveDprState(1, 5);
    expect(state).toEqual({
      pixelRatio: 1,
      emaMs: undefined,
      warmupRemaining: 5,
      upwardRequests: 0,
    });
  });
});
