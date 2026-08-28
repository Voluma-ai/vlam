import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { buildLcc2Scene } from '../formats/lcc/lcc2';
import type { SplatDatasetSource } from '../streaming/dataset-source';

const OPTIONS = { budget: 1000, lodBaseDistance: 10, lodMultiplier: 2 };

function dataset(): SplatDatasetSource {
  return {
    manifestUrl: 'https://host/scene.lcc2',
    resolve: (path) => `https://host/${path}`,
    size: () => Promise.resolve(null),
    directoryFiles: () => null,
    dispose: () => {},
  };
}

/** Two root-child cells: one in front of a default camera, one far to +X. */
function twoChildManifest(): unknown {
  return {
    version: '0.0.2',
    totalLevels: 1,
    lodSplats: [20],
    root: {
      boundingBox: { min: [-1, -1, -9], max: [51, 1, -7] },
      splatFiles: ['near.sog', 'far.sog'],
      child: {
        '0': {
          boundingBox: { min: [-1, -1, -9], max: [1, 1, -7] },
          data: { '3dgs': { name: 0, start: 0, count: 10 } },
        },
        '1': {
          boundingBox: { min: [49, -1, -9], max: [51, 1, -7] },
          data: { '3dgs': { name: 1, start: 0, count: 10 } },
        },
      },
    },
  };
}

function frustumOf(camera: THREE.Camera): THREE.Frustum {
  camera.updateMatrixWorld(true);
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

describe('OctreeLodSource.coverageRunsFor', () => {
  it('returns only the in-view root child', () => {
    const scene = buildLcc2Scene(twoChildManifest(), dataset(), OPTIONS);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.updateMatrixWorld(true);

    const runs = scene.source.coverageRunsFor!(camera.position, frustumOf(camera));
    expect(runs.map((r) => r.file)).toEqual([0]);
    expect(runs[0]?.leafStart).toBe(0);
    expect(runs[0]?.leafEnd).toBe(1);
  });

  it('selects the other child when the camera looks at it', () => {
    const scene = buildLcc2Scene(twoChildManifest(), dataset(), OPTIONS);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(50, 0, 0);
    camera.lookAt(50, 0, -8);
    camera.updateMatrixWorld(true);

    const runs = scene.source.coverageRunsFor!(camera.position, frustumOf(camera));
    expect(runs.map((r) => r.file)).toEqual([1]);
  });

  it('falls back to the nearest cell when the frustum is empty', () => {
    const scene = buildLcc2Scene(twoChildManifest(), dataset(), OPTIONS);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.lookAt(0, 0, 10);
    camera.updateMatrixWorld(true);

    const runs = scene.source.coverageRunsFor!(camera.position, frustumOf(camera));
    expect(runs.map((r) => r.file)).toEqual([0]);
  });
});
