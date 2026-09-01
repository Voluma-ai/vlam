import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  bool,
  float,
  int,
  instanceIndex,
  ivec2,
  mat3,
  storage,
  textureLoad,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import {
  evaluateSplatSh,
  foldSplatModifierStack,
  asNode,
  applyIsotropicCovarianceOverride,
  DEFAULT_ISOTROPIC_VARIANCE_SCALE,
  type SplatShInputs,
  type Vec3Uniform,
} from '../core/splat-mesh-material';
import { colorSpaceToWorking } from 'three/tsl';
import type { SplatModifier } from '../core/splat-modifier';
import { StorageMirrorReleaser } from '../core/storage-attribute-mirror';

/**
 * GPU gather pass for Phase 0 of the unified renderer. It resolves a source
 * pool's active local centers into a shared world-space storage buffer. The
 * work-buffer sorter consumes this buffer directly, so source-local pools can
 * later be heterogeneous (including streamed LOD pools).
 *
 * Internal while M15.4's draw path and public source API are completed.
 */
/** Shared GPU storage for every gathered source in one unified frame. */
export class WorkBuffer {
  /** World-space center xyz; w is display opacity (`visibility × source opacity ×` RAD modifier ratio). */
  readonly centers: THREE.StorageBufferAttribute;
  /** Resolved color and opacity per work slot. */
  readonly colors: THREE.StorageBufferAttribute;
  /** First packed covariance row per work slot. */
  readonly covarianceA: THREE.StorageBufferAttribute;
  /** Second packed covariance row per work slot. */
  readonly covarianceB: THREE.StorageBufferAttribute;
  /** Per-slot isotropic covariance mix (0 = keep Σ, 1 = round dot). */
  readonly isotropicMix: THREE.StorageBufferAttribute;
  /** Per-slot isotropic target sigma radius in screen px (0 = disabled). */
  readonly isotropicScreenRadius: THREE.StorageBufferAttribute;

  /**
   * Slots past {@link capacity}, reserved so a pipeline warm-up has somewhere
   * harmless to write. See {@link WorkBufferGather.warmUp}: compiling a compute
   * pipeline requires actually dispatching it, and dispatching zero workgroups
   * - while it does compile - makes WebGPU log an "unusual workgroup count of 0"
   * warning for every source. One workgroup aimed at this tail compiles just the
   * same, silently, and cannot disturb a drawn slot: admission never allocates
   * past `capacity` and the draw's `instanceCount` never covers it.
   */
  static readonly SCRATCH_SLOTS = 256;

  constructor(readonly capacity: number) {
    const slots = capacity + WorkBuffer.SCRATCH_SLOTS;
    this.centers = new THREE.StorageBufferAttribute(new Float32Array(slots * 4), 4);
    this.colors = new THREE.StorageBufferAttribute(new Float32Array(slots * 4), 4);
    this.covarianceA = new THREE.StorageBufferAttribute(new Float32Array(slots * 4), 4);
    this.covarianceB = new THREE.StorageBufferAttribute(new Float32Array(slots * 4), 4);
    this.isotropicMix = new THREE.StorageBufferAttribute(new Float32Array(slots), 1);
    this.isotropicScreenRadius = new THREE.StorageBufferAttribute(new Float32Array(slots), 1);
    this.mirrors = new StorageMirrorReleaser([
      this.centers,
      this.colors,
      this.covarianceA,
      this.covarianceB,
      this.isotropicMix,
      this.isotropicScreenRadius,
    ]);
  }

  /**
   * Drops the JS-heap copies three keeps behind these storage buffers.
   *
   * Every one of them is written only by the gather compute pass and read only
   * by the draw material - the CPU side is zeroes that no code ever reads, and
   * three's WebGPU backend never frees it on its own. At 72 B/slot that mirror
   * is ~720 MB of JS heap on a 10M-slot scene. See `storage-attribute-mirror`.
   *
   * Safe to call after any dispatch that bound this buffer; a no-op once
   * settled, and on WebGL2 or a renderer double that has no WebGPU backend.
   */
  releaseCpuMirrors(renderer: THREE.WebGPURenderer): void {
    if (this.mirrors.settled) return;
    this.mirrors.release(renderer);
  }

  private readonly mirrors: StorageMirrorReleaser;
}

