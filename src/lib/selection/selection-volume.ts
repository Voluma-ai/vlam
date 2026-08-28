import * as THREE from 'three/webgpu';
import type { SplatData } from '../core/splat-data';

/**
 * Volume selection over splat centers (CPU).
 *
 * A {@link SelectionVolume} answers one question - is this point inside the
 * volume? - so hosts can select a region of a loaded splat cloud with a placed
 * box, sphere or cylinder ({@link createSelectionVolume}), or with any custom
 * shape by implementing the interface directly.
 *
 * Selection runs over a `SplatData`'s positions ({@link selectInData}); the
 * split itself lives in `splat-partition.ts`. Everything here is pure array
 * math - no GPU, no mesh - so it is cheap to test and works the same for any
 * host. A one-shot selection gesture over a few million centers is a
 * brute-force scan by design: it costs milliseconds, needs no index to build
 * or invalidate, and supports arbitrarily transformed (including non-uniformly
 * scaled) volumes that a radius-based spatial grid cannot.
 */
export interface SelectionVolume {
  /**
   * Whether the point `(x, y, z)` lies inside the volume, in **the frame the
   * volume was built for** - for {@link createSelectionVolume} that is the
   * frame of the positions passed to {@link selectInData} (splat-local for a
   * `SplatData`, source-local for a collision mesh), fixed by the
   * `worldMatrix` argument.
   *
   * A splat is selected iff its *center* passes this test; a splat whose
   * center is outside but whose ellipsoid extent overlaps the volume is not
   * selected.
   */
  containsPoint(x: number, y: number, z: number): boolean;
}

/** The built-in selection shapes. Custom shapes implement {@link SelectionVolume}. */
export type SelectionVolumeKind = 'box' | 'sphere' | 'cylinder';

/** Describes a built-in selection shape for {@link createSelectionVolume}. */
export interface SelectionVolumeOptions {
  kind: SelectionVolumeKind;
  /**
   * Places the shape: volume-local → world. Encodes the shape's center,
   * orientation and any (possibly non-uniform) scale. Default identity.
   * Must be invertible - a zero scale axis throws.
   */
  transform?: THREE.Matrix4;
  /**
   * Box half-extents (volume-local units). Required for `kind: 'box'`; every
   * component must be positive.
   */
  halfExtents?: readonly [number, number, number];
  /**
   * Sphere or cylinder radius (volume-local units). Required for
   * `kind: 'sphere'` and `kind: 'cylinder'`; must be positive.
   */
  radius?: number;
  /**
   * Cylinder full height along the volume-local Y axis. Required for
   * `kind: 'cylinder'`; must be positive.
   */
  height?: number;
}

/**
 * Builds a {@link SelectionVolume} for one of the built-in shapes.
 *
 * `worldMatrix` is the local → world matrix of the geometry being selected
 * (`mesh.matrixWorld`; omit for data not attached to a mesh). It fixes the
 * frame {@link SelectionVolume.containsPoint} expects: each point is mapped
 * through `transform⁻¹ · worldMatrix` into the shape's own frame, so a rotated
 * or non-uniformly scaled volume placement costs the same as an axis-aligned
 * one.
 *
 * @throws {Error} if the shape's dimensions are missing/non-positive, or if
 * the combined `transform⁻¹ · worldMatrix` is singular or non-finite (a
 * collapsed axis on either matrix would otherwise select silent garbage).
 */
