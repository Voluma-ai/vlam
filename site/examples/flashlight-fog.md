# Flashlight in the fog

**What you get:** a dark, foggy hall lit only by a flashlight you carry. Its
rings land on the columns and hang in the air in front of you. Put it down and
walk around the beam to see the cone through the fog.

<ExampleEmbed slug="flashlight-fog" hint="Give it a moment to stream in. Look around with the light, then press F to put it down and orbit the beam" />

## Three layers, one light

The look is built from three independent pieces that share one `SpotLight` and
one fog density:

1. **Relit splats.** The capture's collision mesh is lit by the flashlight into
   a screen-space factor map, exactly as in [Relight a capture](/examples/relight).
   `attachRelighting` multiplies it onto the splats.
2. **Fogged splats.** A small `SplatModifier` blends each splat toward a fog
   colour by `1 - exp(-density · depth)`.
3. **The beam in the air.** A full-screen pass ray-marches each pixel through
   the spot cone and adds the light the fog scatters toward the camera.

Relighting runs after the modifier, so splats deep in the fog are still lit
where the beam reaches them.

## Night is a brightness setting

The factor map is a multiplier. Pass a low `brightness` and the same
`background`, and the whole capture sits at that level. Unlit coverage is
`1 × brightness` and uncovered pixels are `background`:

```ts
attachRelighting(splats, { map, brightness: 0.05, background: 0.05, ... });
```

The flashlight's fill is added on top of the 1 before that multiply, so a fill of
about `1 / brightness` brings a facing wall back to its captured colour.

## The rings are a beam profile

There is no flashlight API. The rings come from a **beam profile**: a 1D texture
over `angle / light.angle` that multiplies the spot's fill. The sample bakes it
from a few Gaussian lobes:

```ts
const rings = createRelightingBeamProfile((t) =>
  Math.min(1, 0.12 + lobe(t, 0, 0.2, 0.88) + lobe(t, 0.55, 0.16, 0.38) + lobe(t, 0.88, 0.045, 0.32)),
);
const contribution = { light: flashlight, intensity: 0, fill: 32, beamProfile: rings };
```

Any radial falloff works the same way, such as a measured lamp curve. For a 2D
pattern (a gobo, a window frame), set three's own `SpotLight.map` instead; the
relight fill projects it the way three does on lit meshes. See
[Textured and shaped spot lights](https://github.com/Voluma-ai/vlam/blob/main/docs/guide/relighting.md#textured-and-shaped-spot-lights).

`intensity: 0` keeps the flashlight from adding an umbra of its own. Its fill is
still occluded by its shadow map, so columns cast dark gaps into the beam on the
wall behind them.

The **Rings** slider calls `updateRelightingShadowFactorWeights` with a new
`beamProfileStrength`. That retunes a uniform, with no new material and no
pipeline compile.

## Focusing the beam

The **Beam** slider works like twisting the head of a zoom flashlight: from a
wide, dim cone (0.6 rad) to a tight, bright spot (0.06 rad). At the wide end
brightness follows one over the cone's solid angle, `1 - cos(angle)`, so the
total light stays the same. Carried all the way down to 0.06 rad that would be
about 40× and clip everything to white, so the narrow end is capped and the
brightness is interpolated in log space between the two ends:

```ts
const angle = WIDE + (NARROW - WIDE) * focus;
const brightness = WIDE_BRIGHTNESS * (NARROW_BRIGHTNESS / WIDE_BRIGHTNESS) ** focus;
flashlight.angle = angle;
contribution.fill = baseFill * brightness;
updateRelightingShadowFactorWeights(factorMat, [contribution]);
beamGain.value = baseGain * brightness;
```

Focus also changes reach. The range at which a beam falls to the same
brightness grows with the square root of its intensity, so
`flashlight.distance` follows `baseRange * Math.sqrt(brightness)`: about 12 m
wide open, 39 m fully focused.

All of it is live. The relight material reads `light.angle` as a uniform, the
shadow camera follows it, and the profile is sampled over `angle / light.angle`,
so the rings narrow with the cone instead of being cropped.

## Marching the beam

Splats do not write depth, so the beam pass borrows the proxy's. The factor
target gets a `DepthTexture`, and the march for each pixel stops where its ray
meets the proxy:

```ts
relightTarget.depthTexture = new THREE.DepthTexture(1, 1);
```

At each of 48 jittered steps the shader asks: is this point inside the cone,
how far is it from the light, is it in the flashlight's shadow, and how much
fog lies between it and the camera? It reads the same ring texture, so the
rings appear in the air as nested cones. The quad draws additively after the
main render.

The shadow test reuses the map the relight fill already renders. Each step is
projected through the light's shadow camera with `lightShadowMatrix` and
compared against the map's depth, the way three's own shadow filters do, so a
column cuts a dark gap through the beam in the air behind it, not only on the
wall:

```ts
const clip = lightShadowMatrix(flashlight).mul(vec4(point, 1));
const coord = clip.xyz.div(clip.w);
const unshadowed = shadowDepth
  .sample(vec2(coord.x, coord.y.oneMinus()))
  .compare(coord.z.add(flashlight.shadow.bias)).x;
```

three creates the shadow map on the first shadow draw, after the beam material
is built, so `shadowDepth` starts on a 1×1 placeholder with the same comparison
sampler and is pointed at `flashlight.shadow.map.depthTexture` once it exists.

## Getting it to look right

**Looking down the beam is a disk.** With the light at your eye, every view ray
runs along the cone and the fog glows evenly. That is what a real flashlight
does. Put the light down (F) and step to the side to see the shaft.

**Shadows in the air are only as good as the proxy.** The beam is shadowed by
the collision mesh, not by the splats, so anything the proxy leaves out (thin
railings, foliage) still lets the beam through. While the light is carried
the shadows are hardly visible anyway, because the light sees almost exactly
what you see; put it down and step aside to watch a column cut the shaft.

**Fog brightens the beam too.** Fog density sets both the haze on the splats
and how much the beam scatters, so thicker fog also makes the shaft brighter. A
narrow, focused beam in thick fog can clip to white near the light.

**Cost.** The march is 48 steps per pixel, each with one profile lookup and
one shadow-map compare, at full resolution. On a phone, render it into a half-resolution target and
upscale it, or lower `STEPS`.

## The code

::: code-group

<<< ../../docs/examples/samples/flashlight-fog.ts [main.ts]

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

## Next

- [Relight a capture](/examples/relight): the same relighting pass with a moving sun
- [Write your own effect](/examples/custom-effect): build modifiers like the fog from scratch
