import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  atomicAdd,
  atomicLoad,
  atomicStore,
  float,
  instanceIndex,
  int,
  ivec2,
  storage,
  textureLoad,
  uint,
  uniform,
} from 'three/tsl';
import type { SplatSorter } from './sorter';
import type { SplatSortMetric } from './splat-mesh-types';
import { sourceWorldTransform } from './splat-mesh-material';
import { intersectSortRange, sceneSortRange, type SplatSortRange } from './splat-sort-bounds';
import { StorageMirrorReleaser } from './storage-attribute-mirror';
import type { uniformArray } from 'three/tsl';

/**
 * Optional per-source world transform for a unified {@link MergedSplatMesh} pool.
 * When present, each splat's center is transformed to world space by its
 * source's matrix (selected by a per-splat id read from `sourceIdTexture`)
 * before its depth is computed, so clouds with different world transforms sort
 * against each other correctly. Absent for an ordinary single-transform mesh.
 */
export interface PerSourceSortTransform {
  /** RedFormat float texture holding each pool slot's source id (the channel). */
  sourceIdTexture: THREE.DataTexture;
  /** Shared array of source-matrix columns; see `SourceMatrixArray`. */
  columns: ReturnType<typeof uniformArray>;
  /** CPU mirror of the source-id channel, used by the WebGL2 worker sorter. */
  sourceIds: Float32Array;
  /** Column-major source matrices, used by the WebGL2 worker sorter. */
  matrices: Float32Array;
}

/**
 * GPU depth sorter: a single-pass counting sort over 2²² (~4M) depth
 * buckets, running entirely in TSL compute passes on the WebGPU backend.
 *
 *   1. clear      - zero the histogram
 *   2. histogram  - depth per active splat → bucket id; count per bucket
 *   3. scanBlocks - exclusive prefix sum within each 256-bucket block
 *   4. scanBlockSums - parallel exclusive scans over groups of block totals
 *   5. scanSuperSums - exclusive scan over the remaining super-block totals
 *   6. addBlockOffsets - combine both block-sum scan levels
 *   7. addOffsets - combine block and bucket offsets
 *   8. scatter    - order[offset[bucket]++] = pool index (atomic)
 *
 * Why ~4M buckets, not 64K: on a large scene, 16-bit buckets made a
 * near-camera bucket span thousands of overlapping grass/leaf splats whose
 * arbitrary intra-bucket order reshuffled as the camera moved - visible
 * popping. Each depth bucket is now a sub-splat-width slice, so splats that
 * share a bucket are effectively coplanar and their (still arbitrary) order
 * cannot be seen. (A multi-pass radix would give exact order but needs a
 * *stable* scatter, which the parallel `atomicAdd` scatter is not - hence a
 * single wide pass instead.)
 *
 * Dynamic capacity: the sorter walks the mesh's `sourceIndex` buffer (pool
 * indices of the active splats) and sorts only the first `activeCount`
 * entries, so ranges can be appended and removed without rebuilding
 * pipelines - the per-splat passes are dispatched with a dynamic invocation
 * count and guarded by an `activeCount` uniform.
 *
 * Portable by construction: cross-workgroup communication only happens
 * through the implicit synchronization WebGPU guarantees between dispatches
 * - no spin-waits or scheduling assumptions.
 *
 * The depth range for bucket quantization comes from the mesh's bounding
 * sphere transformed to view space, so no GPU min/max reduction is needed.
 */
export class ComputeSorter implements SplatSorter {
  readonly kind = 'counting' as const;
  private static readonly BUCKET_COUNT = 1 << 22;
  private static readonly BLOCK_SIZE = 256;

  /**
   * Smallest bucket count a sort will dispatch. Below this the fixed passes
   * are already cheap, and the floor keeps every block-scan index exact.
   */
  private static readonly MIN_BUCKET_COUNT = 1 << 16;

  private readonly renderer: THREE.WebGPURenderer;
  private readonly clearPass: THREE.ComputeNode;
  private readonly histogramPass: THREE.ComputeNode;
  private readonly scanBlocksPass: THREE.ComputeNode;
  private readonly scanBlockSumsPass: THREE.ComputeNode;
  private readonly addBlockSumOffsetsPass: THREE.ComputeNode;
  private readonly addOffsetsPass: THREE.ComputeNode;
  private readonly scatterPass: THREE.ComputeNode;
  /** All stages in dependency order, submitted as one WebGPU compute pass. */
  private readonly sortPasses: THREE.ComputeNode[];
  /** Sorter-owned working buffers, released on {@link dispose}. */
  private readonly workingAttributes: THREE.StorageBufferAttribute[];
  /** Frees the JS mirrors three keeps behind the GPU-only working buffers. */
  private readonly mirrors: StorageMirrorReleaser;
  /** Set by {@link dispose}; makes a second dispose a no-op. */
  private disposed = false;

