/** Internal, opt-in SH preparation for standalone WebGPU meshes. */
import * as THREE from 'three/webgpu';
import { Fn, If, instanceIndex, int, ivec2, storage, textureLoad, uniform } from 'three/tsl';
import {
  boolUniform,
  evaluateSplatSh,
  type SplatShInputs,
  type Vec3Uniform,
} from './splat-mesh-material';
import { StorageMirrorReleaser } from './storage-attribute-mirror';
import { releaseRendererAttributes } from './compute-sorter';

/** Three scalar floats avoid vec3 storage's 16-byte array stride. */
export const SH_CACHE_BYTES_PER_SPLAT = 12;
export const SH_CACHE_SETTLE_MS = 150;

export class ShComputeCache {
  readonly contribution: THREE.StorageBufferAttribute;
  readonly pass: THREE.ComputeNode;
  readonly bytes: number;
  readonly enabled = boolUniform();
  private readonly mirrors: StorageMirrorReleaser;
  private readonly activeCount = uniform(0);
  private readonly previousCamera = new THREE.Vector3();
  private readonly observedCamera = new THREE.Vector3();
  private observedCameraValid = false;
  private lastMotionAt = Number.NEGATIVE_INFINITY;
  private previousContent = -1;
  private previousGraph = -1;
  private previousCount = -1;
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
    sourceIndex: THREE.StorageBufferAttribute;
    centersTexture: THREE.DataTexture;
    covarianceBTexture: THREE.DataTexture;
    dataTextureWidth: number;
    sh: SplatShInputs;
    localCameraPosition: Vec3Uniform;
  }) {
    this.bytes = options.capacity * SH_CACHE_BYTES_PER_SPLAT;
    this.contribution = new THREE.StorageBufferAttribute(new Float32Array(options.capacity * 3), 1);
    this.mirrors = new StorageMirrorReleaser([this.contribution]);
    const source = storage(options.sourceIndex, 'uint', options.sourceIndex.count).toReadOnly();
    const output = storage(this.contribution, 'float', options.capacity * 3);
    this.pass = Fn(() => {
      If(instanceIndex.lessThan(this.activeCount.toUint()), () => {
        const index = source.element(instanceIndex);
        const texel = ivec2(
          int(index).mod(int(options.dataTextureWidth)),
          int(index).div(int(options.dataTextureWidth)),
        );
        const center = textureLoad(options.centersTexture, texel).xyz;
        const rgb = evaluateSplatSh(
          options.sh,
          { covarianceBTexture: options.covarianceBTexture },
          texel,
          center.sub(options.localCameraPosition).normalize(),
        ).toVar();
        const offset = index.mul(3);
        output.element(offset).assign(rgb.x);
        output.element(offset.add(1)).assign(rgb.y);
        output.element(offset.add(2)).assign(rgb.z);
      });
    })().compute(1, [256]);
    this.pass.name = 'vlam-sh-contribution';
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
  ): 'cache' | 'cache-between-sorts' | 'vertex-motion' | 'idle' {
    if (this.disposed || activeCount === 0) return 'idle';
    const cameraMoved = this.observedCameraValid && !this.observedCamera.equals(camera);
    this.observedCamera.copy(camera);
    this.observedCameraValid = true;
    if (cameraMoved) {
      this.lastMotionAt = now;
    }
    const contentChanged =
      this.previousContent !== contentRevision || this.previousCount !== activeCount;
    const graphChanged = this.previousGraph !== graphRevision;
    if (cameraMoved && !force && !refreshForSort && !contentChanged && !graphChanged) {
      if (reuseBetweenSorts && this.valid) {
        this.enabled.value = true;
        this.diagnostics.sortCadenceDeferrals++;
        this.diagnostics.lastInvalidation = 'camera-position';
        this.diagnostics.phase = 'cache-between-sorts';
        return 'cache-between-sorts';
      }
      if (this.enabled.value) {
        this.diagnostics.invalidations++;
        this.diagnostics.motionFallbacks++;
      }
      this.enabled.value = false;
      this.diagnostics.lastInvalidation = 'camera-position';
      this.diagnostics.phase = 'vertex-motion';
      return 'vertex-motion';
    }
    const reason = !this.valid
      ? 'initial-or-view'
      : contentChanged
        ? 'content'
        : graphChanged
          ? 'graph'
          : !this.previousCamera.equals(camera)
            ? 'camera-position'
            : null;
    if (reason === null) {
      this.enabled.value = true;
      this.diagnostics.phase = 'cache';
      return 'cache';
    }
    if (
      reason === 'camera-position' &&
      !force &&
      !refreshForSort &&
      now - this.lastMotionAt < SH_CACHE_SETTLE_MS
    ) {
      if (reuseBetweenSorts && this.valid) {
        this.enabled.value = true;
        this.diagnostics.sortCadenceDeferrals++;
        this.diagnostics.phase = 'cache-between-sorts';
        return 'cache-between-sorts';
      }
      this.diagnostics.phase = 'vertex-motion';
      return 'vertex-motion';
    }
    this.activeCount.value = activeCount;
    this.pass.count = activeCount;
    renderer.compute(this.pass);
    this.mirrors.release(renderer);
    this.previousCamera.copy(camera);
    this.previousContent = contentRevision;
    this.previousGraph = graphRevision;
    this.previousCount = activeCount;
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
      cpuMirrorBytes: this.mirrors.pendingBytes,
      peakBytes: this.bytes * 2,
    };
  }

  dispose(renderer: THREE.WebGPURenderer): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pass.dispose();
    releaseRendererAttributes(renderer, [this.contribution]);
    this.contribution.array = new Float32Array(0);
  }
}
