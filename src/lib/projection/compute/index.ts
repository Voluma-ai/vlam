/**
 * Experimental project-once/cull-before-sort strategies.
 *
 * Importing this entry is opt-in: the default viewer and the base unified
 * compositor retain vertex projection without including the compute pipeline.
 *
 * @module projection/compute
 */
import {
  ProjectedSplatPipeline,
  StandaloneProjectedSplatPipeline,
  estimateProjectedSplatPeakBytes,
  estimateProjectedSplatSteadyBytes,
} from '../../core/projected-splat-pipeline';
import {
  DEFAULT_AUTO_PROJECTION_MEMORY_BUDGET_BYTES,
  resolveAutomaticProjectionStrategy,
} from '../../core/projection-strategy-policy';
import {
  type ComputeProjectionMode,
  type ComputeProjectionStrategy,
  type StandaloneProjectionOptions,
  type UnifiedProjectionOptions,
} from '../../core/strategy-types';
import {
  estimateComputeSorterPeakBytes,
  estimateComputeSorterSteadyBytes,
} from '../../core/compute-sorter';

/** Options for {@link computeProjection}. */
export interface ComputeProjectionOptions {
  /** `explicit` always requests compute where the runtime supports it; `auto` uses the measured device policy. */
  mode?: ComputeProjectionMode;
  /** Maximum extra allocation accepted by `auto`; defaults to 1 GiB. */
  projectionMemoryBudgetBytes?: number;
}

/** Creates an injected standalone/unified compute-projection strategy. */
export function computeProjection(
  options: ComputeProjectionOptions = {},
): ComputeProjectionStrategy {
  const mode = options.mode ?? 'explicit';
  if (mode !== 'explicit' && mode !== 'auto') {
    throw new RangeError('computeProjection: mode must be explicit or auto.');
  }
  const memoryBudgetBytes =
    options.projectionMemoryBudgetBytes ?? DEFAULT_AUTO_PROJECTION_MEMORY_BUDGET_BYTES;
  if (!Number.isFinite(memoryBudgetBytes) || memoryBudgetBytes < 0) {
    throw new RangeError('computeProjection: memoryBudgetBytes must be a finite number >= 0.');
  }
  return {
    kind: 'compute',
    mode,
    estimateMemoryBytes: (capacity) => ({
      steadyGpu:
        estimateProjectedSplatSteadyBytes(capacity) +
        estimateComputeSorterSteadyBytes(capacity),
      peakCpuAndGpu:
        estimateProjectedSplatPeakBytes(capacity) + estimateComputeSorterPeakBytes(capacity),
    }),
    resolveAutomatic: (input) =>
      resolveAutomaticProjectionStrategy({ ...input, memoryBudgetBytes }),
    createStandalone: (projectionOptions: StandaloneProjectionOptions) => {
      try {
        return new StandaloneProjectedSplatPipeline(projectionOptions.renderer, projectionOptions);
      } catch (error) {
        throw new Error(`ProjectedSplatPipeline: ${String(error)}`, { cause: error });
      }
    },
    createUnified: (projectionOptions: UnifiedProjectionOptions) => {
      try {
        return new ProjectedSplatPipeline(projectionOptions);
      } catch (error) {
        throw new Error(`ProjectedSplatPipeline: ${String(error)}`, { cause: error });
      }
    },
  };
}

export {
  estimateProjectedSplatPeakBytes,
  estimateProjectedSplatSteadyBytes,
  PROJECTED_SPLAT_BYTES_PER_SLOT,
  PROJECTED_SPLAT_FIXED_BYTES,
} from '../../core/projected-splat-pipeline';
