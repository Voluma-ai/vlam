import type { SdfShapeKind } from '../lib/effects';
import type { SelectionVolumeKind } from '../lib';

/**
 * The frame math behind the `?separate=1` placement gizmo.
 *
 * The demo places its selection volume with a transform gizmo, so the volume
 * carries a full placement - position, orientation and a *per-axis* scale. Two
 * consumers need that placement in different forms:
 *
 *  - the CPU selection (`createSelectionVolume`) takes it as a matrix and tests
 *    every splat in the volume's own unit space, so rotation and non-uniform
 *    scale are exact and free there;
 *  - the GPU tint preview (`sdfEffects`) takes a *mesh-local* center, rotation
 *    and per-kind dimensions, which cannot express every placement.
 *
 * {@link meshLocalSdfShape} is the bridge, and the only place the two can
 * disagree. Kept DOM-free and free of any runtime `three` import so the vitest
 * node environment can test it (same pattern as `separation-state.ts` and
 * `volume-estimate.ts`).
 */

/** A 4×4 matrix in column-major order - `THREE.Matrix4.elements` layout. */
export type Mat4Elements = ArrayLike<number>;

/**
 * Floor for any dimension handed to `SdfEffect.setShapes`, which throws on a
 * non-positive one. Small enough to be invisible, large enough that the
 * shader's divisions stay finite.
 */
const MIN_SDF_DIMENSION = 1e-6;

/** Per-kind dimensions of the selection volume. */
export type VolumeDimensions =
  | { readonly halfExtents: readonly [number, number, number] }
  | { readonly radius: number }
  | { readonly radius: number; readonly height: number };

/**
 * Dimensions of the *unit* selection shape, spanning ±1 on every axis.
 *
 * The gizmo bakes the whole placement - including a per-axis scale - into the
 * volume's `transform`, so the dimensions are always these constants. That is
 * what makes a squashed sphere select a true ellipsoid rather than a ball of
 * some averaged radius, and it makes `createSelectionVolume`'s positive-
 * dimension check unfailable by construction.
 *
 * They match the unit wireframe geometry exactly: `BoxGeometry(2, 2, 2)`,
 * `SphereGeometry(1, …)`, `CylinderGeometry(1, 1, 2, …)`.
 */
export function unitVolumeDimensions(kind: SelectionVolumeKind): VolumeDimensions {
  if (kind === 'box') return { halfExtents: [1, 1, 1] };
  if (kind === 'sphere') return { radius: 1 };
  return { radius: 1, height: 2 };
}

/**
 * Clamps a volume scale to a strictly positive floor, componentwise.
 *
 * A zero (or non-finite) axis makes the placement matrix singular, which
 * `createSelectionVolume` rejects by *throwing* - and it is called from a
 * `requestAnimationFrame` callback, where a throw is unhandled. A scale gizmo
 * can drag an axis through zero, so this runs on every gizmo change.
 */
export function clampVolumeScale(
  scale: readonly [number, number, number],
  minimum: number,
): [number, number, number] {
  const floor = Number.isFinite(minimum) && minimum > 0 ? minimum : MIN_SDF_DIMENSION;
  const clamp = (value: number): number =>
    Number.isFinite(value) ? Math.max(Math.abs(value), floor) : floor;
  return [clamp(scale[0]), clamp(scale[1]), clamp(scale[2])];
}

/** SDF-preview parameters for the selection volume, in the mesh's local frame. */
export interface MeshLocalSdfShape {
  readonly kind: SdfShapeKind;
  readonly center: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly halfExtents?: readonly [number, number, number];
  readonly radius?: number;
  readonly height?: number;
}

