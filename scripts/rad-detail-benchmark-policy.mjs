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
