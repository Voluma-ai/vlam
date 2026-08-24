import { describe, expect, it } from 'vitest';
import {
  clampVolumeScale,
  meshLocalSdfShape,
  unitVolumeDimensions,
  type Mat4Elements,
} from '../selection-transform';

/**
 * Frame math for the `?separate=1` placement gizmo. The node environment has no
 * `three`, so every matrix here is built by hand in column-major order - which
 * is also the point: these assertions are independent of the implementation's
 * own helpers.
 */

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

/** A column-major affine 4×4 from a basis and a translation. */
function matrix(basis: readonly number[], translation: Vec3): number[] {
  // prettier-ignore
  return [
    basis[0] as number, basis[1] as number, basis[2] as number, 0,
    basis[3] as number, basis[4] as number, basis[5] as number, 0,
    basis[6] as number, basis[7] as number, basis[8] as number, 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

const IDENTITY_BASIS = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Scale-only placement (columns are the scaled axes). */
function compose(translation: Vec3, scale: Vec3): number[] {
  return matrix([scale[0], 0, 0, 0, scale[1], 0, 0, 0, scale[2]], translation);
}

/** Rotation about `axis` by `angle`, as a column-major basis (Rodrigues). */
function rotationBasis(axis: Vec3, angle: number): number[] {
  const length = Math.hypot(...axis);
  const [x, y, z] = [axis[0] / length, axis[1] / length, axis[2] / length];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  // Column-major: entries are listed column by column.
  return [
    t * x * x + c,
    t * x * y + s * z,
    t * x * z - s * y,
    t * x * y - s * z,
    t * y * y + c,
    t * y * z + s * x,
    t * x * z + s * y,
    t * y * z - s * x,
    t * z * z + c,
  ];
}

/** Full placement: rotate, then scale each axis, then translate. */
function composeFull(translation: Vec3, axis: Vec3, angle: number, scale: Vec3): number[] {
  const r = rotationBasis(axis, angle);
  // Post-multiplying by a diagonal scales each *column* - matching R · S.
  return matrix(
    [
      (r[0] as number) * scale[0],
      (r[1] as number) * scale[0],
      (r[2] as number) * scale[0],
      (r[3] as number) * scale[1],
      (r[4] as number) * scale[1],
      (r[5] as number) * scale[1],
      (r[6] as number) * scale[2],
      (r[7] as number) * scale[2],
      (r[8] as number) * scale[2],
    ],
    translation,
  );
}

/** `m · p` for a point (w = 1). */
function transformPoint(m: Mat4Elements, p: Vec3): Vec3 {
  return [
    (m[0] as number) * p[0] + (m[4] as number) * p[1] + (m[8] as number) * p[2] + (m[12] as number),
    (m[1] as number) * p[0] + (m[5] as number) * p[1] + (m[9] as number) * p[2] + (m[13] as number),
    (m[2] as number) * p[0] +
      (m[6] as number) * p[1] +
      (m[10] as number) * p[2] +
      (m[14] as number),
  ];
}

/** Rotates `v` by the quaternion `q` (the standard `v + 2q_v × (q_v × v + wv)`). */
function applyQuaternion(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

function expectVectorClose(actual: readonly number[], expected: readonly number[]): void {
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i] as number, 10);
  }
}

describe('unitVolumeDimensions', () => {
  it('spans ±1 on every axis, matching the unit wireframe geometry', () => {
    expect(unitVolumeDimensions('box')).toEqual({ halfExtents: [1, 1, 1] });
    expect(unitVolumeDimensions('sphere')).toEqual({ radius: 1 });
    expect(unitVolumeDimensions('cylinder')).toEqual({ radius: 1, height: 2 });
  });
});

