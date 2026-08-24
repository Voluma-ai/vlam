# Select and cut away part of a capture

**What you get:** a transformable selection box, a live splat count, and an
option to extract the selection as a separate capture.

<ExampleEmbed slug="select-and-cut" hint="Drag the combined gizmo on the box, then Cut out, and drag the piece you cut" />

## Editing a capture means editing a list

A capture is a flat list of splats. To delete part of it, select the matching
entries and build a list without them. Three functions cover this:

| | |
| --- | --- |
| `createSelectionVolume` | describes a region, box, sphere or cylinder |
| `countInData` | how many splats fall inside it |
| `partitionSplatData` | splits the data into `inside` and `outside` |

## Counting is cheap, splitting is not

**`countInData` is one pass over the centers.** No allocation beyond a counter, no GPU work. Running it on every drag event is fine, which is what makes a live "1,483 splats selected" readout practical.

**`partitionSplatData` allocates two new captures.** Every array, positions, colours, covariances, spherical harmonics, is copied into two fresh ones. That is real work and real memory, so do it on a deliberate action: a button, a confirmed edit, an export. Not on a drag.

Count while the user selects; split after they confirm.

## The gizmo's matrix *is* the selection

The box on screen is an ordinary `THREE.Mesh`, a 1×1×1 cube, with [`@voluma/three-transform-gizmo`](https://github.com/Voluma-ai/three-transform-gizmo) attached to it. The gizmo starts in **combined** mode (translate, rotate and scale handles together); dedicated Move / Rotate / Scale toggles are still there. The selection simply reads the cube's matrix:

```ts
createSelectionVolume(
  { kind: 'box', halfExtents: [0.5, 0.5, 0.5], transform: cage.matrixWorld },
  splats.matrixWorld,
);
```

Half-extents of 0.5 describe the unit cube in the volume's own space. Everything the user did, position, rotation, per-axis scale, arrives in `transform`, so a box turned 30° and squashed on one axis selects exactly what it looks like it selects. No special cases.

The second argument is the capture's world matrix. It maps world-space selection
into the data frame, including the upright correction.

Two small things make the gizmo behave:

- **Gate your orbit controls.** `dragging-changed` fires when a handle is grabbed; disable `OrbitControls` for the duration or the two fight over the pointer.
- **Recount on `objectChange`,** not every frame. It fires only while something actually moved.

::: tip It is a separate package
`@voluma/three-transform-gizmo` is not part of VLAM!, install it alongside if you want this UI (`npm i @voluma/three-transform-gizmo`). Three's own `TransformControls` works the same way here; the API is near drop-in.
:::

## The code

::: code-group

<<< ../../docs/examples/samples/select-and-cut.ts [main.ts]

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
 gap: 8px;
 align-items: center;
 color: #fff;
 text-shadow: 0 1px 4px #000;
 }
 #ui button.active {
 background: #ff3366;
 color: #fff;
 }
 </style>
 </head>
 <body>
 <div id="ui">
 <button id="combined" type="button" class="active">All</button>
 <button id="translate" type="button">Move</button>
 <button id="rotate" type="button">Rotate</button>
 <button id="scale" type="button">Scale</button>
 <button id="cut" type="button">Cut out</button>
 <span id="readout"></span>
 </div>
 <script type="module" src="/main.ts"></script>
 </body>
</html>
```

:::

## The cut piece keeps the gizmo

After the split the gizmo is handed to the extracted part, so the same All / Move / Rotate / Scale toggles now transform *it*. That is the shape of a real editing tool: select, extract, then place.

Note that the piece goes into a `THREE.Group` before the gizmo touches it. The gizmo writes a quaternion, and a `SplatMesh`'s own rotation is the correction that stands the capture upright, writing over it would flip the piece on its head. See [Mix splats with ordinary 3D objects](/examples/splats-and-objects) for why.

## What you can build on this

- **Trim a scan to its site boundary** before publishing it, so you are not shipping the neighbour's garden.
- **Isolate an object**: select it, keep `inside`, discard `outside`, and you have extracted a single item from a room.
- **Non-destructive hiding**: for a preview that the user can undo, do not partition at all. A [cutaway effect](/examples/shader-effects) hides the same region on the GPU and costs nothing to reverse. Partition when the edit is meant to be permanent, or is about to be saved.

`partitionSplatData` also accepts an index array instead of a volume, so a selection you computed some other way, by colour, by a lasso projected into 3D, by a machine-learning pass, splits exactly the same way.

## Next

- [Shader effects](/examples/shader-effects), the reversible version, on the GPU
- [Surface queries](/examples/surface-queries), the other CPU-side query family
