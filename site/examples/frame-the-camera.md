# Frame the capture

**What you get:** a viewer that frames a capture from its bounds and restores the
view on demand.

<ExampleEmbed slug="frame-the-camera" hint="Orbit away, then press Reset view" />

## The most common way a first viewer fails

If a loaded capture shows a black screen, the usual causes are:

- The camera is **inside** the capture.
- The camera is **a thousand units away** from a capture that is one unit across.
- The camera is pointing at the origin, and the capture is nowhere near it.

Measure the capture bounds instead of guessing coordinates.

## Bounds, then a bit of trigonometry

The mesh will tell you its own extent. `computeSplatBounds` measures the splats in the mesh's local space, so the mesh's matrix, which holds the [upright correction](/examples/splats-and-objects) as well as anything you set, still has to be applied:

```ts
const box = splats.computeSplatBounds().applyMatrix4(splats.matrixWorld);
```

::: warning Not `Box3.setFromObject`
The usual three.js way to measure an object silently returns nonsense here. A `SplatMesh`'s geometry is a **single instanced unit quad**, the splats live in textures, not in vertex attributes, so `setFromObject` reports a ~2-unit box at the origin regardless of what the capture contains. Use `computeSplatBounds`.
:::

From the box you get a bounding sphere, and from the sphere the distance at which it fills the view:

```ts
const distance = (sphere.radius * margin) / Math.sin(fov / 2);
```

The one subtlety worth copying: use the **smaller** of the vertical and horizontal fields of view. Vertical alone looks right on a wide monitor and crops the capture on a narrow window or a phone in portrait.

## Set the clip planes too

Set clip planes from the measured bounds too:

```ts
camera.near = Math.max(distance / 1000, sphere.radius / 1000);
camera.far = distance + sphere.radius * 4;
```

Default planes of `0.1` and `1000` are wrong at both ends of the range captures actually come in. A capture measured in millimetres disappears behind the near plane; a large scan gets z-fighting because the depth buffer's precision is spread across a range a thousand times bigger than the scene. Deriving both from the size you just measured fixes both problems at once.

## The code

::: code-group

<<< ../../docs/examples/samples/frame-the-camera.ts [main.ts]

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
        top: 14px;
        left: 14px;
        z-index: 1;
        display: flex;
        gap: 12px;
        align-items: center;
        color: #fff;
        text-shadow: 0 1px 4px #000;
      }
    </style>
  </head>
  <body>
    <div id="ui">
      <button id="reset" type="button">Reset view</button>
      <span id="readout"></span>
    </div>
    <script type="module" src="/main.ts"></script>
  </body>
</html>
```

:::

## Print the numbers

The example writes the bounds and centre on screen, and that is not just decoration. The moment a capture misbehaves, those two lines tell you which kind of problem you have: a centre far from the origin means the capture carries a world offset from its solve; a size of `0.02` or `4000` means the units are not what you assumed.

Keep this readout during development; it makes framing problems easier to diagnose.

## It works on streamed captures too

This is the nice part: a `StreamedSplatMesh` has almost no splats resident when it loads, but `computeSplatBounds` reports the **manifest's root bounds**, valid immediately, before a single chunk has arrived.

So the same three lines frame a two-gigabyte scan and a one-megabyte object, and you can frame it the moment the manifest lands rather than waiting for data to stream in.

## Next

- [Open a file from your computer](/examples/open-local-file), framing matters most when you did not choose the capture
- [Save and share a viewpoint](/examples/share-a-viewpoint), once framed, make the view shareable
