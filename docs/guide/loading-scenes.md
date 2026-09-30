# Loading scenes

How to get splat data into a `SplatMesh`: format detection, explicit formats,
format subpaths, structured errors, progress, and cancellation.

## `loadSplatData` and `loadSplatDataFile`

Both fetch/read **and decode in a Web Worker**, then transfer (not copy) the
decoded arrays back, even multi-million-splat decodes never freeze the page.
Import them from `@voluma/vlam/loaders` so the decode worker stays out of the
core renderer graph.

- `loadSplatData(input, options?)`: `input` is a URL (`string | URL`); relative
 URLs resolve against `options.baseUrl` when given.
- `loadSplatDataFile(file, options?)`, a local `File` from a drop or
  `<input type="file">`; the bytes never leave the device.

Both cover the self-contained formats: `.sog` (bundled), `.ply` (both the
3DGS "INRIA" and SuperSplat-compressed flavors), `.spz`, `.splat`, `.ksplat`,
and whole-file `.rad`. Streamed datasets (a `lod-meta.json` directory, `.lcc`,
`.lcc2`, a `.rad` that names external `.radc` chunks) are not single files, they go through
[`StreamedSplatMesh`](streaming-and-lod.md).

## Format detection, automatic and explicit

By default the URL pathname's extension (or the file's name) picks the
parser; pass `format` when the URL carries no useful extension:

```ts
import { SplatMesh } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';
import { parseSog } from '@voluma/vlam/formats/sog';
import { parseSpz } from '@voluma/vlam/formats/spz';

// Auto-detection: the URL pathname's extension picks the parser
// (query strings are fine).
const auto = new SplatMesh(await loadSplatData('/captures/garden.ply?v=3'));

// Explicit format: when the URL carries no useful extension.
const explicit = new SplatMesh(await loadSplatData('/api/scene/42', { format: 'sog' }));

// Direct parsing: hand bytes you already have to a parser. Every parser lives
// on a subpath, so none of them enter your bundle unless you import them.
const sogData = await parseSog(await (await fetch('/scene.sog')).arrayBuffer());
const spzData = await parseSpz(await (await fetch('/scene.spz')).arrayBuffer());
```

<!-- full file: docs/guide/samples/loading-formats.ts -->

### Format subpaths

The main `@voluma/vlam` entry exports the core renderer; loaders live on
`@voluma/vlam/loaders`, and parsers live on format subpaths. Every format parser lives on its own subpath, so none of them
enter your bundle unless you import one:

```ts
import { parseSplatPly } from '@voluma/vlam/formats/ply';
import { parseSog } from '@voluma/vlam/formats/sog';
import { parseRad } from '@voluma/vlam/formats/rad';
import { parseLccManifest } from '@voluma/vlam/formats/lcc';
import { parseSpz } from '@voluma/vlam/formats/spz';
import { parseSplat } from '@voluma/vlam/formats/splat';
import { parseKsplat } from '@voluma/vlam/formats/ksplat';
```

Use `@voluma/vlam/loaders` for `loadSplatData` and `loadSplatDataFile`,
or `@voluma/vlam/streaming` for `StreamedSplatMesh.load`. These routes
recognize supported formats without importing a parser directly.
The subpaths are for direct decode or format inspection.

The directly-called `parseXxx` functions throw plain `Error` on malformed
input, they are handed bytes and have no URL or phase to report. The
structured contract below belongs to the loaders, not the parsers.

## Error handling

The worker-mediated loaders, `loadSplatData`, `loadSplatDataFile`, `ChunkLoader`
and `StreamedSplatMesh`, reject with exactly two kinds of error:

- **`SplatLoadError`** for real failures, with `phase`
 (`'resolve' | 'manifest' | 'fetch' | 'decode' | 'worker'`), the `url`, an
 HTTP `status` where there is one, and `retryable`, enough to tell a dead
 link from a flaky network without parsing message text.
- **`AbortError`** (a `DOMException`) when your `signal` fires. The exported
  `isAbortError(error)` tells deliberate cancellation apart from failure.

```ts
import { SplatMesh } from '@voluma/vlam';
import { SplatLoadError, isAbortError, loadSplatData } from '@voluma/vlam/loaders';

const controller = new AbortController();

export async function loadWithFeedback(url: string): Promise<SplatMesh | null> {
 try {
 const data = await loadSplatData(url, {
 signal: controller.signal,
 onProgress: (loaded, total) => {
 // total is 0 when the response has no Content-Length → show a spinner.
 if (total > 0) console.log(`${Math.round((loaded / total) * 100)}%`);
 },
 });
 return new SplatMesh(data);
 } catch (error) {
 if (isAbortError(error)) return null; // deliberate cancellation, not a failure
 if (error instanceof SplatLoadError) {
 // phase: 'resolve' | 'manifest' | 'fetch' | 'decode' | 'worker'
 console.error(`load failed during ${error.phase} of ${error.url}`, error.status);
 if (error.retryable) {
 // transient (network hiccup, 5xx, 429), offer a retry
 }
 return null;
 }
 throw error; // not a loading error, do not swallow it
 }
}
```

<!-- full file: docs/guide/samples/loading-errors.ts -->

## Progress

`onProgress(loaded, total)` reports bytes read, throttled to roughly 10 updates
per second in the worker. `total` is 0 when the length is unknown. Local
whole-file reads report their complete byte count before decoding; byte
completion does not mean the load has finished.

Use `onStatus` for the current operation, independently of byte progress:

```ts
import { loadSplatData } from '@voluma/vlam/loaders';

const data = await loadSplatData('/capture.splat', {
  onStatus: (status) => {
    // initializing | reading | reading-and-decoding | decoding
    statusLabel.textContent = status;
  },
  onProgress: (loaded, total) => {
    progressLabel.textContent = total > 0 ? `${loaded} / ${total}` : `${loaded} bytes`;
  },
});
```

<!-- full file: docs/guide/samples/loading-status.ts -->

`SplatLoadStatus` is exported from `/loaders` and `/streaming`. Status and
progress callbacks belong to that load and stop after settlement. The returned
promise signals completion; the mesh's existing reveal state signals rendering
readiness. Streamed status covers initial loading, not later background LOD work.

## Cancellation

Pass an `AbortController`'s `signal` in the options (as above) and call
`controller.abort()`, on navigation, on a superseding load, on unmount. The
in-flight fetch/decode stops and the promise rejects with an `AbortError`.
`StreamedSplatMesh.load` takes the same `signal` for its initial manifest
load; a partially built streamed mesh is disposed on abort, so nothing leaks.

## Size limits

A browser caps a single `ArrayBuffer` at 2 GiB. Local uncompressed 3DGS `.ply`
can be decoded in windows beyond that limit; remote PLY streaming remains a
benchmark path, not a convenience loader feature. Other formats, including
whole-file `.rad`, use whole-file decoding and report an error past 2 GiB;
convert oversized files to SOG
(`npx @playcanvas/splat-transform input.ply output.sog`).

## Next

Words for capture vs mesh vs source: [Terminology](terminology.md).
[Streaming & LOD](streaming-and-lod.md), for datasets that should stream
instead of decoding the whole file.