/**
 * Maps a world-placed selection volume into the mesh-local frame the SDF tint
 * modifier evaluates in.
 *
 * With `V` the volume's local→world matrix and `M` the mesh's, the volume in
 * mesh-local space is `L · U` for `L = M⁻¹ · V` over the unit shape `U`.
 * Decomposing `L` into `(center, rotation, k)` makes the shader's test point
 * `R(rotation)⁻¹ · (p − center)` equal `diag(k) · u`, so:
 *
 *  - **box** - `halfExtents = |k|` reproduces `|u_i| ≤ 1` **exactly**;
 *  - **sphere** - the true region is an ellipsoid and the SDF only has a ball,
 *    so the radius collapses to `cbrt(|k_x k_y k_z|)`;
 *  - **cylinder** - `height = 2|k_y|` is exact; the elliptical cross-section
 *    collapses to `radius = sqrt(|k_x k_z|)`.
 *
 * Both reductions are volume-preserving, so the tint covers as much space as
 * the selection actually takes even where it cannot match its shape. The
 * selection itself is unaffected - it uses the matrix directly and is exact for
 * every placement.
 *
 * The decomposition is lossless whenever the *mesh's* own scale is uniform (it
 * then commutes with the mesh rotation). A non-uniformly scaled mesh combined
 * with a rotated volume leaves `L` sheared, and a shear cannot be decomposed
 * into rotation and scale - the preview then approximates for every kind,
 * boxes included. The demo's meshes are rigid or uniformly scaled (`?rot=`, the
 * built-in orientations), so this does not arise in practice.
 *
 * @returns `null` when the mesh matrix is singular or non-finite and has no
 * mesh-local image at all - callers skip the preview rather than hand
 * `setShapes` values it throws on.
 */
export function meshLocalSdfShape(
  kind: SelectionVolumeKind,
  volumeTransform: Mat4Elements,
  meshWorldMatrix: Mat4Elements,
): MeshLocalSdfShape | null {
  if (!isFiniteAffine(volumeTransform) || !isFiniteAffine(meshWorldMatrix)) return null;
  const meshInverse = invertAffine(meshWorldMatrix);
  if (meshInverse === null) return null;

  const local = multiplyAffine(meshInverse, volumeTransform);
  const basis = decomposeAffine(local);
  if (basis === null) return null;

  const { center, rotation, scale } = basis;
  const kx = Math.max(Math.abs(scale[0]), MIN_SDF_DIMENSION);
  const ky = Math.max(Math.abs(scale[1]), MIN_SDF_DIMENSION);
  const kz = Math.max(Math.abs(scale[2]), MIN_SDF_DIMENSION);

  if (kind === 'box') return { kind: 'box', center, rotation, halfExtents: [kx, ky, kz] };
  if (kind === 'sphere')
    return { kind: 'sphere', center, rotation, radius: Math.cbrt(kx * ky * kz) };
  return { kind: 'cylinder', center, rotation, radius: Math.sqrt(kx * kz), height: 2 * ky };
}

/** Every element of an affine 4×4 is a real number. */
function isFiniteAffine(e: Mat4Elements): boolean {
  for (let i = 0; i < 16; i++) {
    if (!Number.isFinite(e[i])) return false;
  }
  return true;
}

/**
 * Inverse of an affine 4×4 (column-major, bottom row assumed `0,0,0,1`) via the
 * 3×3 adjugate. Same shape as `volume-estimate.ts`'s helper, but the
 * determinant is guarded here: nothing upstream has validated this matrix.
 */
