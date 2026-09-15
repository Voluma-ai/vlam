import { suggestAdaptivePixelRatio, type AdaptivePixelRatioResult } from '../lib/core';

/** Consecutive healthy frames required before accepting an upward DPR step. */
export const ADAPTIVE_DPR_RECOVERY_FRAMES = 120;

type AdaptiveDprState = {
  pixelRatio: number;
  emaMs: number | undefined;
  warmupRemaining: number;
  upwardRequests: number;
};

/** Creates a reset adaptive-DPR state for a scene or mode change. */
export function createAdaptiveDprState(
  pixelRatio: number,
  warmupRemaining: number,
): AdaptiveDprState {
  return { pixelRatio, emaMs: undefined, warmupRemaining, upwardRequests: 0 };
}

/**
 * Applies one frame to the viewer's adaptive-DPR policy.
 *
 * Downward suggestions take effect immediately. Upward suggestions must be
 * requested on 120 consecutive frames; a pressure or neutral frame clears the
 * recovery dwell.
 */
export function updateAdaptiveDpr(
  state: AdaptiveDprState,
  input: { frameMs: number; max: number; min: number },
): { state: AdaptiveDprState; changed: boolean } {
  const suggestion: AdaptivePixelRatioResult = suggestAdaptivePixelRatio({
    frameMs: input.frameMs,
    current: state.pixelRatio,
    max: input.max,
    min: input.min,
    emaMs: state.emaMs,
    warmupRemaining: state.warmupRemaining,
  });
  const next: AdaptiveDprState = {
    pixelRatio: state.pixelRatio,
    emaMs: suggestion.emaMs,
    warmupRemaining: suggestion.warmupRemaining,
    upwardRequests: 0,
  };
  if (suggestion.pixelRatio < state.pixelRatio) {
    next.pixelRatio = suggestion.pixelRatio;
  } else if (suggestion.pixelRatio > state.pixelRatio) {
    next.upwardRequests = state.upwardRequests + 1;
    if (next.upwardRequests >= ADAPTIVE_DPR_RECOVERY_FRAMES) {
      next.pixelRatio = suggestion.pixelRatio;
      next.upwardRequests = 0;
    }
  }
  return { state: next, changed: next.pixelRatio !== state.pixelRatio };
}
