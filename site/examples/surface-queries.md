# Surface queries

**What you get:** surface markers and a distance measurement between two points.

<ExampleEmbed slug="stand-on-surface" hint="Click twice to measure · markers settle onto the surface" />

## Two questions the GPU should not be asked

[Picking](/examples/click-the-world) answers what is under the cursor. Many
other questions are about geometry rather than pixels:

- Where is the ground beneath this point?
- What is the nearest surface to this position?

`queryHeight` and `queryNearest` run on the CPU over the splat centers the mesh
currently holds, using a spatial grid it maintains for this. They return
immediately, no promise, no GPU round trip, so they are suitable for drag
handlers and per-frame use.

| | Question | Cost |
| --- | --- | --- |
| `pick` | what pixel did I click? | async, one GPU round trip |
| `queryHeight` | what is below this point? | synchronous, CPU |
| `queryNearest` | what is closest to this point? | synchronous, CPU |

## What `queryHeight` is really for

It is a floor probe. You give it a point and how far down to look; it gives you the highest splat below that point, and how far the drop was.

Typical uses include:

- **A walking camera.** Each frame, probe below the camera and set its height from the result. That is a first-person walkthrough of a scan, and it is a two-line loop.
- **Dropping objects.** Place furniture, markers or annotations so they rest on the floor instead of hovering.
- **Ground clearance.** Ask how far the drop is before letting the user step forward, and you have a cliff edge.

`queryNearest` is the other half: snapping to a surface, contact tests, and "how far is this thing from that thing" measurements.

## The code

::: code-group

<<< ../../docs/examples/samples/stand-on-surface.ts [main.ts]

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
      #readout {
        position: fixed;
        top: 14px;
        left: 14px;
        z-index: 1;
        color: #fff;
        text-shadow: 0 1px 4px #000;
      }
    </style>
  </head>
  <body>
    <p id="readout">Click the capture.</p>
    <script type="module" src="/main.ts"></script>
  </body>
</html>
```

:::

## World space, and what `null` means

Both queries take and return **world-space** values, so a capture you have moved, rotated or scaled is handled for you, including the upright correction. You never convert coordinates yourself.

Both return `null` rather than throwing, and it is a normal answer, not an error:

- Nothing within the range you allowed.
- On a streamed mesh, a region whose chunks are not resident at the moment. Fly closer and the same query starts answering.

For streamed meshes, retain and ease from the last good height when a probe
misses; snapping to `y = 0` will make a walking camera jump.

## Accuracy is splat-sized

These queries work on splat *centers*, not on a reconstructed surface. On a dense capture that is close enough to be indistinguishable from a surface probe. On a sparse or noisy one, the answer wobbles by roughly the spacing between splats, so treat the result as a good estimate, and smooth it if a camera is going to sit on it.

## Next

- [Select and cut away part of a capture](/examples/select-and-cut), the same centers, tested against a volume
- [Click on the world](/examples/click-the-world), the GPU question, for comparison
