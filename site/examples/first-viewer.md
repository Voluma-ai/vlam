# Your first viewer

**What you get:** a full-window Gaussian splat viewer with mouse controls.

<ExampleEmbed slug="first-viewer" hint="Drag to orbit · scroll to zoom · right-drag to pan" />

## What a splat scene actually is

A normal 3D model is built from triangles. A **Gaussian splat** capture is a
cloud of coloured ellipsoids, each with a position, size, orientation and
colour. Together, they reproduce a photographed place from multiple source
images.

Splats must be drawn back to front from the current camera position. `SplatMesh`
sorts them on the GPU; call `splats.update(camera, renderer)` before rendering.

## The four things in the file

Every three.js app has these parts; VLAM! adds the last one:

| | |
| --- | --- |
| **Renderer** | The thing that actually paints pixels into a `<canvas>` on your page. |
| **Scene** | A container. Anything you `add` to it can be drawn. |
| **Camera** | Where you are standing and which way you are looking. |
| **SplatMesh** | The capture, as an object the scene can hold. |

Each frame, update the camera controls, update the splats, then render.

## The code

::: code-group

<<< ../../docs/examples/samples/first-viewer.ts [main.ts]

```html [index.html]
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
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

Put a capture named `goose.sog` in your `public/` folder (or point `loadSplatData` at any URL), run your dev server, and drag.

## Why the order in the loop matters

```ts
controls.update(); //  1. the camera moves
splats.update(camera, renderer); //  2. the splats re-sort for where it now is
renderer.render(scene, camera); //  3. draw
```

If you sort before moving the camera, blending can be wrong for one frame.
`splats.update` also makes streaming and level-of-detail decisions, so pass the
final camera pose.

## Troubleshooting

**Nothing appears, no error.** The camera is probably inside or behind the capture. Try `camera.position.set(0, 0, 3)` and `controls.target.set(0, 0, 0)`, then scroll out.

**It loads but it is on its side.** Different capture tools disagree about which axis is "up". VLAM! stands known formats upright by default; if yours still leans, see [`orientation`](/api/core/interfaces/SplatMeshOptions) on the `SplatMesh` constructor, and [Mix splats with ordinary 3D objects](/examples/splats-and-objects).

**`await` at the top level fails.** The example uses top-level `await`, which needs `<script type="module">` and a modern bundler target. If your setup rejects it, wrap the body in an `async function main() { … }` and call it.

**It is slow on a phone.** Large captures are demanding on mobile GPUs. Streamed
formats load detail only where it is needed; see [Huge scenes](/examples/big-scenes).

## Cleaning up

When you tear the page or component down, release the GPU memory:

<<< ../../docs/guide/samples/getting-started-dispose.ts

## Next

- [Open a file from your computer](/examples/open-local-file): let the user bring their own capture
- [Get started](/get-started): install and the shortest possible version
- <a href="/demo/" target="_self">Full viewer</a>: drop your own file in and see it render