  /** Rows of the model-view matrix used by the selected sort metric. */
  private readonly viewRow0 = uniform(new THREE.Vector4());
  private readonly viewRow1 = uniform(new THREE.Vector4());
  private readonly viewRow2 = uniform(new THREE.Vector4());
  private readonly depthMin = uniform(0);
  private readonly depthScale = uniform(0);
  /** Active splat count; a float compares exactly for counts < 2²⁴. */
  private readonly activeCount = uniform(0);
  /** Highest bucket index this sort uses; see {@link effectiveBucketCount}. */
  private readonly bucketMax = uniform(0);

  private readonly viewCenter = new THREE.Vector3();
  private readonly sortMetric: SplatSortMetric;

  constructor(options: {
    renderer: THREE.WebGPURenderer;
    /** Pool capacity in splats; all buffers are sized once from this. */
    capacity: number;
    /** RGBA32F texture holding splat centers (xyz), pool-indexed. */
    centersTexture?: THREE.DataTexture;
    /** Width of the centers texture, to map pool index → texel. */
    dataTextureWidth?: number;
    /** Work-buffer centers (xyzw per splat), as written by a gather pass. */
    centersBuffer?: THREE.StorageBufferAttribute;
    /** The float `splatIndex` buffer the render material reads. */
    splatIndexAttribute: THREE.StorageInstancedBufferAttribute;
    /** Pool indices of the active splats (first `activeCount` entries). */
    sourceIndexAttribute: THREE.StorageBufferAttribute;
    /** Per-source world transform for a unified pool; omit for a single mesh. */
    perSource?: PerSourceSortTransform;
    /** Camera-space ordering key. Default `'depth'`. */
    sortMetric?: SplatSortMetric;
  }) {
    const { renderer, capacity, centersTexture, dataTextureWidth, centersBuffer, perSource } =
      options;
    const { BUCKET_COUNT, BLOCK_SIZE } = ComputeSorter;
    if (!centersTexture && !centersBuffer) {
      throw new Error('ComputeSorter: provide centersTexture or centersBuffer.');
    }
    if (centersTexture && dataTextureWidth === undefined) {
      throw new Error('ComputeSorter: dataTextureWidth is required with centersTexture.');
    }
    if (centersBuffer && perSource) {
      throw new Error('ComputeSorter: work-buffer centers are already in world space.');
    }

    this.renderer = renderer;
    this.sortMetric = options.sortMetric ?? 'depth';

    // GPU-only working buffers. The histogram is accessed atomically in
    // every pass so all pipelines see one consistent buffer declaration;
    // after `addOffsets` it holds the global write offsets that `scatter`
    // consumes (and destroys - it is rebuilt on every sort).
    const histogramAttribute = new THREE.StorageBufferAttribute(new Uint32Array(BUCKET_COUNT), 1);
    const blockSumsAttribute = new THREE.StorageBufferAttribute(
      new Uint32Array(BUCKET_COUNT / BLOCK_SIZE),
      1,
    );
    const superBlockSumsAttribute = new THREE.StorageBufferAttribute(
      new Uint32Array(BUCKET_COUNT / BLOCK_SIZE / BLOCK_SIZE),
      1,
    );
    const bucketsAttribute = new THREE.StorageBufferAttribute(new Uint32Array(capacity), 1);
    this.workingAttributes = [
      histogramAttribute,
      blockSumsAttribute,
      superBlockSumsAttribute,
      bucketsAttribute,
    ];
    this.mirrors = new StorageMirrorReleaser(this.workingAttributes);
    const histogram = storage(histogramAttribute, 'uint', BUCKET_COUNT).toAtomic();
    const blockSums = storage(blockSumsAttribute, 'uint', BUCKET_COUNT / BLOCK_SIZE);
    const superBlockSums = storage(
      superBlockSumsAttribute,
      'uint',
      BUCKET_COUNT / BLOCK_SIZE / BLOCK_SIZE,
    );
    const buckets = storage(bucketsAttribute, 'uint', capacity);
    const sourceIndex = storage(options.sourceIndexAttribute, 'uint', capacity);
    const order = storage(options.splatIndexAttribute, 'float', capacity);
    const workCenters = centersBuffer ? storage(centersBuffer, 'vec4', capacity) : null;

    this.clearPass = Fn(() => {
      atomicStore(histogram.element(instanceIndex), uint(0));
    })().compute(BUCKET_COUNT, [BLOCK_SIZE]);

    this.histogramPass = Fn(() => {
      If(float(instanceIndex).lessThan(this.activeCount), () => {
        const poolIndex = int(sourceIndex.element(instanceIndex));
        const texel = centersTexture
          ? ivec2(
              poolIndex.mod(int(dataTextureWidth as number)),
              poolIndex.div(int(dataTextureWidth as number)),
            )
          : null;
        const center = workCenters
          ? workCenters.element(poolIndex).xyz
          : textureLoad(centersTexture, texel as THREE.Node<'ivec2'>).xyz;

        // In a unified pool each splat lives in its source's local frame; move
        // it to world space by that source's matrix before measuring depth, so
        // clouds with different transforms share one back-to-front order. The
        // branch is resolved at build time, so a single-transform mesh compiles
        // exactly the original local-center path.
        const depthPoint = perSource
          ? sourceWorldTransform(
              perSource.columns,
              int(textureLoad(perSource.sourceIdTexture, texel as THREE.Node<'ivec2'>).r),
              center,
            ).worldCenter
          : center;
        const viewZ = this.viewRow2.xyz.dot(depthPoint).add(this.viewRow2.w);
        const sortValue =
          this.sortMetric === 'radial'
            ? this.viewRow0.xyz
                .dot(depthPoint)
                .add(this.viewRow0.w)
                .pow2()
                .add(this.viewRow1.xyz.dot(depthPoint).add(this.viewRow1.w).pow2())
                .add(viewZ.pow2())
                .sqrt()
                .negate()
            : viewZ;
        const bucket = sortValue
          .sub(this.depthMin)
          .mul(this.depthScale)
          .clamp(0, this.bucketMax)
          .toUint();

        buckets.element(instanceIndex).assign(bucket);
        atomicAdd(histogram.element(bucket), uint(1));
      });
    })().compute(capacity, [BLOCK_SIZE]);

    // One thread serially scans one 256-bucket block: threads never share
    // data within a dispatch, so no barriers are needed anywhere.
    this.scanBlocksPass = Fn(() => {
      const base = instanceIndex.mul(uint(BLOCK_SIZE)).toVar();
      const runningTotal = uint(0).toVar();
      Loop(BLOCK_SIZE, ({ i }) => {
        const slot = histogram.element(base.add(uint(i)));
        const bucketCount = atomicLoad(slot).toVar();
        atomicStore(slot, runningTotal);
        runningTotal.addAssign(bucketCount);
      });
      blockSums.element(instanceIndex).assign(runningTotal);
    })().compute(BUCKET_COUNT / BLOCK_SIZE, [64]);

    // Scan 256 block totals per invocation, then scan the resulting 64
    // super-block totals. The old single invocation walked all 16,384 totals
    // serially; this keeps every dependency chain at 256 additions or fewer.
    this.scanBlockSumsPass = Fn(() => {
      const base = instanceIndex.mul(uint(BLOCK_SIZE)).toVar();
      const runningTotal = uint(0).toVar();
      Loop(BLOCK_SIZE, ({ i }) => {
        const slot = blockSums.element(base.add(uint(i)));
        const blockTotal = slot.toVar();
        slot.assign(runningTotal);
        runningTotal.addAssign(blockTotal);
      });
      superBlockSums.element(instanceIndex).assign(runningTotal);
    })().compute(BUCKET_COUNT / BLOCK_SIZE / BLOCK_SIZE, [64]);

    const scanSuperBlockSums = Fn(() => {
      If(instanceIndex.equal(uint(0)), () => {
        const runningTotal = uint(0).toVar();
        Loop(BUCKET_COUNT / BLOCK_SIZE / BLOCK_SIZE, ({ i }) => {
          const superBlockTotal = superBlockSums.element(i).toVar();
          superBlockSums.element(i).assign(runningTotal);
          runningTotal.addAssign(superBlockTotal);
        });
      });
    })().compute(1, [64]);

    this.addBlockSumOffsetsPass = Fn(() => {
      blockSums
        .element(instanceIndex)
        .addAssign(superBlockSums.element(instanceIndex.div(uint(BLOCK_SIZE))));
    })().compute(BUCKET_COUNT / BLOCK_SIZE, [BLOCK_SIZE]);

    this.addOffsetsPass = Fn(() => {
      const slot = histogram.element(instanceIndex);
      const offset = blockSums.element(instanceIndex.shiftRight(uint(Math.log2(BLOCK_SIZE))));
      atomicStore(slot, atomicLoad(slot).add(offset));
    })().compute(BUCKET_COUNT, [BLOCK_SIZE]);

    // Ascending view-space z puts the most negative (farthest) splats
    // first: back-to-front, matching the CPU sorter.
    this.scatterPass = Fn(() => {
      If(float(instanceIndex).lessThan(this.activeCount), () => {
        const poolIndex = sourceIndex.element(instanceIndex);
        const bucket = buckets.element(instanceIndex);
        const destination = atomicAdd(histogram.element(bucket), uint(1));
        order.element(destination).assign(float(poolIndex));
      });
    })().compute(capacity, [BLOCK_SIZE]);

    this.sortPasses = [
      this.clearPass,
      this.histogramPass,
      this.scanBlocksPass,
      this.scanBlockSumsPass,
      scanSuperBlockSums,
      this.addBlockSumOffsetsPass,
      this.addOffsetsPass,
      this.scatterPass,
    ];
  }

