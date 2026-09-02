import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputeSorter } from '../core/compute-sorter';

interface ComputeSorterInternals {
  clearPass: THREE.ComputeNode;
  histogramPass: THREE.ComputeNode;
  scanBlocksPass: THREE.ComputeNode;
  scanBlockSumsPass: THREE.ComputeNode;
  addBlockSumOffsetsPass: THREE.ComputeNode;
  addOffsetsPass: THREE.ComputeNode;
  scatterPass: THREE.ComputeNode;
  sortPasses: THREE.ComputeNode[];
  bucketMax: { value: number };
  depthMin: { value: number };
  depthScale: { value: number };
}

const CAPACITY = 256;
const MIN_BUCKETS = 1 << 16;
const BLOCK_SIZE = 256;

function makeSorter(compute = vi.fn()): ComputeSorter {
  const renderer = { compute } as unknown as THREE.WebGPURenderer;
  const centersTexture = new THREE.DataTexture(
    new Float32Array(CAPACITY * 4),
    CAPACITY,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  return new ComputeSorter({
    renderer,
    capacity: CAPACITY,
    centersTexture,
    dataTextureWidth: CAPACITY,
    splatIndexAttribute: new THREE.StorageInstancedBufferAttribute(new Float32Array(CAPACITY), 1),
    sourceIndexAttribute: new THREE.StorageBufferAttribute(new Uint32Array(CAPACITY), 1),
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
    // 17 splats round up to 32 buckets, which the floor lifts to 2¹⁶ - far
    // below the 2²² the histogram is allocated for.
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

  it('grows the bucket range with the live splat count, capped at the pool max', () => {
    sorter = makeSorter();
    const internals = internalsOf(sorter);
    const bounds = new THREE.Sphere(new THREE.Vector3(), 1);

    sorter.sort(new THREE.Matrix4(), 3_000_000, bounds);
    expect(internals.clearPass.count).toBe(1 << 22);
    expect(internals.bucketMax.value).toBe((1 << 22) - 1);

    // Falls back down as a streamed scene sheds splats - the cost tracks what
    // is actually resident, in both directions.
    sorter.sort(new THREE.Matrix4(), 700_000, bounds);
    expect(internals.clearPass.count).toBe(1 << 20);
    expect(internals.scanBlocksPass.count).toBe((1 << 20) / BLOCK_SIZE);
    expect(internals.scanBlockSumsPass.count).toBe((1 << 20) / BLOCK_SIZE / BLOCK_SIZE);
  });

  it('keeps at least one bucket per splat, so depth resolution never degrades', () => {
    sorter = makeSorter();
    const internals = internalsOf(sorter);
    for (const activeCount of [100_000, 250_000, 1_000_000, 1_500_000, 4_000_000]) {
      sorter.sort(new THREE.Matrix4(), activeCount, new THREE.Sphere(new THREE.Vector3(), 1));
      expect(internals.clearPass.count).toBeGreaterThanOrEqual(Math.min(activeCount, 1 << 22));
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
    // their JS mirrors are dead weight (16 MiB for the histogram alone). But
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