export function createSelectionVolume(
  options: SelectionVolumeOptions,
  worldMatrix?: THREE.Matrix4,
): SelectionVolume {
  // Guard both inputs before composing: `Matrix4.invert` reports a singular
  // matrix by silently returning zeros, which would map every point onto the
  // origin and "select" the whole cloud.
  if (options.transform) assertUsableMatrix(options.transform, '`transform`');
  if (worldMatrix) assertUsableMatrix(worldMatrix, '`worldMatrix`');

  const toVolume = new THREE.Matrix4();
  if (options.transform) toVolume.copy(options.transform).invert();
  if (worldMatrix) toVolume.multiply(worldMatrix);

  // Column-major linear part + translation, hoisted out of the per-point test:
  // the scan runs over millions of centers, so it must not touch the matrix
  // object, allocate, or call through a closure per point.
  const e = toVolume.elements;
  const m00 = e[0];
  const m10 = e[1];
  const m20 = e[2];
  const m01 = e[4];
  const m11 = e[5];
  const m21 = e[6];
  const m02 = e[8];
  const m12 = e[9];
  const m22 = e[10];
  const tx = e[12];
  const ty = e[13];
  const tz = e[14];

  switch (options.kind) {
    case 'box': {
      const he = options.halfExtents;
      if (!he || !(he[0] > 0) || !(he[1] > 0) || !(he[2] > 0)) {
        throw new Error(
          'createSelectionVolume: a box requires halfExtents with three positive ' +
            `components (got ${he ? `[${he.join(', ')}]` : 'undefined'}).`,
        );
      }
      const [hx, hy, hz] = he;
      return {
        containsPoint: (x, y, z) =>
          Math.abs(m00 * x + m01 * y + m02 * z + tx) <= hx &&
          Math.abs(m10 * x + m11 * y + m12 * z + ty) <= hy &&
          Math.abs(m20 * x + m21 * y + m22 * z + tz) <= hz,
      };
    }
    case 'sphere': {
      const r = requirePositive(options.radius, 'sphere', 'radius');
      const r2 = r * r;
      return {
        containsPoint: (x, y, z) => {
          const vx = m00 * x + m01 * y + m02 * z + tx;
          const vy = m10 * x + m11 * y + m12 * z + ty;
          const vz = m20 * x + m21 * y + m22 * z + tz;
          return vx * vx + vy * vy + vz * vz <= r2;
        },
      };
    }
    case 'cylinder': {
      const r = requirePositive(options.radius, 'cylinder', 'radius');
      const halfHeight = requirePositive(options.height, 'cylinder', 'height') / 2;
      const r2 = r * r;
      return {
        containsPoint: (x, y, z) => {
          const vy = m10 * x + m11 * y + m12 * z + ty;
          if (Math.abs(vy) > halfHeight) return false;
          const vx = m00 * x + m01 * y + m02 * z + tx;
          const vz = m20 * x + m21 * y + m22 * z + tz;
          return vx * vx + vz * vz <= r2;
        },
      };
    }
  }
}

/**
 * The indices of every splat in `data` whose center is inside `volume`,
 * ascending. Pure read - `data` is untouched; feed the result (or the volume
 * directly) to `partitionSplatData` to split.
 */
export function selectInData(data: SplatData, volume: SelectionVolume): Uint32Array {
  const { positions, count } = data;
  // One growth-free pass: collect into a full-size buffer, then trim.
  const hits = new Uint32Array(count);
  let n = 0;
  for (let i = 0; i < count; i++) {
    if (
      volume.containsPoint(
        positions[i * 3] as number,
        positions[i * 3 + 1] as number,
        positions[i * 3 + 2] as number,
      )
    ) {
      hits[n++] = i;
    }
  }
  return hits.slice(0, n);
}

/**
 * How many splats in `data` fall inside `volume`, without materializing the
 * index list - for a live "n selected" readout while a host drags a volume
 * around, where {@link selectInData}'s `Uint32Array(count)` would allocate tens
 * of megabytes per pointer event on a large scene.
 */
export function countInData(data: SplatData, volume: SelectionVolume): number {
  const { positions, count } = data;
  let n = 0;
  for (let i = 0; i < count; i++) {
    if (
      volume.containsPoint(
        positions[i * 3] as number,
        positions[i * 3 + 1] as number,
        positions[i * 3 + 2] as number,
      )
    ) {
      n++;
    }
  }
  return n;
}

function requirePositive(value: number | undefined, kind: string, name: string): number {
  if (!(typeof value === 'number' && value > 0)) {
    throw new Error(
      `createSelectionVolume: a ${kind} requires a positive ${name} (got ${String(value)}).`,
    );
  }
  return value;
}

/** Rejects a non-finite or singular placement matrix before it is inverted. */
function assertUsableMatrix(matrix: THREE.Matrix4, label: string): void {
  for (const value of matrix.elements) {
    if (!Number.isFinite(value)) {
      throw new Error(`createSelectionVolume: ${label} contains a non-finite value.`);
    }
  }
  if (matrix.determinant() === 0) {
    throw new Error(
      `createSelectionVolume: ${label} is not invertible (a zero scale axis collapses the volume).`,
    );
  }
}