  /**
   * Buckets to actually use for `activeCount` splats, rounded up to a power of
   * two so block indexing stays exact.
   *
   * The histogram is allocated once for the pool's worst case, but clearing and
   * scanning all 2²² buckets costs the same whether one splat is resident or
   * four million - a fixed per-sort bill that dominates on a mobile GPU when
   * the pool is only partly filled (a streaming scene ramping up, or any small
   * scene). Sizing the dispatch to the live splat count keeps the design's
   * ~1-bucket-per-splat depth resolution, so ordering is unaffected, while
   * skipping work on buckets no splat can land in.
   */
  private effectiveBucketCount(activeCount: number): number {
    const exponent = Math.ceil(Math.log2(Math.max(1, activeCount)));
    const rounded = 2 ** exponent;
    return Math.min(Math.max(rounded, ComputeSorter.MIN_BUCKET_COUNT), ComputeSorter.BUCKET_COUNT);
  }

  sort(
    modelView: THREE.Matrix4,
    activeCount: number,
    bounds: THREE.Sphere,
    visibleRange?: SplatSortRange | null,
  ): boolean {
    if (activeCount === 0) return true;

    const m = modelView.elements;
    this.viewRow0.value.set(m[0], m[4], m[8], m[12]);
    this.viewRow1.value.set(m[1], m[5], m[9], m[13]);
    this.viewRow2.value.set(m[2], m[6], m[10], m[14]);
    this.activeCount.value = activeCount;

    const buckets = this.effectiveBucketCount(activeCount);
    const range = intersectSortRange(
      sceneSortRange(modelView, bounds, this.sortMetric, this.viewCenter),
      visibleRange,
    );
    this.depthMin.value = range.min;
    this.depthScale.value = (buckets - 1) / (range.max - range.min || 1);
    this.bucketMax.value = buckets - 1;

    // Keep every stage limited to the buckets and splats in play while batching
    // all dependent stages into one command encoder, compute pass, and submit.
    const blockCount = buckets / ComputeSorter.BLOCK_SIZE;
    this.histogramPass.count = activeCount;
    this.scatterPass.count = activeCount;
    this.clearPass.count = buckets;
    this.scanBlocksPass.count = blockCount;
    this.scanBlockSumsPass.count = blockCount / ComputeSorter.BLOCK_SIZE;
    this.addBlockSumOffsetsPass.count = blockCount;
    this.addOffsetsPass.count = buckets;
    this.renderer.compute(this.sortPasses);
    // The working buffers are GPU-only: the histogram is zeroed by `clearPass`
    // and read atomically on the GPU, and `buckets` never leaves it. Three keeps
    // a JS mirror of each anyway - 16 MiB for the histogram alone, plus 4 B per
    // splat of capacity - so drop it once the dispatch has uploaded them.
    // Deliberately *not* `sourceIndex`/`splatIndex`: those belong to the mesh
    // and are rewritten from the CPU every frame. Same ownership line as
    // `releaseRendererAttributes` draws below.
    if (!this.mirrors.settled) this.mirrors.release(this.renderer);
    return true;
  }

