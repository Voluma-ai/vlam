import * as THREE from 'three/webgpu';
import { float, length, mix, step, vec3, vec4 } from 'three/tsl';
import type { SplatModifier } from '../lib/core';

type Node<T extends string> = THREE.Node<T>;

/** Channel {@link StreamedSplatMesh.setLodLevelDebug} writes with each run's LOD level. */
export const LOD_LEVEL_CHANNEL = 'lodLevel';

/**
 * False-color palette:
 * nearest / finest → red, then orange → yellow → green → blue (farthest / coarsest).
 */
const C0 = vec3(1.0, 0.05, 0.05);
const C1 = vec3(1.0, 0.45, 0.0);
const C2 = vec3(1.0, 0.92, 0.0);
const C3 = vec3(0.05, 0.85, 0.15);
const C4 = vec3(0.15, 0.35, 1.0);
/** Unwritten / invalid channel sample (debug). */
const CMISS = vec3(1.0, 0.0, 1.0);

/** Maps a float band index 0..4+ onto the debug palette. */
function paletteFromBand(band: Node<'float'>): Node<'vec3'> {
  return mix(
    mix(mix(mix(C0, C1, step(0.5, band)), C2, step(1.5, band)), C3, step(2.5, band)),
    C4,
    step(3.5, band),
  );
}

/** Share of original splat RGB kept when tinting (debug tint is the rest). */
const ORIGINAL_BLEND = 0.6;

/**
 * Colors each splat by the **resident LOD level** written into
 * {@link LOD_LEVEL_CHANNEL} (0 = finest / red … 4+ = coarsest / blue).
 * Unwritten samples (−1 fill) tint magenta.
 *
 * Mixes the palette with the splat's own color so scene content stays
 * readable ({@link ORIGINAL_BLEND} original).
 *
 * Zooming out alone does not change this - only when the mesh swaps resident
 * runs to a coarser level. Use {@link createLodDistanceDebugModifier} to see
 * distance bands while moving the camera.
 */
export function createLodLevelDebugModifier(channelName = LOD_LEVEL_CHANNEL): SplatModifier {
  return (context) => {
    const level = context.channel(channelName);
    // fill is -1 until a run writes; keep that distinct from true L0 (red).
    const missing = step(level, float(-0.5));
    const tint = mix(paletteFromBand(level), CMISS, missing);
    const rgb = mix(tint, context.color.rgb, float(ORIGINAL_BLEND));
    return { color: vec4(rgb, context.color.a) };
  };
}

/**
 * Colors each splat by camera distance using classic LCC band edges
 * (`lodBaseDistance=10`, `lodMultiplier=2`):
 * ≤10 red, ≤20 orange, ≤40 yellow, ≤80 green, else blue.
 *
 * Uses view-space depth so dolly / zoom changes colors immediately.
 * Blends with the original splat color like {@link createLodLevelDebugModifier}.
 */
export function createLodDistanceDebugModifier(
  lodBaseDistance = 10,
  lodMultiplier = 2,
): SplatModifier {
  const b0 = float(lodBaseDistance);
  const b1 = float(lodBaseDistance * lodMultiplier);
  const b2 = float(lodBaseDistance * lodMultiplier * lodMultiplier);
  const b3 = float(lodBaseDistance * lodMultiplier * lodMultiplier * lodMultiplier);
  return (context) => {
    // View-space distance (changes with dolly). Abs(z) alone fails for side views.
    const d = length(context.viewCenter);
    const band: Node<'float'> = mix(
      mix(mix(mix(float(0), float(1), step(b0, d)), float(2), step(b1, d)), float(3), step(b2, d)),
      float(4),
      step(b3, d),
    );
    const rgb = mix(paletteFromBand(band), context.color.rgb, float(ORIGINAL_BLEND));
    return { color: vec4(rgb, context.color.a) };
  };
}

/** Short legend HTML for the demo overlay. */
export function lodDebugLegendHtml(mode: 'lod' | 'distance'): string {
  const swatch = (color: string, label: string) =>
    `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px">` +
    `<i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color}"></i>${label}</span>`;
  const row =
    swatch('#ff0d0d', '0') +
    swatch('#ff7300', '1') +
    swatch('#ffeb00', '2') +
    swatch('#0dd926', '3') +
    swatch('#2659ff', '4+');
  if (mode === 'lod') {
    return (
      `<div style="font:12px/1.4 ui-sans-serif,system-ui;color:#eee;text-shadow:0 1px 2px #000">` +
      `<b>LOD level</b> (resident) · red=finest` +
      `<div style="margin-top:4px">${row}</div>` +
      `<div style="opacity:.75;margin-top:4px">Stays red while finest is still on screen.</div>` +
      `</div>`
    );
  }
  return (
    `<div style="font:12px/1.4 ui-sans-serif,system-ui;color:#eee;text-shadow:0 1px 2px #000">` +
    `<b>Distance</b> · ≤10 / ≤20 / ≤40 / ≤80 m` +
    `<div style="margin-top:4px">${row}</div>` +
    `</div>`
  );
}
