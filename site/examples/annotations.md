# Annotations pinned to the capture

**What you get:** HTML labels pinned to points on a capture. They follow their
point as you orbit, and hide when the capture covers them.

<ExampleEmbed slug="annotations" hint="Click to pin labels, then orbit, they track, and hide when covered" />

## Why HTML instead of 3D text

For survey markers, defect tags, hotspots, and room labels, HTML is usually a
better fit than 3D text. It stays crisp, uses your existing styles, supports
accessibility, and can contain controls. Positioning needs one projection per
label per frame and no GPU work.

The technique is the same one three.js's `CSS2DRenderer` uses. It is short enough to write yourself, which is what this example does.

## Project, then position

`Vector3.project` maps a world point into normalized device coordinates, and a little arithmetic turns that into pixels:

```ts
const p = point.clone().project(camera);
const x = (p.x * 0.5 + 0.5) * innerWidth;
const y = (-p.y * 0.5 + 0.5) * innerHeight;
```

Two details matter:

**Check `p.z > 1`.** That means the point is *behind* the camera, and the x/y you get back are mirrored garbage, labels for things behind you appear on screen, in the wrong place. Hide them.

**Position after the render, not before.** `controls.update()` moves the camera, so projecting before the frame is drawn puts the labels one frame behind the image. Over a fast orbit that reads as labels sliding around loosely.

Use a `transform: translate(...)` rather than `left`/`top`. It stays on the compositor and does not force layout for every label every frame.

## Hide labels behind the capture

A label pinned to the far side of an object should disappear when the object gets in the way. Projection alone cannot tell you that, it does not know what is in front of what.

`pick` does. It reports the distance to whatever is actually drawn at a pixel, so an annotation is covered when something solid is closer than the annotation itself:

```ts
const hit = await splats.pick(ndcOfLabel, camera, renderer);
const covered = hit !== null && hit.distance < camera.position.distanceTo(annotation.point) - 0.02;
```

That small tolerance matters: the point sits *on* a surface, so without it the surface occludes its own label.

**Do not do this for every label every frame.** Each pick is a GPU round trip.
This example checks one label per frame, round-robin, with at most one request in
flight, so the cost is fixed no matter how many labels exist.

## The code

::: code-group

<<< ../../docs/examples/samples/annotations.ts [main.ts]

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
      /* The overlay must not eat the pointer, or clicking a label would stop
         you placing the next one, and orbiting would break wherever a label
         happens to sit. */
      #labels {
        position: fixed;
        inset: 0;
        z-index: 1;
        pointer-events: none;
      }
      .label {
        position: absolute;
        top: 0;
        left: 0;
        padding: 4px 9px;
        border-radius: 14px;
        background: #ff3366;
        color: #fff;
        font-size: 12px;
        font-weight: 600;
        white-space: nowrap;
        transition: opacity 0.18s;
      }
    </style>
  </head>
  <body>
    <div id="labels"></div>
    <script type="module" src="/main.ts"></script>
  </body>
</html>
```

:::

`pointer-events: none` on the layer is not a detail, without it the overlay swallows every click and drag that lands on a label. If a label needs to be clickable, put `pointer-events: auto` back on that element alone.

## Fade, don't pop

The labels here transition their opacity rather than toggling `display`. Because occlusion is sampled a few times a second rather than every frame, an instant switch shows up as flicker at the silhouette edge where the answer keeps changing. A 180 ms fade turns that into something that reads as intentional.

## Taking it further

- **Anchor to a surface, not to air.** Combine with [`queryHeight`](/examples/surface-queries) so a label dropped near a wall settles onto it.
- **Persist them.** An annotation is just a world position and a string: store it, reload it, and it lands in the same place, because world space is stable across sessions.
- **Cluster at distance.** Twenty labels on a large scan become unreadable; merge nearby ones into a count when the camera pulls back.

## Next

- [Surface queries](/examples/surface-queries): pin labels to the surface rather than the click point
- [Save and share a viewpoint](/examples/share-a-viewpoint): send someone a link that opens on your annotation
