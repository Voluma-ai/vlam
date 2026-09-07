/** Internal, opt-in SH preparation for standalone WebGPU meshes. */
import * as THREE from 'three/webgpu';
import { Fn, If, instanceIndex, int, ivec2, textureLoad, textureStore, vec4 } from 'three/tsl';
import {
  boolUniform,
  evaluateSplatSh,
  type SplatShInputs,
  type Vec3Uniform,
} from './splat-mesh-material';

/** One final-color RGBA8 storage-texture texel per pool splat. */
export const SH_CACHE_BYTES_PER_SPLAT = 4;
export const SH_CACHE_SETTLE_MS = 150;

export class ShComputeCache {
  readonly finalColor: THREE.Texture;
  readonly pass: THREE.ComputeNode;
  readonly bytes: number;
  readonly enabled = boolUniform();
  private readonly cullToView = boolUniform();
  private readonly localViewProjection: THREE.UniformNode<'mat4', THREE.Matrix4>;
  private readonly previousCamera = new THREE.Vector3();
  private readonly observedCamera = new THREE.Vector3();
  private readonly previousViewProjection = new THREE.Matrix4();
  private readonly observedViewProjection = new THREE.Matrix4();
  private observedCameraValid = false;
  private observedViewValid = false;
  private lastMotionAt = Number.NEGATIVE_INFINITY;
  private previousContent = -1;
  private previousGraph = -1;
  private previousCount = -1;
  private completeForCamera = false;
  private valid = false;
  private disposed = false;
  readonly diagnostics = {
    dispatches: 0,
    invalidations: 0,
    motionFallbacks: 0,
    sortCadenceDeferrals: 0,
    lastInvalidation: 'initial',
    phase: 'unprepared',
  };

  constructor(options: {
    capacity: number;
    centersTexture: THREE.DataTexture;
    colorsTexture: THREE.DataTexture;
    covarianceBTexture: THREE.DataTexture;
    dataTextureWidth: number;
    sh: SplatShInputs;
    localCameraPosition: Vec3Uniform;
    localViewProjection: THREE.UniformNode<'mat4', THREE.Matrix4>;
  }) {
    this.bytes = options.capacity * SH_CACHE_BYTES_PER_SPLAT;
    this.localViewProjection = options.localViewProjection;
    const height = Math.ceil(options.capacity / options.dataTextureWidth);
    const output = new THREE.StorageTexture(options.dataTextureWidth, height);
    output.name = 'vlam-sh-final-color';
    output.type = THREE.UnsignedByteType;
    output.format = THREE.RGBAFormat;
    output.colorSpace = THREE.NoColorSpace;
    output.minFilter = THREE.NearestFilter;
    output.magFilter = THREE.NearestFilter;
    output.generateMipmaps = false;
    (output as THREE.StorageTexture & { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false;
    this.finalColor = output;
    this.pass = Fn(() => {
      const pixel = ivec2(
        int(instanceIndex).mod(int(options.dataTextureWidth)),
        int(instanceIndex).div(int(options.dataTextureWidth)),
      );
      const base = textureLoad(options.colorsTexture, pixel);
      const center = textureLoad(options.centersTexture, pixel).xyz;
      const clipCenter = options.localViewProjection.mul(vec4(center, 1));
      const margin = clipCenter.w.mul(1.2);
      const visible = clipCenter.z
        .greaterThan(margin.negate())
        .and(clipCenter.z.lessThan(clipCenter.w))
        .and(clipCenter.x.abs().lessThan(margin))
        .and(clipCenter.y.abs().lessThan(margin));
      If(this.cullToView.not().or(visible), () => {
        const rgb = evaluateSplatSh(
          options.sh,
          { covarianceBTexture: options.covarianceBTexture },
          pixel,
          center.sub(options.localCameraPosition).normalize(),
        );
        textureStore(output, pixel, vec4(base.rgb.add(rgb).clamp(0, 1), base.a));
      });
    })().compute(options.capacity, [256]);
    this.pass.name = 'vlam-sh-final-color';
  }

  /** Source order is deliberately absent: a sort never changes pool-indexed colors. */
  prepare(
    renderer: THREE.WebGPURenderer,
    activeCount: number,
    camera: THREE.Vector3,
    contentRevision: number,
    graphRevision: number,
    now = performance.now(),
    force = false,
    refreshForSort = false,
    reuseBetweenSorts = false,
  ): 'cache' | 'cache-between-sorts' | 'idle' {
    if (this.disposed || activeCount === 0) return 'idle';
    const cameraMoved = this.observedCameraValid && !this.observedCamera.equals(camera);
    const viewMoved =
      this.observedViewValid && !this.observedViewProjection.equals(this.localViewProjection.value);
    this.observedCamera.copy(camera);
    this.observedViewProjection.copy(this.localViewProjection.value);
    this.observedCameraValid = true;
    this.observedViewValid = true;
    if (cameraMoved || viewMoved) {
      this.lastMotionAt = now;
    }
    const contentChanged =
      this.previousContent !== contentRevision || this.previousCount !== activeCount;
    const graphChanged = this.previousGraph !== graphRevision;
    const cameraChangedSinceCache = !this.previousCamera.equals(camera);
    const viewChangedSinceCache = !this.previousViewProjection.equals(
      this.localViewProjection.value,
    );
    const reason = !this.valid
      ? 'initial-or-view'
      : contentChanged
        ? 'content'
        : graphChanged
          ? 'graph'
          : cameraChangedSinceCache || (!this.completeForCamera && viewChangedSinceCache)
            ? 'camera-or-view'
            : null;
    if (reason === null) {
      // A full cache is valid from every orientation at the same camera
      // position. Keep the observed matrix current without regenerating SH.
      if (this.completeForCamera) {
        this.previousViewProjection.copy(this.localViewProjection.value);
      }
      this.enabled.value = true;
      this.diagnostics.phase = 'cache';
      return 'cache';
    }
    if (
      reason === 'camera-or-view' &&
      !force &&
      !refreshForSort &&
      reuseBetweenSorts &&
      this.valid &&
      now - this.lastMotionAt < SH_CACHE_SETTLE_MS
    ) {
      this.enabled.value = true;
      this.diagnostics.sortCadenceDeferrals++;
      this.diagnostics.lastInvalidation = 'camera-or-view';
      this.diagnostics.phase = 'cache-between-sorts';
      return 'cache-between-sorts';
    }
    this.cullToView.value = reason === 'camera-or-view';
    renderer.compute(this.pass);
    this.previousCamera.copy(camera);
    this.previousViewProjection.copy(this.localViewProjection.value);
    this.previousContent = contentRevision;
    this.previousGraph = graphRevision;
    this.previousCount = activeCount;
    this.completeForCamera = reason !== 'camera-or-view';
    this.valid = true;
    this.enabled.value = true;
    this.diagnostics.dispatches++;
    this.diagnostics.invalidations++;
    this.diagnostics.lastInvalidation = reason;
    this.diagnostics.phase = 'cache';
    return 'cache';
  }

  invalidate(): void {
    this.valid = false;
    this.enabled.value = false;
  }

  snapshot() {
    return {
      ...this.diagnostics,
      gpuBytes: this.bytes,
      cpuMirrorBytes: 0,
      peakBytes: this.bytes,
    };
  }

  dispose(renderer: THREE.WebGPURenderer): void {
    if (this.disposed) return;
    this.disposed = true;
    void renderer;
    this.pass.dispose();
    this.finalColor.dispose();
  }
}
