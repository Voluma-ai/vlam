# Several captures in one scene

**What you get:** overlapping captures sorted and blended as one cloud.

<ExampleEmbed slug="many-captures" hint="Three sources, one shared sort, watch where they overlap" />

## Why two meshes are not enough

Separate `SplatMesh` objects sort only their own splats. That works until they
overlap: transparent splats require a single shared draw order. `SplatScene`
places every capture in one pool and sorts them together.

## The trade: capacity up front

```ts
const scene = new SplatScene({ capacity: data.count * 3 });
const id = scene.addSource(data, placement);
```

`capacity` is allocated when the scene is built. It must cover every source, so
size it for the scene you expect to build.

`addSource` copies a capture into the pool in its own local frame and returns an id. The placement you pass is *not* baked into the data; it is a matrix the shader applies while drawing.

## Moving a source is a uniform write

Move a source by updating its matrix:

```ts
scene.setSourceTransform(id, matrix); // safe every frame, while dragging
```

No data is copied or re-uploaded, and the shared sort keeps the source correctly
interleaved with the others.

Each source keeps its own upright correction too, so captures from different tools with different up-axes still line up, pass `orientation: 'source'` per source if you would rather place the raw data frame yourself.

## The code

::: code-group

<<< ../../docs/examples/samples/many-captures.ts [main.ts]

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

## When to reach for it

**Use `SplatScene`** when captures share space: a room assembled from several scans, an object placed inside a captured environment, anything the user can drag through something else.

**Use separate meshes** when they do not: captures in different rooms, a gallery of items with gaps between them, anything where you would never see two at once through the same pixels. Separate meshes are simpler, need no capacity planning, and can be disposed independently.

## Constraints

- **WebGPU only.** The shared per-source sort has no WebGL2 fallback path.
- **`UnifiedSplatRenderer` does not accept a `SplatScene` as a source.** They are two different answers to overlapping content; pick one.
- **Higher-order spherical harmonics are not rotated per source.** A source you rotate keeps its view-dependent lighting in its original orientation. On most captures this is invisible; on a shiny one it is not.
- **Removing a source** frees its slot, but the pool stays the size you allocated.

## Next

- [Mix splats with ordinary 3D objects](/examples/splats-and-objects), the other kind of "two things in one scene"
- [All samples](/examples/all-samples): `UnifiedSplatRenderer`, capacity sizing, and picking with a source id
