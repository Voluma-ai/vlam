import * as THREE from 'three/webgpu';
import { SplatMesh } from '../lib';
import type { StreamedSplatPerformanceEvent } from '../lib/streaming';

type SortDebugMesh = {
  activeCount: number;
  splatIndexAttribute: THREE.StorageInstancedBufferAttribute;
  sourceIndexAttribute: THREE.StorageBufferAttribute;
  backing: { centers: Float32Array };
};

export type SortVerification = {
  count: number;
  duplicates: number;
  missing: number;
  foreign: number;
  depthInversions: number;
  largestDepthInversion: number;
};

export type SlowFrameAttribution = {
  frameMs: number;
  eventCount: number;
  cpuMs: number;
  activeListMs: number;
  uploadMs: number;
  sortSubmitMs: number;
  stagingTextureAllocations: number;
  activeListUpdateRanges: number;
  appendedCount: number;
  removedCount: number;
  stagedCount: number;
  uploadCount: number;
  activeCount: number;
  forcedSort: boolean;
  compacted: boolean;
};

export type FrameBenchmarkResult = Record<string, number | SlowFrameAttribution[]>;

/** Collects raw animation-loop timing after a configurable warm-up. */
export function createFrameBenchmark(warmupSeconds: number, sampleSeconds: number) {
  let startedAt: number | null = null;
  let previous: number | null = null;
  const durations: number[] = [];
  const eventsByFrame: StreamedSplatPerformanceEvent[][] = [];
  let pendingEvents: StreamedSplatPerformanceEvent[] = [];
  let result: FrameBenchmarkResult | null = null;
  const record = (
    timestamp: number,
    events: readonly StreamedSplatPerformanceEvent[] = [],
  ): FrameBenchmarkResult | null => {
    startedAt ??= timestamp;
    const elapsed = timestamp - startedAt;
    if (elapsed < warmupSeconds * 1000) {
      previous = null;
      pendingEvents = [];
      return null;
    }
    if (previous !== null) {
      durations.push(timestamp - previous);
      // A mutation submitted during the previous frame affects the interval
      // ending at this rAF timestamp, not the interval that preceded it.
      eventsByFrame.push(pendingEvents);
    }
    previous = timestamp;
    pendingEvents = [...events];
    if (elapsed < (warmupSeconds + sampleSeconds) * 1000 || result) return result;
    const sorted = [...durations].sort((a, b) => a - b);
    const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
    const at = (values: readonly number[], fraction: number): number => {
      if (values.length === 0) return 0;
      const ordered = [...values].sort((a, b) => a - b);
      return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] as number;
    };
    const swapDurations = durations.filter((_, index) => (eventsByFrame[index]?.length ?? 0) > 0);
    const nonSwapDurations = durations.filter(
      (_, index) => (eventsByFrame[index]?.length ?? 0) === 0,
    );
    const swapEvents = eventsByFrame.flat();
    const meanOf = (values: readonly number[]): number =>
      values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
    const worstFrameMs = sorted.at(-1) ?? 0;
    const p99FrameMs = at(sorted, 0.99);
    const slowFrames = durations
      .map((frameMs, index): SlowFrameAttribution => {
        const frameEvents = eventsByFrame[index] ?? [];
        const sum = (select: (event: StreamedSplatPerformanceEvent) => number): number =>
          frameEvents.reduce((total, event) => total + select(event), 0);
        return {
          frameMs,
          eventCount: frameEvents.length,
          cpuMs: sum((event) => event.cpuMs),
          activeListMs: sum((event) => event.activeListMs),
          uploadMs: sum((event) => event.uploadMs),
          sortSubmitMs: sum((event) => event.sortSubmitMs),
          stagingTextureAllocations: sum((event) => event.stagingTextureAllocations),
          activeListUpdateRanges: sum((event) => event.activeListUpdateRanges),
          appendedCount: sum((event) => event.appendedCount),
          removedCount: sum((event) => event.removedCount),
          stagedCount: sum((event) => event.stagedCount),
          uploadCount: sum((event) => event.uploadCount),
          activeCount: frameEvents.at(-1)?.activeCount ?? 0,
          forcedSort: frameEvents.some((event) => event.forcedSort),
          compacted: frameEvents.some((event) => event.compacted),
        };
      })
      .sort((a, b) => b.frameMs - a.frameMs)
      .slice(0, 12);
    result = {
      sampleCount: durations.length,
      averageFps: 1000 / mean,
      meanFrameMs: mean,
      minimumFps: worstFrameMs > 0 ? 1000 / worstFrameMs : 0,
      onePercentLowFps: p99FrameMs > 0 ? 1000 / p99FrameMs : 0,
      p95FrameMs: at(sorted, 0.95),
      p99FrameMs,
      worstFrameMs,
      swapTickCount: swapEvents.length,
      swapFrameCount: swapDurations.length,
      swapMeanFrameMs: meanOf(swapDurations),
      swapP95FrameMs: at(swapDurations, 0.95),
      swapWorstFrameMs: at(swapDurations, 1),
      nonSwapMeanFrameMs: meanOf(nonSwapDurations),
      swapCpuMeanMs: meanOf(swapEvents.map((event) => event.cpuMs)),
      swapCpuWorstMs: at(
        swapEvents.map((event) => event.cpuMs),
        1,
      ),
      swapActiveListMeanMs: meanOf(swapEvents.map((event) => event.activeListMs)),
      swapActiveListWorstMs: at(
        swapEvents.map((event) => event.activeListMs),
        1,
      ),
      swapUploadMeanMs: meanOf(swapEvents.map((event) => event.uploadMs)),
      swapUploadWorstMs: at(
        swapEvents.map((event) => event.uploadMs),
        1,
      ),
      swapSortSubmitMeanMs: meanOf(swapEvents.map((event) => event.sortSubmitMs)),
      swapSortSubmitWorstMs: at(
        swapEvents.map((event) => event.sortSubmitMs),
        1,
      ),
      stagingTextureAllocationTotal: swapEvents.reduce(
        (sum, event) => sum + event.stagingTextureAllocations,
        0,
      ),
      stagingTextureAllocationMaxPerTick: at(
        swapEvents.map((event) => event.stagingTextureAllocations),
        1,
      ),
      activeListUpdateRangeMaxPerTick: at(
        swapEvents.map((event) => event.activeListUpdateRanges),
        1,
      ),
      swapUploadTotal: swapEvents.reduce((sum, event) => sum + event.uploadCount, 0),
      stagedUploadTotal: swapEvents.reduce((sum, event) => sum + event.stagedCount, 0),
      stagedMaxPerTick: at(
        swapEvents.map((event) => event.stagedCount),
        1,
      ),
      swapMaxSize: at(
        swapEvents.map((event) => event.appendedCount + event.removedCount),
        1,
      ),
      forcedSortTickCount: swapEvents.filter((event) => event.forcedSort).length,
      compactionTickCount: swapEvents.filter((event) => event.compacted).length,
      slowFrames,
    };
    return result;
  };
  return { record };
}

