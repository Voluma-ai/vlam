import type { SplatMesh } from '../lib/core';

/** Viewer-only inspection of private state; deliberately not a library API. */
export function shEvaluationDiagnostics(mesh: SplatMesh) {
  const host = mesh as unknown as {
    shEvaluation: 'auto' | 'vertex' | 'compute';
    shEvaluationState: { reason: string };
    shCache: null | {
      snapshot(): {
        dispatches: number;
        invalidations: number;
        motionFallbacks: number;
        sortCadenceDeferrals: number;
        lastInvalidation: string;
        phase: string;
        gpuBytes: number;
        cpuMirrorBytes: number;
        peakBytes: number;
      };
    };
    sortScheduler: { snapshot(): { acceptedCount: number } };
  };
  return {
    requested: host.shEvaluation,
    resolved: host.shCache ? 'compute' : 'vertex',
    reason: host.shEvaluationState.reason,
    sortSubmissions: host.sortScheduler.snapshot().acceptedCount,
    ...(host.shCache?.snapshot() ?? {
      dispatches: 0,
      invalidations: 0,
      motionFallbacks: 0,
      sortCadenceDeferrals: 0,
      lastInvalidation: null,
      phase: 'vertex',
      gpuBytes: 0,
      cpuMirrorBytes: 0,
      peakBytes: 0,
    }),
  };
}
