import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  atomicAdd,
  atomicLoad,
  atomicStore,
  float,
  instanceIndex,
  int,
  ivec2,
  mat3,
  storage,
  textureLoad,
  uint,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import type { FloatUniform, Vec2Uniform } from './splat-material-types';
import {
  capProjectedEigenvaluesToScreenRadius,
  equalizeProjectedEigenvalues,
  filterSplatCovariance,
  isSplatFootprintInFrustum,
  projectedSplatAxes,
  projectedSplatEigenvalues,
  projectedSplatEigenvector,
  projectSplatCovariance,
  radSplatStdDev,
} from './splat-render-math';
import { MAX_SPLAT_RADIUS_PX } from './splat-frustum';
import { releaseRendererAttributes } from './compute-sorter';
import { StorageMirrorReleaser } from './storage-attribute-mirror';

/** Capacity-sized memory added by the experimental projection cache. */
export const PROJECTED_SPLAT_BYTES_PER_SLOT = 52;
/** Count plus dispatch and indexed-draw argument buffers. */
export const PROJECTED_SPLAT_FIXED_BYTES = 4 + 3 * 4 + 5 * 4;

export interface ProjectedSplatBuffers {
  /** Clip-space center, indexed by the gathered work-buffer slot. */
  readonly clipCenters: THREE.StorageBufferAttribute;
  /** major.xy, minor.xy in drawing-buffer pixels. */
  readonly axes: THREE.StorageBufferAttribute;
  /** opacity compensation, adjusted stddev, reserved, cached sort key. */
  readonly parameters: THREE.StorageBufferAttribute;
  /** Dense work-buffer indices, one entry per visible splat. */
  readonly visibleIndices: THREE.StorageBufferAttribute;
  /** Atomic visible count written by projection. */
  readonly visibleCount: THREE.StorageBufferAttribute;
  /** `[ceil(visibleCount / 256), 1, 1]`. */
  readonly dispatchArgs: THREE.IndirectStorageBufferAttribute;
  /** Indexed indirect args: six indices and the GPU-visible instance count. */
  readonly drawArgs: THREE.IndirectStorageBufferAttribute;
}

/**
 * Projects and footprint-culls a gathered unified work buffer exactly once per
 * splat. The dense list, sort key and indirect arguments never cross the CPU.
 */
export class ProjectedSplatPipeline {
  static readonly WORKGROUP_SIZE = 256;

  readonly buffers: ProjectedSplatBuffers;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly modelView = uniform(new THREE.Matrix4());
  private readonly projection = uniform(new THREE.Matrix4());
  private readonly resetPass: THREE.ComputeNode;
  private readonly projectPass: THREE.ComputeNode;
  private readonly compactPass: THREE.ComputeNode;
  private readonly finalizePass: THREE.ComputeNode;
  private readonly mirrors: StorageMirrorReleaser;
  private disposed = false;
  projectionDispatches = 0;