export class WorkBufferGather {
  /** World-space `xyzw` center buffer, one element per unified work slot. */
  readonly centers: THREE.StorageBufferAttribute;
  /** Resolved source RGBA values; production draw consumes this next. */
  readonly colors: THREE.StorageBufferAttribute;
  /** Packed symmetric world-space covariance rows. */
  readonly covarianceA: THREE.StorageBufferAttribute;
  readonly covarianceB: THREE.StorageBufferAttribute;
  readonly isotropicMix: THREE.StorageBufferAttribute;
  readonly isotropicScreenRadius: THREE.StorageBufferAttribute;
  /** Shared target for this source's gathered range. */
  readonly workBuffer: WorkBuffer;
  private readonly capacity: number;
  private readonly activeCount = uniform(0);
  private readonly targetOffset = uniform(0);
  private readonly sourceMatrix = uniform(new THREE.Matrix4());
  private readonly cameraViewMatrix = uniform(new THREE.Matrix4());
  private readonly opacity = uniform(1);
  private readonly pass: THREE.ComputeNode;

  constructor(options: {
    capacity: number;
    sourceCapacity: number;
    sourceIndex: THREE.StorageBufferAttribute;
    centersTexture: THREE.DataTexture;
    colorsTexture: THREE.DataTexture;
    covarianceATexture: THREE.DataTexture;
    covarianceBTexture: THREE.DataTexture;
    dataTextureWidth: number;
    sh?: SplatShInputs | null;
    modifiers?: readonly SplatModifier[];
    channels?: ReadonlyMap<string, { texture: THREE.DataTexture }>;
    localCameraPosition?: Vec3Uniform;
    srgbOutput?: boolean;
    /**
     * Source stores Spark LOD alpha (`alpha ÷ 2`, `.rad`). Recover the full
     * `alpha ∈ [0,2]` into `colors.a` from the *original* texture channel so the
     * shared draw material can classify merged vs leaf without seeing fades.
     */
    lodAlpha?: boolean;
    /** Reuse one target across all source gather passes. */
    workBuffer?: WorkBuffer;
  }) {
    const {
      capacity,
      sourceCapacity,
      sourceIndex,
      centersTexture,
      colorsTexture,
      covarianceATexture,
      covarianceBTexture,
      dataTextureWidth,
    } = options;
    const sh = options.sh ?? null;
    const modifiers = options.modifiers ?? [];
    const channels = options.channels ?? new Map<string, { texture: THREE.DataTexture }>();
    const localCameraPosition = options.localCameraPosition ?? uniform(new THREE.Vector3());
    this.workBuffer = options.workBuffer ?? new WorkBuffer(capacity);
    this.capacity = this.workBuffer.capacity;
    this.centers = this.workBuffer.centers;
    this.colors = this.workBuffer.colors;
    this.covarianceA = this.workBuffer.covarianceA;
    this.covarianceB = this.workBuffer.covarianceB;
    this.isotropicMix = this.workBuffer.isotropicMix;
    this.isotropicScreenRadius = this.workBuffer.isotropicScreenRadius;
    const source = storage(sourceIndex, 'uint', sourceCapacity);
    const output = storage(this.centers, 'vec4', capacity);
    const outputColor = storage(this.colors, 'vec4', capacity);
    const outputCovA = storage(this.covarianceA, 'vec4', capacity);
    const outputCovB = storage(this.covarianceB, 'vec4', capacity);
    const outputIsotropicMix = storage(this.isotropicMix, 'float', capacity);
    const outputIsotropicScreenRadius = storage(this.isotropicScreenRadius, 'float', capacity);
    this.pass = Fn(() => {
      If(float(instanceIndex).lessThan(this.activeCount), () => {
        const poolIndex = int(source.element(instanceIndex));
        const texel = ivec2(
          poolIndex.mod(int(dataTextureWidth)),
          poolIndex.div(int(dataTextureWidth)),
        );
        const localCenter = textureLoad(centersTexture, texel).xyz;
        const target = instanceIndex.add(this.targetOffset.toUint());
        const inputA = textureLoad(covarianceATexture, texel);
        const inputB = textureLoad(covarianceBTexture, texel);
        const covarianceBase = mat3(
          vec3(inputA.x, inputA.y, inputA.z),
          vec3(inputA.y, inputA.w, inputB.x),
          vec3(inputA.z, inputB.x, inputB.y),
        );
        const baseColor = textureLoad(colorsTexture, texel);
        const colorAfterSh =
          sh === null
            ? baseColor
            : vec4(
                baseColor.rgb
                  .add(
                    evaluateSplatSh(
                      sh,
                      { covarianceBTexture },
                      texel,
                      localCenter.sub(localCameraPosition).normalize(),
                    ),
                  )
                  .clamp(0.0, 1.0),
                baseColor.a,
              );
        const worldCenter = this.sourceMatrix.mul(vec4(localCenter, 1.0)).xyz;
        const stack = foldSplatModifierStack(modifiers, localCameraPosition, {
          index: poolIndex,
          localCenter,
          color: colorAfterSh,
          makeWorldCenter: () => worldCenter,
          makeViewCenter: () => this.cameraViewMatrix.mul(vec4(worldCenter, 1.0)).xyz,
          makeNormal: () => {
            const inverse = covarianceBase.inverse();
            const toCamera = localCameraPosition.sub(localCenter);
            const axis = inverse.mul(inverse.mul(toCamera)).normalize();
            return axis.mul(axis.dot(toCamera).sign());
          },
          makeChannel: (name) => {
            const channel = channels.get(name);
            if (!channel) {
              throw new Error(
                `UnifiedSplatMesh: source modifier reads undefined channel "${name}".`,
              );
            }
            return textureLoad(channel.texture, texel).r;
          },
        });
        const center = stack.offset === null ? localCenter : localCenter.add(stack.offset);
        const visible = stack.visible === null ? bool(true) : stack.visible;
        // Stable work slots: keep hidden splats in the gather/sort range.
        // `centers.w` is display opacity: `visibility × source opacity`, and for
        // `.rad` sources the modifier-to-original alpha ratio as well. The
        // draw material treats `w <= 0` as non-drawable. Compacting hidden
        // splats was rejected (ROADMAP L3): the hidden set exists only on the
        // GPU, so compaction needs a count readback before the CPU-sized sort.
        const gatheredCenter = this.sourceMatrix.mul(vec4(center, 1.0)).xyz;
        const encodedOriginal = asNode<'float'>(colorAfterSh.a);
        const encodedResolved = asNode<'float'>(stack.color.a);
        const visibility = visible.select(float(1), float(0));
        const resolvedColor = options.srgbOutput
          ? stack.color
          : asNode<'vec4'>(colorSpaceToWorking(stack.color, THREE.SRGBColorSpace));
        if (options.lodAlpha) {
          // Store decoded RAD alpha in `colors.a` so merged vs leaf is decided
          // from the unmodified encoding. Visual fades never enter that channel.
          const modifierOpacity = encodedOriginal
            .greaterThan(0)
            .select(encodedResolved.div(encodedOriginal.max(1e-8)), float(1));
          output
            .element(target)
            .assign(vec4(gatheredCenter, visibility.mul(this.opacity).mul(modifierOpacity)));
          outputColor.element(target).assign(vec4(resolvedColor.rgb, encodedOriginal.mul(2.0)));
        } else {
          output.element(target).assign(vec4(gatheredCenter, visibility.mul(this.opacity)));
          outputColor.element(target).assign(vec4(resolvedColor.rgb, resolvedColor.a));
        }
        const covariance =
          stack.rotation === null
            ? covarianceBase
            : stack.rotation.mul(covarianceBase).mul(stack.rotation.transpose());
        // Collapse in mesh-local space (Spark's min(scale) is local), then lift
        // to world. Applying isotropic on world Σ with a local normal inflated
        // λ and produced large soft blobs under mesh transforms.
        let localCovariance: THREE.Node<'mat3'> = asNode<'mat3'>(covariance);
        if (stack.isotropicCovarianceMix !== null) {
          const varianceScale =
            stack.isotropicVarianceScale ?? float(DEFAULT_ISOTROPIC_VARIANCE_SCALE);
          localCovariance = applyIsotropicCovarianceOverride(
            localCovariance,
            vec3(0, 0, 1),
            stack.isotropicCovarianceMix,
            varianceScale,
          );
        }
        const linear = this.sourceMatrix.toMat3();
        const worldCovarianceBase = linear.mul(localCovariance).mul(linear.transpose());
        const worldCovariance =
          stack.scaleSquared === null
            ? worldCovarianceBase
            : worldCovarianceBase.mul(stack.scaleSquared);
        const c0 = worldCovariance.mul(vec3(1, 0, 0));
        const c1 = worldCovariance.mul(vec3(0, 1, 0));
        const c2 = worldCovariance.mul(vec3(0, 0, 1));
        outputCovA.element(target).assign(vec4(c0.x, c0.y, c0.z, c1.y));
        outputCovB.element(target).assign(vec4(c1.z, c2.z, 0, 0));
        outputIsotropicMix
          .element(target)
          .assign(stack.isotropicCovarianceMix === null ? float(0) : stack.isotropicCovarianceMix);
        outputIsotropicScreenRadius
          .element(target)
          .assign(
            stack.isotropicCovarianceMix === null
              ? float(0)
              : (stack.isotropicScreenRadiusPx ?? float(0)),
          );
      });
    })().compute(sourceCapacity, [256]);
  }

