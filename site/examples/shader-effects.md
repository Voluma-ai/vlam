# Shader effects

**What you get:** a capture that reveals itself, relights, and cuts away with a
moving sphere.

<ExampleEmbed slug="change-the-look" hint="Three effects stacked: reveal, cutaway, relighting, kept slow so each stays legible" />

To drive the same presets by hand, the <a href="/demo/" target="_self">viewer's effects panel</a> exposes them with sliders.

## You are changing the paint, not the capture

A **modifier** is shader code that changes a splat's colour, opacity, position,
or size as it is drawn. It does not alter or re-upload the stored capture.
Hiding splats, for example, means returning zero opacity.

Modifiers run in a list, each one handed the output of the one before, so they stack. This example stacks three:

| | |
| --- | --- |
| `revealPreset` | dissolves the capture in over time |
| `sdfEffects` | hides (or isolates) everything inside a shape |
| `lightingPreset` | relights the splats from a direction you choose |

## Create effects once; update uniforms

**Creating an effect builds a shader.** That is expensive and happens on the main thread.
**Changing an effect's uniform is just handing a number to a shader that already exists.** That is free.

So build your effects once, outside the loop, and per frame touch only their values, `reveal.progress.value`, `lighting.direction.value`, `cutaway.setShapes(...)`. Calling `sdfEffects(...)` again inside the loop would rebuild the shader on every frame, and the page will crawl.

Adding or removing an effect also rebuilds the shader. Do that for user actions,
not every frame.

## The code

::: code-group

<<< ../../docs/examples/samples/change-the-look.ts [main.ts]

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

## What the presets are for

**`sdfEffects`** takes a list of shapes, spheres, boxes, planes, each set to `hide` (cut it away) or `show` (keep only what is inside). Useful for cutaway views of a building, isolating one object out of a room, or clipping a capture to a site boundary. `setShapes` moves and resizes them live.

**`lightingPreset`** shades each splat from the direction you give it, using the splat's own shape to work out which way it faces. Captures come with the original lighting baked in, so this is a stylistic layer on top, good for making a capture feel like it belongs in a scene you control. For a moving sun with real shadows, that is a different path: [Relight a capture](/examples/relight).

**`revealPreset`** dissolves splats in as `progress` goes 0 → 1. It is the standard way to hide a load: start at 0, sweep to 1 once the capture is ready, and the scene builds itself instead of popping in.

There is also a stylized depth-of-field preset here, but for anything meant to look like a real lens prefer the core path, that is its own example: [Cinematic depth of field](/examples/depth-of-field). `worldWarpPreset` wraps the far field into a planet or a bowl: [Tiny planet](/examples/tiny-planet).

You can also write a modifier from scratch, see [Write your own effect](/examples/custom-effect).

## Troubleshooting

**The effect does nothing.** Check you assigned the list: `splats.modifiers = [...]`. Building a preset does not attach it.

**The frame rate dies after a few seconds.** Something in the loop is rebuilding. Look for a preset constructor, or a modifier function defined inline, inside `setAnimationLoop`.

**The reveal effect does nothing on this device.** `revealPreset` uses shader features that need WebGPU. On the WebGL2 fallback it is inert; `sdfEffects` and `lightingPreset` work on both.

## Next

- [Relight a capture](/examples/relight): sun and shadows from a triangle proxy
- [Tiny planet](/examples/tiny-planet): wrap the far field without moving the camera
- [Cinematic depth of field](/examples/depth-of-field), the other way to change the look, built into the projection
