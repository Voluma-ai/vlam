import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { transformCovariance, writeCovariance } from '../splat-data';

/** The 9-element column-major linear part a caller feeds {@link transformCovariance}. */
function linearPart(m: THREE.Matrix4): number[] {
  const e = m.elements;
  return [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]] as number[];
}

/** Reference Σ' = A·Σ·Aᵀ via THREE.Matrix3, returned as the upper triangle. */
function referenceTransform(cov6: Float32Array, m: THREE.Matrix4): number[] {
  const [s00, s01, s02, s11, s12, s22] = cov6 as unknown as number[];
  // Matrix3.set takes row-major arguments; Σ is symmetric.
  const sigma = new THREE.Matrix3().set(
    s00 as number,
    s01 as number,
    s02 as number,
    s01 as number,
    s11 as number,
    s12 as number,
    s02 as number,
    s12 as number,
    s22 as number,
  );
  const a = new THREE.Matrix3().setFromMatrix4(m);
  const aT = a.clone().transpose();
  const result = a.clone().multiply(sigma).multiply(aT);
  const r = result.elements; // column-major
  // Upper triangle m00, m01, m02, m11, m12, m22.
  return [r[0], r[3], r[6], r[4], r[7], r[8]] as number[];
}

function makeCovariance(sx: number, sy: number, sz: number, q: THREE.Quaternion): Float32Array {
  const cov = new Float32Array(6);
  writeCovariance(cov, 0, sx, sy, sz, q.w, q.x, q.y, q.z);
  return cov;
}

describe('transformCovariance (Σ’ = A·Σ·Aᵀ)', () => {
  const cases: { name: string; matrix: THREE.Matrix4 }[] = [
    { name: 'identity', matrix: new THREE.Matrix4() },
    {
      name: 'pure rotation (90° about Y)',
      matrix: new THREE.Matrix4().makeRotationY(Math.PI / 2),
    },
    {
      name: 'arbitrary rotation',
      matrix: new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.4, -1.1, 2.3)),
    },
    {
      name: 'non-uniform scale',
      matrix: new THREE.Matrix4().makeScale(2, 0.5, 3),
    },
    {
      name: 'rotation + non-uniform scale + translation',
      matrix: new THREE.Matrix4().compose(
        new THREE.Vector3(10, -4, 7), // translation must not affect the result
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.7, 1.2, 0.3)),
        new THREE.Vector3(1.5, 0.8, 2.2),
      ),
    },
  ];

  const cov = makeCovariance(
    0.08,
    0.03,
    0.05,
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.5, -0.3)),
  );

  for (const { name, matrix } of cases) {
    it(`matches the Matrix3 reference for ${name}`, () => {
      const out = new Float32Array(6);
      transformCovariance(out, 0, cov, 0, linearPart(matrix));
      const expected = referenceTransform(cov, matrix);
      for (let i = 0; i < 6; i++) {
        expect(out[i]).toBeCloseTo(expected[i] as number, 5);
      }
    });
  }

  it('composes placement then host rotation as R·(A·Σ·Aᵀ)·Rᵀ = (R·A)·Σ·(R·A)ᵀ', () => {
    // Pins the ordering the material graph relies on (M16): the per-source
    // placement A maps the source's data frame to mesh-local so it is
    // innermost, and a host modifier's rigid rotation R is authored in
    // mesh-local so it wraps A. Applying them in the other order rotates the
    // splat about the wrong frame once a source is placed non-trivially.
    const a = new THREE.Matrix4()
      .makeRotationFromQuaternion(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, 0.9, 0.2).normalize(), 0.7),
      )
      .scale(new THREE.Vector3(2, 0.5, 1.3)); // non-uniform: A·Σ·Aᵀ is still exact
    const r = new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.4),
    );

    const placed = new Float32Array(6);
    transformCovariance(placed, 0, cov, 0, linearPart(a));
    const stepwise = new Float32Array(6);
    transformCovariance(stepwise, 0, placed, 0, linearPart(r));

    const combined = new Float32Array(6);
    transformCovariance(combined, 0, cov, 0, linearPart(r.clone().multiply(a)));

    for (let i = 0; i < 6; i++) {
      expect(stepwise[i]).toBeCloseTo(combined[i] as number, 5);
    }
  });

  it('writes at the requested output/input offsets', () => {
    const packed = new Float32Array(12);
    packed.set(cov, 6);
    const out = new Float32Array(12);
    transformCovariance(out, 1, packed, 1, linearPart(new THREE.Matrix4()));
    // Slot 0 stays zero; slot 1 holds the (identity-transformed) covariance.
    for (let i = 0; i < 6; i++) expect(out[i]).toBe(0);
    for (let i = 0; i < 6; i++) expect(out[6 + i]).toBeCloseTo(cov[i] as number, 6);
  });
});