describe('clampVolumeScale', () => {
  it('lifts a zero, negative or non-finite axis to the floor', () => {
    expect(clampVolumeScale([0, -0.5, Number.NaN], 0.25)).toEqual([0.25, 0.5, 0.25]);
    expect(clampVolumeScale([1e-30, Number.POSITIVE_INFINITY, 3], 0.25)).toEqual([0.25, 0.25, 3]);
  });

  it('leaves an already-valid scale untouched', () => {
    expect(clampVolumeScale([2, 0.5, 7], 0.1)).toEqual([2, 0.5, 7]);
  });

  it('falls back to its own floor when the minimum is unusable', () => {
    const [x] = clampVolumeScale([0, 0, 0], 0);
    expect(x).toBeGreaterThan(0);
  });
});

describe('meshLocalSdfShape', () => {
  it('passes a translated axis-aligned box through an identity mesh unchanged', () => {
    const shape = meshLocalSdfShape(
      'box',
      compose([1, 2, 3], [0.5, 2, 4]),
      matrix(IDENTITY_BASIS, [0, 0, 0]),
    );
    expect(shape).not.toBeNull();
    expectVectorClose(shape!.center, [1, 2, 3]);
    expectVectorClose(shape!.rotation, [0, 0, 0, 1]);
    expectVectorClose(shape!.halfExtents!, [0.5, 2, 4]);
  });

  it('reproduces every box corner exactly under rotated mesh and volume', () => {
    // The strong one: a rotated, anisotropically scaled volume inside a rotated
    // mesh. Each unit corner mapped through V then M⁻¹ must land exactly on
    // `center + R(rotation) · (±halfExtents)` - which is what the shader tests.
    // Catches a transposed rotation, a swapped multiplication order, or a
    // mis-signed quaternion, none of which the simpler cases would show.
    const volume = composeFull([3, -1, 2], [0.3, 1, -0.7], 0.9, [2, 0.4, 1.5]);
    const mesh = composeFull([-2, 5, 1], [1, 0.2, 0.4], -1.1, [0.75, 0.75, 0.75]);
    const shape = meshLocalSdfShape('box', volume, mesh);
    expect(shape).not.toBeNull();

    const meshInverse = invertForTest(mesh);
    for (const corner of [
      [1, 1, 1],
      [1, 1, -1],
      [1, -1, 1],
      [1, -1, -1],
      [-1, 1, 1],
      [-1, 1, -1],
      [-1, -1, 1],
      [-1, -1, -1],
    ] as Vec3[]) {
      const meshLocal = transformPoint(meshInverse, transformPoint(volume, corner));
      const half = shape!.halfExtents!;
      const offset = applyQuaternion(shape!.rotation as Quat, [
        corner[0] * half[0],
        corner[1] * half[1],
        corner[2] * half[2],
      ]);
      expectVectorClose(meshLocal, [
        shape!.center[0] + offset[0],
        shape!.center[1] + offset[1],
        shape!.center[2] + offset[2],
      ]);
    }
  });

  it('maps the center through a pure mesh rotation', () => {
    // The y-down flip the demo applies to several formats: π about X.
    const mesh = matrix(rotationBasis([1, 0, 0], Math.PI), [0, 0, 0]);
    const shape = meshLocalSdfShape('box', compose([1, 2, 3], [1, 1, 1]), mesh);
    expect(shape).not.toBeNull();
    expectVectorClose(shape!.center, [1, -2, -3]);
    // Compare rotations by their action, never componentwise: q and −q are the
    // same rotation and the decomposition may return either.
    expectVectorClose(applyQuaternion(shape!.rotation as Quat, [0, 1, 0]), [0, -1, 0]);
    expectVectorClose(shape!.halfExtents!, [1, 1, 1]);
  });

  it('divides through a uniformly scaled mesh', () => {
    const shape = meshLocalSdfShape(
      'box',
      compose([4, 8, 2], [3, 6, 1.5]),
      compose([0, 0, 0], [2, 2, 2]),
    );
    expect(shape).not.toBeNull();
    expectVectorClose(shape!.center, [2, 4, 1]);
    expectVectorClose(shape!.halfExtents!, [1.5, 3, 0.75]);
  });

  it('collapses an anisotropic sphere to a volume-preserving radius', () => {
    const shape = meshLocalSdfShape(
      'sphere',
      compose([0, 0, 0], [1, 2, 4]),
      matrix(IDENTITY_BASIS, [0, 0, 0]),
    );
    expect(shape).not.toBeNull();
    expect(shape!.radius).toBeCloseTo(2, 10); // cbrt(1 · 2 · 4)
    expect(shape!.halfExtents).toBeUndefined();
    expect(shape!.height).toBeUndefined();
  });

  it('keeps a cylinder height exact and collapses only its cross-section', () => {
    const shape = meshLocalSdfShape(
      'cylinder',
      compose([0, 0, 0], [1, 3, 4]),
      matrix(IDENTITY_BASIS, [0, 0, 0]),
    );
    expect(shape).not.toBeNull();
    expect(shape!.radius).toBeCloseTo(2, 10); // sqrt(1 · 4)
    expect(shape!.height).toBeCloseTo(6, 10); // 2 · 3, exact
  });

  it('returns null for a singular mesh matrix rather than NaN dimensions', () => {
    const flattened = matrix([1, 0, 0, 0, 1, 0, 0, 0, 0], [0, 0, 0]);
    expect(meshLocalSdfShape('box', compose([0, 0, 0], [1, 1, 1]), flattened)).toBeNull();
  });

  it('returns null when either matrix is non-finite', () => {
    const identity = matrix(IDENTITY_BASIS, [0, 0, 0]);
    const broken = matrix(IDENTITY_BASIS, [Number.NaN, 0, 0]);
    expect(meshLocalSdfShape('box', broken, identity)).toBeNull();
    expect(meshLocalSdfShape('box', identity, broken)).toBeNull();
  });

  it('reports positive dimensions and a unit quaternion for a mirrored mesh', () => {
    // A mirrored matrix decomposes with one negative scale component so the
    // residual basis stays a proper rotation; the dimensions must not inherit
    // that sign, or `setShapes` throws.
    const shape = meshLocalSdfShape(
      'box',
      compose([0, 0, 0], [1, 1, 1]),
      compose([0, 0, 0], [1, 1, -1]),
    );
    expect(shape).not.toBeNull();
    for (const extent of shape!.halfExtents!) expect(extent).toBeGreaterThan(0);
    const [x, y, z, w] = shape!.rotation;
    expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 10);
  });
});

