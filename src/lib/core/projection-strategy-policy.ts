/** Conservative one-time policy for the experimental compute projection path. */
import { PROJECTED_SPLAT_BYTES_PER_SLOT } from './projected-splat-pipeline';
import { estimateComputeSorterPeakBytes } from './compute-sorter';

/** The only measured automatic cohort is the 8.72M-splat Langenthal capture. */
export const AUTO_PROJECTION_MIN_SPLATS = 8_000_000;
/**
 * Conservative cap for projection plus cached SH allocations on an identified
 * desktop dGPU. It is an application policy, never a claim about available VRAM.
 */
export const DEFAULT_AUTO_PROJECTION_MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;

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
  /** `undefined` deliberately remains conservative: adapter identity was hidden. */
  readonly gpuClass: 'discrete' | 'integrated' | 'fallback' | undefined;
  /** The adapter class has a qualifying device measurement, not merely a GPU class. */
  readonly isValidatedDeviceClass: boolean;
  readonly isMobile: boolean;
  readonly memoryBudgetBytes: number;
}

export interface AutomaticProjectionPolicyResult {
  readonly strategy: 'vertex' | 'compute';
  readonly reason: string;
  /** Projection, projected-sorter, and padded RGBA8 SH-cache peak. */
  readonly requiredMemoryBytes: number;
}

/** Prices every allocation the automatic compute-and-cache path adds to a mesh. */
export function estimateAutomaticProjectionMemoryBytes(capacity: number): number {
  if (!Number.isFinite(capacity) || capacity < 0) {
    throw new RangeError('Splat capacity must be a non-negative finite number.');
  }
  const splats = Math.floor(capacity);
  // The cache has one RGBA8 texel per 2048-wide pool row, including row padding.
  const shCacheBytes = Math.ceil(splats / 2048) * 2048 * 4;
  // Storage-attribute mirrors coexist with the GPU buffers until the first
  // successful submission retires them, so price the observable peak rather
  // than treating retained GPU buffers as the whole allocation.
  // Compute projection creates its own dense-list counting sorter. Its bucket
  // buffer/histogram are not part of the vertex-path sorter and its CPU mirrors
  // coexist with their first GPU upload, so omitting them can accept a policy
  // decision that exceeds the caller's stated cap.
  return (
    splats * PROJECTED_SPLAT_BYTES_PER_SLOT * 2 +
    estimateComputeSorterPeakBytes(splats) +
    shCacheBytes
  );
}

/**
 * Chooses only the cohort measured with compute projection plus the SH cache.
 * Every unknown or unmeasured case remains on the established vertex path.
 */
export function resolveAutomaticProjectionStrategy(
  input: AutomaticProjectionPolicyInput,
): AutomaticProjectionPolicyResult {
  const requiredMemoryBytes = estimateAutomaticProjectionMemoryBytes(input.capacity);
  const vertex = (reason: string): AutomaticProjectionPolicyResult => ({
    strategy: 'vertex',
    reason,
    requiredMemoryBytes,
  });
  if (!input.isWebGpu) return vertex('auto-webgl');
  if (input.isXr) return vertex('auto-xr');
  if (input.isUnifiedSource) return vertex('auto-unified-source');
  if (!input.isStatic || !input.ownsPool) return vertex('auto-dynamic-or-shared-pool');
  if (input.hasSourcePlacement) return vertex('auto-source-placement');
  if (input.hasModifiers) return vertex('auto-modifiers');
  if (!input.usesCountingSort) return vertex('auto-sort-strategy');
  if (input.usesFoveation) return vertex('auto-foveation');
  if (input.isMobile) return vertex('auto-mobile-device');
  if (input.gpuClass === undefined) return vertex('auto-unknown-device');
  if (input.gpuClass !== 'discrete') return vertex('auto-nondiscrete-device');
  if (!input.isValidatedDeviceClass) return vertex('auto-unvalidated-device-class');
  if (input.capacity < AUTO_PROJECTION_MIN_SPLATS) return vertex('auto-small-static-scene');
  if (!input.hasSh) return vertex('auto-no-sh');
  if (!input.hasBalancedContributionCulls) return vertex('auto-full-detail');
  if (requiredMemoryBytes > input.memoryBudgetBytes) return vertex('auto-memory-budget');
  return { strategy: 'compute', reason: 'auto-large-static-discrete-sh', requiredMemoryBytes };
}
