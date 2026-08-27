# Tiny planet

**What you get:** a streamed street that wraps into a sphere under your feet,
or up into a bowl over your head, while orbit still works.

<ExampleEmbed slug="tiny-planet" hint="Give it a moment to stream in, then drag Fold / Planet" />

## The camera does not move

`worldWarpPreset` is a `SplatModifier`. It displaces splat centres (and rotates
their ellipsoids with the wrap) in the shader. WASD, orbit, and pointer-lock
keep doing what they already do: the near field stays put, and the street
curves away from you.

That is the opposite of a cubemap tiny-planet, where you reproject the *image*.
Here the 3D capture is still a 3D capture. You can walk around on it.

This example streams the same Dehaar `.lcc2` the
<a href="/demo/?scene=/remote/jack/v/Dehaar/Dehaar.lcc2&effects=warp&fallback=goose" target="_self">viewer</a>
opens with `?effects=warp`. How streaming itself works is
[Huge scenes](/examples/big-scenes).

## One signed dial

**`intensity`**, in `[-1, 1]`. Positive wraps the far field *down* so you stand
on the planet. Negative wraps it *up* so you stand in the bowl. `0` is
identity. Mutate `.value` to animate, no recompile.

**`radius`**, the distance at which the wrap becomes strong. Nearby splats
(`depth ≪ radius`) barely move, which is why walking still reads as walking.
The viewer uses about `0.22 ×` the capture's bounding-span.

Build the preset once, assign `splats.modifiers = [warp.modifier]`, and drive
the uniforms from a slider.

## The code

::: code-group

<<< ../../docs/examples/samples/tiny-planet.ts [main.ts]

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
      #ui {
        position: fixed;
        bottom: 16px;
        left: 16px;
        z-index: 1;
        color: #fff;
        text-shadow: 0 1px 4px #000;
      }
    </style>
  </head>
  <body>
    <div id="ui">
      <label>Fold <input id="intensity" type="range" min="-1" max="1" step="0.01" value="0.55" /> Planet</label>
    </div>
    <script type="module" src="/main.ts"></script>
  </body>
</html>
```

:::

## What you should know

**Sort order does not follow the wrap.** Displaced splats keep their
pre-displacement depth order. At high `|intensity|` some ellipsoids will
composite in the wrong order. The preset does not re-sort on warped centres.

**Radius is in the capture's units.** Same warning as [depth of
field](/examples/depth-of-field): one unit is rarely one metre. A compact
object like the goose has almost no far field, so the wrap either does
nothing or throws it out of frame. Use a street.

**The `.lcc2` URL is same-origin.** `/remote/…` is the docs/demo proxy onto
`assets.voluma.ai`. Point `StreamedSplatMesh.load` at your own manifest when
you copy this out.

## Next

- [Write your own effect](/examples/custom-effect): the same modifier hook, without a preset
- [Relight a capture](/examples/relight): sun and shadows on this same street
