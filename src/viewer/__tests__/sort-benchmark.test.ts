import { describe, expect, it } from 'vitest';
import type { StreamedSplatPerformanceEvent } from '../../lib';
import { createFrameBenchmark } from '../sort-benchmark';

const swapEvent = (overrides: Partial<StreamedSplatPerformanceEvent> = {}) => ({
  timestamp: 10,
  cpuMs: 4,
  activeListMs: 0,
  uploadMs: 0,
  sortSubmitMs: 0,
  stagingTextureAllocations: 0,
  activeListUpdateRanges: 0,
  appendedCount: 80,
  removedCount: 20,
  stagedCount: 0,
  uploadCount: 80,
  activeCount: 1_000,
  forcedSort: true,
  compacted: false,
  ...overrides,
});

describe('createFrameBenchmark swap attribution', () => {
  it('attributes a mutation to the following frame interval', () => {
    const benchmark = createFrameBenchmark(0, 0.1);
    expect(benchmark.record(0)).toBeNull();
    expect(benchmark.record(10, [swapEvent()])).toBeNull();
    expect(benchmark.record(60)).toBeNull();
    const result = benchmark.record(100);

    expect(result).toMatchObject({
      sampleCount: 3,
      minimumFps: 20,
      onePercentLowFps: 20,
      swapTickCount: 1,
      swapFrameCount: 1,
      swapMeanFrameMs: 50,
      swapWorstFrameMs: 50,
      nonSwapMeanFrameMs: 25,
      swapCpuMeanMs: 4,
      swapUploadTotal: 80,
      swapMaxSize: 100,
      forcedSortTickCount: 1,
      compactionTickCount: 0,
    });
    expect(result?.averageFps).toBeCloseTo(30);
    expect(result?.slowFrames).toEqual([
      expect.objectContaining({
        frameMs: 50,
        markerCount: 1,
        cpuMs: 4,
        uploadCount: 80,
        forcedSort: true,
      }),
      expect.objectContaining({ frameMs: 40, markerCount: 0 }),
      expect.objectContaining({ frameMs: 10, markerCount: 0 }),
    ]);
  });

  it('excludes warm-up mutations from attribution', () => {
    const benchmark = createFrameBenchmark(0.05, 0.05);
    benchmark.record(0, [swapEvent()]);
    benchmark.record(40, [swapEvent()]);
    benchmark.record(50);
    benchmark.record(100);

    expect(benchmark.record(110)).toMatchObject({
      swapTickCount: 0,
      swapFrameCount: 0,
    });
  });
});
