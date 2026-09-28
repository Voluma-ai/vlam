import { describe, expect, it } from 'vitest';
import type { StreamedSplatPerformanceEvent } from '../../lib/streaming';
import { createFrameBenchmark, isSwapPerformanceEvent, verifyUnifiedGpuSort } from '../sort-benchmark';
import type * as THREE from 'three/webgpu';
import type { UnifiedSplatMesh } from '../../lib/unified';

const swapEvent = (overrides: Partial<StreamedSplatPerformanceEvent> = {}) => ({
  timestamp: 10,
  cpuMs: 4,
  activeListMs: 0,
  uploadMs: 0,
  sortSubmitMs: 0,
  stagingTextureAllocations: 0,
  textureCopyCount: 0,
  textureCopyBytes: 0,
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
  it('excludes ordinary event-bearing frames from swap statistics', () => {
    const idle = swapEvent({
      appendedCount: 0,
      removedCount: 0,
      uploadCount: 0,
      forcedSort: false,
      uploadMs: 0.2,
      sortSubmitMs: 0.3,
    });
    expect(isSwapPerformanceEvent(idle)).toBe(false);
    const benchmark = createFrameBenchmark(0, 0.06);
    benchmark.record(0, [idle]);
    benchmark.record(10, [idle]);
    benchmark.record(30, [idle]);
    const result = benchmark.record(60, [idle]);
    expect(result).toMatchObject({
      sampleCount: 3,
      swapTickCount: 0,
      swapFrameCount: 0,
      swapMeanFrameMs: 0,
      nonSwapMeanFrameMs: 20,
    });
    expect(result?.slowFrames).toEqual([
      expect.objectContaining({ frameMs: 30, eventCount: 0 }),
      expect.objectContaining({ frameMs: 20, eventCount: 0 }),
      expect.objectContaining({ frameMs: 10, eventCount: 0 }),
    ]);
  });

  it('counts upload-only and mutation frames but not idle frames', () => {
    const idle = swapEvent({
      appendedCount: 0,
      removedCount: 0,
      uploadCount: 0,
      forcedSort: false,
    });
    const uploadOnly = { ...idle, textureCopyCount: 2, textureCopyBytes: 2048, uploadMs: 3 };
    const mutation = swapEvent({ uploadMs: 7 });
    expect(isSwapPerformanceEvent(uploadOnly)).toBe(true);
    expect(isSwapPerformanceEvent(mutation)).toBe(true);
    const benchmark = createFrameBenchmark(0, 0.06);
    benchmark.record(0, [idle]);
    benchmark.record(10, [uploadOnly]);
    benchmark.record(30, [mutation]);
    const result = benchmark.record(60, [idle]);
    expect(result).toMatchObject({
      swapTickCount: 2,
      swapFrameCount: 2,
      swapMeanFrameMs: 25,
      nonSwapMeanFrameMs: 10,
      swapUploadMeanMs: 5,
      swapUploadTotal: 80,
      forcedSortTickCount: 1,
    });
    expect(result?.slowFrames).toEqual([
      expect.objectContaining({ frameMs: 30, eventCount: 1, uploadCount: 80 }),
      expect.objectContaining({ frameMs: 20, eventCount: 1, uploadMs: 3 }),
      expect.objectContaining({ frameMs: 10, eventCount: 0 }),
    ]);
  });

  it('attributes a mutation to the following frame interval and keeps display refresh separate', () => {
    const benchmark = createFrameBenchmark(0, 0.1);
    expect(benchmark.record(0)).toBeNull();
    expect(benchmark.record(10, [swapEvent()], { renderDrawCalls: 1 })).toBeNull();
    expect(benchmark.record(60, [], { renderDrawCalls: 1 })).toBeNull();
    const result = benchmark.record(100, [], { renderDrawCalls: 1 });

    expect(result).toMatchObject({
      sampleCount: 3,
      minimumFps: 20,
      onePercentLowFps: 20,
      medianFrameMs: 40,
      observedCallbackCadenceMs: 10,
      displayRefreshMs: null,
      missedRefreshOpportunities: null,
      refreshSource: 'unavailable',
      intervalsOver33_33ms: 2,
      renderDrawCallsMean: 1,
      renderDrawCallsP95: 1,
      renderDrawCallsMax: 1,
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
        eventCount: 1,
        cpuMs: 4,
        uploadCount: 80,
        forcedSort: true,
      }),
      expect.objectContaining({ frameMs: 40, eventCount: 0 }),
      expect.objectContaining({ frameMs: 10, eventCount: 0 }),
    ]);
  });

  it('samples changing rendered cuts after warm-up and excludes the terminal frame', () => {
    const benchmark = createFrameBenchmark(0.05, 0.05);
    benchmark.record(0, [], { renderedSplatCount: 9000 });
    benchmark.record(40, [], { renderedSplatCount: 8000 });
    benchmark.record(50, [], { renderedSplatCount: 100 });
    benchmark.record(60, [], { renderedSplatCount: 200 });
    benchmark.record(80, [], { renderedSplatCount: 0 });
    const result = benchmark.record(100, [], { renderedSplatCount: 7000 });
    expect(result).toMatchObject({
      sampleCount: 3,
      renderedSplatCountSamples: 3,
      renderedSplatCountMean: 100,
      renderedSplatCountMin: 0,
      renderedSplatCountMax: 200,
    });
  });

  it('reports unavailable rendered counts without inventing zero-work samples', () => {
    const benchmark = createFrameBenchmark(0, 0.01);
    benchmark.record(0);
    expect(benchmark.record(10)).toMatchObject({
      renderedSplatCountSamples: 0,
      renderedSplatCountMean: null,
      renderedSplatCountMin: null,
      renderedSplatCountMax: null,
    });
  });

  it('excludes warm-up mutations from attribution', () => {
    const benchmark = createFrameBenchmark(0.05, 0.05);
    benchmark.record(0, [swapEvent()]);
    benchmark.record(40, [swapEvent()]);
    benchmark.record(50);
    expect(benchmark.measurementStartedAtMs).toBe(50);
    benchmark.record(100);

    expect(benchmark.record(110)).toMatchObject({
      swapTickCount: 0,
      swapFrameCount: 0,
    });
  });
});