  constructor(options: {
    renderer: THREE.WebGPURenderer;
    capacity: number;
    centers: THREE.StorageBufferAttribute;
    colors: THREE.StorageBufferAttribute;
    covarianceA: THREE.StorageBufferAttribute;
    covarianceB: THREE.StorageBufferAttribute;
    focal: Vec2Uniform;
    viewport: Vec2Uniform;
    maxStdDev: FloatUniform;
    minSplatSizePx: FloatUniform;
    antialias: FloatUniform;
    projectedLowPassVariance: FloatUniform;
    compensateProjectedLowPass: FloatUniform;
    dofFocusDistance: FloatUniform;
    dofAperture: FloatUniform;
    sortMetric: 'depth' | 'radial';
  }) {
    this.renderer = options.renderer;
    const clipCenters = new THREE.StorageBufferAttribute(new Float32Array(options.capacity * 4), 4);
    const axes = new THREE.StorageBufferAttribute(new Float32Array(options.capacity * 4), 4);
    const parameters = new THREE.StorageBufferAttribute(new Float32Array(options.capacity * 4), 4);
    const visibleIndices = new THREE.StorageBufferAttribute(new Uint32Array(options.capacity), 1);
    const visibleCount = new THREE.StorageBufferAttribute(new Uint32Array(1), 1);
    const dispatchArgs = new THREE.IndirectStorageBufferAttribute(new Uint32Array(3), 1);
    const drawArgs = new THREE.IndirectStorageBufferAttribute(new Uint32Array(5), 1);
    this.buffers = {
      clipCenters,
      axes,
      parameters,
      visibleIndices,
      visibleCount,
      dispatchArgs,
      drawArgs,
    };
    const centerData = storage(options.centers, 'vec4', options.capacity);
    const colorData = storage(options.colors, 'vec4', options.capacity);
    const covAData = storage(options.covarianceA, 'vec4', options.capacity);
    const covBData = storage(options.covarianceB, 'vec4', options.capacity);
    const clipData = storage(clipCenters, 'vec4', options.capacity);
    const axesData = storage(axes, 'vec4', options.capacity);
    const parameterData = storage(parameters, 'vec4', options.capacity);
    const visibleData = storage(visibleIndices, 'uint', options.capacity);
    const counter = storage(visibleCount, 'uint', 1).toAtomic();
    const dispatch = storage(dispatchArgs, 'uint', 3);
    const draw = storage(drawArgs, 'uint', 5);

    this.resetPass = Fn(() => {
      If(instanceIndex.equal(uint(0)), () => {
        atomicStore(counter.element(0), uint(0));
        dispatch.element(0).assign(uint(0));
        dispatch.element(1).assign(uint(1));
        dispatch.element(2).assign(uint(1));
        draw.element(0).assign(uint(6));
        draw.element(1).assign(uint(0));
        draw.element(2).assign(uint(0));
        draw.element(3).assign(uint(0));
        draw.element(4).assign(uint(0));
      });
    })().compute(1, [1]);

    this.projectPass = Fn(() => {
      const workIndex = instanceIndex;
      const centerSample = centerData.element(workIndex);
      const viewCenter = this.modelView.mul(vec4(centerSample.xyz, 1)).toVar();
      const clipCenter = this.projection.mul(viewCenter).toVar();
      const covA = covAData.element(workIndex);
      const covB = covBData.element(workIndex);
      const covariance = mat3(
        vec3(covA.x, covA.y, covA.z),
        vec3(covA.y, covA.w, covB.x),
        vec3(covA.z, covB.x, covB.y),
      );
      const raw = projectSplatCovariance(
        covariance,
        viewCenter,
        options.focal,
        this.modelView.toMat3().transpose(),
      );
      const opacityCompensation = float(1).toVar();
      // Unified gather also packs these two scalars into covarianceB.zw so
      // this stage stays below WebGPU's portable 8-storage-buffer baseline.
      const isoMix = covB.z;
      const filtered = filterSplatCovariance(
        raw,
        {
          lowPassVariance: options.projectedLowPassVariance,
          compensate: options.antialias.max(options.compensateProjectedLowPass),
          isotropicMix: isoMix,
          viewZ: viewCenter.z,
          focalX: options.focal.x,
          focusDistance: options.dofFocusDistance,
          aperture: options.dofAperture,
        },
        opacityCompensation,
      );
      let { lambda1, lambda2 } = projectedSplatEigenvalues(filtered.a, filtered.b, filtered.d);
      const equalized = equalizeProjectedEigenvalues(lambda1, lambda2, isoMix);
      lambda1 = equalized.lambda1;
      lambda2 = equalized.lambda2;
      const capped = capProjectedEigenvaluesToScreenRadius(
        lambda1,
        lambda2,
        isoMix,
        covB.w,
        options.maxStdDev,
      );
      lambda1 = capped.lambda1;
      lambda2 = capped.lambda2;
      const stdDev = radSplatStdDev(colorData.element(workIndex).a, options.maxStdDev);
      const eigenvector = projectedSplatEigenvector(filtered.a, filtered.b, lambda1);
      const projectedAxes = projectedSplatAxes(
        eigenvector,
        lambda1,
        lambda2,
        stdDev,
        MAX_SPLAT_RADIUS_PX,
        options.minSplatSizePx,
      );
      const visible = centerSample.w
        .greaterThan(0)
        .and(
          isSplatFootprintInFrustum(
            clipCenter,
            options.viewport,
            projectedAxes.major,
            projectedAxes.minor,
          ),
        );
      {
        clipData.element(workIndex).assign(clipCenter);
        axesData.element(workIndex).assign(vec4(projectedAxes.major, projectedAxes.minor));
        const sortKey =
          options.sortMetric === 'radial' ? viewCenter.xyz.length().negate() : viewCenter.z;
        parameterData
          .element(workIndex)
          .assign(vec4(opacityCompensation, stdDev, visible.select(float(1), float(0)), sortKey));
      }
    })().compute(options.capacity, [ProjectedSplatPipeline.WORKGROUP_SIZE]);

    // A separate pass keeps projection at seven storage bindings. It consumes
    // only the visibility flag, dense list and counter (three bindings).
    this.compactPass = Fn(() => {
      If(parameterData.element(instanceIndex).z.greaterThan(0), () => {
        const destination = atomicAdd(counter.element(0), uint(1));
        visibleData.element(destination).assign(instanceIndex);
      });
    })().compute(options.capacity, [ProjectedSplatPipeline.WORKGROUP_SIZE]);

    this.finalizePass = Fn(() => {
      If(instanceIndex.equal(uint(0)), () => {
        const count = atomicLoad(counter.element(0));
        dispatch
          .element(0)
          .assign(
            count
              .add(uint(ProjectedSplatPipeline.WORKGROUP_SIZE - 1))
              .div(uint(ProjectedSplatPipeline.WORKGROUP_SIZE)),
          );
        draw.element(1).assign(count);
      });
    })().compute(1, [1]);

    this.mirrors = new StorageMirrorReleaser([
      clipCenters,
      axes,
      parameters,
      visibleIndices,
      visibleCount,
      dispatchArgs,
      drawArgs,
    ]);
  }

