import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { SplatMesh } from '../core/splat-mesh';
import { SplatPool } from '../core/splat-mesh-pool';
import type { SplatData } from '../core/splat-data';
import { splatCenterUploadData } from '../core/splat-center-storage';

vi.mock('../../../benchmarks/experiments/config', () => ({
  experiments: { packedCenterColors: true, unifiedPackedColorReuse: false },
}));
vi.mock(
  '../core/splat-center-storage',
  () => import('../../../benchmarks/experiments/packed-center-storage'),
);
vi.mock(
  '../core/splat-texture-read',
  () => import('../../../benchmarks/experiments/packed-texture-read'),
);

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

  it('uploads packed live rows with an integer staging texture', () => {
    const mesh = new SplatMesh({ capacity: 2048 }, { orientation: 'source' });
    try {
      const data = point([-0, -123.456, 0.0000123], [255, 255, 255, 255]);
      mesh.appendRange(data);
      const centerTexture = poolOf(mesh).centersTexture;
      const copies: THREE.DataTexture[] = [];
      const renderer = {
        copyTextureToTexture: (source: THREE.DataTexture, target: THREE.DataTexture) => {
          expect(source.format).toBe(target.format);
          expect(source.type).toBe(target.type);
          if (target === centerTexture) copies.push(source);
        },
      } as unknown as THREE.WebGPURenderer;
      // Narrow adapter to inspect staged bytes without requiring a GPU device.
      (
        mesh as unknown as { flushPendingUploads(r: THREE.WebGPURenderer): void }
      ).flushPendingUploads(renderer);
      expect(copies).toHaveLength(1);
      expect(copies[0]!.format).toBe(THREE.RGBAIntegerFormat);
      expect(Array.from((copies[0]!.image.data as Uint32Array).subarray(0, 4))).toEqual([
        ...new Uint32Array(data.positions.buffer),
        0xffffffff,
      ]);
    } finally {
      mesh.dispose();
    }
  });

  it('reads snapshot bytes and offsets even after live pool slots have been reused', () => {
    const mesh = new SplatMesh(point([-0, 1.5, -2.25], [255, 255, 255, 255]), {
      orientation: 'source',
    });
    try {
      const pool = poolOf(mesh);
      const padded = new Float32Array(12);
      padded.set(pool.backing.centers.subarray(0, 4), 4);
      const snapshot = padded.subarray(4, 8);
      const expected = Array.from(new Uint32Array(snapshot.buffer, snapshot.byteOffset, 4));
      pool.backing.centers.fill(42);
      const upload = splatCenterUploadData(pool.centersTexture, snapshot);
      expect(upload).toBeInstanceOf(Uint32Array);
      expect(upload.buffer).toBe(snapshot.buffer);
      expect(upload.byteOffset).toBe(snapshot.byteOffset);
      expect(Array.from(upload)).toEqual(expected);
      expect(upload[3]).toBe(0xffffffff);
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
