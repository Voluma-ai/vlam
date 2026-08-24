// Guide sample: docs/guide/effects-and-modifiers.md - a stacked effect
// pipeline managed through ModifierSlots (reveal + SDF cutaway + fog).
import { mix, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { ModifierSlots, type SplatMesh, type SplatModifier } from '@voluma/vlam';
import { revealPreset, sdfEffects } from '@voluma/vlam/effects';

// Build each effect ONCE and keep its function identity stable - a fresh
// closure per frame would mean a shader recompile per frame.
const reveal = revealPreset();
const cutaway = sdfEffects([{ kind: 'sphere', mode: 'hide', center: [0, 1, 0], radius: 0.5 }]);

// A small custom distance-fog modifier; its density is a live uniform.
const fogDensity = uniform(0.02);
const fogColor = vec3(0.75, 0.8, 0.9);
const fog: SplatModifier = (ctx) => {
  const depth = ctx.viewCenter.z.negate();
  const f = smoothstep(0, 1, depth.mul(fogDensity)).min(1);
  return { color: vec4(mix(ctx.color.rgb, fogColor, f), ctx.color.a) };
};

// Slot order is fixed at construction and defines the fold order.
const slots = new ModifierSlots(['reveal', 'sdf', 'fog']);

export function setup(mesh: SplatMesh) {
  slots.set('reveal', reveal.modifier); // structural → one rebuild on apply
  slots.set('sdf', cutaway.modifier);
  slots.set('fog', fog);
  slots.apply(mesh);
}

export function everyFrame(mesh: SplatMesh, time: number) {
  reveal.progress.value = Math.min(1, time / 3); // value-only → never rebuilds
  fogDensity.value = 0.02 + 0.01 * Math.sin(time);
  slots.apply(mesh); // free: compacted array reference is stable
}
