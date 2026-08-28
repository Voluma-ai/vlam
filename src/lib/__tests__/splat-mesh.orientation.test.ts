import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { SplatMesh } from '../splat-mesh';
import { writeCovariance, type SplatData } from '../splat-data';
import { createYUpTransform } from '../orientation';

/** A one-splat scene, optionally stamped with the format it was decoded from. */
function makeData(format?: SplatData['format']): SplatData {
  const covariances = new Float32Array(6);
  writeCovariance(covariances, 0, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  return {
    count: 1,
    positions: new Float32Array(3),
    colors: new Uint8Array([255, 255, 255, 255]),
    covariances,
    ...(format === undefined ? {} : { format }),
  };
}

function expectMatrix(mesh: SplatMesh, expected: THREE.Matrix4): void {
  mesh.updateMatrix(); // recompose from position/quaternion/scale
  for (let i = 0; i < 16; i++) {
    expect(mesh.matrix.elements[i]).toBeCloseTo(expected.elements[i] as number, 10);
  }
}

describe('SplatMesh orientation', () => {
  const meshes: SplatMesh[] = [];
  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });
  const track = (m: SplatMesh): SplatMesh => (meshes.push(m), m);
  const identity = new THREE.Matrix4();
  const yUp = createYUpTransform();

  it('defaults to y-up: flips a Y-down PLY 180° about X', () => {
    const mesh = track(new SplatMesh(makeData('ply')));
    expect(mesh.orientation).toBe('y-up');
    expectMatrix(mesh, yUp);
  });

  it('leaves an already-Y-up SPZ unrotated even in y-up mode', () => {
    expectMatrix(track(new SplatMesh(makeData('spz'))), identity);
  });

  it('flips a Spark RAD from its OpenCV source frame in y-up mode', () => {
    expectMatrix(track(new SplatMesh(makeData('rad'))), yUp);
  });

  it('source mode applies no cosmetic flip to a PLY', () => {
    expectMatrix(track(new SplatMesh(makeData('ply'), { orientation: 'source' })), identity);
  });

  it('leaves an unstamped (hand-built) scene unrotated', () => {
    expectMatrix(track(new SplatMesh(makeData())), identity);
  });

  it('never auto-orients a dynamic-capacity pool (no source format)', () => {
    expectMatrix(track(new SplatMesh({ capacity: 2048 })), identity);
    expectMatrix(track(new SplatMesh({ capacity: 2048 }, { orientation: 'y-up' })), identity);
  });
});
