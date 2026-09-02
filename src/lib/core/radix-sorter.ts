/**
 * @role Bridge
 * Portable stable WebGPU radix sorting adapted to Three.js TSL compute nodes.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  atomicAdd,
  atomicLoad,
  atomicOr,
  atomicStore,
  countOneBits,
  float,
  floatBitsToUint,
  instanceIndex,
  int,
  invocationLocalIndex,
  ivec2,
  storage,
  storageBarrier,
  textureLoad,
  uint,
  uniform,
  workgroupArray,
  workgroupBarrier,
  workgroupId,
} from 'three/tsl';
import type { SplatSorter } from './sorter';
import type { SplatSortMetric } from './splat-mesh-types';
import { releaseRendererAttributes } from './compute-sorter';
import {
  RADIX_BITS_PER_PASS,
  RADIX_EXACT_KEY_BITS,
  RADIX_KEY_BITS,
  RADIX_KEY_MAX,
  radixPassCount,
} from './radix-sort';
import { intersectSortRange, sceneSortRange, type SplatSortRange } from './splat-sort-bounds';
import { StorageMirrorReleaser } from './storage-attribute-mirror';

const WORKGROUP_SIZE = 256;
const ELEMENTS_PER_THREAD = 8;
const ELEMENTS_PER_WORKGROUP = WORKGROUP_SIZE * ELEMENTS_PER_THREAD;
const DIGIT_COUNT = 16;
const MASK_WORDS_PER_DIGIT = WORKGROUP_SIZE / 32;
const MASK_WORDS_PER_GROUP = DIGIT_COUNT * MASK_WORDS_PER_DIGIT;
const SCAN_BLOCK_SIZE = 256;

type UintWorkgroupArray = {
  element(index: THREE.Node<'uint'>): THREE.Node<'uint'>;
};

/** Isolates gaps in Three's current WorkgroupInfo/Bitcount TypeScript declarations. */
function asUintNode(node: unknown): THREE.Node<'uint'> {
  return node as THREE.Node<'uint'>;
}

/**
 * Stable four-bit-per-pass WebGPU radix sorter.
 *
 * The ranked scatter follows PlayCanvas/WebGPU-Radix-Sort's per-digit bitmask
 * design. Three.js does not currently expose atomic workgroup arrays in TSL,
 * so masks use disjoint global-storage slices per workgroup. Workgroup and
 * storage barriers retain the same stable ranking semantics without relying
 * on cross-workgroup execution order.
 */
export class RadixSorter implements SplatSorter {
  readonly kind = 'radix' as const;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly stages: THREE.ComputeNode[] = [];
  private readonly workingAttributes: THREE.StorageBufferAttribute[];
  /** Frees the JS mirrors three keeps behind the GPU-only ping-pong buffers. */
  private readonly mirrors: StorageMirrorReleaser;
  /** Set by {@link dispose}; makes a second dispose a no-op. */
  private disposed = false;
  private readonly viewRow0 = uniform(new THREE.Vector4());
  private readonly viewRow1 = uniform(new THREE.Vector4());
  private readonly viewRow2 = uniform(new THREE.Vector4());
  private readonly depthMin = uniform(0);
  private readonly depthScale = uniform(0);
  private readonly activeCount = uniform(0);
  private readonly viewCenter = new THREE.Vector3();
  /** Exact mode avoids scene-bounds quantization entirely. */
  private readonly exactDepth: boolean;
  private readonly sortMetric: SplatSortMetric;

