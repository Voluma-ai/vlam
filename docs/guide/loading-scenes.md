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

The main `@voluma/vlam` entry exports the core renderer and the loaders, and no
parsers at all. Every format parser lives on its own subpath, so none of them
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

You do **not** need any subpath just to load: `loadSplatData`, `loadSplatDataFile`,
and `StreamedSplatMesh.load` accept every format and decode it in a worker.
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

`onProgress(loaded, total)` reports bytes as they are read, a determinate
progress bar for downloads and file reads. It is throttled to ~10/s in the
worker, always starts at 0, and always ends exactly at `total`. Two spinner
cases: a format that must be decoded whole reports only on completion, and
`total` is 0 when the response carries no `Content-Length`.

## Cancellation

Pass an `AbortController`'s `signal` in the options (as above) and call
`controller.abort()`, on navigation, on a superseding load, on unmount. The
in-flight fetch/decode stops and the promise rejects with an `AbortError`.
`StreamedSplatMesh.load` takes the same `signal` for its initial manifest
load; a partially built streamed mesh is disposed on abort, so nothing leaks.

## Size limits

A browser caps a single `ArrayBuffer` at 2 GiB. Uncompressed 3DGS `.ply` is
decoded a window at a time, so its size is unlimited; the other formats must
be decoded whole and report a clear error past 2 GiB, convert those to SOG
(`npx @playcanvas/splat-transform input.ply output.sog`).

## Next

Words for capture vs mesh vs source: [Terminology](terminology.md).
[Streaming & LOD](streaming-and-lod.md), for datasets that should stream
instead of decoding the whole file.
