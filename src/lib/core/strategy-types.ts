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

/** Runtime signals supplied to an automatic projection strategy. */
export interface AutomaticProjectionPolicyInput {
  readonly capacity: number;
  readonly hasSh: boolean;
  readonly hasBalancedContributionCulls: boolean;
  readonly isStatic: boolean;
  readonly ownsPool: boolean;
  readonly isWebGpu: boolean;
  readonly isXr: boolean;
  readonly isUnifiedSource: boolean;
  readonly hasSourcePlacement: boolean;
  readonly hasModifiers: boolean;
  readonly usesCountingSort: boolean;
  readonly usesFoveation: boolean;
  readonly gpuClass: 'discrete' | 'integrated' | 'fallback' | undefined;
  readonly isValidatedDeviceClass: boolean;
  readonly isMobile: boolean;
}

/** Result returned by an automatic projection strategy. */
export interface AutomaticProjectionPolicyResult {
  readonly strategy: 'vertex' | 'compute';
  readonly reason: string;
  readonly requiredMemoryBytes: number;
}

/** Additional memory retained or temporarily allocated by a projector. */
export interface ProjectionMemoryEstimate {
  readonly steadyGpu: number;
  readonly peakCpuAndGpu: number;
}

/** Compute-projection modes exposed by the optional projection entry. */
export type ComputeProjectionMode = 'explicit' | 'auto';

/** An experimental projector supplied by `@voluma/vlam/projection/compute`. */
export interface ComputeProjectionStrategy {
  readonly kind: 'compute';
  readonly mode: ComputeProjectionMode;
  estimateMemoryBytes(capacity: number): ProjectionMemoryEstimate;
  resolveAutomatic(input: AutomaticProjectionPolicyInput): AutomaticProjectionPolicyResult;
  createStandalone(options: StandaloneProjectionOptions): ProjectedSplatPipeline;
  createUnified(options: UnifiedProjectionOptions): ProjectedSplatPipeline;
}

/** Projection strategies built into the lightweight viewer or injected as add-ons. */
export type SplatProjectionStrategy = 'vertex' | ComputeProjectionStrategy;

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
export function sortStrategyLabel(
  strategy: SplatSortStrategy,
): 'counting' | 'worker' | 'radix' | 'exact' {
  if (strategy === 'counting' || strategy === 'worker') return strategy;
  return strategy.exactDepth ? 'exact' : 'radix';
}

/** Built-in names plus injected radix factories from `@voluma/vlam/sorting/radix`. */
export function isSplatSortStrategy(strategy: unknown): strategy is SplatSortStrategy {
  if (strategy === 'counting' || strategy === 'worker') return true;
  if (typeof strategy !== 'object' || strategy === null) return false;
  const candidate = strategy as SplatSortStrategyFactory;
  return (
    candidate.kind === 'radix' &&
    typeof candidate.exactDepth === 'boolean' &&
    typeof candidate.create === 'function'
  );
}

/**
 * Rejects the former `'radix'` / `'exact'` string names. Those implementations
 * live behind `radixSort()` / `exactSort()` from `@voluma/vlam/sorting/radix`.
 * Leftover strings selected counting sort in 0.10.1.
 */
export function assertSplatSortStrategy(
  strategy: unknown,
  where: string,
): asserts strategy is SplatSortStrategy {
  if (isSplatSortStrategy(strategy)) return;
  const label = typeof strategy === 'string' ? JSON.stringify(strategy) : typeof strategy;
  throw new RangeError(
    `${where}: unsupported sortStrategy ${label}. Pass radixSort() or exactSort() from @voluma/vlam/sorting/radix.`,
  );
}
