import { describe, expect, it } from 'vitest';
import { memoryBenchmarkSettings } from '../memory-benchmark-settings';

describe('memory benchmark measurement policy', () => {
  it.each(['', '&uaMemory=0', '&uaMemory=1'])(
    'disables slow memory probes during startup with query suffix %s',
    (suffix) => {
      expect(memoryBenchmarkSettings(new URLSearchParams(`startupMetrics=1${suffix}`))).toEqual({
        startupMetrics: true,
        userAgentMemoryEnabled: false,
      });
    },
  );

  it('retains browser memory measurements for ordinary memory runs', () => {
    expect(memoryBenchmarkSettings(new URLSearchParams())).toEqual({
      startupMetrics: false,
      userAgentMemoryEnabled: true,
    });
  });

  it('honors the ordinary memory-run opt-out', () => {
    expect(memoryBenchmarkSettings(new URLSearchParams('uaMemory=0'))).toEqual({
      startupMetrics: false,
      userAgentMemoryEnabled: false,
    });
  });
});
