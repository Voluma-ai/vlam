import { afterEach, describe, expect, it } from 'vitest';
import { SplatMesh } from '../splat-mesh';
import { writeCovariance, type SplatData } from '../splat-data';

/** A one-splat scene, optionally carrying the antialias meta flag. */
function makeData(antialias?: boolean): SplatData {
  const covariances = new Float32Array(6);
  writeCovariance(covariances, 0, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  return {
    count: 1,
    positions: new Float32Array(3),
    colors: new Uint8Array([255, 255, 255, 255]),
    covariances,
    ...(antialias === undefined ? {} : { antialias }),
  };
}

/** Reads the mesh's private `antialias` flag baked into the material graph. */
function antialiasOf(mesh: SplatMesh): boolean {
  return (mesh as unknown as { antialias: boolean }).antialias;
}

function filterProfileOf(mesh: SplatMesh): 'default' | 'lcc' {
  return (mesh as unknown as { projectedFilterProfile: 'default' | 'lcc' }).projectedFilterProfile;
}

describe('SplatMesh antialias flag (M4.3)', () => {
  const meshes: SplatMesh[] = [];
  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });
  const track = (m: SplatMesh): SplatMesh => (meshes.push(m), m);

  it('defaults to off for a static scene without the flag', () => {
    expect(antialiasOf(track(new SplatMesh(makeData())))).toBe(false);
  });

  it('honors the source scene flag (SOG meta) for a static mesh', () => {
    expect(antialiasOf(track(new SplatMesh(makeData(true))))).toBe(true);
  });

  it('lets an explicit option override the source flag', () => {
    expect(antialiasOf(track(new SplatMesh(makeData(true), { antialias: false })))).toBe(false);
    expect(antialiasOf(track(new SplatMesh(makeData(false), { antialias: true })))).toBe(true);
  });

  it('defaults to off for a dynamic mesh, and honors the option', () => {
    expect(antialiasOf(track(new SplatMesh({ capacity: 2048 })))).toBe(false);
    expect(antialiasOf(track(new SplatMesh({ capacity: 2048 }, { antialias: true })))).toBe(true);
  });

  it('uses the compensated LCC filter only when the format selects it', () => {
    const defaultMesh = track(new SplatMesh(makeData()));
    const lccMesh = track(new SplatMesh(makeData(), { projectedFilterProfile: 'lcc' }));

    expect(filterProfileOf(defaultMesh)).toBe('default');
    expect(filterProfileOf(lccMesh)).toBe('lcc');
    expect(lccMesh.getUnifiedSourceView().projectedFilterProfile).toBe('lcc');
  });
});
