# Architecture and engineering guide

The deep guide for people working on **VLAM!**, an open-source (MIT),
WebGPU-first renderer for 3D Gaussian Splatting, built on three.js
`WebGPURenderer` + TSL, made by [Voluma](https://voluma.ai).

[`CONTRIBUTING.md`](../CONTRIBUTING.md) covers setup, CI, and pull-request
mechanics. This document covers the code: how it is laid out, the rules that
must not be broken, and the things that cost us time to learn the first time.

## Names

The repository ships the npm package `@voluma/vlam` (lowercase, npm rejects
capitals); the brand is written "VLAM!" in prose. Development happens at
[github.com/Voluma-ai/vlam](https://github.com/Voluma-ai/vlam). When the
directory name and `package.json` disagree, trust `package.json`.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | install dependencies (also registers lint + typecheck + docs:check git hooks) |
| `npm run dev` | VitePress docs site → http://localhost:5170 (port pinned; interactive viewer at `/demo/`, harnesses at `/chunk-harness.html` / `/unified-harness.html` / `/rad-parity-harness.html`, settled benchmark at `/render-benchmark.html`) |
| `npm run build:site` | docs site + viewer + TypeDoc HTML → `dist-site/` |
| `npm run build:lib` | library ES build + `.d.ts` → `dist/` |
| `npm run build` | site + library |
| `npm test` | Vitest unit tests (dev-only; not shipped in the package) |

## Architecture: the 30-second tour

```
src/
 viewer/ docs-site / local viewer; never imported by lib/
 index.html SPA shell; Vite entry, served at `/demo/`
 main.ts viewer entry: renderer, camera-controls, scene loading
 loading-status.ts overlay/pill copy for determinate load progress
 chrome.ts UI presets (`full` / `embed`) for overlays
 drop-zone.ts drag-and-drop file/folder intake
 failure.ts SplatLoadError → friendly failure card
 effects.ts, paint.ts viewer-side effect picker + painting on lib primitives
 chunk-harness.ts / .html ChunkLoader GPU harness (`/chunk-harness.html`)
 unified-harness.ts / .html UnifiedSplatMesh GPU harness (`/unified-harness.html`)
 rad-parity-harness.ts / .html Opt-in streamed `.rad` direct/unified screenshot run
 sort-benchmark.ts frame/sort timing rig behind ?benchmarkSeconds
 render-benchmark.html / .ts settled plain-SplatMesh device benchmark
 lib/ the published library ("@voluma/vlam" on npm); folders match package
      subpaths (each `index.ts` is the published entry)
 core/ → `@voluma/vlam` (SplatMesh, MergedSplatMesh, renderer, sort)
 loaders/ → `@voluma/vlam/loaders` (loadSplatData, ChunkLoader, workers)
 static-lod/ → `@voluma/vlam/static-lod`
 streaming/ → `@voluma/vlam/streaming` (StreamedSplatMesh, governors, LOD)
 unified/ → `@voluma/vlam/unified`
 selection/ → `@voluma/vlam/selection`
 effects/ → `@voluma/vlam/effects`
 formats/
 ply/ → `@voluma/vlam/formats/ply` (parse-splat-ply, parse-compressed-ply)
 sog/ → `@voluma/vlam/formats/sog`
 rad/ → `@voluma/vlam/formats/rad` (parse-rad, rad, frontier-*)
 lcc/ → `@voluma/vlam/formats/lcc` (parse-lcc, lcc, lcc2, collision)
 spz/ → `@voluma/vlam/formats/spz`
 splat/ → `@voluma/vlam/formats/splat`
 ksplat/ → `@voluma/vlam/formats/ksplat`

 -- core/ rendering / mesh --
 splat-mesh.ts SplatMesh: the pool, range lifecycle, active list, sort wiring
 splat-mesh-types.ts its public options, result types, and profile defaults
 splat-mesh-material.ts its TSL graph (display + pick), as free functions
 splat-mesh-picking.ts SplatPicker: the GPU pick pass and its resources
 splat-mesh-pool.ts pool data textures + the row-span allocator
 merged-splat-mesh.ts MergedSplatMesh: several fully decoded sources, one pool
 splat-data.ts SplatData arrays + shared covariance/SH math
 splat-modifier.ts M7 TSL hook types (SplatContext/SplatOutputs)
 splat-budget.ts device profiling + per-device default splat budget
 webgpu-limits.ts application requiredLimits helper + storage-buffer size checks
 splat-depth-pack.ts depth pack/unpack + view-depth (un)projection for picking
 sorter.ts depth-sorter interface (`kind` discriminator)
 sort-scheduler.ts adaptive sort cadence by active count (see README)
 compute-sorter.ts GPU counting sort, 8 TSL compute passes (WebGPU)
 radix-sort.ts radix constants + reference CPU sort (verification)
 radix-sorter.ts experimental GPU radix sorter (lazy-loaded)
 worker-sorter.ts CPU counting sort in a worker (WebGL2 fallback)
 sort-worker.ts the worker script behind worker-sorter

 -- unified/ --
 unified-splat-mesh.ts UnifiedSplatMesh: one WebGPU draw over registered meshes

 -- streaming/ --
 streamed-splat-mesh.ts LOD streaming pool; dynamic-imports RAD/LCC/frontier
 streamed-splat-mesh-utils.ts format-neutral swap, fetch, and chunk helpers
 dataset-source.ts HTTP vs dropped-folder dataset sources
 lod-source.ts LodSource + StreamedScene abstraction; SOG builder
 lod-manifest.ts lod-meta.json parser → flat leaves + chunk URLs
 lod-scheduler.ts SOG LodSource: flat leaves, distance, hysteresis, budget

 -- loaders/ --
 loading.ts shared types, URL/format resolution, SplatLoadError,
 readWholeFile + the 2 GiB ArrayBuffer ceiling
 load-splat-data.ts public whole-file loaders (loadSplatData/loadSplatDataFile)
 chunk-loader.ts ChunkLoader: multiplexed, cancellable fetches + progress,
 across two workers (streaming eager, one-shot lazy)
 load-worker.ts streaming decode off the main thread (transfers arrays):
 rad-chunk, lcc-bin, SOG directories, PLY. Inlined via
                            `?worker&inline`, so every parser it imports is an
                            untree-shakeable string literal in dist/loaders.js, keep
                            it to the streaming formats. Do not dynamic-import
                            inside it (blob URLs cannot resolve chunks).
    one-shot-worker.ts      whole-file spz/splat/ksplat, dynamic-imported by
                            ChunkLoader on first use. Exists so SPZ's ~39 KB ZSTD
                            wasm (16 KB gzipped) stays out of the published entry.
    worker-host.ts          the message loop both workers run (ids, cancel, transfers)
    worker-fetch.ts         range/whole-body fetching + progress, shared by both
    ply-header.ts           shared PLY header reader used by both PLY flavors and
                            by formats/lcc's collision-mesh PLY
```

The `splat-mesh-*.ts` modules are internal: they are reached through
`SplatMesh`, never exported from `core/index.ts`. Two things to know before moving
code between them. The material graph must be handed the mesh's uniform *node
instances* and its **live** channels map, not copies, display and pick share
the uniforms, and a rebuild after `defineChannel` has to see the new entry. And
several tests reach into private members **by name** through
`as unknown as` casts (`rebuildActiveList`, `acquireUploadStaging`,
`flushPendingUploads`, `sorter`, `channels`, and on `StreamedSplatMesh` the
private constructor plus `reschedule`/`stageGroup`/`cache`/`resident`), so
those must stay instance members even when the work moves out.

`SplatMesh` has two modes: fully loaded (`new SplatMesh(data)`) and
dynamic-capacity (`new SplatMesh({ capacity })`, an empty pool filled with
`appendRange`/`removeRange`, row-aligned in the pool textures).
`StreamedSplatMesh extends SplatMesh` drives that pool within a per-device
splat budget from any streamed source: a Streamed SOG (`lod-meta.json`)
manifest, XGRIDS LCC (`.lcc`, manifest v3–v5), `.lcc2`, or Spark `.rad`. Both
modes work on both backends: the WebGL2 fallback's CPU sort worker mirrors the
pool centers and sorts the active spans. shN is dropped on appended ranges
(per-chunk palettes cannot be merged in the shared pool).

The demo consumes the library through the published entries (`src/lib/core/index.ts`
and the optional subpaths) - if the demo needs something those entries do not
export, that is an API design question, not a reason for a deep import. Format
inspection APIs belong on `@voluma/vlam/formats/*`, not the main entry.

Data flow: loader → `SplatData` (positions, colors, covariances, optional SH
palette) → `SplatMesh` packs data textures, draws one instanced quad per
splat → vertex stage projects 3D covariance to a screen ellipse (EWA) →
fragment stage applies the Gaussian falloff, premultiplied-alpha blending.
A sorter rewrites the `splatIndex` buffer back-to-front when the camera
moves. TSL compiles the same shader graph to WGSL (WebGPU) and GLSL
(automatic WebGL2 fallback), one code path, both backends.

## Non-negotiables

1. **License hygiene is load-bearing.** This is an MIT project. Reuse code
 only from MIT/Apache-2.0 sources, with attribution in the README.
 **Never copy code from `graphdeco-inria` repositories** (the 3DGS
 reference implementation and its viewers), it is not licensed for
 commercial use. The math in the papers is free; their code is not.
2. **Do not regress the verified rendering math.** Quads extend to ±3σ and
 the fragment falloff is `exp(-4.5·|q|²)`, the reference-correct
 mapping. (The antimatter15 convention of `sqrt(2λ)` quads with
   `exp(-|q|²)` renders splats visibly too small; we fixed that once.)
   Any change to projection, falloff, or blending requires side-by-side
   visual verification against SuperSplat or another reference viewer.
3. **Keep compute portable.** GPU kernels may rely only on the implicit
   synchronization WebGPU guarantees *between* dispatches, plus
   workgroup-level barriers. No spin-waits, no cross-workgroup ordering
   assumptions, they break on real GPUs (Apple M1 is the classic victim).
4. **Type-check ≠ done.** After every renderer change, load a small scene,
   a PLY scene (parser parity), and the largest scene you have, then look
   at the pixels. Sorting bugs and color-space bugs pass `tsc`.
5. **Keep dependencies minimal.** The published library depends on exactly
   **one** package: `three` (a peer dependency). Demo-only dependencies
   (e.g. `camera-controls`, `@voluma/three-transform-gizmo`) live in
   `devDependencies` and must never be
 imported from `src/lib/`, the demo/lib boundary is the published
 `src/lib` entry modules (`core/index.ts` plus the optional subpaths).
 Adding a library dependency needs a very good reason; prefer the
 platform (e.g. we unzip with ~50 lines and decode WebP with
   `ImageDecoder` instead of shipping libraries).

## Code standards

- TypeScript strict mode with `noUncheckedIndexedAccess`. No `any`; for
  typed-array reads use narrow `as number` casts, and isolate any
  library-typing gap behind one commented cast.
- Files kebab-case, classes PascalCase, functions/variables camelCase.
- Comments explain **why** and state constraints the code cannot show;
  JSDoc on every exported symbol. No "what the next line does" comments.
- Small, single-purpose modules; match the style of neighboring code.
- Workers communicate through exported, typed message interfaces (see
  `core/sort-worker.ts` / `loaders/load-worker.ts`).

Everyone can read this code. Write every line as if it is on the front page
of the repository, because it is. Docs may be lightly playful, but APIs,
error messages, and comments stay strictly professional.

## Domain knowledge (hard-won, do not relearn the hard way)

| Fact | Detail |
| --- | --- |
| PLY vs SOG opacity | PLY stores logits → apply sigmoid. SOG stores linear alpha → use as-is. Mixing these up looks "fine but wrong". |
| Quaternion order | Both formats reconstruct as (w, x, y, z); SOG uses smallest-three with the omitted component's id in alpha − 252. |
| Scene orientation | 3DGS/SOG scenes are y-down; the demo flips those meshes upright with `rotation.x = Math.PI`. `.lcc2` is normalized inside `StreamedSplatMesh.load` to Three.js Y-up (`(x,y,z)→(-x,z,y)`); do not also rotate it in the application. SH is evaluated in mesh-local space, so this stays consistent. |
| TSL typings are stricter than runtime | Use `attribute<'float'>('name', 'float')`, `.toInt()`, `.toMat3()` instead of the loosely-typed constructor forms. `StorageBufferAttribute` wants a typed array in TS, not `(count, itemSize, Type)`. |
| Atomics in TSL | `storage(attr, 'uint', n).toAtomic()`; `atomicAdd(ptr.element(i), v)` returns the old value and can be captured directly. |
| Dynamic dispatch | `renderer.compute(node, dispatchSize)` exists for dynamic counts; kernel `count` is otherwise baked at build time. |
| `splatIndex` is float32 | Exact for indices ≤ 2²⁴ (~16.7M splats). Fine today; revisit for larger scenes. |
| Output color space | Source formats store display-ready sRGB colors; the splat material converts them to the renderer's linear working space in-shader (`colorSpaceToWorking`, see `core/splat-mesh.ts`). The renderer keeps the default `SRGBColorSpace` output, so standard meshes share the canvas untouched. |
| Hidden/embedded previews report 1 FPS | An embedded browser pane often reports `visibilityState: "hidden"`, so rAF is throttled (often fully paused). Drive `splats.update()` + `renderer.render()` manually and time `update()` synchronously; `PerformanceObserver('longtask')` is polluted by background-tab pauses, so it over-reports. |
| One-time WebGPU pipeline compiles | First `renderer.compute` (sort) and first `copyTextureToTexture` (pool upload) each compile a pipeline (~200 ms) on first use. These spikes are one-time, not per-frame, exclude a couple of warm-up frames before measuring steady-state cost. `suggestAdaptivePixelRatio` ignores those frames (warmup + hitch filter) so they do not pin pixel ratio at 1. |
| Sort precision scales with scene size | The GPU sort buckets depth linearly across the whole scene's range, so a big scene gives coarse near-camera buckets → thousands of overlapping splats tie → they reshuffle as the camera moves (popping on grass/foliage). It uses 2²² buckets (sub-splat-width) so ties stay coplanar and invisible. Do NOT switch to a multi-pass LSD radix: the parallel `atomicAdd` scatter is **not** stable, so pass 2 scrambles pass 1's order (only the top bits end up sorted). The CPU worker's sequential scatter *is* stable, so it can and does use a 2-pass 24-bit radix. |
| WebGPU never defaults to the CPU sort worker | Spark matching is load speed and LOD quality. `sortStrategy: 'worker'` on WebGPU is an explicit A/B opt-in (`?sort=worker` in the demo). Do not switch the demo or library default to the worker to "match Spark's lower-frequency sort": at millions of splats that lags hundreds of ms behind the camera. |
| Never assume the initial texture upload covers later writes | The backends upload a `needsUpdate` texture at different moments (WebGL: first render, even with 0 instances). Only constructor-time pool writes may ride the initial upload; every post-construction write must go through the staging-copy flush, or the skipped rows render invisible (a rectangular "hole" of alpha-0 splats). |
| Active-list rebuild is per-frame, not per-op | `appendRange`/`removeRange` only mark the active list dirty; `SplatMesh.update()` rebuilds it once. Rebuilding per op made streaming O(appends × active), a big stall. Keep batch mutations cheap. |
| `lodBaseDistance` is scene-scale-dependent | The default (10, PlayCanvas-compatible) assumes ~unit-scale scenes. SOG scenes can span hundreds of units (log-encoded means), so tune it per scene or expect everything to sit at coarse LODs. |
| splat-transform flag renames | In v3.0.0, `-d/--decimate` is the decimator; `-F` is `--filter-floaters` (older docs disagree). `-F 50%` runs the voxel filter with garbage params and crashes on big scenes (`Set maximum size exceeded`, upstream #275). Coarse-LOD quality comes from `-d`'s moment-matched merging, never build LODs by subsampling. |
| Streaming swaps must be region-atomic | A leaf region's old and new runs must apply in the same tick (group by leaf-interval overlap) or defer together. Removing before the replacement lands = black flicker; letting old+new overlap across ticks = bright flicker. Deferred regions substitute the pinned coarsest level. |
| Two LOD models behind one machinery | Streamed SOG = flat leaves, pick a level per leaf (`LodScheduler`). LCC2 = a cut-based octree where coarse nodes are shared ancestors, per-leaf selection would double-draw, so `OctreeLodSource` picks a valid cut (antichain). Both implement `LodSource` and feed the same `StreamedSplatMesh`; nodes carry leaf intervals over the finest cells so ancestor↔child swaps nest into the region-atomic groups. |
| `StreamedScene.chunkKind` | Streamed SOG chunks are unbundled directories (`'directory'` → `parseSogDirectory`); LCC2 tiles are bundled `.sog` ZIP files (`'file'` → `parseSog`). Wrong kind = every chunk 404s. Coordinate systems: 3DGS/SOG is Y-down, LCC2 is Z-up. The library normalizes both to Y-up by default (`orientation: 'y-up'`): SOG gets a 180°-X flip in `fromSource`; LCC2 applies its `formatTransform` (in both modes, format semantics). `orientation: 'source'` skips the cosmetic SOG flip but keeps LCC2's matrix. |
| `window.__voluma` | Demo-only debug handle: `{ renderer, scene, camera, controls, splats, splatData }`. TS `private` fields are plain runtime props, so `splats.scheduler` / `splats.resident` are reachable for console probes. Never let library code depend on this handle. |

## Verification workflow

1. `npm run build` (demo + library) must pass.
2. `npm run dev`, open `/demo/`, then load **every** scene you have (`?scene=`, or drop the
 file/folder); orbit each one. The
 demo loads a default scene on start; verify at minimum with one small
 scene and with the largest scene you have locally.
3. Repeat renderer-visible checks on the forced WebGL2 fallback
 (`?backend=webgl`), not only on WebGPU.
4. For sorter changes: read back the order buffer with
   `renderer.getArrayBufferAsync(attr)` and assert it is an exact
   permutation with non-decreasing view-space depth (see git history for
   the probe snippet).
5. Performance sanity on a desktop GPU: the 1.9M-splat scene should render
   in single-digit milliseconds per frame with a full GPU re-sort every
   frame; scene loading must not stall the main thread beyond ~0.5 s.

## Where to find work

[`ROADMAP.md`](../ROADMAP.md) is the execution queue (Next → Later →
Blocked). Capability claims live in [`capabilities.md`](capabilities.md).
Doc index: [`README.md`](README.md). Commit, changelog, and pull-request
conventions are in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