  /** Gathers a source's active pool slots into a contiguous work-buffer range. */
  gather(
    renderer: THREE.WebGPURenderer,
    activeCount: number,
    targetOffset: number,
    sourceMatrix: THREE.Matrix4,
    cameraViewMatrixOrOpacity: THREE.Matrix4 | number = new THREE.Matrix4(),
    opacity = 1,
  ): void {
    if (activeCount < 0 || targetOffset < 0 || targetOffset + activeCount > this.capacity) {
      throw new Error('WorkBufferGather: requested range exceeds work-buffer capacity.');
    }
    this.activeCount.value = activeCount;
    this.targetOffset.value = targetOffset;
    this.sourceMatrix.value.copy(sourceMatrix);
    const cameraViewMatrix =
      typeof cameraViewMatrixOrOpacity === 'number'
        ? new THREE.Matrix4()
        : cameraViewMatrixOrOpacity;
    this.cameraViewMatrix.value.copy(cameraViewMatrix);
    this.opacity.value = Math.max(
      0,
      typeof cameraViewMatrixOrOpacity === 'number' ? cameraViewMatrixOrOpacity : opacity,
    );
    this.pass.count = activeCount;
    renderer.compute(this.pass);
    // The dispatch just built this pass's bind group, which is what makes three
    // create the storage buffers - synchronously. Nothing reads their CPU side
    // back, so drop it. A `WorkBuffer` shared by several gathers releases on
    // whichever dispatches first; the rest find it settled.
    this.workBuffer.releaseCpuMirrors(renderer);
  }

