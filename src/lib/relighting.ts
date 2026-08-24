/**
 * PlayCanvas-style proxy-mesh splat relighting (screen-space modulate).
 *
 * Host lights a proxy mesh into an RGBA render target (RGB = lit color,
 * A = coverage), then {@link SplatMesh.setRelighting} /
 * {@link UnifiedSplatRenderer.setRelighting} multiplies baked splat color in
 * the display fragment. Not a `SplatModifier` - coverage is per-pixel.
 *
 * See `docs/guide/relighting.md`.
 */
import * as THREE from 'three/webgpu';

/** Defaults match PlayCanvas `GsplatRelighting` (0.5 gray proxy albedo → brightness 2). */
export const DEFAULT_RELIGHT_BLEND = 1;
export const DEFAULT_RELIGHT_BRIGHTNESS = 2;
export const DEFAULT_RELIGHT_BACKGROUND = 1;
/** Screen-space soft edge on coverage (px). Softens coarse proxy silhouettes. */
export const DEFAULT_RELIGHT_SOFTNESS = 0;

/** Live screen-space relighting settings for {@link SplatMesh.setRelighting}. */
export type RelightingSettings = {
  /** Lit proxy render: RGB = lighting, A = mesh coverage (0 = sky / uncovered). */
  map: THREE.Texture;
  /** How much the map affects splat color (`0` = baked only, `1` = full modulate). */
  blend?: number;
  /** Scales `map.rgb` before multiply; `2` compensates a 0.5 gray proxy albedo. */
  brightness?: number;
  /** Multiplier for splats where `map.a ≈ 0` (sky / uncovered). */
  background?: number;
  /**
   * Softens the coverage mask over this many screen pixels (box filter). Use
   * `2`–`4` when the proxy is a coarse collision mesh so triangle silhouettes
   * do not read as a static shadow. `0` = hard PlayCanvas-style edges.
   */
  softness?: number;
};

/** Resolved numeric fields after clamping (map omitted - still the host texture). */
export type RelightingUniforms = {
  blend: number;
  brightness: number;
  background: number;
  softness: number;
};

/**
 * Clamps blend / brightness / background / softness.
 */
export function clampRelightingSettings(
  partial: Partial<Pick<RelightingSettings, 'blend' | 'brightness' | 'background' | 'softness'>>,
  previous: RelightingUniforms = {
    blend: DEFAULT_RELIGHT_BLEND,
    brightness: DEFAULT_RELIGHT_BRIGHTNESS,
    background: DEFAULT_RELIGHT_BACKGROUND,
    softness: DEFAULT_RELIGHT_SOFTNESS,
  },
): RelightingUniforms {
  const blend = partial.blend !== undefined ? partial.blend : previous.blend;
  const brightness = partial.brightness !== undefined ? partial.brightness : previous.brightness;
  const background = partial.background !== undefined ? partial.background : previous.background;
  const softness = partial.softness !== undefined ? partial.softness : previous.softness;
  return {
    blend: Number.isFinite(blend) ? Math.min(1, Math.max(0, blend)) : previous.blend,
    brightness: Number.isFinite(brightness) ? Math.max(0, brightness) : previous.brightness,
    background: Number.isFinite(background) ? Math.max(0, background) : previous.background,
    softness: Number.isFinite(softness) ? Math.min(8, Math.max(0, softness)) : previous.softness,
  };
}

/**
 * 1×1 opaque white placeholder so the fragment graph can always sample a map
 * when relighting is off (`blend === 0`).
 */
export function createPlaceholderRelightTexture(): THREE.DataTexture {
  const data = new Uint8Array([255, 255, 255, 255]);
  const texture = new THREE.DataTexture(data, 1, 1);
  texture.needsUpdate = true;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}