  prepare(modelView: THREE.Matrix4, projection: THREE.Matrix4, activeCount: number): void {
    if (this.disposed) return;
    this.modelView.value.copy(modelView);
    this.projection.value.copy(projection);
    this.projectPass.count = activeCount;
    this.compactPass.count = activeCount;
    this.renderer.compute(
      activeCount === 0
        ? [this.resetPass, this.finalizePass]
        : [this.resetPass, this.projectPass, this.compactPass, this.finalizePass],
    );
    this.projectionDispatches++;
    if (!this.mirrors.settled) this.mirrors.release(this.renderer);
  }

  async readVisibleCount(): Promise<number> {
    const bytes = await this.renderer.getArrayBufferAsync(this.buffers.visibleCount);
    return new Uint32Array(bytes)[0] ?? 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resetPass.dispose();
    this.projectPass.dispose();
    this.compactPass.dispose();
    this.finalizePass.dispose();
    releaseRendererAttributes(this.renderer, Object.values(this.buffers));
  }
}

export function estimateProjectedSplatSteadyBytes(capacity: number): number {
  if (!Number.isFinite(capacity) || capacity < 0) {
    throw new RangeError('Splat capacity must be a non-negative finite number.');
  }
  return Math.floor(capacity) * PROJECTED_SPLAT_BYTES_PER_SLOT + PROJECTED_SPLAT_FIXED_BYTES;
}

export function estimateProjectedSplatPeakBytes(capacity: number): number {
  return estimateProjectedSplatSteadyBytes(capacity) * 2;
}

