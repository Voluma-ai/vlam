// Guide sample: docs/guide/effects-and-modifiers.md - the rebuild vs
// uniform-update contract, as a do/don't pair.
import { uniform, vec4 } from 'three/tsl';
import type { SplatMesh, SplatModifier } from '@voluma/vlam';

// DO: build the modifier once; animate through its uniforms.
const fade = uniform(1);
const fadeModifier: SplatModifier = (ctx) => ({
  color: vec4(ctx.color.rgb, ctx.color.a.mul(fade)),
});

export function goodFrame(mesh: SplatMesh, opacity: number) {
  if (mesh.modifiers.length === 0) mesh.modifiers = [fadeModifier]; // once
  fade.value = opacity; // uniform write - no recompile, safe every frame
}

// DON'T: a fresh closure per frame is a *different* modifier identity, so
// the material recompiles its shader graph every single frame.
export function badFrame(mesh: SplatMesh, opacity: number) {
  mesh.modifiers = [(ctx) => ({ color: vec4(ctx.color.rgb, ctx.color.a.mul(opacity)) })];
}
