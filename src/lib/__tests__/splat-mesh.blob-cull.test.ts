import { afterEach, describe, expect, it } from 'vitest';
import { SplatMesh } from '../splat-mesh';
import { writeCovariance, type SplatData } from '../splat-data';

function makeData(): SplatData {
  const covariances = new Float32Array(6);
  writeCovariance(covariances, 0, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  return {
    count: 1,
    positions: new Float32Array(3),
    colors: new Uint8Array([255, 255, 255, 255]),
    covariances,
  };
}

/** Reads the mesh's private screen-radius cull threshold. */
function cullOf(mesh: SplatMesh): number {
  return (mesh as unknown as { maxSplatScreenRadius: number }).maxSplatScreenRadius;
}

describe('SplatMesh maxSplatScreenRadius (blob cull)', () => {
  const meshes: SplatMesh[] = [];
  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });
  const track = (m: SplatMesh): SplatMesh => (meshes.push(m), m);

  it('defaults to 0 (off) when unset', () => {
    expect(cullOf(track(new SplatMesh(makeData())))).toBe(0);
  });

  it('keeps an explicit threshold', () => {
    expect(cullOf(track(new SplatMesh(makeData(), { maxSplatScreenRadius: 350 })))).toBe(350);
  });

  it('treats 0 as off', () => {
    expect(cullOf(track(new SplatMesh(makeData(), { maxSplatScreenRadius: 0 })))).toBe(0);
  });

  it('rejects a negative or non-finite threshold', () => {
    expect(() => new SplatMesh(makeData(), { maxSplatScreenRadius: -1 })).toThrow(/≥ 0/);
    expect(() => new SplatMesh(makeData(), { maxSplatScreenRadius: Number.NaN })).toThrow(/finite/);
  });
});
