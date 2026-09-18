import type * as THREE from 'three/webgpu';
import type { PerSourceSortTransform } from './compute-sorter';
import type { FloatUniform, SplatShInputs, Vec2Uniform, Vec3Uniform } from './splat-material-types';
import type { SplatSortMetric } from './splat-mesh-types';
import type { SplatSortRange } from './splat-sort-bounds';

/** The sorter inputs supplied by a standalone or unified mesh. */
export interface SplatSorterOptions {
  renderer: THREE.WebGPURenderer;
  capacity: number;
  centersTexture?: THREE.DataTexture;
  dataTextureWidth?: number;
  centersBuffer?: THREE.StorageBufferAttribute;
  perSource?: PerSourceSortTransform;
  splatIndexAttribute: THREE.StorageInstancedBufferAttribute;
  sourceIndexAttribute: THREE.StorageBufferAttribute;
  exactDepth?: boolean;
  sortMetric?: SplatSortMetric;
}

/** The implementation contract shared by all mesh sorters. */
export interface SplatSorter {
  readonly kind: 'counting' | 'radix' | 'worker';
  readonly submissionCount?: number;
  readonly passCount?: number;
  sort(
    modelView: THREE.Matrix4,
    activeCount: number,
    bounds: THREE.Sphere,
    visibleRange?: SplatSortRange | null,
  ): boolean;
  dispose(): void;
}

/** An experimental sorter supplied by `@voluma/vlam/sorting/radix`. */
export interface SplatSortStrategyFactory {
  readonly kind: 'radix';
  readonly exactDepth: boolean;
  create(options: SplatSorterOptions): SplatSorter;
}

/** Sort strategies built into the lightweight viewer or injected as add-ons. */
export type SplatSortStrategy = 'counting' | 'worker' | SplatSortStrategyFactory;

/** GPU buffers shared by standalone and unified projection pipelines. */
export interface ProjectedSplatBuffers {
  readonly clipCenters: THREE.StorageBufferAttribute;
  readonly axes: THREE.StorageBufferAttribute;
  readonly parameters: THREE.StorageBufferAttribute;
  readonly visibleIndices: THREE.StorageBufferAttribute;
  readonly visibleCount: THREE.StorageBufferAttribute;
  readonly dispatchArgs: THREE.IndirectStorageBufferAttribute;
  readonly drawArgs: THREE.IndirectStorageBufferAttribute;
}

/** The pipeline contract consumed by mesh lifecycle and fallback code. */
export interface ProjectedSplatPipeline {
  readonly buffers: ProjectedSplatBuffers;
  readonly packedColor: boolean;
  projectionDispatches: number;
  prepare(modelView: THREE.Matrix4, projection: THREE.Matrix4, activeCount: number): void;
  readVisibleCount(): Promise<number>;
  dispose(): void;
}

/** Inputs used when an injected strategy creates a standalone projector. */
export interface StandaloneProjectionOptions {
  renderer: THREE.WebGPURenderer;
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
  minPixelSize: number;
  minContribution: number;
  sortMetric: SplatSortMetric;
  localCameraPosition: Vec3Uniform;
  sh: SplatShInputs | null;
}

/** Inputs used when an injected strategy creates a unified projector. */
export interface UnifiedProjectionOptions {
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
  minPixelSize: number;
  minContribution: number;
  sortMetric: SplatSortMetric;
}

/** Compute-projection modes exposed by the optional projection entry. */
export type ComputeProjectionMode = 'explicit' | 'auto';

/** An experimental projector supplied by `@voluma/vlam/projection/compute`. */
export interface ComputeProjectionStrategy {
  readonly kind: 'compute';
  readonly mode: ComputeProjectionMode;
  readonly memoryBudgetBytes: number;
  createStandalone(options: StandaloneProjectionOptions): ProjectedSplatPipeline;
  createUnified(options: UnifiedProjectionOptions): ProjectedSplatPipeline;
}

/** Projection strategies built into the lightweight viewer or injected as add-ons. */
export type SplatProjectionStrategy = 'vertex' | ComputeProjectionStrategy;

/** Capacity-sized memory added by the experimental projection cache. */
export const PROJECTED_SPLAT_BYTES_PER_SLOT = 52;
/** Counter and indirect-argument buffers retained by the projector. */
export const PROJECTED_SPLAT_FIXED_BYTES = 4 + 3 * 4 + 5 * 4;

/** Estimates the steady projection allocation for a mesh capacity. */
export function estimateProjectedSplatSteadyBytes(capacity: number): number {
  if (!Number.isFinite(capacity) || capacity < 0) {
    throw new RangeError('Splat capacity must be a non-negative finite number.');
  }
  return Math.floor(capacity) * PROJECTED_SPLAT_BYTES_PER_SLOT + PROJECTED_SPLAT_FIXED_BYTES;
}

/** Estimates the first-use projection allocation while CPU mirrors coexist. */
export function estimateProjectedSplatPeakBytes(capacity: number): number {
  return estimateProjectedSplatSteadyBytes(capacity) * 2;
}

/** Returns true for an injected compute projection strategy. */
export function isComputeProjectionStrategy(
  strategy: SplatProjectionStrategy,
): strategy is ComputeProjectionStrategy {
  return typeof strategy !== 'string' && strategy.kind === 'compute';
}

/** Returns true when an injected compute strategy requests device selection. */
export function isAutomaticProjectionStrategy(strategy: SplatProjectionStrategy): boolean {
  return isComputeProjectionStrategy(strategy) && strategy.mode === 'auto';
}

/** Returns the public label used by diagnostics and memory accounting. */
export function sortStrategyLabel(strategy: SplatSortStrategy): 'counting' | 'worker' | 'radix' | 'exact' {
  if (strategy === 'counting' || strategy === 'worker') return strategy;
  return strategy.exactDepth ? 'exact' : 'radix';
}
