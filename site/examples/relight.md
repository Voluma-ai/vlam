# Relight a capture

**What you get:** a moving sun with shadows on a streamed street, from the
capture's collision mesh rather than from the splats themselves.

<ExampleEmbed slug="relight" hint="Give it a moment to stream in. The sun orbits, shadows follow the collision mesh" />

## Baked lighting does not move

A capture records the light that was there when it was photographed. Adding a
`DirectionalLight` to the three.js scene lights your cubes and leaves the
splats alone. The [lighting preset](/examples/shader-effects) is a cheap
stylized shade from each splat's own shape. Neither one casts a shadow.

This path is different. You render a **triangle proxy** of the scene into a
screen-space map, then multiply that map onto the baked splat colour. Umbra
follows those triangles. Splat foliage cannot cast.

This example streams the same Dehaar `.lcc2` the
<a href="/demo/?scene=/remote/jack/v/Dehaar/Dehaar.lcc2&effects=relight&fallback=goose" target="_self">viewer</a>
opens with `?effects=relight`. How streaming itself works is
[Huge scenes](/examples/big-scenes).

## It is a lighting pass, not a modifier

Same class of feature as [depth of field](/examples/depth-of-field): a draw-time
material setting, not a `SplatModifier`. Coverage is per pixel, so it cannot
live in the per-splat vertex hook.

Each frame, before the splat draw:

1. Light a proxy mesh into an RGBA target (RGB = multiplier, A = coverage).
2. Hand that texture to `splats.setRelighting({ map })`.
3. Then `splats.update` and the main render, as usual.

Clear the target to **white, alpha 0**. A black clear pulls dark outlines
around every proxy triangle once softness samples the coverage edge.

## The code

::: code-group

<<< ../../docs/examples/samples/relight.ts [main.ts]

```html [index.html]
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        margin: 0;
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <script type="module" src="/main.ts"></script>
  </body>
</html>
```

:::

## What to use as the proxy

Dehaar ships LCC collision tiles, so the sample passes those through
`createRelightingProxy({ tiles, matrixWorld })`. Collision geometry is
source-local; bake `splats.matrixWorld` or the shadows sit in the wrong place.

Other captures:

- a reconstruction or splat-transform `.collision.glb`, via `geometries`
- a stand-in box, if you only need to see the sun move

The umbra shape is only as good as that mesh. Floor-only collision gives ground
shadows, not canopy silhouettes from splat leaves.

`createRelightingShadowFactorMaterial` writes a **multiplier**: unshadowed
coverage stays about 1, so grass does not go muddy. Pass `{ color, diffuse,
direction }` for a Lambert boost on top, and keep `direction` pointed at the
sun as it moves. RGB can go above 1, which is why the target is `HalfFloatType`.

`blend`, `brightness`, `background`, and `softness` are live uniforms. Changing
the map texture identity rebuilds once. Pass `null` to `setRelighting` to turn
it off.

## Getting it to look right

**Fit the shadow camera to the proxy.** The default directional-light box is
about ±5 units, which clips a street immediately. The sample sizes
`sun.shadow.camera` to the collision bounds. The
<a href="/demo/?scene=/remote/jack/v/Dehaar/Dehaar.lcc2&effects=relight&fallback=goose" target="_self">demo</a>
goes further: four texel-snapped cascades so close trees stay stable without
clipping distant umbras.

**Softness hides a coarse hull.** Low-poly collision leaves hard coverage
edges. `softness: 2`–`4` blurs them. Keep the white, alpha-0 clear or those
edges become a dark stamp of the mesh.

**The proxy is not in the main scene.** Put it on a separate scene (as here) or
a layer the splat camera does not draw. Otherwise you will see gray triangles
on top of the capture.

**The `.lcc2` URL is same-origin.** `/remote/…` is the docs/demo proxy onto
`assets.voluma.ai`. Point `StreamedSplatMesh.load` at your own manifest when
you copy this out.

## Next

- [Tiny planet](/examples/tiny-planet): wrap this same street without moving the camera
- [Shader effects](/examples/shader-effects): the cheap per-splat lighting preset
