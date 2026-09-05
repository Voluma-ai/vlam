# Proxy-mesh relighting

PlayCanvas-style **screen-space** relighting for Gaussian splats: render a
triangle **proxy** into an RGBA target, then multiply that onto baked splat
color in the display fragment.

Relighting is an optional, pre-v1 package: import it from
`@voluma/vlam/relighting`. The base renderer does not bind or sample a
relighting texture. `attachRelighting(target, settings)` composes a display
color callback, rebuilds only when a map or callback changes, and returns
`update(settings)` / `dispose()`; numeric settings remain live uniforms.

This is **not** a [`SplatModifier`](effects-and-modifiers.md). Modifiers run
per splat in the vertex / gather stage; coverage is per pixel. Relighting is
a draw-time material feature, same class as `SplatMesh.setDepthOfField`.

## What the RT means

The fragment does:

`factor = mix(background, lit.rgb × brightness, lit.a)`

| Pixel | Typical RT | Result on splats |
|--------|------------|------------------|
| Uncovered | A = 0 | `background` (usually 1) |
| Covered, multiplier ≈ 1 | RGB ≈ 1, A = 1 | unchanged |
| Covered, facing light | RGB &gt; 1 when `diffuse` &gt; 0 | brightened / tinted |
| Covered, umbra | RGB &lt; 1, A = 1 | darkened |

Clear the lighting RT to **RGB 1, A 0** (not black). Softness / bilinear
samples at coverage edges otherwise pull in black and draw a dark outline
of every collision triangle.

Treat RGB as a **multiplier**, not as a lit-gray “look.” A low-ambient
MeshStandard pass writes mid-gray on the whole footprint, so grass under the
collision mesh looks muddy even where no shadow falls. Prefer
`createRelightingShadowFactorMaterial(light)` so unshadowed coverage stays ≈ 1.
Pass `{ umbra: 0.45 }` (default) so full shadow multiplies by ~0.45 instead of
crushing splat color to black. `{ color, diffuse, direction }` adds a Lambert
boost on top of that identity (RGB may exceed 1 — use a HalfFloat lighting RT).
Pass an array of contributions for several casters (up to
`MAX_RELIGHTING_SHADOW_LIGHTS`, currently 32); the shader unrolls only the
lights you pass. A contribution such as
`{ light: accent, intensity: 0, fill: 1.5 }` adds Lambert light without adding
an umbra. Point and spot fill is shadow-occluded and fades over the light's
`distance`; spot fill also follows its cone and penumbra. Light and target
positions are read in world space, so lights may live under transformed groups.

Splat foliage cannot cast. Umbra shape follows **proxy triangles** only.
Floor-only LCC collision yields ground / overhang self-shadow, not canopy
silhouettes from the splat leaves — use a denser lighting mesh when you need
that.

Collision foliage that both casts and receives sparkles: PCF samples flip on
noisy leaf/branch triangles as the sun or camera moves. The shadow-factor
material therefore receives only on **upward** faces by default (`receiveUpMin`,
`0.25`). Trees still cast onto grass and paths. Pass `{ receiveUpMin: 0 }` if
every proxy face must receive. The demo uses three texel-snapped cascades:
~20 m / ~50 m / ~160 m / full scene AABB.

