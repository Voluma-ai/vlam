import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { MergedSplatMesh } from '../core/merged-splat-mesh';
import { SplatMesh } from '../core/splat-mesh';
import { writeCovariance, type SplatData } from '../core/splat-data';

/**
 * `SplatMesh.displacementBounds`: the reach a modifier declares for the splats
 * it moves, which the sort quantizes over on every path and a unified draw
 * reads through `getUnifiedSourceView`.
 */

function points(...centers: [number, number, number][]): SplatData {
  const count = centers.length;
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) writeCovariance(covariances, i, 0.01, 0.01, 0.01, 1, 0, 0, 0);
  return {
    count,
    positions: Float32Array.from(centers.flat()),
    colors: new Uint8Array(count * 4).fill(255),
    covariances,
  };
}

interface Internals {
  boundingSphereLocal: THREE.Sphere;
  localBounds: THREE.Box3;
  refreshSortBounds(): void;
}
const peek = (mesh: SplatMesh) => mesh as unknown as Internals;

const meshes: SplatMesh[] = [];
afterEach(() => {
  for (const mesh of meshes.splice(0)) mesh.dispose();
});
function track<T extends SplatMesh>(mesh: T): T {
  meshes.push(mesh);
  return mesh;
}

const reach = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 5, 1));

describe('SplatMesh.displacementBounds', () => {
  it('is null by default and leaves the data bounds alone', () => {
    const mesh = track(new SplatMesh({ capacity: 2048 }));
    mesh.appendRange(points([0, 0, 0], [1, 1, 1]));
    expect(mesh.displacementBounds).toBeNull();
    expect(mesh.computeSplatBounds().max.toArray()).toEqual([1, 1, 1]);
  });

  it('widens the sort sphere and computeSplatBounds, but never the grow-only data bounds', () => {
    const mesh = track(new SplatMesh({ capacity: 2048 }));
    mesh.appendRange(points([0, 0, 0], [1, 1, 1]));
    mesh.displacementBounds = reach;
    const state = peek(mesh);
    state.refreshSortBounds();
    expect(state.boundingSphereLocal.containsPoint(new THREE.Vector3(0, 5, 0))).toBe(true);
    expect(mesh.computeSplatBounds().max.toArray()).toEqual([1, 5, 1]);
    expect(state.localBounds.max.toArray()).toEqual([1, 1, 1]);

    // Cleared, the sphere shrinks back to the data.
    mesh.displacementBounds = null;
    state.refreshSortBounds();
    expect(state.boundingSphereLocal.containsPoint(new THREE.Vector3(0, 5, 0))).toBe(false);
  });

  it('copies the box, so a later mutation of the caller box changes nothing', () => {
    const mesh = track(new SplatMesh({ capacity: 2048 }));
    mesh.appendRange(points([0, 0, 0]));
    const box = reach.clone();
    mesh.displacementBounds = box;
    box.max.set(100, 100, 100);
    expect(mesh.displacementBounds?.max.toArray()).toEqual([1, 5, 1]);
    // An empty box is no declaration.
    mesh.displacementBounds = new THREE.Box3();
    expect(mesh.displacementBounds).toBeNull();
  });

  it('reaches the unified source view', () => {
    const mesh = track(new SplatMesh({ capacity: 2048 }));
    mesh.appendRange(points([0, 0, 0], [1, 1, 1]));
    mesh.updateMatrixWorld(true);
    const before = mesh.getUnifiedSourceView().worldBounds.clone();
    mesh.displacementBounds = reach;
    const after = mesh.getUnifiedSourceView().worldBounds;
    expect(before.containsPoint(new THREE.Vector3(0, 5, 0))).toBe(false);
    expect(after.containsPoint(new THREE.Vector3(0, 5, 0))).toBe(true);
  });

  it('is kept by a merged mesh, whose sort bound spans its placed sources', () => {
    const mesh = track(new MergedSplatMesh({ capacity: 4096 }));
    mesh.addSource(points([0, 0, 0], [1, 0, 0]), new THREE.Matrix4().makeTranslation(10, 0, 0));
    mesh.displacementBounds = reach;
    const state = peek(mesh);
    state.refreshSortBounds();
    expect(state.boundingSphereLocal.containsPoint(new THREE.Vector3(10.5, 0, 0))).toBe(true);
    expect(state.boundingSphereLocal.containsPoint(new THREE.Vector3(0, 5, 0))).toBe(true);
    expect(mesh.computeSplatBounds().max.y).toBe(5);
  });
});
