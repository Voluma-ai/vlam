/**
 * Conservative screen-space bounds shared by splat display and SH preparation.
 * Internal: these bounds must include every capped quad the display can draw.
 */
import * as THREE from 'three/webgpu';

/** Per-axis radius cap used by the standalone and unified display graphs. */
export const MAX_SPLAT_RADIUS_PX = 512;

/**
 * Writes a conservative center-frustum margin in NDC, once per viewport update.
 * Each screen component is bounded by the sum of two capped quad axes. Keep
 * the optional pixel floor in the bound too, since it is applied after the cap.
 */
export function updateSplatFrustumMargin(
  viewport: THREE.Vector2,
  target: THREE.Vector2,
  minSplatSizePx = 0,
): THREE.Vector2 {
  const diameterSum = 4 * Math.max(MAX_SPLAT_RADIUS_PX, minSplatSizePx);
  return target.set(
    1.2 + diameterSum / Math.max(1, viewport.x),
    1.2 + diameterSum / Math.max(1, viewport.y),
  );
}

/** Cheap homogeneous rejection before covariance or SH coefficient work. */
export function isSplatCenterInFrustum(
  clipCenter: THREE.Node<'vec4'>,
  margin: THREE.Node<'vec2'>,
): THREE.Node<'bool'> {
  return clipCenter.z
    .greaterThan(clipCenter.w.mul(1.2).negate())
    .and(clipCenter.z.lessThan(clipCenter.w))
    .and(clipCenter.x.abs().lessThanEqual(clipCenter.w.mul(margin.x)))
    .and(clipCenter.y.abs().lessThanEqual(clipCenter.w.mul(margin.y)));
}
