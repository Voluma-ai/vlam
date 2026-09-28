import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { SplatMesh } from '../core/splat-mesh';
import { SplatPool } from '../core/splat-mesh-pool';
import type { SplatData } from '../core/splat-data';

vi.mock('../internal/experiments', async (importOriginal) => {
  const original = await importOriginal<typeof import('../internal/experiments')>();
  return { ...original, experiments: { ...original.experiments, packedCenterColors: true } };
});

function point(positions: number[], colors: number[]): SplatData {
  return {
    count: 1,
    positions: Float32Array.from(positions),
    colors: Uint8Array.from(colors),
    covariances: Float32Array.from([0.03, 0, 0, 0.015, 0, 0.01]),
  };
}

function poolOf(mesh: SplatMesh): SplatPool {
  return (mesh as unknown as { pool: SplatPool }).pool;
}

describe('experimental lossless center/color texels', () => {
  it('retains center float32 bits and opaque RGBA words including NaN bit patterns', () => {
    const data = point([-0, -123.456, 0.0000123], [255, 255, 255, 255]);
    const mesh = new SplatMesh(data, { orientation: 'source' });
    try {
      const texture = poolOf(mesh).centersTexture;
      const bits = texture.image.data as Uint32Array;
      expect(texture.format).toBe(THREE.RGBAIntegerFormat);
      expect(texture.type).toBe(THREE.UnsignedIntType);
      expect(Array.from(bits.subarray(0, 3))).toEqual(
        Array.from(new Uint32Array(data.positions.buffer)),
      );
      expect(bits[3]).toBe(0xffffffff);
    } finally {
      mesh.dispose();
    }
  });

  it('preserves the packed word when compaction moves a row', () => {
    const mesh = new SplatMesh({ capacity: 4096 }, { orientation: 'source' });
    try {
      const first = mesh.appendRange(point([10, 0, 0], [1, 2, 3, 4]));
      mesh.appendRange(point([0.25, -0.5, 0], [255, 255, 255, 255]));
      mesh.removeRange(first);
      mesh.compact();
      const pool = poolOf(mesh);
      expect(pool.backing.centers[0]).toBe(0.25);
      expect(pool.backing.centers[1]).toBe(-0.5);
      expect((pool.centersTexture.image.data as Uint32Array)[3]).toBe(0xffffffff);
    } finally {
      mesh.dispose();
    }
  });

  it('keeps the existing half-float texture path', () => {
    const pool = new SplatPool({ capacity: 2048, floatTextures: 'float16' });
    try {
      expect(pool.centersTexture.format).toBe(THREE.RGBAFormat);
      expect(pool.centersTexture.image.data).toBeInstanceOf(Uint16Array);
    } finally {
      pool.dispose();
    }
  });
});
