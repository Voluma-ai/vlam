import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { SplatMesh } from '../core/splat-mesh';
import {
  estimateComputeSorterPeakBytes,
  estimateComputeSorterSteadyBytes,
} from '../core/compute-sorter';
import {
  estimateProjectedSplatPeakBytes,
  estimateProjectedSplatSteadyBytes,
  StandaloneProjectedSplatPipeline,
} from '../core/projected-splat-pipeline';
import {
  DEFAULT_AUTO_PROJECTION_MEMORY_BUDGET_BYTES,
  estimateAutomaticProjectionMemoryBytes,
  resolveAutomaticProjectionStrategy,
  type AutomaticProjectionPolicyInput,
} from '../core/projection-strategy-policy';
import type { SplatShInputs } from '../core/splat-mesh-material';
import { computeProjection } from '../projection/compute';

const data = {
  count: 1,
  positions: new Float32Array(3),
  colors: new Uint8Array([255, 255, 255, 255]),
  covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
};

describe('compute projection configuration', () => {
  it('defaults to vertex projection and exposes explicit compute memory', () => {
    const auto = new SplatMesh(data);
    const compute = new SplatMesh(data, { projectionStrategy: computeProjection() });
    expect(auto.projectionStrategy).toBe('vertex');
    expect(auto.projectionMemoryBytes).toEqual({ steadyGpu: 0, peakCpuAndGpu: 0 });
    expect((compute.projectionStrategy as { kind: string }).kind).toBe('compute');
    expect(compute.projectionMemoryBytes.steadyGpu).toBe(
      estimateProjectedSplatSteadyBytes(compute.capacity) +
        estimateComputeSorterSteadyBytes(compute.capacity),
    );
    expect(compute.projectionMemoryBytes.peakCpuAndGpu).toBe(
      estimateProjectedSplatPeakBytes(compute.capacity) +
        estimateComputeSorterPeakBytes(compute.capacity),
    );
    auto.dispose();
    compute.dispose();
  });

  it('rejects invalid strategies and invalid memory capacities', () => {
    expect(() => new SplatMesh(data, { projectionStrategy: 'invalid' as never })).toThrow(
      /invalid projectionStrategy/,
    );
    expect(() => estimateProjectedSplatSteadyBytes(-1)).toThrow(RangeError);
  });

  it('exposes contribution culls independently of the performance profile', () => {
    const quality = new SplatMesh(data, { performanceProfile: 'quality' });
    expect(quality.minPixelSize).toBe(0);
    expect(quality.minContribution).toBe(0);
    quality.dispose();
    const smooth = new SplatMesh(data, { performanceProfile: 'smooth' });
    expect(smooth.minPixelSize).toBe(2);
    expect(smooth.minContribution).toBe(3);
    smooth.dispose();
    const balanced = new SplatMesh(data, { performanceProfile: 'balanced' });
    expect(balanced.minPixelSize).toBe(2);
    expect(balanced.minContribution).toBe(3);
    balanced.dispose();
    const explicit = new SplatMesh(data, {
      performanceProfile: 'quality',
      minPixelSize: 2,
      minContribution: 3,
    });
    expect(explicit.minPixelSize).toBe(2);
    expect(explicit.minContribution).toBe(3);
    explicit.dispose();
    expect(() => new SplatMesh(data, { minPixelSize: -1 })).toThrow(/minPixelSize/);
  });
});