**Vs PlayCanvas:** their [relighting](https://developer.playcanvas.com/user-manual/gaussian-splatting/building/relighting/)
lights a reconstructed / photogrammetry proxy (gray albedo, `brightness: 2`)
and transfers lit RGB + coverage. Separately, splats can *cast* onto meshes;
they do not receive shadows directly. Using walk-collision as caster+receiver
is a demo shortcut — crease self-shadow often reads as dark triangle outlines,
which is not their intended look.

## Proxy vs collision mesh

Both are triangle meshes that approximate the scene. They differ by **job**:

- **Collision** — physics / walk / camera BVH. May omit thin props.
- **Proxy** — shading / shadow stand-in. Needs triangles where umbras matter.

You may reuse LCC collision tiles (or a PlayCanvas `.collision.glb`) as the
proxy when the silhouette is good enough. Prefer a denser reconstructed mesh
when light edges matter. The core API never requires `SplatCollisionData`; pass
any `THREE.Texture` from your own RT.

## Minimal loop (shadow-factor)

```ts
import { SplatMesh, createWebGPURenderer } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';
import {
  attachRelighting,
  createRelightingProxy,
  createRelightingShadowFactorMaterial,
  renderRelightingFactorMap,
} from '@voluma/vlam/relighting';

const proxy = createRelightingProxy({
  geometries: [new THREE.BoxGeometry(2, 1, 2)],
});

const relightScene = new THREE.Scene();
relightScene.add(proxy.group);
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.castShadow = true;
sun.position.set(2, 4, 1);
relightScene.add(sun);

const factorMat = createRelightingShadowFactorMaterial(sun);
proxy.group.traverse((obj) => {
  if (obj instanceof THREE.Mesh) {
    obj.material = factorMat;
    obj.castShadow = true;
    obj.receiveShadow = true;
  }
});

const relightTarget = new THREE.RenderTarget(1, 1, { depthBuffer: true });
const relighting = attachRelighting(splats, {
  map: relightTarget.texture,
  blend: 1,
  brightness: 1,
  background: 1,
  softness: 3,
});

// Each frame, before the main splat draw:
renderer.shadowMap.enabled = true;
renderRelightingFactorMap(renderer, relightScene, camera, relightTarget);

splats.update(camera, renderer);
renderer.render(scene, camera);
```

<!-- full file: docs/guide/samples/relighting.ts -->

Use {@link renderRelightingFactorMap} on an application-owned `WebGPURenderer`
(`autoClear: false`, tone-mapping `contextNode`, and so on). The helper
resizes the RT, clears white with alpha 0, turns shadow maps on for the pass,
swaps in a passthrough `contextNode` (never `undefined` — WebGPURenderer
reads `contextNode.id`), and restores renderer state afterward. Hand-rolling
`setRenderTarget` only matches a fresh `createWebGPURenderer()`.

`blend` / `brightness` / `background` / `softness` are live uniforms (no material
rebuild). Changing the map texture identity rebuilds once. Call
`relighting.dispose()` to restore the prior callback. The pick pass is not tinted.

Coarse collision proxies leave hard coverage silhouettes. If you use
`softness`, keep the lighting RT clear at **RGB 1, A 0** and prefer the
alpha-weighted filter (built in); a black clear turns soft edges into mesh
outlines. PlayCanvas does not add this blur — proxy quality is the main lever.

On `UnifiedSplatMesh`, the attachment modulates the unified draw material
without invalidating gather caches. Supplied textures and proxy resources stay
owned by the caller.

A compact runnable copy lives in the docs as
[Relight a capture](../../site/examples/relight.md).

## Demo

The runnable [Relight a capture](../../site/examples/relight.md) example uses
an LCC / `.lcc2` scene that ships collision meshes. The lighting RT is still a
**multiplier** (not a gray MeshStandard look): umbra darkens, and a warm
Lambert boost (`color` `0xffa040`, `diffuse` 0.8) brightens sun-facing
proxy faces. The directional map covers the proxy ∪ splat bounds
(texel-snapped, 20 / 50 / 160 / scene cascades) so close trees stay stable
through mid-range and umbras still reach the far side. Lighting follows
**proxy triangles** only — splat foliage cannot cast or receive.

An external lighting mesh may replace the LCC collision tiles for the relight
pass only; walk collision remains available for navigation and other consumers.

## See also

- [`lightingPreset`](effects-and-modifiers.md) — cheap per-splat Lambert from
  covariance normals (no proxy, no shadows).
- [Effects & modifiers](effects-and-modifiers.md) — vertex-stage hooks.