/** Independent affine inverse, so the corner round-trip does not lean on the module's. */
function invertForTest(m: readonly number[]): number[] {
  const a = (r: number, c: number): number => m[c * 4 + r] as number;
  const cofactor = (r: number, c: number): number => {
    const rows = [0, 1, 2].filter((i) => i !== r);
    const cols = [0, 1, 2].filter((i) => i !== c);
    const minor =
      a(rows[0] as number, cols[0] as number) * a(rows[1] as number, cols[1] as number) -
      a(rows[0] as number, cols[1] as number) * a(rows[1] as number, cols[0] as number);
    return (r + c) % 2 === 0 ? minor : -minor;
  };
  const det = a(0, 0) * cofactor(0, 0) + a(0, 1) * cofactor(0, 1) + a(0, 2) * cofactor(0, 2);
  // Inverse of the 3×3 is the adjugate (transposed cofactors) over the determinant.
  const inv3: number[][] = [0, 1, 2].map((r) => [0, 1, 2].map((c) => cofactor(c, r) / det));
  const t: Vec3 = [a(0, 3), a(1, 3), a(2, 3)];
  const translation: Vec3 = [0, 1, 2].map(
    (r) =>
      -(
        (inv3[r] as number[])[0]! * t[0] +
        (inv3[r] as number[])[1]! * t[1] +
        (inv3[r] as number[])[2]! * t[2]
      ),
  ) as Vec3;
  return matrix(
    [
      (inv3[0] as number[])[0]!,
      (inv3[1] as number[])[0]!,
      (inv3[2] as number[])[0]!,
      (inv3[0] as number[])[1]!,
      (inv3[1] as number[])[1]!,
      (inv3[2] as number[])[1]!,
      (inv3[0] as number[])[2]!,
      (inv3[1] as number[])[2]!,
      (inv3[2] as number[])[2]!,
    ],
    translation,
  );
}
