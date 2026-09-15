/** Where the physical display cadence used for normalization came from. */
export type RefreshSource = 'provided' | 'screen' | 'unavailable';

/** Optional cadence hints, in precedence order. */
export interface RefreshTimingHints {
  /** Explicit `?refreshHz=` or another host-provided refresh rate. */
  refreshHz?: number;
  /** `screen.refreshRate`, when the browser exposes a valid value. */
  screenRefreshRate?: number;
}

/** Refresh-normalized frame timing shared by the HUD and benchmark reports. */
export interface RefreshNormalizedMetrics {
  /** P10 animation-callback cadence, independent of physical display refresh. */
  observedCallbackCadenceMs: number | null;
  /** Physical display cadence, or `null` when no trustworthy rate is known. */
  displayRefreshMs: number | null;
  /** Missed refresh opportunities, or `null` when refresh is unavailable. */
  missedRefreshOpportunities: number | null;
  /** Source used to determine the cadence. */
  refreshSource: RefreshSource;
}

/** Estimates refresh cadence without mistaking a throttled callback for a display. */
export function estimateRefreshMetrics(
  frames: readonly number[],
  hints: RefreshTimingHints = {},
): RefreshNormalizedMetrics {
  const observedCallbackCadenceMs = observedCadence(frames);
  const refreshHz = validRefreshHz(hints.refreshHz);
  if (refreshHz !== null)
    return normalized(refreshHz, frames, 'provided', observedCallbackCadenceMs);

  const screenRefreshHz = validRefreshHz(hints.screenRefreshRate);
  if (screenRefreshHz !== null)
    return normalized(screenRefreshHz, frames, 'screen', observedCallbackCadenceMs);

  return unavailable(observedCallbackCadenceMs);
}

function validRefreshHz(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 30 && value <= 240
    ? value
    : null;
}

function observedCadence(frames: readonly number[]): number | null {
  const sorted = frames
    .filter((frameMs) => Number.isFinite(frameMs) && frameMs > 0)
    .sort((a, b) => a - b);
  return sorted.length === 0
    ? null
    : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.1))] as number);
}

function normalized(
  refreshHz: number,
  frames: readonly number[],
  refreshSource: Exclude<RefreshSource, 'unavailable'>,
  observedCallbackCadenceMs: number | null,
): RefreshNormalizedMetrics {
  const displayRefreshMs = 1000 / refreshHz;
  const missedRefreshOpportunities = frames
    .filter((frameMs) => Number.isFinite(frameMs) && frameMs > 0)
    .reduce((total, frameMs) => total + Math.max(0, Math.round(frameMs / displayRefreshMs) - 1), 0);
  return {
    observedCallbackCadenceMs,
    displayRefreshMs,
    missedRefreshOpportunities,
    refreshSource,
  };
}

function unavailable(observedCallbackCadenceMs: number | null): RefreshNormalizedMetrics {
  return {
    observedCallbackCadenceMs,
    displayRefreshMs: null,
    missedRefreshOpportunities: null,
    refreshSource: 'unavailable',
  };
}
