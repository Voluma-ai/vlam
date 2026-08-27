# Cinematic depth of field

**What you get:** lens-style depth of field with focus, aperture, and
click-to-focus controls.

<ExampleEmbed slug="depth-of-field" hint="Drag the sliders, or click the capture to focus on that spot" />

## Why a capture looks flat without it

A photograph has a focal plane: objects at that distance are sharp and others
blur. Gaussian splat captures render every splat sharply, so depth of field can
make a scene read more like a photographed space.

## It is part of the projection, not an effect

This is the important distinction, and it is why depth of field lives on the mesh rather than in the [effects](/examples/shader-effects) module.

Each splat is projected to the screen as a 2D Gaussian. Depth of field adds a **circle-of-confusion disc** to that projection: the further a splat is from the focal plane, the wider the disc it is smeared into. That is a description of what a lens physically does, applied to the actual footprint of each splat.

The alternative, the stylized `depthOfFieldPreset` modifier, fakes it by scaling splats. It stacks with your other modifiers and is fine for a look. But for anything meant to read as a camera, use the core path:

```ts
splats.setDepthOfField({ focusDistance: 1.8, aperture: 0.45 });
```

There is no post-process pass or second render target; the blur is applied while
each splat is projected.

## The two dials

**`focusDistance`**, how far from the camera the sharp plane sits, in world units. This is the one you animate: racking focus from a foreground object to a background one is a shot, not a setting.

**`aperture`**, how fast things fall out of focus. Think of it as the lens opening: bigger means a shallower band of sharpness and a stronger, dreamier blur. `0` turns depth of field off entirely.

Both are live uniforms. Drive them from a slider, animation, or user input.

## Click to focus

`pick` returns `hit.distance`, the distance from the camera to the point under the cursor. `focusDistance` is measured the same way, so autofocus is one assignment with no conversion in between:

```ts
const hit = await splats.pick(ndc, camera, renderer);
if (hit) splats.setDepthOfField({ focusDistance: hit.distance });
```

That is the whole feature. Tap-to-focus, exactly like a phone camera, in three lines.

## The code

::: code-group

<<< ../../docs/examples/samples/depth-of-field.ts [main.ts]

```html [index.html]
<!doctype html>
<html>
 <head>
 <meta charset="utf-8" />
 <style>
 body {
 margin: 0;
 overflow: hidden;
 font: 14px system-ui;
 }
 #ui {
 position: fixed;
 bottom: 16px;
 left: 16px;
 z-index: 1;
 display: flex;
 gap: 18px;
 align-items: center;
 color: #fff;
 text-shadow: 0 1px 4px #000;
 }
 </style>
 </head>
 <body>
 <div id="ui">
 <label>Focus <input id="focus" type="range" min="0.5" max="3.5" step="0.01" value="1.8" /></label>
 <label>Aperture <input id="aperture" type="range" min="0" max="1" step="0.01" value="0.45" /></label>
 <span id="readout"></span>
 </div>
 <script type="module" src="/main.ts"></script>
 </body>
</html>
```

:::

## Getting it to look right

**Scale the numbers to the capture.** `focusDistance` is in the capture's world units, and a capture's units come from the solve, one unit is rarely one metre. The slider range that suits this goose is not the range that suits a building.

**Start subtle.** A large aperture on a small object blurs almost everything and reads as a mistake. Open it until you can see the falloff, then back off.

**A blurred splat covers more pixels.** The disc widens the footprint, so a heavily defocused foreground costs fill rate, the thing that [mobile GPUs are shortest on](/examples/fast-on-phones). If a scene is tight on frame time, a big aperture is not free.

## Next

- [Relight a capture](/examples/relight): sun and shadows, also a draw-time material setting
- [Click on the world](/examples/click-the-world): the pick behind click-to-focus