/** Reads the GPU order buffer and verifies permutation and depth invariants. */
export async function verifyGpuSort(
  mesh: SplatMesh,
  camera: THREE.Camera,
  renderer: THREE.WebGPURenderer,
): Promise<SortVerification> {
  const debug = mesh as unknown as SortDebugMesh;
  const count = debug.activeCount;
  const bytes = await renderer.getArrayBufferAsync(debug.splatIndexAttribute);
  const order = new Float32Array(bytes, 0, count);
  const source = debug.sourceIndexAttribute.array as Uint32Array;
  const expected = new Uint8Array(mesh.capacity);
  const seen = new Uint8Array(mesh.capacity);
  for (let i = 0; i < count; i++) expected[source[i] as number] = 1;

  let duplicates = 0;
  let foreign = 0;
  let depthInversions = 0;
  let largestDepthInversion = 0;
  const modelView = new THREE.Matrix4().multiplyMatrices(
    camera.matrixWorldInverse,
    mesh.matrixWorld,
  );
  const m = modelView.elements;
  let previousDepth = -Infinity;
  for (let i = 0; i < count; i++) {
    const poolIndex = Math.round(order[i] as number);
    if (poolIndex < 0 || poolIndex >= mesh.capacity || expected[poolIndex] === 0) {
      foreign++;
      continue;
    }
    if (seen[poolIndex] === 1) duplicates++;
    seen[poolIndex] = 1;
    const p = poolIndex * 4;
    const depth =
      (debug.backing.centers[p] as number) * m[2] +
      (debug.backing.centers[p + 1] as number) * m[6] +
      (debug.backing.centers[p + 2] as number) * m[10] +
      m[14];
    if (depth < previousDepth) {
      depthInversions++;
      largestDepthInversion = Math.max(largestDepthInversion, previousDepth - depth);
    }
    previousDepth = depth;
  }
  let missing = 0;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === 1 && seen[i] === 0) missing++;
  }
  return { count, duplicates, missing, foreign, depthInversions, largestDepthInversion };
}