/** Texture-backed counterpart used by an unmodified standalone SplatMesh. */
export class StandaloneProjectedSplatPipeline {
  readonly buffers: ProjectedSplatBuffers;
  private readonly modelView = uniform(new THREE.Matrix4());
  private readonly projection = uniform(new THREE.Matrix4());
  private readonly resetPass: THREE.ComputeNode;
  private readonly projectPass: THREE.ComputeNode;
  private readonly finalizePass: THREE.ComputeNode;
  private readonly mirrors: StorageMirrorReleaser;
  private disposed = false;
  projectionDispatches = 0;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    options: {
      capacity: number;
      sourceIndex: THREE.StorageBufferAttribute;
      centersTexture: THREE.DataTexture;
      colorsTexture: THREE.DataTexture;
      covarianceATexture: THREE.DataTexture;
      covarianceBTexture: THREE.DataTexture;
      dataTextureWidth: number;
      focal: Vec2Uniform;
      viewport: Vec2Uniform;
      maxStdDev: number;
      minSplatSizePx: number;
      antialias: boolean;
      projectedLowPassVariance: number;
      compensateProjectedLowPass: boolean;
      dofFocusDistance: FloatUniform;
      dofAperture: FloatUniform;
      maxAspect: number;
      lodAlpha: boolean;
      performanceProfile: 'quality' | 'smooth';
      sortMetric: 'depth' | 'radial';
    },
  ) {
    const clipCenters = new THREE.StorageBufferAttribute(new Float32Array(options.capacity * 4), 4);
    const axes = new THREE.StorageBufferAttribute(new Float32Array(options.capacity * 4), 4);
    const parameters = new THREE.StorageBufferAttribute(new Float32Array(options.capacity * 4), 4);
    const visibleIndices = new THREE.StorageBufferAttribute(new Uint32Array(options.capacity), 1);
    const visibleCount = new THREE.StorageBufferAttribute(new Uint32Array(1), 1);
    const dispatchArgs = new THREE.IndirectStorageBufferAttribute(new Uint32Array(3), 1);
    const drawArgs = new THREE.IndirectStorageBufferAttribute(new Uint32Array(5), 1);
    this.buffers = {
      clipCenters,
      axes,
      parameters,
      visibleIndices,
      visibleCount,
      dispatchArgs,
      drawArgs,
    };
    const source = storage(options.sourceIndex, 'uint', options.capacity);
    const clipData = storage(clipCenters, 'vec4', options.capacity);
    const axesData = storage(axes, 'vec4', options.capacity);
    const parameterData = storage(parameters, 'vec4', options.capacity);
    const visibleData = storage(visibleIndices, 'uint', options.capacity);
    const counter = storage(visibleCount, 'uint', 1).toAtomic();
    const dispatch = storage(dispatchArgs, 'uint', 3);
    const draw = storage(drawArgs, 'uint', 5);
    this.resetPass = Fn(() => {
      atomicStore(counter.element(0), uint(0));
      dispatch.element(0).assign(uint(0));
      dispatch.element(1).assign(uint(1));
      dispatch.element(2).assign(uint(1));
      draw.element(0).assign(uint(6));
      draw.element(1).assign(uint(0));
      draw.element(2).assign(uint(0));
      draw.element(3).assign(uint(0));
      draw.element(4).assign(uint(0));
    })().compute(1, [1]);
    this.projectPass = Fn(() => {
      const poolIndex = source.element(instanceIndex);
      const index = int(poolIndex);
      const texel = ivec2(
        index.mod(int(options.dataTextureWidth)),
        index.div(int(options.dataTextureWidth)),
      );
      const center = textureLoad(options.centersTexture, texel).xyz;
      const viewCenter = this.modelView.mul(vec4(center, 1)).toVar();
      const clipCenter = this.projection.mul(viewCenter).toVar();
      const covA = textureLoad(options.covarianceATexture, texel);
      const covB = textureLoad(options.covarianceBTexture, texel);
      const covariance = mat3(
        vec3(covA.x, covA.y, covA.z),
        vec3(covA.y, covA.w, covB.x),
        vec3(covA.z, covB.x, covB.y),
      );
      const raw = projectSplatCovariance(
        covariance,
        viewCenter,
        options.focal,
        this.modelView.toMat3().transpose(),
      );
      const opacityCompensation = float(1).toVar();
      const filtered = filterSplatCovariance(
        raw,
        {
          lowPassVariance: options.projectedLowPassVariance,
          compensate: options.compensateProjectedLowPass || options.antialias,
          isotropicMix: null,
          viewZ: viewCenter.z,
          focalX: options.focal.x,
          focusDistance: options.dofFocusDistance,
          aperture: options.dofAperture,
        },
        opacityCompensation,
      );
      const { lambda1, lambda2 } = projectedSplatEigenvalues(filtered.a, filtered.b, filtered.d);
      const majorLambda =
        options.maxAspect > 0
          ? lambda1.min(lambda2.mul(options.maxAspect * options.maxAspect))
          : lambda1;
      const originalAlpha = textureLoad(options.colorsTexture, texel).a;
      const stdDev = options.lodAlpha
        ? radSplatStdDev(originalAlpha.mul(2), float(options.maxStdDev))
        : float(options.maxStdDev);
      const eigenvector = projectedSplatEigenvector(filtered.a, filtered.b, lambda1);
      const projectedAxes = projectedSplatAxes(
        eigenvector,
        majorLambda,
        lambda2,
        stdDev,
        MAX_SPLAT_RADIUS_PX,
        float(options.minSplatSizePx),
      );
      const footprintVisible = isSplatFootprintInFrustum(
        clipCenter,
        options.viewport,
        projectedAxes.major,
        projectedAxes.minor,
      );
      const contributionVisible =
        options.performanceProfile === 'smooth'
          ? originalAlpha
              .greaterThanEqual(1 / 255)
              .and(
                projectedAxes.major
                  .length()
                  .max(projectedAxes.minor.length())
                  .mul(2)
                  .greaterThanEqual(2),
              )
              .and(
                originalAlpha
                  .mul(projectedAxes.major.length())
                  .mul(projectedAxes.minor.length())
                  .greaterThanEqual(3),
              )
          : float(1).greaterThan(0);
      If(footprintVisible.and(contributionVisible), () => {
        clipData.element(poolIndex).assign(clipCenter);
        axesData.element(poolIndex).assign(vec4(projectedAxes.major, projectedAxes.minor));
        const sortKey =
          options.sortMetric === 'radial' ? viewCenter.xyz.length().negate() : viewCenter.z;
        parameterData.element(poolIndex).assign(vec4(opacityCompensation, stdDev, 0, sortKey));
        const destination = atomicAdd(counter.element(0), uint(1));
        visibleData.element(destination).assign(poolIndex);
      });
    })().compute(options.capacity, [ProjectedSplatPipeline.WORKGROUP_SIZE]);
    this.finalizePass = Fn(() => {
      const count = atomicLoad(counter.element(0));
      dispatch
        .element(0)
        .assign(
          count
            .add(uint(ProjectedSplatPipeline.WORKGROUP_SIZE - 1))
            .div(uint(ProjectedSplatPipeline.WORKGROUP_SIZE)),
        );
      draw.element(1).assign(count);
    })().compute(1, [1]);
    this.mirrors = new StorageMirrorReleaser(Object.values(this.buffers));
  }

  prepare(modelView: THREE.Matrix4, projection: THREE.Matrix4, activeCount: number): void {
    if (this.disposed) return;
    this.modelView.value.copy(modelView);
    this.projection.value.copy(projection);
    this.projectPass.count = activeCount;
    this.renderer.compute(
      activeCount === 0
        ? [this.resetPass, this.finalizePass]
        : [this.resetPass, this.projectPass, this.finalizePass],
    );
    this.projectionDispatches++;
    if (!this.mirrors.settled) this.mirrors.release(this.renderer);
  }

  async readVisibleCount(): Promise<number> {
    const bytes = await this.renderer.getArrayBufferAsync(this.buffers.visibleCount);
    return new Uint32Array(bytes)[0] ?? 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resetPass.dispose();
    this.projectPass.dispose();
    this.finalizePass.dispose();
    releaseRendererAttributes(this.renderer, Object.values(this.buffers));
  }
}
