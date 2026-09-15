/** Sampling and failure policy for `scripts/rad-detail-benchmark.mjs`. */

export const RAD_DETAIL_SAMPLE_OFFSETS_MS = [
  0, 250, 500, 1000, 2000, 3500, 5000, 7500, 8000, 8500, 9000, 9500, 10000, 15000, 20000, 30000,
  35000, 40000, 45000, 50000, 60000,
];

/** Browser-wide memory is opt-in. The default must not delay screenshot times. */
export function parseMemoryMode(value) {
  const mode = value ?? 'off';
  if (mode !== 'off' && mode !== 'sample') {
    throw new Error('Invalid memory mode. Use --memory=off|sample.');
  }
  return mode;
}

/**
 * Screenshot offsets from camera-stop, always including the requested endpoint.
 * The historic 60 s table is a set of interior points, not a cap.
 */
export function sampleSchedule(sampleMs) {
  if (!Number.isFinite(sampleMs) || sampleMs < 1000 || sampleMs > 120000) {
    throw new Error('Invalid runs or sampleMs.');
  }
  const points = RAD_DETAIL_SAMPLE_OFFSETS_MS.filter((ms) => ms <= sampleMs);
  if (points.at(-1) !== sampleMs) points.push(sampleMs);
  return points;
}

export function classifyBenchmarkFailures({
  pageErrors = [],
  deviceLost = null,
  streamingError = null,
  sawFirstImage = true,
} = {}) {
  const failures = [...pageErrors];
  if (!sawFirstImage) failures.push('no first image');
  if (deviceLost) failures.push(`device lost: ${deviceLost}`);
  if (streamingError) failures.push(`streaming: ${streamingError}`);
  return failures;
}

export function stopToEquivalentMs({ failures, referenceStillPending, firstEquivalent, samples }) {
  if (failures.length > 0 || referenceStillPending || firstEquivalent < 0) return null;
  return samples[firstEquivalent]?.elapsedMs ?? null;
}

/**
 * Warm mode reuses one browser context so HTTP responses can stay hot.
 * Each measured run still opens a new page, so decoded GPU/JS scene state is
 * not retained. The first load of a warm session is an unmeasured prime.
 */
export function warmPrimeRoute(cacheMode, routes) {
  if (cacheMode !== 'warm') return null;
  const route = routes[0];
  if (!route) throw new Error('Warm cache mode requires at least one route.');
  return route;
}

export function cacheSemantics({ cacheMode, role, httpCachePrimed }) {
  const priming = role === 'prime';
  return {
    role,
    cacheMode,
    httpCache: priming
      ? 'cold-prime'
      : cacheMode === 'warm' && httpCachePrimed
        ? 'warm-http'
        : 'cold',
    decodedSceneCache: 'fresh-page',
    httpCachePrimed: priming ? false : Boolean(httpCachePrimed),
  };
}

/** HTTP bytes can land even if the pager is still refining at sampleMs. */
export function httpCacheWasPrimed(failures = []) {
  return (
    !failures.includes('no first image') &&
    !failures.some(
      (failure) => failure === 'page crashed' || String(failure).startsWith('device lost'),
    )
  );
}
