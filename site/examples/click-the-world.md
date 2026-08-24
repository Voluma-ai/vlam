# Click on the world

**What you get:** click a capture to place a marker and orbit around that point.

<ExampleEmbed slug="click-the-world" hint="Click the capture to drop a marker and orbit that point" />

## Why this is not a raycast

A splat capture has no triangles to raycast. Each pixel blends many transparent
splats, so `pick` instead asks what is drawn at that pixel and how far away it
is. It returns the depth where contributing splats become sufficiently opaque.

Picking matches the rendered result: hidden splats cannot be picked, and a
streamed region is picked at its current detail level.

## `alphaThreshold` is the "how solid counts as solid" dial

Walking the smudges front-to-back, the accumulated opacity climbs. `alphaThreshold` is where you declare that enough has piled up to call it a surface.

- **Low (0.05)**: stops at the first faint haze. Picks up dust, fog, and the fuzzy fringe around objects.
- **Around 0.1**: the default sweet spot; ignores haze, stops on real surfaces.
- **High (0.5)**: only dense, confidently solid material. Thin things like leaves and railings become unclickable.

## The code

::: code-group

<<< ../../docs/examples/samples/click-the-world.ts [main.ts]

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

## It is asynchronous, and a miss is normal

`pick` returns a promise because it reads from the GPU. Call it from an event
handler, not inside the render loop.

A miss returns `null`, never an error. Clicking the sky is not a failure, so always guard before using the result.

If you fire a pick on every `pointermove`, throttle it. One per frame is plenty and each one costs a GPU round trip.

## When you want a different question answered

`pick` is "what is under the cursor". Two related questions have cheaper, synchronous answers that never touch the GPU:

- `queryNearest(point, radius)`, the closest splat to a world position. Measurements, snapping, proximity checks.
- `queryHeight(point, maxDrop)`, the highest splat below a point. Floor probes, dropping an object onto the ground, keeping a walking camera on the terrain.

Both work in world space, so a moved or scaled capture is handled for you. See [All samples](/examples/all-samples) for a worked pair.

## Next

- [Shader effects](/examples/shader-effects), hide part of the capture, and watch picking follow
- [Mix splats with ordinary 3D objects](/examples/splats-and-objects), put the marker in a scene with real geometry
