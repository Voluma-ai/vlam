import type * as THREE from 'three/webgpu';

/**
 * The greatest view-space depth displacement of a local bounding sphere.
 *
 * View depth is the dot product of the local point and row 2 of `modelView`.
 * A sphere with radius `r` therefore spans exactly `r · ||row2.xyz||` either
 * side of its transformed center. Unlike a maximum-axis-scale estimate, this
 * remains correct when a non-uniformly scaled ancestor and a rotated child
 * compose into a shear.
 */
export function viewDepthRadius(modelView: THREE.Matrix4, radius: number): number {
  const m = modelView.elements;
  return radius * Math.hypot(m[2], m[6], m[10]);
}

/**
 * A conservative camera-space radius for radial-distance quantization.
 *
 * Uses `sqrt(||A^T A||∞)`, an upper bound on the linear part's largest
 * singular value. Unlike `Matrix4.getMaxScaleOnAxis()`, it cannot under-bound
 * a sphere when a transformed hierarchy introduces shear.
 */
export function viewRadialRadius(modelView: THREE.Matrix4, radius: number): number {
  const e = modelView.elements;
  const x0 = e[0];
  const y0 = e[1];
  const z0 = e[2];
  const x1 = e[4];
  const y1 = e[5];
  const z1 = e[6];
  const x2 = e[8];
  const y2 = e[9];
  const z2 = e[10];
  const g00 = x0 * x0 + y0 * y0 + z0 * z0;
  const g11 = x1 * x1 + y1 * y1 + z1 * z1;
  const g22 = x2 * x2 + y2 * y2 + z2 * z2;
  const g01 = x0 * x1 + y0 * y1 + z0 * z1;
  const g02 = x0 * x2 + y0 * y2 + z0 * z2;
  const g12 = x1 * x2 + y1 * y2 + z1 * z2;
  return (
    radius *
    Math.sqrt(
      Math.max(
        g00 + Math.abs(g01) + Math.abs(g02),
        g11 + Math.abs(g01) + Math.abs(g12),
        g22 + Math.abs(g02) + Math.abs(g12),
      ),
    )
  );
}

/**
 * Builds the pose signature relevant to radial sorting.
 *
 * World-space distance depends on the mesh's linear transform and its
 * translation relative to the camera, but not on camera orientation. The
 * scheduler compares this matrix so rotating in place does not dispatch an
 * identical radial sort.
 */
export function radialSortState(
  meshWorld: THREE.Matrix4,
  cameraWorld: THREE.Matrix4,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  out.copy(meshWorld);
  const state = out.elements;
  const camera = cameraWorld.elements;
  state[12] -= camera[12];
  state[13] -= camera[13];
  state[14] -= camera[14];
  return out;
}