describe('automatic compute-projection policy', () => {
  const measured: AutomaticProjectionPolicyInput = {
    capacity: 8_724_225,
    hasSh: true,
    hasBalancedContributionCulls: true,
    isStatic: true,
    ownsPool: true,
    isWebGpu: true,
    isXr: false,
    isUnifiedSource: false,
    hasSourcePlacement: false,
    hasModifiers: false,
    usesCountingSort: true,
    usesFoveation: false,
    gpuClass: 'discrete',
    isValidatedDeviceClass: true,
    isMobile: false,
    memoryBudgetBytes: DEFAULT_AUTO_PROJECTION_MEMORY_BUDGET_BYTES,
  };

  it('selects only the measured static discrete-SH cohort within its policy budget', () => {
    const result = resolveAutomaticProjectionStrategy(measured);
    expect(result).toMatchObject({ strategy: 'compute', reason: 'auto-large-static-discrete-sh' });
    expect(result.requiredMemoryBytes).toBe(
      estimateAutomaticProjectionMemoryBytes(measured.capacity),
    );
    expect(result.requiredMemoryBytes).toBeLessThanOrEqual(measured.memoryBudgetBytes);
  });

  it('rejects a near-cap workload once projected-sorter scratch is included', () => {
    const result = resolveAutomaticProjectionStrategy({ ...measured, capacity: 9_900_000 });
    expect(result).toMatchObject({ strategy: 'vertex', reason: 'auto-memory-budget' });
    expect(result.requiredMemoryBytes).toBeGreaterThan(measured.memoryBudgetBytes);
  });

  it.each([
    ['unknown adapter', { gpuClass: undefined }, 'auto-unknown-device'],
    ['integrated adapter', { gpuClass: 'integrated' as const }, 'auto-nondiscrete-device'],
    [
      'unvalidated discrete adapter',
      { isValidatedDeviceClass: false },
      'auto-unvalidated-device-class',
    ],
    ['small static scene', { capacity: 7_999_999 }, 'auto-small-static-scene'],
    ['no SH', { hasSh: false }, 'auto-no-sh'],
    ['full detail', { hasBalancedContributionCulls: false }, 'auto-full-detail'],
    ['explicit memory cap', { memoryBudgetBytes: 0 }, 'auto-memory-budget'],
    ['streamed pool', { isStatic: false }, 'auto-dynamic-or-shared-pool'],
    ['modifier graph', { hasModifiers: true }, 'auto-modifiers'],
    ['XR', { isXr: true }, 'auto-xr'],
  ])('keeps %s on vertex projection', (_label, override, reason) => {
    expect(resolveAutomaticProjectionStrategy({ ...measured, ...override })).toMatchObject({
      strategy: 'vertex',
      reason,
    });
  });

  it('locks an automatic choice before any camera-dependent projection work', () => {
    const shData = {
      ...data,
      sh: {
        bands: 1 as const,
        labels: new Uint32Array(1),
        palette: new Float32Array(4),
        paletteWidth: 1,
        paletteHeight: 1,
      },
    };
    const mesh = new SplatMesh(shData, { performanceProfile: 'balanced' });
    Object.defineProperty(mesh, 'capacity', { configurable: true, value: 8_724_225 });
    const resolve = (
      mesh as unknown as {
        resolvedProjectionStrategy(renderer: THREE.WebGPURenderer): 'vertex' | 'compute';
      }
    ).resolvedProjectionStrategy.bind(mesh);
    const renderer = {
      backend: {
        isWebGPUBackend: true,
        device: { adapterInfo: { vendor: 'nvidia', architecture: 'ampere' } },
      },
    } as unknown as THREE.WebGPURenderer;
    expect(resolve(renderer)).toBe('compute');
    (renderer.backend as unknown as { isWebGPUBackend: boolean }).isWebGPUBackend = false;
    expect(resolve(renderer)).toBe('compute');
    mesh.dispose();
  });
});

function makeStandalonePipeline(sh: SplatShInputs | null): StandaloneProjectedSplatPipeline {
  const texture = new THREE.DataTexture(new Float32Array(16), 4, 1);
  return new StandaloneProjectedSplatPipeline({ compute() {} } as unknown as THREE.WebGPURenderer, {
    capacity: 4,
    sourceIndex: new THREE.StorageBufferAttribute(new Uint32Array(4), 1),
    centersTexture: texture,
    colorsTexture: texture,
    covarianceATexture: texture,
    covarianceBTexture: texture,
    dataTextureWidth: 4,
    focal: uniform(new THREE.Vector2(1, 1)),
    viewport: uniform(new THREE.Vector2(1, 1)),
    maxStdDev: 3,
    minSplatSizePx: 0,
    antialias: false,
    projectedLowPassVariance: 0.3,
    compensateProjectedLowPass: false,
    dofFocusDistance: uniform(1),
    dofAperture: uniform(0),
    maxAspect: 0,
    lodAlpha: false,
    minPixelSize: 0,
    minContribution: 0,
    sortMetric: 'depth',
    localCameraPosition: uniform(new THREE.Vector3()),
    sh,
  });
}

describe('standalone projector SH bindings', () => {
  it('does not bind SH textures when constructed with sh: null', () => {
    const palette = new THREE.DataTexture(new Float32Array(64 * 4), 64, 1);
    const sh: SplatShInputs = { mode: 'palette', bands: 1, paletteTexture: palette };
    const withSh = makeStandalonePipeline(sh);
    const withoutSh = makeStandalonePipeline(null);
    expect(withSh.packedColor).toBe(true);
    expect(withoutSh.packedColor).toBe(false);
    withSh.dispose();
    withoutSh.dispose();
    palette.dispose();
  });
});
