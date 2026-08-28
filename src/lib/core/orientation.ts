import * as THREE from 'three/webgpu';

/**
 * How a loaded capture is oriented into the three.js Y-up world.
 *
 * - `'y-up'` (default): VLAM normalizes every known format to three.js Y-up -
 *   the OpenCV-frame formats (PLY/`.splat`/`.ksplat`/SOG/`.rad`) are flipped
 *   180° about X, SPZ is already Y-up, and LCC carries its own Z-up→Y-up matrix.
 *   "Drop a file and it stands up", matching engine viewers (PlayCanvas, Babylon).
 * - `'source'`: keep the native/source coordinate frame. No cosmetic 180°-X flip.
 *   An application that manages orientation itself (for example swapping viewers
 *   while keeping one stored per-capture rotation) uses this.
 *
 * LCC's Z-up→Y-up matrix is format semantics, not a cosmetic default: it is
 * applied in **both** modes (Spark applies it too). Only the 180°-X flip for
 * the Y-down formats is gated by this option.
 */
export type SplatOrientation = 'y-up' | 'source';

/**
 * Formats {@link yUpTransformForFormat} understands: the self-contained scene
 * formats ({@link SplatData.format}) plus the streamed ones.
 */
export type OrientableFormat =
  'ply' | 'splat' | 'ksplat' | 'sog' | 'spz' | 'rad' | 'streamed-sog' | 'lcc' | 'lcc2';

/**
 * The 180°-about-X rotation that maps a 3DGS Y-down capture to three.js Y-up -
 * the same correction Spark documents as `quaternion.set(1, 0, 0, 0)`. Returned
 * as a fresh {@link THREE.Matrix4} so callers can mutate/decompose it freely.
 */
export function createYUpTransform(): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationX(Math.PI);
}

/**
 * The `'y-up'` correction for a format, or `null` when nothing is needed:
 * SPZ is already Y-up, and LCC self-orients via its `formatTransform`
 * (callers apply that in both modes, so this returns `null` for LCC to avoid
 * doubling it). Y-down formats (PLY/`.splat`/`.ksplat`/SOG) get the 180°-X flip.
 */
export function yUpTransformForFormat(format: OrientableFormat | undefined): THREE.Matrix4 | null {
  switch (format) {
    case 'ply':
    case 'splat':
    case 'ksplat':
    case 'sog':
    case 'rad':
    case 'streamed-sog':
      return createYUpTransform();
    case 'spz':
    case 'lcc':
    case 'lcc2':
    case undefined:
      return null;
  }
}
