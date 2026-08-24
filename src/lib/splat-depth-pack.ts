/**
 * 24-bit RGB packing for linear view-space depth used by GPU splat picking.
 *
 * Depth is stored as a normalized value in [0, 1] mapped across the camera
 * near/far range, then quantized into three 8-bit channels (R = high byte).
 * This matches an RGBA8 render target without a depth-texture readback path.
 */
import * as THREE from 'three/webgpu';

/** Maximum integer representable in 24 bits. */
const DEPTH_24_MAX = (1 << 24) - 1;

const _ndc = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
const _dirView = new THREE.Vector3();

/**
 * Packs a normalized depth in [0, 1] into 8-bit RGB (high → low).
 * Values outside [0, 1] are clamped.
 */
export function packNormalizedDepth(normalized: number): { r: number; g: number; b: number } {
  const t = Math.min(1, Math.max(0, normalized));
  const encoded = Math.round(t * DEPTH_24_MAX);
  return {
    r: (encoded >> 16) & 0xff,
    g: (encoded >> 8) & 0xff,
    b: encoded & 0xff,
  };
}

/**
 * Unpacks 8-bit RGB channels back to a normalized depth in [0, 1].
 */
export function unpackNormalizedDepth(r: number, g: number, b: number): number {
  const encoded = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
  return encoded / DEPTH_24_MAX;
}

/**
 * Maps a positive linear view-space depth (OpenGL: −z) into [0, 1] using the
 * camera near/far plane. Clamps to the range.
 */
export function normalizeViewDepth(viewDepth: number, near: number, far: number): number {
  if (!(far > near)) return 0;
  return Math.min(1, Math.max(0, (viewDepth - near) / (far - near)));
}

/**
 * Inverse of {@link normalizeViewDepth}.
 */
export function denormalizeViewDepth(normalized: number, near: number, far: number): number {
  return near + normalized * (far - near);
}

/**
 * Reconstructs a world-space hit from NDC and a positive view-space depth
 * (−z in OpenGL camera space). Writes into `outPoint` and returns camera
 * distance. The camera must have an up-to-date world matrix.
 */
export function unprojectViewDepth(
  ndcX: number,
  ndcY: number,
  viewDepth: number,
  camera: THREE.Camera,
  outPoint: THREE.Vector3,
): { point: THREE.Vector3; distance: number } {
  _ndc.set(ndcX, ndcY);
  _raycaster.setFromCamera(_ndc, camera);
  // View-space Z of the hit is −viewDepth; scale the world ray so its view-Z
  // matches. Camera upper-3×3 is orthonormal (no non-uniform scale).
  _dirView.copy(_raycaster.ray.direction).transformDirection(camera.matrixWorldInverse);
  const t = viewDepth / -_dirView.z;
  outPoint.copy(_raycaster.ray.origin).addScaledVector(_raycaster.ray.direction, t);
  return { point: outPoint, distance: outPoint.distanceTo(_raycaster.ray.origin) };
}
