# Effects & modifiers

Recolor regions, animate reveals, cut scenes open, and relight splats without
forking the renderer. Everything here is built on one hook: a
`SplatModifier`, a pure TSL function that runs per splat in the vertex stage
and returns the transform fields it changes (`color`, `offset`, `scale`,
`rotation`, `visible`).

## Presets from `@voluma/vlam/effects`

Optional and tree-shakeable, nothing lands in your bundle unless imported:

```ts
import { depthOfFieldPreset, lightingPreset, revealPreset, sdfEffects, worldWarpPreset } from '@voluma/vlam/effects';

// Soft cutaway: fade out the splats inside a sphere.
const cutaway = sdfEffects([{ kind: 'sphere', mode: 'hide', center: [0, 0, 0], radius: 0.4 }]);
splats.modifiers = [cutaway.modifier];
// Moving the shape is a uniform write, no shader recompile:
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

// Planet (positive, walk on top) / bowl fold (negative). Near field stays put.
const warp = worldWarpPreset({ intensity: 0.55, radius: 2 });
warp.intensity.value = -0.4; // fold, no recompile
```

`worldWarpPreset` is camera-centered: walking/orbiting is unchanged, distant splats wrap. Extreme warps still sort by pre-displacement depth.

<!-- full file: docs/guide/samples/effects-presets.ts -->

`sdfEffects` shapes are `sphere` or `box`; modes are `tint`, `desaturate`,
`hide`, and `rim`, with per-shape `color`, `falloff`, `invert`, and
`strength`. All presets are worked examples of the public hook, not a
framework, read their source as starting points.

## Stacking effects: `ModifierSlots`

Hosts that stack several effects on one mesh should manage them through
`ModifierSlots`, named, ordered slots that compact into `mesh.modifiers`:

```ts
import { ModifierSlots, type SplatModifier } from '@voluma/vlam';
import { revealPreset, sdfEffects } from '@voluma/vlam/effects';

// Build each effect ONCE and keep its function identity stable, a fresh
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
slots.set('reveal', reveal.modifier); // structural → one rebuild on apply
slots.set('sdf', cutaway.modifier);
slots.set('fog', fog);
slots.apply(mesh);

// Every frame, value-only updates, then a free re-apply:
reveal.progress.value = Math.min(1, time / 3);
fogDensity.value = 0.02 + 0.01 * Math.sin(time);
slots.apply(mesh); // free: compacted array reference is stable
```

<!-- full file: docs/guide/samples/effects-slots.ts -->

Empty slots cost nothing (an all-empty stack is byte-for-byte the unhooked
graph), unknown slot names throw, and `apply` is safe to call every frame.

## The rebuild vs uniform-update contract

Structural changes recompile; value changes never do. Filling, clearing, or
replacing a slot (or assigning a `modifiers` array with different function
identities) changes the shader graph, so the material rebuilds once on the
next frame, that is the *only* recompiling path. Everything else, mutating
a modifier's own uniforms (`progress.value`, `setShapes`, a light direction)
or re-applying an unchanged stack, is a pure GPU data write, safe at
animation rates. The corollary: build each effect once and keep its function
identity stable for its lifetime; animate through its uniforms; toggle by
clearing/filling its slot (one recompile per toggle) or, for frequent
toggles, by driving its strength uniform to zero and leaving the slot
occupied.

```ts
// DO: build the modifier once; animate through its uniforms.
const fade = uniform(1);
const fadeModifier: SplatModifier = (ctx) => ({
  color: vec4(ctx.color.rgb, ctx.color.a.mul(fade)),
});
mesh.modifiers = [fadeModifier]; // once
fade.value = opacity; // uniform write, no recompile, safe every frame

// DON'T: a fresh closure per frame is a *different* modifier identity, so
// the material recompiles its shader graph every single frame.
mesh.modifiers = [(ctx) => ({ color: vec4(ctx.color.rgb, ctx.color.a.mul(opacity)) })];
```

<!-- full file: docs/guide/samples/effects-contract.ts -->

`UnifiedSplatRenderer` normally re-gathers modifier-bearing sources every
frame because a uniform can change without a graph rebuild. For a truly static
modifier, register the source with `cacheModifiers: true`. If its uniforms or
channels later change, call `unified.invalidateSource(mesh)` before the next
`update`. This is deliberately opt-in: missing an invalidation would otherwise
leave cached colors, visibility, or transforms stale.

## Writing a custom modifier

A modifier reads the per-splat `SplatContext` (`localCenter`, `sourceCenter`,
`sourceToLocal`, `worldCenter`, `viewCenter`, `cameraLocal`, `baseColor` after SH, a lazy
`normal`, per-splat `channel(name)` reads, and the running
`color`/`offset`/`scale`/`rotation`/`visible`) and returns only the fields it
changes:

```ts
import { clamp, mix, uniform, vec3, vec4 } from 'three/tsl';
import type { SplatModifier } from '@voluma/vlam';

const strength = uniform(1); // captured in the closure; .value is data-only

export const heightTint: SplatModifier = (ctx) => {
 const t = clamp(ctx.worldCenter.y.mul(0.5).add(0.5), 0, 1);
 const tint = mix(vec3(0.35, 0.6, 1.0), vec3(1.0, 0.65, 0.35), t);
 const tinted = ctx.color.rgb.mul(tint);
 // Return only the fields you change; omitted fields pass through the fold.
 return { color: vec4(mix(ctx.color.rgb, tinted, strength), ctx.color.a) };
};

mesh.modifiers = [heightTint]; // structural change → one recompile
```

<!-- full file: docs/guide/samples/effects-custom-modifier.ts -->

> **Inside a `SplatScene`,** `localCenter` is the splat's *placed* position: the
> per-source matrix is applied before the stack runs, so one effect covers every
> source as a single scene rather than travelling with a moved one. Read
> `sourceCenter` for the pre-placement position when an effect *should* follow
> its source, and map any source-frame displacement vector through
> `sourceToLocal` before returning it. A source-frame rotation `R` becomes
> `sourceToLocal · R · sourceToLocal.inverse()`.

Constraints to know (from the
modifier contract): covariance is pre-baked,
so `scale` is uniform-only and `rotation` rigid-only; displaced splats keep
their pre-displacement depth-sort order; modifiers run per splat, not per
pixel. Pure-TSL modifiers run on both backends; a `wgslFn` escape hatch (as
in `revealPreset`) is WebGPU-only.

## Proxy-mesh relighting (not a modifier)

For PlayCanvas-style sun / shadow relighting of a baked capture, use core
[`setRelighting`](relighting.md) with a lit proxy mesh rendered to a
screen-aligned RT. That path is per-pixel fragment modulate, not a
`SplatModifier`. See [Proxy-mesh relighting](relighting.md).

## Next

[Picking & queries](picking-and-queries.md). GPU picks and CPU spatial
queries that follow exactly what your modifiers draw.
