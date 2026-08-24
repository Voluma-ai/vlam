# Troubleshooting

Symptoms you are most likely to hit when embedding VLAM!, the cause behind
each, and the fix. Every entry below is drawn from behavior that exists in the
current source, the error strings quoted are the ones the library actually
throws.

If something here is wrong or missing, that is a bug worth reporting: see
[CONTRIBUTING.md](../../CONTRIBUTING.md) and the
[issue tracker](https://github.com/Voluma-ai/vlam/issues).

## Nothing renders at all

**Symptom.** The canvas is the clear colour. No errors. Other three.js objects
in the same scene draw fine.

**Cause.** `splats.update(camera, renderer)` is not being called every frame.
It writes the projection uniforms and schedules the GPU depth sort; without it
the mesh has never been prepared for the current camera.

**Fix.** Call it once per frame, *before* `renderer.render`:

```ts
renderer.setAnimationLoop(() => {
  splats.update(camera, renderer); // uniforms + GPU depth sort
  renderer.render(scene, camera);
});
```

The same applies to `StreamedSplatMesh` (its `update` also drives LOD
residency) and to `UnifiedSplatRenderer.update(camera)`.

If `update` *is* being called, check the ordinary three.js causes next: the
mesh was never `scene.add`-ed, the camera is inside or behind the scene, or
the camera's `far` plane is shorter than the scene (the quick-start sample
uses `0.01 / 100`, which is small for a room-scale capture).

## Black screen, washed-out or double-darkened colours

**Symptom.** The scene draws but looks wrong: milky and low-contrast, or
crushed and overly dark, compared with SuperSplat or the source viewer.

**Cause.** Colour space is applied twice, or not at all. Source formats store
**display-ready sRGB** colours. By default the splat material converts them to
the renderer's linear working space *itself*, in-shader, so the renderer must
keep its normal sRGB output conversion. `srgbOutput: true` does the opposite:
it emits the stored sRGB values as-is and requires a renderer that **skips**
output conversion.

**Fix.** Pick one of the two consistent combinations and do not mix them:

| `srgbOutput` | Renderer output conversion |
| --- | --- |
| `false` (default) | leave it on, `renderer.outputColorSpace = THREE.SRGBColorSpace` |
| `true` | the host must configure the renderer to skip output conversion |

```ts
// Default path: the shader converts sRGB → working space itself.
renderer.outputColorSpace = THREE.SRGBColorSpace;
const splats = new SplatMesh(data); // srgbOutput defaults to false
```

