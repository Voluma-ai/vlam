/** Resolve measurement policy once so reports describe the probes actually run. */
export function memoryBenchmarkSettings(params: URLSearchParams): {
  startupMetrics: boolean;
  userAgentMemoryEnabled: boolean;
} {
  const startupMetrics = params.get('startupMetrics') === '1';
  return {
    startupMetrics,
    // Browser-wide measurement may wait seconds for GC. An explicit uaMemory=1
    // must not insert that pause into a startup timing run.
    userAgentMemoryEnabled: !startupMetrics && params.get('uaMemory') !== '0',
  };
}
