# Huge scenes that load as you walk

**What you get:** a large capture that streams detail near the camera and drops
unneeded chunks.

<ExampleEmbed slug="big-scenes" hint="Give it a moment to stream in. Drag to orbit, press to walk, then look around" />

Hold the left button still for a moment to walk forward; a drag in that window still orbits. Once you are walking, moving the mouse looks around.

## Why a big capture cannot just be loaded

Large captures can exceed GPU memory and practical download sizes. They are split
into chunks at several levels of detail, with a manifest describing each chunk.
`StreamedSplatMesh` fetches fine detail near the camera and coarser detail
farther away, so a capture larger than the budget is never resident in full.

This example streams the same Dehaar `.lcc2` the
<a href="/demo/?scene=/remote/jack/v/Dehaar/Dehaar.lcc2&fallback=goose" target="_self">viewer</a>
opens. `/remote/…` is the docs/demo proxy onto `assets.voluma.ai`. Point
`StreamedSplatMesh.load` at your own manifest when you copy this out.

## How the splat budget works

**Budget = the maximum active splat count.** The streamer spends it where detail
is most useful.

Raise it and you get more detail, more memory, more time per frame. Lower it and everything gets softer but faster. Left out, the library picks a number from what it can tell about the device, a phone gets a smaller one than a desktop.

**Start with the default.** It is device-derived. For a quality slider, scale the
resolved default instead of choosing a fixed number.

Changing the budget does not reload anything. The mesh just re-decides which chunks are worth keeping.

## The code

::: code-group

<<< ../../docs/examples/samples/big-scenes.ts [main.ts]

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
      <label>Quality <input id="quality" type="range" min="0.25" max="1" step="0.05" value="1" /></label>
      <span>Press to walk</span>
    </div>
    <script type="module" src="/main.ts"></script>
  </body>
</html>
```

:::

## What you point it at

`StreamedSplatMesh.load` takes a manifest URL, not a splat file:

| Format | What you pass |
| --- | --- |
| Streamed SOG | the `lod-meta.json` next to the chunk folders |
| `.lcc` / `.lcc2` | the `.lcc` file; its `data.bin` is read in ranges |
| `.rad` | the `.rad` file (not a `.radc` chunk) |

All of them need a host that answers HTTP range requests, any normal static host or CDN does. If the capture sits on a different origin than your page, that origin needs CORS headers, or the fetches fail before anything renders.

For a folder the user drags in from their own disk, use `StreamedSplatMesh.loadLocal` instead; it takes a map of files and needs no server at all. The <a href="/demo/" target="_self">viewer</a> takes that path when you drop a streamed folder onto it.

## Troubleshooting

**It stays blurry.** The camera may be outside the range where fine detail is used. Raise `lodBaseDistance`, or check the scene's scale, a capture in millimetres puts the camera thousands of units away by accident.

**Detail pops in visibly.** That is chunks arriving. It is worse on slow connections and unavoidable to some degree; a lower budget makes it less frequent, not less visible.

**Everything after `update` looks fine but memory keeps growing.** Call `dispose()` when you tear the viewer down. Streamed meshes hold a chunk cache as well as the pool.

## Next

- [Relight a capture](/examples/relight): sun and shadows on this same street
- [Click on the world](/examples/click-the-world), picking works the same on a streamed mesh