  /**
   * Compiles this gather's compute pipeline without gathering anything.
   *
   * WebGPU compiles a compute pipeline lazily, at its first dispatch - not when
   * the node graph is built. Measured on a 13-mesh scene, a source's *first*
   * `gather` took up to 2.0s while every later dispatch of the same pipeline
   * took under 0.4ms, and because `gather` runs inside `update` that compile
   * landed whole in one render frame. Running it through the async path here
   * compiles off the critical frame, so the first real gather finds it ready.
   *
   * The dispatch targets {@link WorkBuffer.SCRATCH_SLOTS} past the drawable
   * capacity rather than dispatching zero workgroups: zero also compiles, but
   * WebGPU warns about it once per source, and writing into a drawn slot could
   * leave junk behind when a cached gather is reused instead of re-run.
   *
   * Best-effort: a failure here costs only the stall it was meant to avoid, so
   * callers may ignore it.
   */
  async warmUp(renderer: THREE.WebGPURenderer): Promise<void> {
    this.activeCount.value = 1;
    this.targetOffset.value = this.capacity;
    this.pass.count = 1;
    await renderer.computeAsync(this.pass);
    // Leave nothing that a later reuse check could mistake for real state.
    this.activeCount.value = 0;
    this.targetOffset.value = 0;
    // Warm-up is often the first dispatch of all, so this is usually where the
    // mirrors actually go.
    this.workBuffer.releaseCpuMirrors(renderer);
  }

  /** Releases the gather pipeline. The owner releases the storage attribute. */
  dispose(): void {
    this.pass.dispose();
  }
}