VLAM! never changes `renderer.outputColorSpace` for you, that setting belongs
to the host application, which shares the canvas with its own meshes. In a
`UnifiedSplatRenderer` every registered source must agree on `srgbOutput`.
Background: [capabilities.md § Color space](../capabilities.md#color-space-srgboutput).

> The `srgbOutput: true` path is exercised by unit tests but is not what the
> demo runs, so the exact renderer configuration for it is left to the host
> rather than prescribed here.

## WebGPU bind-group / storage-buffer validation errors on large scenes

**Symptom.** A large streamed or unified scene fails at construction with a
message like:

```
vlam: storage buffer needs 192.0 MiB for 12,000,000 splats, but device
maxStorageBufferBindingSize is 128.0 MiB (WebGPU default is 128). Pass
recommendedWebGpuRequiredLimits(adapter) to WebGPURenderer, or lower the
splat budget.
```

Without that early throw you would instead see a cascade of
`GPUValidationError`s from `CreateBindGroup`.

**Cause.** WebGPU's default `maxStorageBufferBindingSize` is **128 MiB**. The
unified work buffer allocates an RGBA32F centers attribute at **16 bytes per
splat**, so capacities above roughly 8M splats exceed the default. Desktop
adapters commonly advertise around 2 GiB, but only if the host asks for it at
device creation.

**Fix.** The quickest one is `await createSplatRenderer()`, which does exactly
the recipe below (and requests the adapter's features too, keeping MSAA alive).
To do it by hand, pass the adapter's advertised maxima as `requiredLimits`,
and prefer `webGpuPowerPreferenceOptions()` so Windows Chrome does not warn
about an ignored `powerPreference`
([crbug.com/369219127](https://crbug.com/369219127)):

```ts
const adapter = await navigator.gpu?.requestAdapter({
  ...webGpuPowerPreferenceOptions(),
});
const renderer = new THREE.WebGPURenderer({
  ...webGpuPowerPreferenceOptions(),
  ...(adapter ? { requiredLimits: recommendedWebGpuRequiredLimits(adapter) } : {}),
});
```

If the device genuinely cannot go higher, lower the splat budget instead. See
[capabilities.md § WebGPU storage-buffer limits](../capabilities.md#webgpu-storage-buffer-limits).

## Streamed / LCC loads fail: "ignored a Range request"

**Symptom.** A streamed `.lcc`, `.rad` or other range-based load rejects with
a `SplatLoadError` (`phase: 'fetch'`) reading:

```
<url> ignored a Range request (HTTP 200); LCC streaming needs a server that
answers 206 Partial Content.
```

**Cause.** These formats keep their splats in one large file (`data.bin` for
LCC, the single-file `.rad`) and fetch chunks as HTTP **byte ranges**. A server
that ignores the `Range` header answers `200` with the *whole* body. For a
300 MB file that is a catastrophic download that would still appear to
"work", so VLAM! rejects the unranged response outright rather than decoding
it.

**Fix.** Serve the dataset from an origin that honours `Range` and answers
`206 Partial Content`. Common culprits: dev servers or object-storage proxies
with range support disabled, and CDN or compression middleware that rewrites
the response. If a CORS setup is involved, the browser also needs
`Access-Control-Expose-Headers` to cover `Content-Range`.

Dropping the folder into the page locally sidesteps servers entirely:
`StreamedSplatMesh.loadLocal` reads each file through a `blob:` URL, which
serves range requests exactly as an HTTP origin does.

## `NotReadableError` on a large local file

**Symptom.** Dropping a big capture (over ~2 GiB) fails, and the browser's own
error text blames file permissions, the file is fine.

**Cause.** A browser cannot allocate more than 2 GiB in one `ArrayBuffer`.
Chrome surfaces the over-size read as `NotReadableError`, whose stock message
is misleading.

**Fix.** VLAM! checks the size up front and replaces that message with an
actionable one naming the file and its size. Convert the capture to SOG or a
compressed `.ply`:

```bash
npx @playcanvas/splat-transform input.ply output.sog
```

Uncompressed 3DGS `.ply` is exempt: it has a streaming window parser, so its
size is not limited this way. The formats that must be decoded in one piece
are the ones that hit the ceiling.

A genuine `NotReadableError` on a *small* file usually means the file moved,
was renamed, or changed since it was dropped, a `File` reference is a
snapshot and reading revalidates it. Re-pick the file.

## Duplicate `three` copies in the bundle

**Symptom.** `instanceof` checks fail across the boundary, materials or nodes
behave strangely, `WebGPURenderer` rejects a VLAM! mesh, or the bundle is
suspiciously large.

**Cause.** `three` is a **peer dependency** precisely so there is exactly one
copy. A linked checkout (`npm link`), a nested `node_modules/three` under the
package, or two different `three` versions in a monorepo will each give the
bundler two copies of the module graph.

**Fix.** Make the resolver collapse them, `npm dedupe`, a Vite
`resolve.dedupe: ['three']`, a webpack `resolve.alias` for `three`, or a
package-manager `resolutions`/`overrides` pin. Verify with
`npm ls three`, which should print exactly one resolved version.

## `UnifiedSplatRenderer` throws on WebGL2

**Symptom.**

```
UnifiedSplatRenderer requires a WebGPU backend (renderer.backend.isWebGPUBackend).
On WebGL2 use standalone SplatMesh draws or static SplatScene.
```

**Cause.** Heterogeneous unified gather/sort/draw is WebGPU-only; there is no
CPU gather implementation. `THREE.WebGPURenderer` falls back to WebGL2
automatically wherever WebGPU is unavailable, so this fires on machines that
work fine for everything else.

**Fix.** Gate construction:

```ts
if (supportsUnifiedSplatRenderer(renderer)) {
 // unified path
} else {
 // standalone SplatMesh draws, or a static SplatScene
}
```

Note that `supportsUnifiedSplatRenderer` also answers `false` **before the
backend has initialized**, so call it after renderer init rather than
immediately after construction. Full list of fallback differences:
[capabilities.md § WebGL2 scope statement](../capabilities.md#webgl2-scope-statement).

## Flicker while moving the camera on WebGL2 streamed scenes

**Symptom.** On the WebGL2 fallback, a streamed LCC / Streamed SOG / RAD scene
flickers or pops while the camera moves. Stationary views look correct.

**Cause.** The WebGL2 path sorts on a CPU worker rather than on the GPU, and
its cadence against streaming residency changes is the known weak point.
Tracked as [ROADMAP L5](../../ROADMAP.md).

**Status.** The logic-level races behind this (sorted-permutation draw-list
patching, `activePrefix` sort spans, stationary-camera swap re-sort, order
upload ranges) have been fixed and are pinned by deterministic tests. Visual
confirmation in a real WebGL2 browser is **still pending**, so the item is not
closed and residual flicker is possible.

**Workaround.** WebGPU is the supported path for streamed formats. Where
WebGPU is unavailable, a static `SplatMesh` (non-streamed) is unaffected.

## The scene looks too soft, or too spiky

**Symptom.** Splats look blurred and bloated, or conversely hard-edged with
visible spiky tails and popping in the distance.

**Cause and fix.** Three options, in the second `SplatMesh` constructor
argument:

- **`maxStdDev`** (default `3`): how far out each
  Gaussian is drawn, in standard deviations. Lowering it clips the faint tail
  of every splat and is the main lever on blending cost in a busy view;
  lowering it too far makes edges look cut off. Raising it costs fill rate.
  `setMaxStdDev` applies a new cutoff without rebuilding the mesh.
- **`minSplatSizePx`** (default `1.5` on mobile, disabled elsewhere, including
  integrated/fallback desktops): the
  minimum projected quad radius. It closes sparse zoomed-out gaps by growing
  only undersized splats instead of paying to grow every splat with a larger
  `maxStdDev`. Pass `0` to disable it.
- **`antialias`** (default `false`): the Mip-Splatting 2D filter: screen-space
  dilation plus opacity compensation, so small and distant splats stop
  over-brightening. This must **match your exporter**; a SOG file's
  `antialias` meta flag sets it automatically. Enabling it when the capture
 was not trained with it (or vice versa) is a common cause of "the wrong kind
 of soft".
- **`performanceProfile`** (`'smooth'` on mobile, `'quality'` elsewhere) -
  `smooth` rejects splats whose projected contribution is negligible, which
  can visibly thin fine detail on a scene you expected to be complete. Pass
  `'quality'` explicitly to keep every splat.

## Library warnings in the console

**Symptom.** Messages prefixed `vlam:` in the host console that you would
rather route into your own logger, or suppress.

**Cause.** The library never writes to the host console without an opt-out -
every warning and error goes through one hook.

**Fix.**

```ts
import { setVlamLogHandler } from '@voluma/vlam';

setVlamLogHandler((level, message, ...details) => myLogger[level](message, ...details));
setVlamLogHandler(null); // silence VLAM! entirely
setVlamLogHandler(); // back to the console default
```

## Telling a dead link from a flaky network

The worker-mediated loaders (`loadScene`, `loadSceneFile`, `ChunkLoader`,
`StreamedSplatMesh`) reject with a `SplatLoadError` that names the `phase`
(`resolve`, `manifest`, `fetch`, `decode`, `worker`), the `url`, an HTTP
`status` where there is one, and a `retryable` flag, so you never have to
parse message text. A cancellation via `signal` rejects with an `AbortError`
instead; `isAbortError(error)` tells the two apart. The standalone `parseXxx`
functions throw plain `Error` on malformed input: they are handed bytes and
have no URL or phase to report.

See [Loading scenes](loading-scenes.md) for the full error contract.

## Still stuck

- Exact per-format and per-backend support:
 [capabilities.md](../capabilities.md), including the
 [browser and platform matrix](../capabilities.md#browser--platform-support).
- Every exported symbol: the generated API reference (`npm run dev`, then `/api/`).
- Known open work: [ROADMAP.md](../../ROADMAP.md).
