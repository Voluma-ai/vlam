import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputeSorter } from '../core/compute-sorter';

interface ComputeSorterInternals {
  histogramBucketCount: number;
  clearPass: THREE.ComputeNode;
  histogramPass: THREE.ComputeNode;
  scanBlocksPass: THREE.ComputeNode;
  scanBlockSumsPass: THREE.ComputeNode;
  addBlockSumOffsetsPass: THREE.ComputeNode;
  addOffsetsPass: THREE.ComputeNode;
  scatterPass: THREE.ComputeNode;
  sortPasses: THREE.ComputeNode[];
  workingAttributes: THREE.StorageBufferAttribute[];
  bucketMax: { value: number };
  depthMin: { value: number };
  depthScale: { value: number };
}

const CAPACITY = 256;
const MIN_BUCKETS = 1 << 16;
const BLOCK_SIZE = 256;

function makeSorter(compute = vi.fn(), capacity = CAPACITY): ComputeSorter {
  const renderer = { compute } as unknown as THREE.WebGPURenderer;
  const width = Math.min(CAPACITY, capacity);
  const height = Math.ceil(capacity / width);
  const centersTexture = new THREE.DataTexture(
    new Float32Array(width * height * 4),
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  return new ComputeSorter({
    renderer,
    capacity,
    centersTexture,
    dataTextureWidth: width,
    splatIndexAttribute: new THREE.StorageInstancedBufferAttribute(new Float32Array(capacity), 1),
    sourceIndexAttribute: new THREE.StorageBufferAttribute(new Uint32Array(capacity), 1),
  });
}

function internalsOf(sorter: ComputeSorter): ComputeSorterInternals {
  return sorter as unknown as ComputeSorterInternals;
}

describe('ComputeSorter', () => {
  let sorter: ComputeSorter | null = null;

  afterEach(() => {
    sorter?.dispose();
    sorter = null;
    vi.restoreAllMocks();
  });

  it('submits all sort stages in one ordered compute pass', () => {
    const compute = vi.fn();
    sorter = makeSorter(compute);

    const activeCount = 17;
    sorter.sort(new THREE.Matrix4(), activeCount, new THREE.Sphere(new THREE.Vector3(), 1));

    const internals = internalsOf(sorter);
    expect(compute).toHaveBeenCalledOnce();
    expect(compute).toHaveBeenCalledWith(internals.sortPasses);
    // clear → histogram → scan buckets → scan block sums → scan super-block
    // sums → add super-block offsets → add bucket offsets → scatter.
    expect(internals.sortPasses).toHaveLength(8);
    expect(internals.sortPasses[0]).toBe(internals.clearPass);
    expect(internals.sortPasses[1]).toBe(internals.histogramPass);
    expect(internals.sortPasses[2]).toBe(internals.scanBlocksPass);
    expect(internals.sortPasses[3]).toBe(internals.scanBlockSumsPass);
    expect(internals.sortPasses[5]).toBe(internals.addBlockSumOffsetsPass);
    expect(internals.sortPasses[6]).toBe(internals.addOffsetsPass);
    expect(internals.sortPasses[7]).toBe(internals.scatterPass);
    expect(internals.histogramPass.count).toBe(activeCount);
    expect(internals.scatterPass.count).toBe(activeCount);
  });

  it('dispatches only the buckets a small scene can reach', () => {
    sorter = makeSorter();
    // 17 splats round up to 32 buckets, which the floor lifts to 2¹⁶.
    sorter.sort(new THREE.Matrix4(), 17, new THREE.Sphere(new THREE.Vector3(), 1));

    const internals = internalsOf(sorter);
    expect(internals.clearPass.count).toBe(MIN_BUCKETS);
    expect(internals.addOffsetsPass.count).toBe(MIN_BUCKETS);
    expect(internals.scanBlocksPass.count).toBe(MIN_BUCKETS / BLOCK_SIZE);
    expect(internals.scanBlockSumsPass.count).toBe(MIN_BUCKETS / BLOCK_SIZE / BLOCK_SIZE);
    expect(internals.addBlockSumOffsetsPass.count).toBe(MIN_BUCKETS / BLOCK_SIZE);
    // Depth quantization and the shader's clamp must agree with the dispatch.
    expect(internals.bucketMax.value).toBe(MIN_BUCKETS - 1);
  });

  it.each([
    [1, MIN_BUCKETS],
    [MIN_BUCKETS, MIN_BUCKETS],
    [MIN_BUCKETS + 1, MIN_BUCKETS * 2],
    [(1 << 22) - 1, 1 << 22],
    [1 << 22, 1 << 22],
    [(1 << 22) + 1, 1 << 22],
  ])('allocates %i-capacity pools with %i histogram buckets', (capacity, expectedBuckets) => {
    const candidate = makeSorter(vi.fn(), capacity);
    const internals = internalsOf(candidate);

    expect(internals.histogramBucketCount).toBe(expectedBuckets);
    expect(internals.workingAttributes[0]!.array).toHaveLength(expectedBuckets);
    // The histogram-consuming passes are built for the pool allocation; sort()
    // later narrows only their dispatch counts to the active resident set.
    expect(internals.clearPass.count).toBe(expectedBuckets);
    expect(internals.scanBlocksPass.count).toBe(expectedBuckets / BLOCK_SIZE);
    expect(internals.addOffsetsPass.count).toBe(expectedBuckets);

    candidate.dispose();
  });

  it('grows and shrinks the bucket range without reallocating the histogram', () => {
    const capacity = MIN_BUCKETS * 2;
    sorter = makeSorter(vi.fn(), capacity);
    const internals = internalsOf(sorter);
    const bounds = new THREE.Sphere(new THREE.Vector3(), 1);
    const histogram = internals.workingAttributes[0];
    const histogramArray = histogram!.array;

    for (const [activeCount, buckets] of [
      [17, MIN_BUCKETS],
      [70_000, MIN_BUCKETS * 2],
      [17, MIN_BUCKETS],
    ] as const) {
      sorter.sort(new THREE.Matrix4(), activeCount, bounds);

      expect(internals.histogramPass.count).toBe(activeCount);
      expect(internals.scatterPass.count).toBe(activeCount);
      expect(internals.clearPass.count).toBe(buckets);
      expect(internals.addOffsetsPass.count).toBe(buckets);
      expect(internals.scanBlocksPass.count).toBe(buckets / BLOCK_SIZE);
      expect(internals.scanBlockSumsPass.count).toBe(buckets / BLOCK_SIZE / BLOCK_SIZE);
      expect(internals.addBlockSumOffsetsPass.count).toBe(buckets / BLOCK_SIZE);
      expect(internals.bucketMax.value).toBe(buckets - 1);
      expect(internals.depthMin.value).toBe(-1);
      expect(internals.depthScale.value).toBe((buckets - 1) / 2);
      expect(internals.workingAttributes[0]).toBe(histogram);
      expect(histogram!.array).toBe(histogramArray);
      expect(histogram!.array).toHaveLength(capacity);
    }
  });

  it('keeps at least one bucket per splat, so depth resolution never degrades', () => {
    sorter = makeSorter(vi.fn(), 1 << 20);
    const internals = internalsOf(sorter);
    for (const activeCount of [100_000, 250_000, 500_000, 1_000_000]) {
      sorter.sort(new THREE.Matrix4(), activeCount, new THREE.Sphere(new THREE.Vector3(), 1));
      expect(internals.clearPass.count).toBeGreaterThanOrEqual(activeCount);
    }
  });

  it('treats an empty sort as done without dispatching', () => {
    const compute = vi.fn();
    sorter = makeSorter(compute);
    expect(sorter.sort(new THREE.Matrix4(), 0, new THREE.Sphere(new THREE.Vector3(), 1))).toBe(
      true,
    );
    expect(compute).not.toHaveBeenCalled();
  });

  it('quantizes only the camera-visible interval when scene bounds contain RAD outliers', () => {
    sorter = makeSorter();
    const internals = internalsOf(sorter);
    // The million-unit sphere represents a corrupt/distant RAD center; it must
    // not turn centimeter-spaced visible depths into one counting bucket.
    sorter.sort(
      new THREE.Matrix4(),
      32,
      new THREE.Sphere(new THREE.Vector3(0, 0, -500_000), 500_000),
      { min: -100, max: 0 },
    );
    expect(internals.depthMin.value).toBe(-100);
    expect(internals.depthScale.value).toBe((MIN_BUCKETS - 1) / 100);
  });

  it('accepts world-space centers from a storage work buffer', () => {
    const renderer = { compute: vi.fn() } as unknown as THREE.WebGPURenderer;
    sorter = new ComputeSorter({
      renderer,
      capacity: CAPACITY,
      centersBuffer: new THREE.StorageBufferAttribute(new Float32Array(CAPACITY * 4), 4),
      splatIndexAttribute: new THREE.StorageInstancedBufferAttribute(new Float32Array(CAPACITY), 1),
      sourceIndexAttribute: new THREE.StorageBufferAttribute(new Uint32Array(CAPACITY), 1),
    });
    expect(sorter.sort(new THREE.Matrix4(), 1, new THREE.Sphere(new THREE.Vector3(), 1))).toBe(
      true,
    );
  });

  it('rejects a per-source transform for pre-resolved work-buffer centers', () => {
    const renderer = { compute: vi.fn() } as unknown as THREE.WebGPURenderer;
    expect(
      () =>
        new ComputeSorter({
          renderer,
          capacity: CAPACITY,
          centersBuffer: new THREE.StorageBufferAttribute(new Float32Array(CAPACITY * 4), 4),
          splatIndexAttribute: new THREE.StorageInstancedBufferAttribute(
            new Float32Array(CAPACITY),
            1,
          ),
          sourceIndexAttribute: new THREE.StorageBufferAttribute(new Uint32Array(CAPACITY), 1),
          perSource: {} as never,
        }),
    ).toThrow(/already in world space/);
  });

  it('frees its own working-buffer mirrors and never the mesh-owned ones', () => {
    // The ownership boundary. `histogram`/`blockSums`/`buckets` are GPU-only, so
    // their JS mirrors are dead weight (4 B per capacity-sized histogram bucket). But
    // `splatIndex` and `sourceIndex` belong to the mesh and are rewritten from
    // the CPU every frame - releasing those would silently stop the draw order
    // and the active list from reaching the GPU, and nothing else in this suite
    // would notice.
    const uploaded = new WeakMap<object, { buffer?: object }>();
    const tracked: THREE.BufferAttribute[] = [];
    const renderer = {
      // Stands in for three creating the storage buffers when it builds the
      // dispatch's bind group.
      compute: vi.fn(() => {
        for (const attribute of tracked) uploaded.set(attribute, { buffer: {} });
      }),
      backend: {
        isWebGPUBackend: true,
        has: (o: object) => uploaded.has(o),
        get: (o: object) => uploaded.get(o) ?? {},
      },
    } as unknown as THREE.WebGPURenderer;

    const splatIndexAttribute = new THREE.StorageInstancedBufferAttribute(
      new Float32Array(CAPACITY),
      1,
    );
    const sourceIndexAttribute = new THREE.StorageBufferAttribute(new Uint32Array(CAPACITY), 1);
    sorter = new ComputeSorter({
      renderer,
      capacity: CAPACITY,
      centersBuffer: new THREE.StorageBufferAttribute(new Float32Array(CAPACITY * 4), 4),
      splatIndexAttribute,
      sourceIndexAttribute,
    });
    const working = (sorter as unknown as { workingAttributes: THREE.BufferAttribute[] })
      .workingAttributes;
    // Mark the mesh-owned pair as uploaded too, so this cannot pass merely
    // because they were never releasable in the first place.
    tracked.push(...working, splatIndexAttribute, sourceIndexAttribute);

    sorter.sort(new THREE.Matrix4(), 16, new THREE.Sphere(new THREE.Vector3(), 1));

    for (const attribute of working) expect(attribute.array.length).toBe(0);
    expect(splatIndexAttribute.array.length).toBe(CAPACITY);
    expect(sourceIndexAttribute.array.length).toBe(CAPACITY);

    // Dispose must still succeed over released attributes.
    expect(() => sorter?.dispose()).not.toThrow();
  });
});
