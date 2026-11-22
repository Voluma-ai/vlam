/** Conservative one-time policy for the experimental compute projection path. */
import { estimateComputeSorterPeakBytes } from './compute-sorter';
import { PROJECTED_SPLAT_BYTES_PER_SLOT } from './projected-splat-pipeline';
import type {
  AutomaticProjectionPolicyInput as ProjectionPolicySignals,
  AutomaticProjectionPolicyResult,
} from './strategy-types';

/** The measured discrete-GPU automatic cohort is a static SH capture of at least 8 million splats. */
export const AUTO_PROJECTION_MIN_SPLATS = 8_000_000;
/**
 * Smallest static scene the Apple Silicon Mac cohort projects with compute. Measured
 * 2026-11-21 on an Apple M3 (16 GB, Chromium WebGPU, demo defaults: `quality`
 * profile, counting sort, DPR 2, orbiting): a 3,994,523-splat SH3 SOG went from
 * 13.7 to 31.7 fps (GPU completion 361 -> 126 ms behind submission) and a
 * 4,592,169-splat PLY without SH from 18.1 to 56.8 fps (215 -> 15 ms). 14,636- and
 * 384,366-splat scenes tied at vsync. 0.4M-4M is unmeasured, so the cut sits below
 * the smallest measured win.
 */
export const AUTO_APPLE_SILICON_PROJECTION_MIN_SPLATS = 3_500_000;
/**
 * Conservative cap for projection plus cached SH allocations on an identified
 * desktop dGPU. It is an application policy, never a claim about available VRAM.
 */
export const DEFAULT_AUTO_PROJECTION_MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;

export type AutomaticProjectionPolicyInput = ProjectionPolicySignals & {
  readonly memoryBudgetBytes: number;
};
export type { AutomaticProjectionPolicyResult };

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
 * Chooses only measured cohorts: discrete NVIDIA Ampere with SH and the SH cache, and
 * large static scenes on Apple Silicon Macs.
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
  // Deliberately stricter than the SH cache gate, which accepts an owned
  // dynamic pool: automatic compute projection is unvalidated on streaming pools.
  if (!input.isStatic || !input.ownsPool) return vertex('auto-dynamic-or-shared-pool');
  if (input.hasSourcePlacement) return vertex('auto-source-placement');
  if (input.hasModifiers) return vertex('auto-modifiers');
  if (!input.usesCountingSort) return vertex('auto-sort-strategy');
  if (input.usesFoveation) return vertex('auto-foveation');
  if (input.isMobile) return vertex('auto-mobile-device');
  // Unlike the discrete cohort, Apple Silicon wins without SH and under the full-detail
  // `quality` profile, so neither gate applies to it (see the constant above).
  if (input.isAppleSiliconMac === true) {
    if (input.capacity < AUTO_APPLE_SILICON_PROJECTION_MIN_SPLATS) {
      return vertex('auto-small-static-scene');
    }
    if (requiredMemoryBytes > input.memoryBudgetBytes) return vertex('auto-memory-budget');
    return { strategy: 'compute', reason: 'auto-large-static-apple-silicon', requiredMemoryBytes };
  }
  if (input.gpuClass === undefined) return vertex('auto-unknown-device');
  if (input.gpuClass !== 'discrete') return vertex('auto-nondiscrete-device');
  if (!input.isValidatedDeviceClass) return vertex('auto-unvalidated-device-class');
  if (input.capacity < AUTO_PROJECTION_MIN_SPLATS) return vertex('auto-small-static-scene');
  if (!input.hasSh) return vertex('auto-no-sh');
  if (!input.hasBalancedContributionCulls) return vertex('auto-full-detail');
  if (requiredMemoryBytes > input.memoryBudgetBytes) return vertex('auto-memory-budget');
  return { strategy: 'compute', reason: 'auto-large-static-discrete-sh', requiredMemoryBytes };
}
