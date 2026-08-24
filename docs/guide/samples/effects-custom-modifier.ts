// Guide sample: docs/guide/effects-and-modifiers.md - a custom modifier on
// the raw SplatModifier hook: warm-high / cool-low tint by world height,
// with a live blend uniform. Pure TSL, so it runs on WebGPU and WebGL2.
import { clamp, mix, uniform, vec3, vec4 } from 'three/tsl';
import type { SplatMesh, SplatModifier } from '@voluma/vlam';

const strength = uniform(1); // captured in the closure; .value is data-only

export const heightTint: SplatModifier = (ctx) => {
  // Read-only context: localCenter/worldCenter/viewCenter, cameraLocal,
  // baseColor (post-SH), normal (lazy), channel(name). Running transform:
  // color, offset, scale, rotation, visible.
  const t = clamp(ctx.worldCenter.y.mul(0.5).add(0.5), 0, 1);
  const tint = mix(vec3(0.35, 0.6, 1.0), vec3(1.0, 0.65, 0.35), t);
  const tinted = ctx.color.rgb.mul(tint);
  // Return only the fields you change; omitted fields pass through the fold.
  return { color: vec4(mix(ctx.color.rgb, tinted, strength), ctx.color.a) };
};

export function attach(mesh: SplatMesh) {
  mesh.modifiers = [heightTint]; // structural change → one recompile
  strength.value = 0.5; // animate freely afterwards
}
