/** Internal, opt-in SH preparation for standalone WebGPU meshes. */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  atomicLoad,
  instanceIndex,
  int,
  ivec2,
  storage,
  textureLoad,
  textureStore,
  vec4,
} from 'three/tsl';
import {
  boolUniform,
  evaluateSplatSh,
  type SplatShInputs,
  type Vec3Uniform,
  type Vec2Uniform,
} from './splat-mesh-material';
import { isSplatCenterInFrustum } from './splat-frustum';

/** One final-color RGBA8 storage-texture texel per pool splat. */
export const SH_CACHE_BYTES_PER_SPLAT = 4;
export const SH_CACHE_SETTLE_MS = 150;

export class ShComputeCache {
  readonly finalColor: THREE.Texture;
  readonly pass: THREE.ComputeNode;
  /** Camera/view refresh over the projector's GPU-visible pool indices. */
  private readonly visiblePass: THREE.ComputeNode | null;
  private readonly visibleDispatchArgs: THREE.IndirectStorageBufferAttribute | null;
  readonly bytes: number;
  readonly enabled = boolUniform();
  private readonly cullToView = boolUniform();
  private readonly localViewProjection: THREE.UniformNode<'mat4', THREE.Matrix4>;
  private readonly previousCamera = new THREE.Vector3();
  private readonly observedCamera = new THREE.Vector3();
  private readonly previousViewProjection = new THREE.Matrix4();
  private readonly frustumMargin: Vec2Uniform;
  private readonly previousFrustumMargin = new THREE.Vector2();
  private observedCameraValid = false;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
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
    viewCadenceRefreshes: 0,
    visibleListRefreshes: 0,
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
    frustumMargin: Vec2Uniform;
    /** Projector output; absent on the established vertex-projection path. */
    visibleIndices?: THREE.StorageBufferAttribute;
    visibleCount?: THREE.StorageBufferAttribute;
    visibleDispatchArgs?: THREE.IndirectStorageBufferAttribute;
  }) {
    this.bytes = options.capacity * SH_CACHE_BYTES_PER_SPLAT;
    this.localViewProjection = options.localViewProjection;
    this.frustumMargin = options.frustumMargin;
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
      // Use the display's cap-aware broad bound: a center outside the screen
      // can still contribute a large visible splat whose SH must be refreshed.
      const visible = isSplatCenterInFrustum(clipCenter, options.frustumMargin);
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
    this.visibleDispatchArgs = options.visibleDispatchArgs ?? null;
    if (options.visibleIndices && options.visibleCount && this.visibleDispatchArgs) {
      const visibleIndices = storage(options.visibleIndices, 'uint', options.capacity);
      const visibleCount = storage(options.visibleCount, 'uint', 1).toAtomic();
      const visiblePass = Fn(() => {
        // The indirect dispatch rounds up to a workgroup. Keep the tail from
        // indexing the dense list past the projector's GPU-written count.
        If(instanceIndex.lessThan(atomicLoad(visibleCount.element(0))), () => {
          const poolIndex = visibleIndices.element(instanceIndex);
          const index = int(poolIndex);
          const pixel = ivec2(
            index.mod(int(options.dataTextureWidth)),
            index.div(int(options.dataTextureWidth)),
          );
          const base = textureLoad(options.colorsTexture, pixel);
          const center = textureLoad(options.centersTexture, pixel).xyz;
          const rgb = evaluateSplatSh(
            options.sh,
            { covarianceBTexture: options.covarianceBTexture },
            pixel,
            center.sub(options.localCameraPosition).normalize(),
          );
          textureStore(output, pixel, vec4(base.rgb.add(rgb).clamp(0, 1), base.a));
        });
      })().compute(1, [256]);
      // The public TSL typing accepts a scalar count, while the WebGPU backend
      // also accepts an indirect dispatch attribute. Clear that scalar before
      // first compilation so it does not inject a one-invocation early return;
      // `renderer.compute(visiblePass, dispatchArgs)` supplies the dimensions.
      visiblePass.count = null;
      visiblePass.dispatchSize = [1, 1, 1];
      this.visiblePass = visiblePass;
      this.visiblePass.name = 'vlam-sh-final-color-visible';
    } else {
      this.visiblePass = null;
    }
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
    const cameraMovedThisFrame = this.observedCameraValid && !this.observedCamera.equals(camera);
    this.observedCamera.copy(camera);
    this.observedCameraValid = true;
    const contentChanged =
      this.previousContent !== contentRevision || this.previousCount !== activeCount;
    const graphChanged = this.previousGraph !== graphRevision;
    const cameraChangedSinceCache = !this.previousCamera.equals(camera);
    // A smaller render target widens the cap's NDC coverage even when camera
    // pose, aspect and projection are unchanged (e.g. adaptive pixel ratio).
    const viewChangedSinceCache =
      !this.previousViewProjection.equals(this.localViewProjection.value) ||
      !this.previousFrustumMargin.equals(this.frustumMargin.value);
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
      (cameraMovedThisFrame || now - this.lastRefreshAt < SH_CACHE_SETTLE_MS)
    ) {
      this.enabled.value = true;
      this.diagnostics.sortCadenceDeferrals++;
      this.diagnostics.lastInvalidation = 'camera-or-view';
      this.diagnostics.phase = 'cache-between-sorts';
      return 'cache-between-sorts';
    }
    // Projection has already compacted the exact draw survivors and written
    // an indirect workgroup count. Refreshing only that list avoids walking a
    // multi-million-slot SH texture for a small view. The full path remains
    // mandatory for initial/content/graph refreshes, where every pool-indexed
    // entry must become valid before it can first enter the view.
    const refreshVisibleList = reason === 'camera-or-view' && this.visiblePass !== null;
    this.cullToView.value = reason === 'camera-or-view' && !refreshVisibleList;
    if (refreshVisibleList) {
      renderer.compute(this.visiblePass, this.visibleDispatchArgs!);
      this.diagnostics.visibleListRefreshes++;
    } else {
      renderer.compute(this.pass);
    }
    if (reason === 'camera-or-view' && !refreshForSort) {
      this.diagnostics.viewCadenceRefreshes++;
    }
    this.lastRefreshAt = now;
    this.previousCamera.copy(camera);
    this.previousViewProjection.copy(this.localViewProjection.value);
    this.previousFrustumMargin.copy(this.frustumMargin.value);
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
    this.visiblePass?.dispose();
    this.finalColor.dispose();
  }
}