function invertAffine(e: Mat4Elements): number[] | null {
  const a00 = e[0] as number;
  const a10 = e[1] as number;
  const a20 = e[2] as number;
  const a01 = e[4] as number;
  const a11 = e[5] as number;
  const a21 = e[6] as number;
  const a02 = e[8] as number;
  const a12 = e[9] as number;
  const a22 = e[10] as number;
  const tx = e[12] as number;
  const ty = e[13] as number;
  const tz = e[14] as number;

  const b00 = a11 * a22 - a12 * a21;
  const b01 = a02 * a21 - a01 * a22;
  const b02 = a01 * a12 - a02 * a11;
  const det = a00 * b00 + a10 * b01 + a20 * b02;
  if (!Number.isFinite(det) || det === 0) return null;

  const inv = 1 / det;
  const m00 = b00 * inv;
  const m01 = b01 * inv;
  const m02 = b02 * inv;
  const m10 = (a12 * a20 - a10 * a22) * inv;
  const m11 = (a00 * a22 - a02 * a20) * inv;
  const m12 = (a02 * a10 - a00 * a12) * inv;
  const m20 = (a10 * a21 - a11 * a20) * inv;
  const m21 = (a01 * a20 - a00 * a21) * inv;
  const m22 = (a00 * a11 - a01 * a10) * inv;

  // prettier-ignore
  return [
    m00, m10, m20, 0,
    m01, m11, m21, 0,
    m02, m12, m22, 0,
    -(m00 * tx + m01 * ty + m02 * tz),
    -(m10 * tx + m11 * ty + m12 * tz),
    -(m20 * tx + m21 * ty + m22 * tz),
    1,
  ];
}

/** `a · b` for two affine 4×4s in column-major order. */
function multiplyAffine(a: Mat4Elements, b: Mat4Elements): number[] {
  const out = new Array<number>(16);
  for (let column = 0; column < 4; column++) {
    const bx = b[column * 4] as number;
    const by = b[column * 4 + 1] as number;
    const bz = b[column * 4 + 2] as number;
    const bw = b[column * 4 + 3] as number;
    for (let row = 0; row < 3; row++) {
      out[column * 4 + row] =
        (a[row] as number) * bx +
        (a[4 + row] as number) * by +
        (a[8 + row] as number) * bz +
        (a[12 + row] as number) * bw;
    }
    out[column * 4 + 3] = column === 3 ? 1 : 0;
  }
  return out;
}

interface AffineBasis {
  readonly center: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

/**
 * Splits an affine 4×4 into translation, rotation and per-axis scale - the same
 * decomposition `THREE.Matrix4.decompose` performs, including negating the
 * first scale component on a mirrored matrix so the residual basis stays a
 * *proper* rotation. Callers must therefore take `Math.abs` of the scale before
 * using it as a dimension.
 */
function decomposeAffine(e: readonly number[]): AffineBasis | null {
  const lengthX = Math.hypot(e[0] as number, e[1] as number, e[2] as number);
  const lengthY = Math.hypot(e[4] as number, e[5] as number, e[6] as number);
  const lengthZ = Math.hypot(e[8] as number, e[9] as number, e[10] as number);
  if (lengthX === 0 || lengthY === 0 || lengthZ === 0) return null;

  const determinant =
    (e[0] as number) *
      ((e[5] as number) * (e[10] as number) - (e[6] as number) * (e[9] as number)) -
    (e[4] as number) *
      ((e[1] as number) * (e[10] as number) - (e[2] as number) * (e[9] as number)) +
    (e[8] as number) * ((e[1] as number) * (e[6] as number) - (e[2] as number) * (e[5] as number));
  const scaleX = determinant < 0 ? -lengthX : lengthX;

  const m11 = (e[0] as number) / scaleX;
  const m21 = (e[1] as number) / scaleX;
  const m31 = (e[2] as number) / scaleX;
  const m12 = (e[4] as number) / lengthY;
  const m22 = (e[5] as number) / lengthY;
  const m32 = (e[6] as number) / lengthY;
  const m13 = (e[8] as number) / lengthZ;
  const m23 = (e[9] as number) / lengthZ;
  const m33 = (e[10] as number) / lengthZ;

  let x: number;
  let y: number;
  let z: number;
  let w: number;
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m32 - m23) * s;
    y = (m13 - m31) * s;
    z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s;
    x = 0.25 * s;
    y = (m12 + m21) / s;
    z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s;
    x = (m12 + m21) / s;
    y = 0.25 * s;
    z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s;
    x = (m13 + m31) / s;
    y = (m23 + m32) / s;
    z = 0.25 * s;
  }

  return {
    center: [e[12] as number, e[13] as number, e[14] as number],
    rotation: [x, y, z, w],
    scale: [scaleX, lengthY, lengthZ],
  };
}
