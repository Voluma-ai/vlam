import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { SplatMesh } from '../core/splat-mesh';
import { writeCovariance, type SplatData } from '../core/splat-data';

/**
 * Integration tests for M9's CPU spatial queries on a SplatMesh: correctness
 * over the pool's decoded centers, world-transform handling, resident-only
 * semantics (via range removal), and grid rebuild on churn.
 */

const WIDTH = 2048;

/** Splats at the given world-local positions. */
function dataAt(points: [number, number, number][]): SplatData {
  const count = points.length;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  points.forEach(([x, y, z], i) => {
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  });
  return { count, positions, colors, covariances };
}

describe('SplatMesh CPU queries (M9)', () => {
  it('queryRay returns the nearest resident center inside its cone', () => {
    const mesh = new SplatMesh({ capacity: WIDTH });
    mesh.appendRange(
      dataAt([
        [0.4, 0, -5],
        [0.1, 0, -10],
        [0, 0, 2],
      ]),
    );
    const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));

    const hit = mesh.queryRay(ray, 0.025, 0.05);
    expect(hit?.point.x).toBeCloseTo(0.1);
    expect(hit?.point.y).toBe(0);
    expect(hit?.point.z).toBe(-10);
    expect(hit?.distance).toBeCloseTo(10);
    expect(mesh.queryRay(ray, -1)).toBeNull();
    mesh.dispose();
  });

  it('returns the nearest splat within the radius, in world space', () => {
    const mesh = new SplatMesh({ capacity: WIDTH });
    mesh.appendRange(
      dataAt([
        [0, 0, 0],
        [5, 0, 0],
        [10, 0, 0],
      ]),
    );

    const hit = mesh.queryNearest(new THREE.Vector3(4, 0, 0), 3);
    expect(hit).not.toBeNull();
    expect(hit!.point.toArray()).toEqual([5, 0, 0]);
    expect(hit!.distance).toBeCloseTo(1, 6);

    // Nothing within a tight radius of a gap.
    expect(mesh.queryNearest(new THREE.Vector3(7.5, 0, 0), 1)).toBeNull();
    mesh.dispose();
  });

  it('accounts for the mesh world transform', () => {
    const mesh = new SplatMesh({ capacity: WIDTH });
    mesh.appendRange(
      dataAt([
        [0, 0, 0],
        [2, 0, 0],
      ]),
    );
    mesh.position.set(10, 0, 0); // shift the whole mesh in world space

    const hit = mesh.queryNearest(new THREE.Vector3(12, 0, 0), 1);
    expect(hit).not.toBeNull();
    expect(hit!.point.toArray()).toEqual([12, 0, 0]); // local (2,0,0) → world (12,0,0)
    expect(hit!.distance).toBeCloseTo(0, 6);
    mesh.dispose();
  });

  it('rebuilds the grid when the resident set changes (churn)', () => {
    const mesh = new SplatMesh({ capacity: WIDTH * 2 });
    const near = mesh.appendRange(dataAt([[0, 0, 0]]));
    mesh.appendRange(dataAt([[9, 0, 0]]));

    expect(mesh.queryNearest(new THREE.Vector3(1, 0, 0), 20)!.point.toArray()).toEqual([0, 0, 0]);
    // Remove the near splat; the next query must see the new resident set.
    mesh.removeRange(near);
    expect(mesh.queryNearest(new THREE.Vector3(1, 0, 0), 20)!.point.toArray()).toEqual([9, 0, 0]);
    mesh.dispose();
  });

  it('queryHeight finds the highest splat below within the drop and radius', () => {
    const mesh = new SplatMesh({ capacity: WIDTH });
    mesh.appendRange(
      dataAt([
        [0, 0, 0],
        [0, 1, 0],
        [0, 2, 0],
        [0, 5, 0],
        [3, 2, 0],
      ]),
    );

    // From (0,3,0): below within maxDrop 2.5 and radius 0.5 → y=2 (the y=0 splat
    // is 3 below = too far; y=5 is above; the x=3 splat is outside the disc).
    const hit = mesh.queryHeight(new THREE.Vector3(0, 3, 0), 2.5, 0.5);
    expect(hit).not.toBeNull();
    expect(hit!.point.toArray()).toEqual([0, 2, 0]);
    expect(hit!.drop).toBeCloseTo(1, 6);

    // Nothing below within reach of a point beneath the whole column.
    expect(mesh.queryHeight(new THREE.Vector3(0, -1, 0), 0.5, 0.5)).toBeNull();
    mesh.dispose();
  });

  it('answers in world space under rotated and uniformly scaled ancestors', () => {
    const mesh = new SplatMesh({ capacity: WIDTH });
    mesh.appendRange(dataAt([[1, 0, 0]]));
    const parent = new THREE.Group();
    parent.position.set(0, 3, 0);
    parent.rotation.y = Math.PI / 2; // local +x → world −z
    parent.scale.setScalar(2);
    parent.add(mesh);
    parent.updateMatrixWorld(true);

    // Local (1, 0, 0) → rotate → (0, 0, −1) → scale 2 → (0, 0, −2) → +(0, 3, 0).
    const expected = new THREE.Vector3(0, 3, -2);
    const hit = mesh.queryNearest(expected.clone(), 0.5);
    expect(hit).not.toBeNull();
    expect(hit!.point.distanceTo(expected)).toBeLessThan(1e-5);
    expect(hit!.distance).toBeCloseTo(0, 5);
    // A world radius that only reaches when correctly rescaled into local
    // units: the splat is 1 world unit away, radius 1.2 must find it.
    const offset = mesh.queryNearest(new THREE.Vector3(0, 3, -3), 1.2);
    expect(offset).not.toBeNull();
    expect(offset!.distance).toBeCloseTo(1, 5);

    // queryHeight judges the drop in world space despite the rotation.
    const floor = mesh.queryHeight(new THREE.Vector3(0, 4, -2), 2, 0.5);
    expect(floor).not.toBeNull();
    expect(floor!.drop).toBeCloseTo(1, 5);
    mesh.dispose();
  });

  it('honors orientation: y-up flips the queried frame, source keeps it', () => {
    const data = dataAt([[0, 1, 0]]);
    const stamped = { ...data, format: 'ply' as const };
    const yUp = new SplatMesh(stamped);
    const source = new SplatMesh(stamped, { orientation: 'source' });

    // y-up bakes the 180°-X flip into the mesh matrix: world (0, −1, 0).
    expect(yUp.queryNearest(new THREE.Vector3(0, -1, 0), 0.1)).not.toBeNull();
    expect(yUp.queryNearest(new THREE.Vector3(0, 1, 0), 0.1)).toBeNull();
    // source leaves the encoded frame untouched: world (0, 1, 0).
    expect(source.queryNearest(new THREE.Vector3(0, 1, 0), 0.1)).not.toBeNull();
    expect(source.queryNearest(new THREE.Vector3(0, -1, 0), 0.1)).toBeNull();
    yUp.dispose();
    source.dispose();
  });

  it('rejects non-finite and negative radii cleanly', () => {
    const mesh = new SplatMesh({ capacity: WIDTH });
    mesh.appendRange(dataAt([[0, 0, 0]]));
    expect(mesh.queryNearest(new THREE.Vector3(), Number.NaN)).toBeNull();
    expect(mesh.queryNearest(new THREE.Vector3(), -1)).toBeNull();
    expect(mesh.queryHeight(new THREE.Vector3(0, 1, 0), Number.NaN)).toBeNull();
    expect(mesh.queryHeight(new THREE.Vector3(0, 1, 0), 2, -1)).toBeNull();
    mesh.dispose();
  });

  it('returns null on an empty mesh', () => {
    const mesh = new SplatMesh({ capacity: WIDTH });
    expect(mesh.queryNearest(new THREE.Vector3(), 10)).toBeNull();
    expect(mesh.queryHeight(new THREE.Vector3(), 10)).toBeNull();
    mesh.dispose();
  });
});
