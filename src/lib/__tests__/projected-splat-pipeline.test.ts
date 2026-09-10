import { describe, expect, it } from 'vitest';
import { SplatMesh } from '../core/splat-mesh';
import {
  estimateProjectedSplatPeakBytes,
  estimateProjectedSplatSteadyBytes,
} from '../core/projected-splat-pipeline';

const data = {
  count: 1,
  positions: new Float32Array(3),
  colors: new Uint8Array([255, 255, 255, 255]),
  covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
};

describe('compute projection configuration', () => {
  it('keeps vertex projection as the default and exposes explicit memory', () => {
    const vertex = new SplatMesh(data);
    const compute = new SplatMesh(data, { projectionStrategy: 'compute' });
    expect(vertex.projectionStrategy).toBe('vertex');
    expect(vertex.projectionMemoryBytes).toEqual({ steadyGpu: 0, peakCpuAndGpu: 0 });
    expect(compute.projectionStrategy).toBe('compute');
    expect(compute.projectionMemoryBytes.steadyGpu).toBe(
      estimateProjectedSplatSteadyBytes(compute.capacity),
    );
    expect(compute.projectionMemoryBytes.peakCpuAndGpu).toBe(
      estimateProjectedSplatPeakBytes(compute.capacity),
    );
    vertex.dispose();
    compute.dispose();
  });

  it('rejects invalid strategies and invalid memory capacities', () => {
    expect(() => new SplatMesh(data, { projectionStrategy: 'invalid' as 'compute' })).toThrow(
      /invalid projectionStrategy/,
    );
    expect(() => estimateProjectedSplatSteadyBytes(-1)).toThrow(RangeError);
  });
});
