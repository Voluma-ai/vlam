import type { SdfShapeKind } from '../lib/effects';
import type { SelectionVolumeKind } from '../lib/selection';

/** Exact frame math for the selection gizmo and its GPU tint preview. */

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

/** Exact shape-local → mesh-local preview placement, as column-major elements. */
export interface MeshLocalSdfShape {
  readonly kind: SdfShapeKind;
  readonly transform: readonly number[];
  readonly halfExtents?: readonly [number, number, number];
  readonly radius?: number;
  readonly height?: number;
}

/** Maps the selection into mesh-local space without dropping shear or anisotropy. */
export function meshLocalSdfShape(
  kind: SelectionVolumeKind,
  volumeTransform: Mat4Elements,
  meshWorldMatrix: Mat4Elements,
): MeshLocalSdfShape | null {
  if (!isFiniteAffine(volumeTransform) || !isFiniteAffine(meshWorldMatrix)) return null;
  const meshInverse = invertAffine(meshWorldMatrix);
  if (meshInverse === null || invertAffine(volumeTransform) === null) return null;
  const transform = multiplyAffine(meshInverse, volumeTransform);
  if (!isFiniteAffine(transform)) return null;
  return { kind, transform, ...unitVolumeDimensions(kind) };
}

/** Every element of an affine 4×4 is a real number. */
function isFiniteAffine(e: Mat4Elements): boolean {
  for (let i = 0; i < 16; i++) {
    if (!Number.isFinite(e[i])) return false;
  }
  return e[3] === 0 && e[7] === 0 && e[11] === 0 && e[15] === 1;
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
