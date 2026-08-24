# Open a file from your computer

**What you get:** a viewer that opens local captures by file picker or drag and
drop, with progress and useful errors.

<ExampleEmbed
 slug="open-local-file"
 hint="Drop one of your own captures onto the frame, or open it full page, which is easier to drag onto"
/>

## The bytes stay on the device

`loadSceneFile` accepts a `File` from an `<input type="file">` or drop event
and decodes it in a Web Worker. The file stays on the device and the page stays
responsive while it loads.

## Loading is slow, so plan for the three outcomes

A capture can be tens or hundreds of megabytes. Handle these cases:

**It takes a while.** `onProgress` fires as bytes are read. When the size is unknown you get `total === 0`, show a spinner rather than a fake percentage.

**The user changes their mind.** Use an `AbortSignal` to cancel the previous
load. Otherwise, a slow file may replace the newer selection.

**It fails.** A `SplatLoadError` carries a `phase`. `'fetch'` is the network; `'decode'` almost always means the file is not the format its name claims, a `.ply` that is a mesh export rather than a splat capture is the classic one. Say that in words the user can act on.

## The code

::: code-group

<<< ../../docs/examples/samples/open-local-file.ts [main.ts]

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
 top: 12px;
 left: 12px;
 z-index: 1;
 color: #fff;
 text-shadow: 0 1px 3px #000;
 }
 </style>
 </head>
 <body>
 <div id="ui">
 <input id="file" type="file" accept=".sog,.ply,.spz,.splat,.ksplat,.rad" />
 <span id="status">Pick a file, or drop one anywhere.</span>
 </div>
 <script type="module" src="/main.ts"></script>
 </body>
</html>
```

:::

## Swap late, dispose the old one

Note the order: the new mesh is built *after* the decode succeeds, and only then is the old one removed and disposed. The previous capture stays on screen the whole time the new one is loading, and a failed load leaves you with what you had rather than an empty screen.

Call `dispose()`. Each capture owns GPU buffers and textures that browsers do
not reclaim automatically.

## Which files can users give you?

`.sog`, `.ply`, `.spz`, `.splat`, `.ksplat`, `.rad`. The extension picks the parser; pass `format` explicitly if your files arrive with the wrong name or none at all.

## Keeping your bundle small

`loadScene` and `loadSceneFile` accept anything, which means they must be able to reach every parser. If your app only ever loads one format, your own pipeline's output, say, you are shipping five decoders you will never call.

Each format is a separate entry point, so import just the one you need:

```ts
import { parseSog } from '@voluma/vlam/formats/sog';
```

This includes only the SOG decoder. Available subpaths are
`@voluma/vlam/formats/{sog,ply,spz,splat,ksplat,rad,lcc}`.

The effects presets work the same way. They live behind `@voluma/vlam/effects` and cost nothing unless you import them, so a viewer that never applies an effect never pays for the effects code.

Use the general `loadScene` when the user chooses the file, as they do here. Reach for a direct parser when *you* choose it.

Folders of streamed data, a `.lcc` directory, a streamed SOG capture, go through `StreamedSplatMesh.loadLocal` instead, since those are many files rather than one. See [Huge scenes](/examples/big-scenes).

## Next

- [Huge scenes that load as you walk](/examples/big-scenes), when one file is too big to hold at once
- [Click on the world](/examples/click-the-world), find the point under the cursor
