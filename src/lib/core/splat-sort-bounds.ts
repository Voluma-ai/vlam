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
