import { suggestAdaptivePixelRatio, type AdaptivePixelRatioResult } from '../lib/core';

/** Consecutive healthy active time required before accepting an upward DPR step. */
export const ADAPTIVE_DPR_RECOVERY_DWELL_MS = 2_000;
/** Active-time probation after an upward step. */
export const ADAPTIVE_DPR_PROBATION_MS = 5_000;
/** Active-time cooldown after an ordinary downward step. */
export const ADAPTIVE_DPR_DOWNWARD_COOLDOWN_MS = 10_000;
/** Initial active-time delay after a recovery probe fails under pressure. */
export const ADAPTIVE_DPR_FAILED_PROBE_DELAY_MS = 30_000;
/** Maximum failed-probe active-time delay. */
export const ADAPTIVE_DPR_MAX_FAILED_PROBE_DELAY_MS = 5 * 60_000;

export type AdaptiveDprTransitionReason =
  'scene-reset' | 'pressure' | 'recovery-probe' | 'failed-probe';

/** Internal transition record; benchmark JSON converts `atMs` to elapsed time. */
export interface AdaptiveDprTransition {
  atMs: number;
  oldPixelRatio: number;
  newPixelRatio: number;
  reason: AdaptiveDprTransitionReason;
}

/** Controller state whose timers advance only while rendering is active. */
export interface AdaptiveDprState {
  pixelRatio: number;
  emaMs: number | undefined;
  warmupRemaining: number;
  healthyRecoveryMs: number;
  probationRemainingMs: number;
  cooldownRemainingMs: number;
  failedProbeDelayMs: number;
  lastActiveAtMs: number | undefined;
}

/** Creates a reset adaptive-DPR state for a scene or mode change. */
export function createAdaptiveDprState(
  pixelRatio: number,
  warmupRemaining: number,
): AdaptiveDprState {
  return {
    pixelRatio,
    emaMs: undefined,
    warmupRemaining,
    healthyRecoveryMs: 0,
    probationRemainingMs: 0,
    cooldownRemainingMs: 0,
    failedProbeDelayMs: ADAPTIVE_DPR_FAILED_PROBE_DELAY_MS,
    lastActiveAtMs: undefined,
  };
}

/**
 * Applies one visible, mounted frame to the adaptive-DPR policy.
 *
 * Downward suggestions take effect immediately. Upward suggestions require
 * two seconds of active healthy time, then enter a five-second active-time
 * probation. A failed probe backs off exponentially; inactive frames do not
 * advance the EMA, warm-up, dwell, probation, or cooldown state.
 */
export function updateAdaptiveDpr(
  state: AdaptiveDprState,
  input: { frameMs: number; max: number; min: number; nowMs: number; active?: boolean },
): { state: AdaptiveDprState; changed: boolean; transition?: AdaptiveDprTransition } {
  if (input.active === false) return { state, changed: false };

  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  const activeGap =
    state.lastActiveAtMs === undefined ? 0 : Math.max(0, nowMs - state.lastActiveAtMs);
  // Background/XR/initial-reveal gaps are not active rendering time. A large
  // foreground scheduling gap also must not turn one callback into a long
  // recovery/probation advance.
  const timerMs = activeGap > 250 ? 0 : Math.min(activeGap, 100);
  const suggestion: AdaptivePixelRatioResult = suggestAdaptivePixelRatio({
    frameMs: input.frameMs,
    current: state.pixelRatio,
    max: input.max,
    min: input.min,
    emaMs: state.emaMs,
    warmupRemaining: state.warmupRemaining,
  });
  const probationWasActive = state.probationRemainingMs > 0;
  const next: AdaptiveDprState = {
    ...state,
    emaMs: suggestion.emaMs,
    warmupRemaining: suggestion.warmupRemaining,
    healthyRecoveryMs: activeGap > 250 ? 0 : state.healthyRecoveryMs,
    probationRemainingMs: Math.max(0, state.probationRemainingMs - timerMs),
    cooldownRemainingMs: Math.max(0, state.cooldownRemainingMs - timerMs),
    lastActiveAtMs: nowMs,
  };

  if (suggestion.pixelRatio < state.pixelRatio) {
    const failedProbe = probationWasActive;
    next.pixelRatio = suggestion.pixelRatio;
    next.healthyRecoveryMs = 0;
    next.probationRemainingMs = 0;
    next.cooldownRemainingMs = failedProbe
      ? state.failedProbeDelayMs
      : ADAPTIVE_DPR_DOWNWARD_COOLDOWN_MS;
    if (failedProbe) {
      next.failedProbeDelayMs = Math.min(
        ADAPTIVE_DPR_MAX_FAILED_PROBE_DELAY_MS,
        state.failedProbeDelayMs * 2,
      );
    }
    return {
      state: next,
      changed: true,
      transition: {
        atMs: nowMs,
        oldPixelRatio: state.pixelRatio,
        newPixelRatio: next.pixelRatio,
        reason: failedProbe ? 'failed-probe' : 'pressure',
      },
    };
  }

  if (next.probationRemainingMs > 0) {
    next.healthyRecoveryMs = 0;
    return { state: next, changed: false };
  }
  if (probationWasActive) {
    // A probation that reached zero without pressure completed successfully.
    next.failedProbeDelayMs = ADAPTIVE_DPR_FAILED_PROBE_DELAY_MS;
    next.healthyRecoveryMs = 0;
  }

  const emaMs = suggestion.emaMs;
  if (emaMs === undefined || next.cooldownRemainingMs > 0) {
    next.healthyRecoveryMs = 0;
    return { state: next, changed: false };
  }

  const recoveryThresholdMs = 18 * 0.95;
  if (emaMs > 22) {
    next.healthyRecoveryMs = 0;
  } else if (emaMs < recoveryThresholdMs) {
    next.healthyRecoveryMs = Math.min(
      ADAPTIVE_DPR_RECOVERY_DWELL_MS,
      next.healthyRecoveryMs + timerMs,
    );
  } else {
    // Normal frame jitter is neutral: let it consume health time instead of
    // forcing a fresh two-second dwell from zero.
    next.healthyRecoveryMs = Math.max(0, next.healthyRecoveryMs - timerMs);
  }

  if (
    suggestion.pixelRatio > state.pixelRatio &&
    next.healthyRecoveryMs >= ADAPTIVE_DPR_RECOVERY_DWELL_MS
  ) {
    next.pixelRatio = suggestion.pixelRatio;
    next.healthyRecoveryMs = 0;
    next.probationRemainingMs = ADAPTIVE_DPR_PROBATION_MS;
    return {
      state: next,
      changed: true,
      transition: {
        atMs: nowMs,
        oldPixelRatio: state.pixelRatio,
        newPixelRatio: next.pixelRatio,
        reason: 'recovery-probe',
      },
    };
  }

  return { state: next, changed: false };
}

/**
 * Keeps only transitions belonging to one adaptive benchmark and makes their
 * timestamps relative to that benchmark's start.
 */
export function scopeAdaptiveDprTransitions(
  transitions: readonly AdaptiveDprTransition[],
  startIndex: number,
  startAtMs: number,
  endAtMs: number,
  enabled: boolean,
): Array<Omit<AdaptiveDprTransition, 'atMs'> & { elapsedMs: number }> {
  if (!enabled) return [];
  return transitions.slice(Math.max(0, startIndex)).flatMap(({ atMs, ...transition }) => {
    if (atMs < startAtMs || atMs > endAtMs) return [];
    return [{ ...transition, elapsedMs: Math.max(0, atMs - startAtMs) }];
  });
}
