# Write your own effect

**What you get:** a custom modifier that tints by height and sways, with live
tint and sway controls.

<ExampleEmbed slug="custom-effect" hint="Colour by height, swaying · adjust tint strength and sway amount" />

## A modifier is a function that runs once

Your modifier is called once while the shader is compiled. Its nodes are
placeholders; arithmetic on them describes GPU code that runs for every splat.

```ts
const height = smoothstep(-0.5, 0.5, ctx.localCenter.y);
```

This builds the expression that computes height on the GPU. Changes to the
calculation require a new shader; changes to uniforms do not.

## What you get, and what you may return

The context carries the splat as a set of nodes:

| | |
| --- | --- |
| `ctx.localCenter` | position in the mesh's own space |
| `ctx.worldCenter` / `ctx.viewCenter` | the same in world and view space |
| `ctx.color` | colour and opacity coming in from the previous modifier |
| `ctx.cameraLocal` | the camera, in mesh space, for distance effects |
| `ctx.index` | the splat's pool index, for per-splat channels |

Return only what you want to change. `color` and `offset` are used here; anything you leave out passes through untouched, which is why modifiers stack cleanly.

Use `ctx.color` rather than `ctx.baseColor` when you want to build on the modifier before you in the list, which is nearly always.

## Uniforms are the dials you keep

Anything you want to change later must be a `uniform` declared outside the modifier:

```ts
const tintStrength = uniform(0.85);
const swayAmount = uniform(0.08);
// …later, per frame or on an input event:
tintStrength.value = 0.4; // free, no recompile
swayAmount.value = 0.04; // free, no recompile
```

The tint slider sets `tintStrength`; the sway slider sets `swayAmount`, which
controls the horizontal offset. Both update uniforms, so they take effect
without recompiling the shader.

Plain numbers are baked into the shader. Changing one requires a new modifier
and shader, so use uniforms for values users can adjust.

## The code

::: code-group

<<< ../../docs/examples/samples/custom-effect.ts [main.ts]

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
      #controls {
        position: fixed;
        bottom: 16px;
        left: 16px;
        z-index: 1;
        display: flex;
        gap: 12px;
        color: #fff;
        text-shadow: 0 1px 4px #000;
      }
    </style>
  </head>
  <body>
    <div id="controls">
      <label>Tint <input id="strength" type="range" min="0" max="1" step="0.01" value="0.85" /></label>
      <label>Sway <input id="sway" type="range" min="0" max="0.24" step="0.01" value="0.08" /></label>
    </div>
    <script type="module" src="/main.ts"></script>
  </body>
</html>
```

:::

## The identity rule

The mesh decides whether to rebuild by comparing the *functions* in `modifiers` to the ones it had. So this recompiles the shader on every single frame:

```ts
// ✗ a new closure each frame, the mesh sees a different modifier every time
renderer.setAnimationLoop(() => {
  splats.modifiers = [(ctx) => ({ color: tint(ctx.color, someValue) })];
});
```

Define the function once, keep the reference, and drive it with uniforms. If you are stacking several effects and toggling them independently, `ModifierSlots` manages exactly this for you, see [All samples](/examples/all-samples).

## Portability

Plain TSL arithmetic, `mix`, `smoothstep`, `sin`, vector maths, runs on both backends. Anything built on `wgslFn`, including the reveal preset's noise, is WebGPU only and inert on the WebGL2 fallback. If you need an effect to work everywhere, stay in the portable subset and test on both.

## Next

- [Shader effects](/examples/shader-effects), the presets, now that you know what they are made of
- [All samples](/examples/all-samples): `ModifierSlots`, the rebuild contract as a do/don't pair
