# Scene memory benchmark

`/memory-benchmark.html` is the development-only protocol for separating scene
loading peaks, retained CPU arrays, decoded streaming caches, and explicit GPU
allocations. It does not turn one browser heap number into a total-memory claim.

## Run it

Start the site with `npm run dev`, then open a fresh foreground tab for every
run. Static URL example:

```text
http://localhost:5170/memory-benchmark.html?scene=/goose.sog
```

Streamed example:

```text
http://localhost:5170/memory-benchmark.html?kind=streamed&scene=/capture.lcc2&budget=1000000&maxBudget=1000000
```

For a local uncompressed PLY, open the page without `scene`, choose the file,
and press **Measure selected static file**. This path exercises the windowed
`File` reader rather than turning the capture into one URL `ArrayBuffer`.
`?scene=synthetic&syntheticSplats=64` is a worker-free lifecycle smoke for
parallel CI; it is not a loading-memory baseline.

Useful query parameters:

| Parameter | Values / default | Purpose |
| --- | --- | --- |
| `kind` | `static` / `streamed`; `static` | Loader and mesh lifecycle |
| `backend` | `webgpu` / `webgl`; `webgpu` | Requested renderer backend |
| `poolFloat` | `float32` / `float16`; `float32` | Pool texture precision |
| `storage` | `editable` / `render-only`; `editable` | Static mesh CPU-storage lifetime |
| `sort` | `counting`, `radix`, `exact`, `worker`; `counting` | Requested sort storage |
| `sh` | `0`–`3`; source default | SH storage requested from the mesh |
| `budget` | positive splat count; `1000000` | Streamed active budget |
| `maxBudget` | positive splat count; `budget` | Streamed pool ceiling |
| `settleSeconds` | positive seconds; `30` | Maximum streaming settle wait |
| `uaMemory` | `1` / `0`; `1` | Disable slow browser-wide checkpoints for smoke tests |
| `syntheticSplats` | positive count; `64` | Size of the `scene=synthetic` CI smoke |

The JSON remains on the page, is available as `window.__vlamMemoryBenchmark`
for local automation, and can be downloaded. Keep raw reports under `.tmp/`;
large captures and reports do not belong in Git.

## What is recorded

The harness checkpoints before load, after static decode, after mesh
construction, after first render/stream settle, after dropping the caller's
static `SplatData`, and after disposal. A 100 ms sampler records
`performance.memory.usedJSHeapSize` where Chromium exposes it. That is a
main-isolate signal only. The stronger browser-wide measurement is recorded at
checkpoints only when `measureUserAgentSpecificMemory` exists and is permitted;
the dev page sends the cross-origin-isolation headers it requires.

The `accounted` section is deterministic rather than sampled:

- `decodedSource` sums the typed arrays owned by static `SplatData`.
- `mesh.cpuBackingBytes` and `mesh.gpuBytes` split
  `estimateSplatPoolBytes`, including the selected sorter. Palette SH is added
  as one retained CPU image and one GPU texture.
- `streamedCacheBytes` comes from `StreamedSplatMesh.fetchCounts`, including
  the worker-owned page-table cache.

Streamed reports also snapshot `scene.streamDiagnostics` (pending state,
failed chunks, fetch counts, evictions, and the cache limit). A run with
`settleTimedOut: true` is diagnostic only: increase `settleSeconds` or resolve
the reported fetch/cache churn before treating its retained values as a
baseline.

GPU figures cover allocations VLAM can name. Renderer internals, driver
alignment, transient command data, browser UI, and unrelated tab memory are not
included. `float16` still retains authoritative float32 CPU pool arrays, so its
GPU reduction is not a CPU reduction.

## Repetition and comparison

Run each case at least three times in a fresh tab, alternate baseline and
candidate order, and compare medians. Record browser, OS, GPU, backend, source
format and bytes, splat count, SH bands, pool capacity, and whether exposed GC
was available. Treat a change as measured only when its absolute saving is
larger than the run-to-run range and its deterministic allocation accounting
agrees in direction.

Minimum matrix:

| Scene | Required paths |
| --- | --- |
| Static DC-only PLY or SOG | WebGPU + forced WebGL2 |
| Static uncompressed SH3 PLY | Local windowed read, WebGPU + forced WebGL2 |
| Static bundled palette-SH SOG | WebGPU |
| Streamed SOG or LCC2 | WebGPU + forced WebGL2, settled cache recorded |
| Page-table RAD | WebGPU, worker cache recorded |
| Lifecycle | load → replace → dispose, repeated in one tab and fresh tabs |

### Reference smoke record

The harness itself was established on 2026-09-08 with Chromium 152 on Windows
and WebGPU (`float32`, counting sort, no exposed GC). Three fresh-tab runs of
the bundled 149,120-splat `goose.sog` produced these medians:

| Signal | Median / deterministic value |
| --- | ---: |
| Load time | 272 ms |
| Main-isolate heap before load | 15,260,935 bytes |
| Main-isolate peak / settled sample | 36,786,974 bytes |
| Sampled heap delta | 21,526,039 bytes |
| Decoded source arrays | 5,964,800 bytes |
| Mesh CPU backing | 10,166,272 bytes |
| Explicit mesh GPU allocation | 10,682,624 bytes |

These numbers are a local smoke reference, not a portable performance target.
A 250,000-budget Tempel LCC2 probe also verified streamed cache reporting, but
was still refining at the 30-second bound; its report was therefore classified
as diagnostic rather than recorded as a settled baseline.

## Retained first reduction: uncompressed PLY SH

The prior PLY decoder allocated all higher-order coefficients as float32 and
then allocated their packed representation. At SH3 that intermediate was
`15 coefficients × 3 channels × 4 bytes = 180 bytes/splat`, on top of the
40-byte core decoded data and 60-byte packed result.

The retained decoder now makes two exact passes. URL loads reuse the already
present source buffer; local files reread the same bounded windows. Pass one
decodes core data and measures the symmetric SH extent, and pass two writes
11/10/11 packed words directly. Tests compare every packed word and range with
the former float-intermediate algorithm. The expected peak reduction is the
removed 180 bytes/splat; it is not described as a total-process saving, and the
second local read's load-time cost stays visible in `scene.loadMs`.

## Settled reduction: render-only static WebGPU

`storageMode: 'render-only'` releases a static mesh's pool texture images,
authoritative pool arrays, active/reverse index maps, and draw/source attribute
mirrors once three.js has created all corresponding WebGPU resources. The
default `editable` mode and every WebGL2, dynamic, streamed, shared-pool, or
subclass path are unchanged.

Against the reference `goose.sog` run above, the 149,504-slot padded pool moves
from 10,166,272 bytes of retained mesh CPU backing to 0 after the first draw:
`149,504 × 68 bytes = 10,166,272 bytes` (9.70 MiB) released, while the explicit
10,682,624-byte GPU allocation is unchanged. The browser lifecycle test checks
the real WebGPU backend state, requires the released byte count to match the
accounting report, and completes a GPU pick after release. This is a mesh-owned
allocation reduction, not a claim about total browser memory or arrays the
application still references.

Render-only mode keeps GPU picking, transforms, display/effect uniforms, and
sorting on supported GPU strategies. CPU queries, range or channel mutation,
compaction, shared storage, unified sources, worker sorting, and WebGL2 throw
explicit errors.

## Acceptance for further reductions

Do not release more pool backing merely to improve this page. Default behavior
must retain CPU queries, channel painting, dynamic writes, pool compaction,
streamed residency, and WebGL2 worker sorting. Any further opt-in storage mode
must remain gated by these baselines and explicit unsupported-operation
behavior.