describe('unified GPU counting-order verification', () => {
  const inspect = (order: number[], buckets: number[]) => {
    const orderAttribute = {};
    const bucketAttribute = {};
    const mesh = {
      geometry: { instanceCount: order.length },
      performanceTimings: { activeCount: order.length, sortSerial: 1 },
      orderAttribute,
      sorter: { kind: 'counting', workingAttributes: [{}, {}, {}, bucketAttribute] },
    } as unknown as UnifiedSplatMesh;
    const renderer = {
      getArrayBufferAsync: async (attribute: object) => attribute === orderAttribute
        ? new Float32Array(order).buffer
        : new Uint32Array(buckets).buffer,
    } as unknown as THREE.WebGPURenderer;
    return verifyUnifiedGpuSort(mesh, renderer);
  };

  it('accepts a complete permutation in ascending GPU bucket order', async () => {
    expect(await inspect([2, 0, 1], [3, 9, 1])).toMatchObject({
      available: true, count: 3, duplicates: 0, missing: 0, foreign: 0, bucketInversions: 0,
    });
  });

  it('reports duplicate, missing and foreign draw slots', async () => {
    expect(await inspect([2, 2, 0, 8], [3, 9, 1, 10])).toMatchObject({
      duplicates: 1, missing: 2, foreign: 1,
    });
  });

  it('reports bucket inversions even with complete slot coverage', async () => {
    expect(await inspect([1, 0, 2], [3, 9, 1])).toMatchObject({
      duplicates: 0, missing: 0, foreign: 0, bucketInversions: 2,
    });
  });
});
