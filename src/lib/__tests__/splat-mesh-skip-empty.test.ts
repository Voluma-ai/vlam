import { describe, expect, it, vi } from 'vitest';
import { SplatMesh } from '../core/splat-mesh';
import { SplatPool } from '../core/splat-mesh-pool';
import type { SplatData } from '../core/splat-data';

vi.mock('../internal/experiments', () => ({ experiments: { initialPoolUpload: 'skip-empty' } }));

function textures(mesh: SplatMesh) {
  const pool = (mesh as unknown as { pool: SplatPool }).pool;
  return [
    pool.centersTexture,
    pool.colorsTexture,
    pool.covarianceATexture,
    pool.covarianceBTexture,
    ...pool.shPackedTextures,
  ];
}

describe('skip-empty experiment', () => {
  it('marks only privately owned empty dynamic destinations as not ready', () => {
    for (const bands of [0, 1, 2, 3] as const) {
      const dynamic = new SplatMesh({ capacity: 2048 }, { shBands: bands });
      expect(textures(dynamic)).toHaveLength([4, 5, 6, 8][bands]!);
      expect(textures(dynamic).every((texture) => texture.source.dataReady === false)).toBe(true);
      expect(textures(dynamic).every((texture) => texture.version > 0)).toBe(true);
      dynamic.dispose();
    }
    const data: SplatData = {
      count: 1,
      positions: new Float32Array(3),
      colors: new Uint8Array(4),
      covariances: new Float32Array(6),
    };
    const staticMesh = new SplatMesh(data);
    expect(textures(staticMesh).every((texture) => texture.source.dataReady)).toBe(true);
    staticMesh.dispose();

    const sharedPool = new SplatPool({ capacity: 2048 });
    const sharedMesh = new SplatMesh({ capacity: 2048 }, { pool: sharedPool });
    expect(textures(sharedMesh).every((texture) => texture.source.dataReady)).toBe(true);
    sharedMesh.dispose();
    sharedPool.dispose();
  });
});
