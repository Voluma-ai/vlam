/**
 * Core projected-2D depth of field (post-EWA isotropic CoC).
 *
 * Spark-style pinhole CoC:
 *   focusBlur = |depth − focus| / depth
 *   apertureRadius = focalPx · tan(0.5 · apertureAngle)
 *   cocRadius = focusBlur · apertureRadius
 *   blurVariance = clamp(cocRadius², …, maxRadius²)
 *
 * `/ depth` is Spark's exact falloff (`splatVertex.glsl`), restored for visual
 * parity: scenes authored against Spark's foreground defocus rendered flat here
 * under the previous `/ max(depth, focus)`, which capped focusBlur at 1 and so
 * limited the CoC to a single apertureRadius - sub-pixel at the aperture sizes
 * ModifyCamera produces. Behind the focus plane the two forms are identical
 * (`max(depth, focus) === depth`), so only the near side changes.
 *
 * Note `/ depth` is unbounded as depth → 0. The fill-rate guard is the same one
 * Spark uses: {@link MAX_DOF_RADIUS_PX} clamps the CoC. Do not "fix" the near
 * side by dividing by focus instead - that pushes every *background* splat to
 * the cap when zooming out with a near focus plane (huge quads → fill-rate
 * death), which is what the bounded form was originally guarding against.
 *
 * Voluma's ModifyCamera `apertureSize` maps to an angle through the *live*
 * focus distance - `apertureAngle = 2·atan(0.5·size / focus)` - matching the
 * host helper Voluma ships for Spark. A fixed reference distance was tried
 * instead to stop near focus planes from
 * ballooning every splat, but it decouples aperture from focus and so flattens
 * the intended effect: racking focus toward the camera is exactly how authors
 * get the whole scene to go soft. Keep the mapping focus-relative; the CoC cap
 * is what bounds fill-rate.
 *
 * Unlike the M13 `depthOfFieldPreset` modifier (3D scale), this path adds
 * `coc²·I` to the projected 2D covariance with `√(det)` opacity fade.
 */

/**
 * Soft CoC radius cap in pixels (Spark clamps with `maxPixelRadius`).
 * Kept modest for interactive fill-rate; raise only if cinematic stills need it.
 */
export const MAX_DOF_RADIUS_PX = 24;

/** Cap on CoC variance (px²) added to the projected 2D covariance diagonal. */
export const MAX_DOF_VARIANCE = MAX_DOF_RADIUS_PX * MAX_DOF_RADIUS_PX;

/** Live camera depth-of-field settings for {@link SplatMesh.setDepthOfField}. */
export type DepthOfFieldSettings = {
  /** View-space distance to the focal plane (world units). Must stay positive. */
  focusDistance: number;
  /** Aperture size in the same units as Voluma `DofSettings.apertureSize`. `0` = off. */
  aperture: number;
};

/**
 * Maps Voluma aperture size → full aperture angle (radians) through the focus
 * distance, identical to the host helper Voluma ships for Spark:
 * `2·atan(0.5·size / focus)`. Pulling focus toward the camera widens the angle,
 * which is what makes a near focus plane soften the whole scene.
 */
export function apertureAngleFromSize(aperture: number, focusDistance: number): number {
  const size = Math.max(0, aperture);
  if (size <= 0) return 0;
  const focus = Math.max(1e-4, focusDistance);
  return 2 * Math.atan((0.5 * size) / focus);
}

/**
 * Circle-of-confusion variance in px² for a splat at view-space depth.
 * Returns `0` when aperture is disabled. Mirrors Spark's vertex DoF branch.
 */
export function computeDofCocVariancePx2(options: {
  depth: number;
  focusDistance: number;
  aperture: number;
  focalPx: number;
  maxVariance?: number;
}): number {
  const depth = Math.max(1e-4, options.depth);
  const focus = Math.max(1e-4, options.focusDistance);
  const apertureAngle = apertureAngleFromSize(options.aperture, focus);
  if (apertureAngle <= 0 || !(options.focalPx > 0)) return 0;
  // Spark's falloff. Unbounded as depth → 0; the px cap below is the guard.
  const focusBlur = Math.abs(depth - focus) / depth;
  const apertureRadius = options.focalPx * Math.tan(0.5 * apertureAngle);
  const cocRadiusPx = focusBlur * apertureRadius;
  const variance = cocRadiusPx * cocRadiusPx;
  const maxVariance = options.maxVariance ?? MAX_DOF_VARIANCE;
  return Math.min(variance, maxVariance);
}

/**
 * Opacity fade that conserves Gaussian mass after isotropic screen-space
 * dilation: `√(detRaw / detBlur)`.
 */
export function computeDofOpacityFade(detRaw: number, detBlur: number): number {
  return Math.sqrt(Math.max(0, detRaw) / Math.max(1e-9, detBlur));
}

/** Clamps host-supplied DoF settings before writing live uniforms. */
export function clampDepthOfFieldSettings(
  settings: Partial<DepthOfFieldSettings>,
  previous: DepthOfFieldSettings = { focusDistance: 10, aperture: 0 },
): DepthOfFieldSettings {
  const focusDistance =
    typeof settings.focusDistance === 'number' && Number.isFinite(settings.focusDistance)
      ? Math.max(1e-4, settings.focusDistance)
      : previous.focusDistance;
  const aperture =
    typeof settings.aperture === 'number' && Number.isFinite(settings.aperture)
      ? Math.max(0, settings.aperture)
      : previous.aperture;
  return { focusDistance, aperture };
}
