/**
 * Test-only CPU contract for Spark `.rad` LOD alpha.
 *
 * Display, picking, and unified TSL graphs must match these formulas; they
 * cannot import this helper. Production shaders keep original encoded alpha
 * for classification and apply source/modifier opacity after falloff.
 */

/** Shader recovers `alpha ∈ [0, 2]` by doubling the stored opacity byte. */
export const RAD_LOD_ALPHA_DECODE = 2;

/** Decoded LOD alpha from the stored (pre-modifier) texture channel. */
export function decodeRadLodAlpha(encoded: number): number {
  return encoded * RAD_LOD_ALPHA_DECODE;
}

/** Merged nodes use `decoded > 1`; leaves and every non-`.rad` splat do not. */
export function isRadMergedNode(decodedAlpha: number): boolean {
  return decodedAlpha > 1;
}

/**
 * Spark remap: decoded `1..2` → `1..5`, then clamped. Drives σ-growth and
 * the super-Gaussian exponent. Independent of visual opacity.
 */
export function radLodRemap(decodedAlpha: number): number {
  return Math.min(decodedAlpha * 4 - 3, 5);
}

/** Quad extent / Gaussian σ. Leaves keep `maxStdDev`; merged nodes grow it. */
export function radLodStdDev(decodedAlpha: number, maxStdDev: number): number {
  if (!isRadMergedNode(decodedAlpha)) return maxStdDev;
  return maxStdDev + 0.7 * (radLodRemap(decodedAlpha) - 1);
}

/**
 * Center-normalized falloff at quad coordinate `|q|² = squaredQuadDistance`.
 * A leaf composites `g · decoded`. A merged node uses `1 − (1 − g)^a`.
 */
export function radLodFalloff(
  squaredQuadDistance: number,
  decodedAlpha: number,
  maxStdDev: number,
): number {
  const stdDev = radLodStdDev(decodedAlpha, maxStdDev);
  const g = Math.exp(-0.5 * stdDev * stdDev * squaredQuadDistance);
  if (!isRadMergedNode(decodedAlpha)) return g * decodedAlpha;
  const remap = radLodRemap(decodedAlpha);
  const aExp = Math.exp((remap * remap - 1) / Math.E);
  return 1 - (1 - g) ** aExp;
}

/**
 * Zero-safe visual opacity from modifier-resolved vs original encoded alpha.
 * No alpha modifier → `1`. A multiplicative fade yields that fade. Original
 * zero keeps the multiplier at `1` so later falloff (already zero) stays
 * zero without dividing.
 */
export function visualOpacityMultiplier(encodedOriginal: number, encodedResolved: number): number {
  if (encodedOriginal <= 0) return 1;
  return encodedResolved / encodedOriginal;
}

/**
 * What unified gather stores in `centers.w`. RAD sources fold the modifier
 * ratio in; non-RAD sources keep resolved alpha in `colors.a` instead.
 */
export function unifiedDisplayOpacity(
  visible: boolean,
  sourceOpacity: number,
  modifierMultiplier: number,
  lodAlpha: boolean,
): number {
  const visibility = visible ? 1 : 0;
  if (!lodAlpha) return visibility * sourceOpacity;
  return visibility * sourceOpacity * modifierMultiplier;
}

/** Expected work-buffer channels for one gathered RAD splat. */
export function unifiedGatheredRadSlot(
  encodedOriginal: number,
  sourceOpacity: number,
  modifierMultiplier: number,
): { colorsA: number; centersW: number } {
  return {
    colorsA: decodeRadLodAlpha(encodedOriginal),
    centersW: unifiedDisplayOpacity(true, sourceOpacity, modifierMultiplier, true),
  };
}
