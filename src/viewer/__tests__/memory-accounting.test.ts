import { describe, expect, it } from 'vitest';
import type { SplatData } from '../../lib/core';
import { decodedSplatMemory, estimateMeshMemory } from '../memory-accounting';

describe('memory accounting', () => {
  it('separates core, SH, and LOD decoded arrays', () => {
    const data: SplatData = {
      count: 2,
      positions: new Float32Array(6),
      colors: new Uint8Array(8),
      covariances: new Float32Array(12),
      shPacked: {
        bands: 1,
        packed: new Uint32Array(6),
        range: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
      radTree: {
        childCount: new Uint16Array(2),
        childStart: new Uint32Array(2),
        size: new Float32Array(2),
      },
      frontierParent: new Float32Array(2),
    };

    expect(decodedSplatMemory(data)).toEqual({
      coreBytes: 80,
      sphericalHarmonicsBytes: 24,
      lodBytes: 28,
      totalBytes: 132,
    });
  });

  it('keeps palette images separate from packed pool SH', () => {
    const plain = estimateMeshMemory(2048, {
      floatTextures: 'float32',
      packedShBands: 0,
      sortStrategy: 'counting',
    });
    const palette = estimateMeshMemory(2048, {
      floatTextures: 'float32',
      packedShBands: 0,
      sortStrategy: 'counting',
      paletteBytes: 4096,
    });

    expect(palette.cpuBackingBytes - plain.cpuBackingBytes).toBe(4096);
    expect(palette.gpuBytes - plain.gpuBytes).toBe(4096);
    expect(palette.totalBytes - plain.totalBytes).toBe(8192);
  });

  it('moves render-only CPU backing into the released category', () => {
    const editable = estimateMeshMemory(2048, {
      floatTextures: 'float32',
      packedShBands: 3,
      sortStrategy: 'counting',
      paletteBytes: 4096,
    });
    const renderOnly = estimateMeshMemory(2048, {
      floatTextures: 'float32',
      packedShBands: 3,
      sortStrategy: 'counting',
      storageMode: 'render-only',
      paletteBytes: 4096,
    });

    expect(renderOnly.cpuBackingBytes).toBe(0);
    expect(renderOnly.releasedCpuBackingBytes).toBe(editable.cpuBackingBytes);
    expect(renderOnly.gpuBytes).toBe(editable.gpuBytes);
  });

  it('reports worker sorting as both CPU and GPU memory', () => {
    const worker = estimateMeshMemory(2048, {
      floatTextures: 'float32',
      packedShBands: 0,
      sortStrategy: 'worker',
    });
    const webGpu = estimateMeshMemory(2048, {
      floatTextures: 'float32',
      packedShBands: 0,
      sortStrategy: 'counting',
    });

    expect(worker.cpuBackingBytes).toBeGreaterThan(webGpu.cpuBackingBytes);
    expect(worker.gpuBytes).toBeGreaterThan(0);
  });

  it('reports compute projection steady and peak allocations explicitly', () => {
    const vertex = estimateMeshMemory(100, {
      floatTextures: 'float32',
      packedShBands: 0,
      sortStrategy: 'counting',
    });
    const compute = estimateMeshMemory(100, {
      floatTextures: 'float32',
      packedShBands: 0,
      sortStrategy: 'counting',
      projectionStrategy: 'compute',
    });

    expect(compute.projectionCacheBytes).toBe(4_800);
    expect(compute.visibleListBytes).toBe(400);
    expect(compute.indirectArgumentBytes).toBe(36);
    expect(compute.gpuBytes - vertex.gpuBytes).toBe(5_236);
    expect(compute.projectionPeakCpuMirrorBytes).toBe(5_236);
    expect(compute.peakTotalBytes - compute.totalBytes).toBe(5_236);
  });
});