  constructor(options: {
    renderer: THREE.WebGPURenderer;
    capacity: number;
    centersTexture?: THREE.DataTexture;
    dataTextureWidth?: number;
    /** Gathered world-space centers for a unified renderer. */
    centersBuffer?: THREE.StorageBufferAttribute;
    splatIndexAttribute: THREE.StorageInstancedBufferAttribute;
    sourceIndexAttribute: THREE.StorageBufferAttribute;
    /** Keep every Float32 depth bit instead of quantizing to 24 bits. */
    exactDepth?: boolean;
    /** Camera-space ordering key. Default `'depth'`. */
    sortMetric?: SplatSortMetric;
  }) {
    const { capacity, centersTexture, dataTextureWidth, centersBuffer } = options;
    if (!centersTexture && !centersBuffer) {
      throw new Error('RadixSorter: provide centersTexture or centersBuffer.');
    }
    if (centersTexture && dataTextureWidth === undefined) {
      throw new Error('RadixSorter: dataTextureWidth is required with centersTexture.');
    }
    this.renderer = options.renderer;
    this.sortMetric = options.sortMetric ?? 'depth';
    const exactDepth = options.exactDepth === true;
    this.exactDepth = exactDepth;
    const passCount = radixPassCount(exactDepth ? RADIX_EXACT_KEY_BITS : RADIX_KEY_BITS);
    const groupCount = Math.ceil(capacity / ELEMENTS_PER_WORKGROUP);
    const histogramLength = DIGIT_COUNT * groupCount;
    const scanBlockCount = Math.ceil(histogramLength / SCAN_BLOCK_SIZE);

    const keysAAttribute = new THREE.StorageBufferAttribute(new Uint32Array(capacity), 1);
    const keysBAttribute = new THREE.StorageBufferAttribute(new Uint32Array(capacity), 1);
    const valuesAAttribute = new THREE.StorageBufferAttribute(new Uint32Array(capacity), 1);
    const valuesBAttribute = new THREE.StorageBufferAttribute(new Uint32Array(capacity), 1);
    const histogramAttribute = new THREE.StorageBufferAttribute(
      new Uint32Array(histogramLength),
      1,
    );
    const scanSumsAttribute = new THREE.StorageBufferAttribute(new Uint32Array(scanBlockCount), 1);
    const masksAttribute = new THREE.StorageBufferAttribute(
      new Uint32Array(groupCount * MASK_WORDS_PER_GROUP),
      1,
    );
    this.workingAttributes = [
      keysAAttribute,
      keysBAttribute,
      valuesAAttribute,
      valuesBAttribute,
      histogramAttribute,
      scanSumsAttribute,
      masksAttribute,
    ];
    this.mirrors = new StorageMirrorReleaser(this.workingAttributes);

    const keysA = storage(keysAAttribute, 'uint', capacity);
    const keysB = storage(keysBAttribute, 'uint', capacity);
    const valuesA = storage(valuesAAttribute, 'uint', capacity);
    const valuesB = storage(valuesBAttribute, 'uint', capacity);
    const source = storage(options.sourceIndexAttribute, 'uint', capacity);
    const order = storage(options.splatIndexAttribute, 'float', capacity);
    const workCenters = centersBuffer ? storage(centersBuffer, 'vec4', capacity) : null;
    const histogram = storage(histogramAttribute, 'uint', histogramLength).toAtomic();
    const scanSums = storage(scanSumsAttribute, 'uint', scanBlockCount);
    const masks = storage(masksAttribute, 'uint', groupCount * MASK_WORDS_PER_GROUP).toAtomic();

    const buildKeys = Fn(() => {
      If(float(instanceIndex).lessThan(this.activeCount), () => {
        const poolIndex = source.element(instanceIndex);
        const texel = centersTexture
          ? ivec2(
              int(poolIndex).mod(int(dataTextureWidth as number)),
              int(poolIndex).div(int(dataTextureWidth as number)),
            )
          : null;
        const center = workCenters
          ? workCenters.element(poolIndex).xyz
          : textureLoad(centersTexture, texel as THREE.Node<'ivec2'>).xyz;
        const viewZ = this.viewRow2.xyz.dot(center).add(this.viewRow2.w);
        const depth =
          this.sortMetric === 'radial'
            ? this.viewRow0.xyz
                .dot(center)
                .add(this.viewRow0.w)
                .pow2()
                .add(this.viewRow1.xyz.dot(center).add(this.viewRow1.w).pow2())
                .add(viewZ.pow2())
                .sqrt()
                .negate()
            : viewZ;
        if (exactDepth) {
          // IEEE-754 bits are monotonic only for positive values. Flip the
          // sign partition so ascending unsigned keys remain ascending numeric
          // depth, including VLAM's negative view-space Z convention.
          // Three's BitcastNode typings omit shift/xor; runtime nodes support them.
          const bits = asUintNode(floatBitsToUint(depth));
          const mask = bits
            .shiftRight(uint(31))
            .equal(uint(0))
            .select(uint(0x80000000), uint(0xffffffff));
          keysA.element(instanceIndex).assign(bits.bitXor(mask));
        } else {
          keysA
            .element(instanceIndex)
            .assign(depth.sub(this.depthMin).mul(this.depthScale).clamp(0, RADIX_KEY_MAX).toUint());
        }
        valuesA.element(instanceIndex).assign(poolIndex);
      });
    })().compute(capacity, [WORKGROUP_SIZE]);
    this.stages.push(buildKeys);

    for (let pass = 0; pass < passCount; pass++) {
      const inputKeys = pass % 2 === 0 ? keysA : keysB;
      const outputKeys = pass % 2 === 0 ? keysB : keysA;
      const inputValues = pass % 2 === 0 ? valuesA : valuesB;
      const outputValues = pass % 2 === 0 ? valuesB : valuesA;
      const bit = uint(pass * RADIX_BITS_PER_PASS);

      const clearHistogram = Fn(() => {
        atomicStore(histogram.element(instanceIndex), uint(0));
      })().compute(histogramLength, [WORKGROUP_SIZE]);

      const buildHistogram = Fn(() => {
        const base = workgroupId.x.mul(uint(ELEMENTS_PER_WORKGROUP));
        Loop(ELEMENTS_PER_THREAD, ({ i }) => {
          const index = base.add(uint(i).mul(uint(WORKGROUP_SIZE))).add(invocationLocalIndex);
          If(float(index).lessThan(this.activeCount), () => {
            const digit = inputKeys.element(index).shiftRight(bit).bitAnd(uint(0xf));
            atomicAdd(histogram.element(digit.mul(uint(groupCount)).add(workgroupId.x)), uint(1));
          });
        });
      })().compute(groupCount * WORKGROUP_SIZE, [WORKGROUP_SIZE]);

      const scanBlocks = Fn(() => {
        const start = instanceIndex.mul(uint(SCAN_BLOCK_SIZE));
        const running = uint(0).toVar();
        Loop(SCAN_BLOCK_SIZE, ({ i }) => {
          const index = start.add(uint(i));
          If(index.lessThan(uint(histogramLength)), () => {
            const value = atomicLoad(histogram.element(index)).toVar();
            atomicStore(histogram.element(index), running);
            running.addAssign(value);
          });
        });
        scanSums.element(instanceIndex).assign(running);
      })().compute(scanBlockCount, [64]);

      const scanBlockSums = Fn(() => {
        If(instanceIndex.equal(uint(0)), () => {
          const running = uint(0).toVar();
          Loop(scanBlockCount, ({ i }) => {
            const value = scanSums.element(i).toVar();
            scanSums.element(i).assign(running);
            running.addAssign(value);
          });
        });
      })().compute(1, [64]);

      const addBlockOffsets = Fn(() => {
        const block = instanceIndex.div(uint(SCAN_BLOCK_SIZE));
        atomicStore(
          histogram.element(instanceIndex),
          atomicLoad(histogram.element(instanceIndex)).add(scanSums.element(block)),
        );
      })().compute(histogramLength, [WORKGROUP_SIZE]);

      const digitOffsets = workgroupArray('uint', DIGIT_COUNT) as unknown as UintWorkgroupArray;
      const rankedScatter = Fn(() => {
        const thread = invocationLocalIndex;
        const group = workgroupId.x;
        const maskBase = group.mul(uint(MASK_WORDS_PER_GROUP));
        If(thread.lessThan(uint(DIGIT_COUNT)), () => {
          digitOffsets.element(thread).assign(uint(0));
        });
        If(thread.lessThan(uint(MASK_WORDS_PER_GROUP)), () => {
          atomicStore(masks.element(maskBase.add(thread)), uint(0));
        });
        storageBarrier();
        workgroupBarrier();

        Loop(ELEMENTS_PER_THREAD, ({ i }) => {
          const index = group
            .mul(uint(ELEMENTS_PER_WORKGROUP))
            .add(i.toUint().mul(uint(WORKGROUP_SIZE)))
            .add(thread);
          const valid = float(index).lessThan(this.activeCount);
          const key = uint(0).toVar();
          const value = uint(0).toVar();
          const digit = uint(0).toVar();
          If(valid, () => {
            key.assign(inputKeys.element(index));
            value.assign(inputValues.element(index));
            digit.assign(key.shiftRight(bit).bitAnd(uint(0xf)));
            const word = thread.shiftRight(uint(5));
            const bitInWord = thread.bitAnd(uint(31));
            const maskIndex = maskBase.add(digit.mul(uint(MASK_WORDS_PER_DIGIT))).add(word);
            atomicOr(masks.element(maskIndex), uint(1).shiftLeft(bitInWord));
          });
          storageBarrier();
          workgroupBarrier();

          If(valid, () => {
            const word = thread.shiftRight(uint(5));
            const bitInWord = thread.bitAnd(uint(31));
            const digitBase = maskBase.add(digit.mul(uint(MASK_WORDS_PER_DIGIT)));
            const localRank = digitOffsets.element(digit).toVar();
            Loop(MASK_WORDS_PER_DIGIT, ({ i: wordIndex }) => {
              If(uint(wordIndex).lessThan(word), () => {
                localRank.addAssign(
                  asUintNode(
                    countOneBits(atomicLoad(masks.element(digitBase.add(wordIndex.toUint())))),
                  ),
                );
              });
            });
            const precedingMask = uint(1).shiftLeft(bitInWord).sub(uint(1));
            localRank.addAssign(
              asUintNode(
                countOneBits(atomicLoad(masks.element(digitBase.add(word))).bitAnd(precedingMask)),
              ),
            );
            const prefix = atomicLoad(histogram.element(digit.mul(uint(groupCount)).add(group)));
            const target = prefix.add(localRank);
            outputKeys.element(target).assign(key);
            outputValues.element(target).assign(value);
          });

          storageBarrier();
          workgroupBarrier();
          If(thread.lessThan(uint(DIGIT_COUNT)), () => {
            const total = uint(0).toVar();
            Loop(MASK_WORDS_PER_DIGIT, ({ i: wordIndex }) => {
              const maskIndex = maskBase
                .add(thread.mul(uint(MASK_WORDS_PER_DIGIT)))
                .add(wordIndex.toUint());
              total.addAssign(asUintNode(countOneBits(atomicLoad(masks.element(maskIndex)))));
              atomicStore(masks.element(maskIndex), uint(0));
            });
            digitOffsets.element(thread).addAssign(total);
          });
          storageBarrier();
          workgroupBarrier();
        });
      })().compute(groupCount * WORKGROUP_SIZE, [WORKGROUP_SIZE]);

      this.stages.push(
        clearHistogram,
        buildHistogram,
        scanBlocks,
        scanBlockSums,
        addBlockOffsets,
        rankedScatter,
      );
    }

    const writeOrder = Fn(() => {
      If(float(instanceIndex).lessThan(this.activeCount), () => {
        order.element(instanceIndex).assign(float(valuesA.element(instanceIndex)));
      });
    })().compute(capacity, [WORKGROUP_SIZE]);
    this.stages.push(writeOrder);
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
    if (!this.exactDepth) {
      const range = intersectSortRange(
        sceneSortRange(modelView, bounds, this.sortMetric, this.viewCenter),
        visibleRange,
      );
      this.depthMin.value = range.min;
      this.depthScale.value = RADIX_KEY_MAX / (range.max - range.min || 1);
    }
    this.stages[0]!.count = activeCount;
    this.stages[this.stages.length - 1]!.count = activeCount;
    this.renderer.compute(this.stages);
    // Key/value ping-pong, histogram, scan sums and masks are all written and
    // read entirely on the GPU - at 4 B per splat of capacity each, their JS
    // mirrors are ~16 B/splat of pure waste. Deliberately *not*
    // `sourceIndex`/`splatIndex`: those belong to the mesh and are rewritten
    // from the CPU every frame. Same ownership line as `releaseRendererAttributes`.
    if (!this.mirrors.settled) this.mirrors.release(this.renderer);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stage of this.stages) stage.dispose();
    releaseRendererAttributes(this.renderer, this.workingAttributes);
  }
}
