import { describe, expect, it } from 'vitest';
import { SplatMesh } from '../core/splat-mesh';
import { SplatPool } from '../core/splat-mesh-pool';
import type { SplatData } from '../core/splat-data';

function poolTextures(mesh: SplatMesh) {
  const pool = (mesh as unknown as { pool: SplatPool }).pool;
  return [
    pool.centersTexture,
    pool.colorsTexture,
    pool.covarianceATexture,
    pool.covarianceBTexture,
    ...pool.shPackedTextures,
  ];
}

describe('initial pool uploads', () => {
  it('skips initial uploads only for private dynamic pools by default', () => {
    const dynamic = new SplatMesh({ capacity: 2048 }, { shBands: 3 });
    const data: SplatData = {
      count: 1,
      positions: new Float32Array(3),
      colors: new Uint8Array(4),
      covariances: new Float32Array(6),
    };
    const staticMesh = new SplatMesh(data);
    const sharedPool = new SplatPool({ capacity: 2048 });
    const sharedMesh = new SplatMesh({ capacity: 2048 }, { pool: sharedPool });
    expect(poolTextures(dynamic).every((texture) => !texture.source.dataReady)).toBe(true);
    dynamic.dispose();
    for (const mesh of [staticMesh, sharedMesh]) {
      expect(poolTextures(mesh).every((texture) => texture.source.dataReady)).toBe(true);
      mesh.dispose();
    }
    sharedPool.dispose();
  });
});
