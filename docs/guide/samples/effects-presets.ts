// Guide sample: docs/guide/effects-and-modifiers.md - the @voluma/vlam/effects
// presets. Nothing here is in your bundle unless you import it.
import type { SplatMesh } from '@voluma/vlam';
import {
  depthOfFieldPreset,
  lightingPreset,
  revealPreset,
  sdfEffects,
  worldWarpPreset,
} from '@voluma/vlam/effects';

export function applyPresets(splats: SplatMesh) {
  // Soft cutaway: fade out the splats inside a sphere.
  const cutaway = sdfEffects([{ kind: 'sphere', mode: 'hide', center: [0, 0, 0], radius: 0.4 }]);
  splats.modifiers = [cutaway.modifier];
  // Moving the shape is a uniform write - no shader recompile:
  cutaway.setShapes([{ kind: 'sphere', mode: 'hide', center: [0.2, 0, 0], radius: 0.4 }]);

  // Per-splat Lambertian shading from the covariance normal (both backends).
  const lighting = lightingPreset({ direction: [0.3, 1, 0.6], ambient: 0.35 });
  lighting.direction.value.set(1, 1, 0).normalize(); // relight, no recompile

  // Time-driven dissolve (wgslFn noise → WebGPU only).
  const reveal = revealPreset({ frequency: 3, edge: 0.08 });
  reveal.progress.value = 0.5; // sweep 0 → 1 to reveal

  // Stylized modifier-based DoF. For physically-modeled camera DoF prefer
  // the core splats.setDepthOfField({ focusDistance, aperture }) path.
  const dof = depthOfFieldPreset({ focusDistance: 4, aperture: 0.5 });
  dof.focusDistance.value = 6; // rack focus, no recompile

  // Planet (positive, walk on top) / Inception-style bowl fold (negative).
  const warp = worldWarpPreset({ intensity: 0.55, radius: 2 });
  warp.intensity.value = -0.4;

  return { cutaway, lighting, reveal, dof, warp };
}
