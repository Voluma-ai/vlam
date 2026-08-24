import * as THREE from 'three/webgpu';

/**
 * LCC2 / XGRIDS captures are Z-up. Three.js (and this package's SOG/PLY path)
 * expects Y-up. The established LCC/Spark convention maps raw LCC coordinates
 * `(x, y, z)` → `(-x, z, y)` - equivalent to −90° about X followed by 180°
 * about Y. Kept as a single matrix so consumers cannot accidentally apply only
 * half of the correction.
 *
 * Basis check: +X → −X, +Y → +Z, +Z → +Y.
 */
export function createLcc2ToThreeMatrix(): THREE.Matrix4 {
  // Row-major: x'=-x, y'=z, z'=y.
  return new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
}

/**
 * Applies the LCC2→Three.js format correction to a mesh. Bounds and LOD data
 * stay in source-local coordinates; `matrixWorld` / `worldToLocal` pick this up.
 * `StreamedSplatMesh.load()` applies this correction automatically for LCC2;
 * use this helper only with meshes created through another loading path.
 */
export function applyLcc2ToThreeTransform(target: THREE.Object3D): void {
  target.matrix.copy(createLcc2ToThreeMatrix());
  target.matrix.decompose(target.position, target.quaternion, target.scale);
  target.matrixWorldNeedsUpdate = true;
}
