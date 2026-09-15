import { describe, expect, it } from 'vitest';
import {
  ADAPTIVE_DPR_DOWNWARD_COOLDOWN_MS,
  ADAPTIVE_DPR_FAILED_PROBE_DELAY_MS,
  ADAPTIVE_DPR_MAX_FAILED_PROBE_DELAY_MS,
  ADAPTIVE_DPR_PROBATION_MS,
  createAdaptiveDprState,
  scopeAdaptiveDprTransitions,
  updateAdaptiveDpr,
} from './adaptive-dpr';

type State = ReturnType<typeof createAdaptiveDprState>;

function update(state: State, nowMs: number, frameMs: number, max = 1, active = true) {
  return updateAdaptiveDpr(state, { frameMs, max, min: 0.8, nowMs, active });
}

function recover(state: State, max = 1): State {
  for (let frame = 1; frame <= 240; frame++) {
    const result = update(state, frame * 16.7, 16.8, max);
    state = result.state;
    if (result.changed) return state;
  }
  return state;
}

describe('adaptive DPR controller', () => {
  it('does not lower DPR for the first post-warm-up hitch', () => {
    const first = update(createAdaptiveDprState(1, 0), 0, 30);
    expect(first.changed).toBe(false);
    expect(first.state.emaMs).toBeCloseTo(19.8);
    const second = update(first.state, 16.7, 30);
    expect(second.changed).toBe(false);
    const sustained = update(second.state, 33.4, 30);
    expect(sustained.changed).toBe(true);
    expect(sustained.transition?.reason).toBe('pressure');
  });

  it('applies sustained pressure reductions immediately', () => {
    let state = createAdaptiveDprState(1, 0);
    state = update(state, 0, 40).state;
    const result = update(state, 16.7, 40);
    expect(result.changed).toBe(true);
    expect(result.state.pixelRatio).toBe(0.8);
    expect(result.state.cooldownRemainingMs).toBe(ADAPTIVE_DPR_DOWNWARD_COOLDOWN_MS);
  });

  it('requires two seconds of active healthy time for recovery', () => {
    const state = recover(createAdaptiveDprState(0.8, 0));
    expect(state.pixelRatio).toBe(1);
    expect(state.probationRemainingMs).toBe(ADAPTIVE_DPR_PROBATION_MS);
  });

  it('decays healthy time through neutral jitter instead of resetting it', () => {
    const state: State = {
      ...createAdaptiveDprState(0.8, 0),
      emaMs: 17.5,
      healthyRecoveryMs: 1_000,
      lastActiveAtMs: 0,
    };
    const result = update(state, 16.7, 20);
    expect(result.state.healthyRecoveryMs).toBeCloseTo(983.3);
    expect(result.state.pixelRatio).toBe(0.8);
  });

  it('clears healthy time under pressure', () => {
    const state: State = {
      ...createAdaptiveDprState(0.8, 0),
      emaMs: 22,
      healthyRecoveryMs: 1_000,
      lastActiveAtMs: 0,
    };
    const result = update(state, 16.7, 40);
    expect(result.state.healthyRecoveryMs).toBe(0);
  });

  it('does not advance probation or cooldown while inactive', () => {
    const state: State = {
      ...createAdaptiveDprState(0.8, 0),
      emaMs: 16.8,
      probationRemainingMs: 5_000,
      cooldownRemainingMs: 10_000,
      healthyRecoveryMs: 500,
      lastActiveAtMs: 0,
    };
    const hidden = update(state, 100_000, 16.8, 1, false);
    expect(hidden.state).toBe(state);
    const resumed = update(hidden.state, 100_000, 16.8);
    expect(resumed.state.probationRemainingMs).toBe(5_000);
    expect(resumed.state.cooldownRemainingMs).toBe(10_000);
    expect(resumed.state.healthyRecoveryMs).toBe(0);
  });

  it('resets failed-probe backoff after a successful probation', () => {
    const state: State = {
      ...createAdaptiveDprState(1, 0),
      emaMs: 16.8,
      probationRemainingMs: 16.7,
      failedProbeDelayMs: 120_000,
      lastActiveAtMs: 0,
    };
    const result = update(state, 16.7, 16.8);
    expect(result.state.probationRemainingMs).toBe(0);
    expect(result.state.failedProbeDelayMs).toBe(ADAPTIVE_DPR_FAILED_PROBE_DELAY_MS);
  });

  it('backs off failed probes exponentially and caps the delay', () => {
    const state: State = {
      ...createAdaptiveDprState(1, 0),
      emaMs: 22,
      probationRemainingMs: 5_000,
      failedProbeDelayMs: 120_000,
      lastActiveAtMs: 0,
    };
    const result = update(state, 16.7, 40);
    expect(result.transition?.reason).toBe('failed-probe');
    expect(result.state.cooldownRemainingMs).toBe(120_000);
    expect(result.state.failedProbeDelayMs).toBe(240_000);
    let delay = result.state.failedProbeDelayMs;
    while (delay < ADAPTIVE_DPR_MAX_FAILED_PROBE_DELAY_MS) delay = Math.min(delay * 2, 300_000);
    expect(delay).toBe(ADAPTIVE_DPR_MAX_FAILED_PROBE_DELAY_MS);
  });

  it('resets every controller field for a fresh scene or mode', () => {
    const state = createAdaptiveDprState(1, 5);
    expect(state).toEqual({
      pixelRatio: 1,
      emaMs: undefined,
      warmupRemaining: 5,
      healthyRecoveryMs: 0,
      probationRemainingMs: 0,
      cooldownRemainingMs: 0,
      failedProbeDelayMs: ADAPTIVE_DPR_FAILED_PROBE_DELAY_MS,
      lastActiveAtMs: undefined,
    });
  });
});

describe('adaptive DPR benchmark transition scope', () => {
  const transitions = [
    { atMs: 90, oldPixelRatio: 1, newPixelRatio: 0.8, reason: 'pressure' as const },
    { atMs: 110, oldPixelRatio: 0.8, newPixelRatio: 1, reason: 'recovery-probe' as const },
    { atMs: 150, oldPixelRatio: 1, newPixelRatio: 0.8, reason: 'failed-probe' as const },
  ];

  it('returns measurement-relative transitions only', () => {
    expect(scopeAdaptiveDprTransitions(transitions, 1, 100, 120, true)).toEqual([
      { elapsedMs: 10, oldPixelRatio: 0.8, newPixelRatio: 1, reason: 'recovery-probe' },
    ]);
  });

  it('returns no transitions when adaptive DPR is disabled or pinned', () => {
    expect(scopeAdaptiveDprTransitions(transitions, 0, 0, 200, false)).toEqual([]);
  });
});