  dispose(): void {
    // Idempotent: a mesh disposed twice (or a unified renderer torn down after
    // its owner already released the sorter) must not double-free GPU state.
    if (this.disposed) return;
    this.disposed = true;
    // Disposing each compute node releases its pipeline, bind groups and
    // node state from the renderer - without this, every scene switch on a
    // long-lived renderer leaked the sorter's working set (~32 MB GPU + CPU).
    for (const pass of this.sortPasses) pass.dispose();
    // Only the sorter-owned working buffers are freed here -
    // sourceIndex/splatIndex belong to the mesh (see releaseRendererAttributes).
    releaseRendererAttributes(this.renderer, this.workingAttributes);
  }
}

/**
 * Frees the GPU buffers of storage attributes that never sat in a geometry.
 * The renderer has no public API for this, so it reaches for the renderer's
 * attribute map directly; a harmless no-op if the internal shape changes, and
 * idempotent (the map's `delete` ignores unknown entries). Shared by the
 * sorters and by owners of mesh-level storage attributes (`sourceIndex`, the
 * unified work buffer) on dispose.
 */
export function releaseRendererAttributes(
  renderer: THREE.WebGPURenderer,
  attributes: readonly THREE.BufferAttribute[],
): void {
  const map = (renderer as unknown as { _attributes?: { delete(a: object): void } })._attributes;
  if (!map) return;
  for (const attribute of attributes) map.delete(attribute);
}
