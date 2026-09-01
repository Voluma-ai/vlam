# VLAM! capability matrix

Canonical support matrix for formats and renderer features, kept current with
the tree. For narrative detail see `ROADMAP.md`, format notes under `docs/`,
and [`architecture.md`](architecture.md).

**Legend:** ✅ supported · ⚠️ partial / opt-in · ❌ not supported ·, not applicable

## Formats

| Format | Fully loaded (`loadSplatData` / `SplatMesh`) | Streamed (`StreamedSplatMesh`) | Local folder drop | Pos / Cov / Opacity / Color | SH (rendered) | Auto tests | Manual / device |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **PLY** (3DGS INRIA) | ✅ |, | ✅ file | ✅ | ✅ packed shN (`f_rest_*`, bands 1–3) | `parse-splat-ply.test.ts` | orbit; SH vs DC |
| **Compressed PLY** (SuperSplat) | ✅ |, | ✅ file | ✅ | ✅ packed shN when `sh` element present | `parse-compressed-ply.test.ts` | large capture |
| **SOG** v2 (bundled ZIP) | ✅ |, | ✅ bundled `.sog` file | ✅ | ✅ palette shN | `parse-sog.test.ts` | demo default scene |
| **Streamed SOG** (`lod-meta.json`) |, | ✅ | ✅ directory | ✅ | ⚠️ opt-in `shBands` (re-quantized packed) | `lod-scheduler`, `sog-scene-shn` | `?sh=N` A/B |
| **SPLAT** (antimatter15) | ✅ |, | ✅ file | ✅ | ❌ DC only (32-byte record has no SH) | `parse-splat.test.ts` |, |
| **KSPLAT** | ✅ |, | ✅ file | ✅ | ✅ packed shN (SH degrees 1–2) | `parse-ksplat.test.ts` |, |
| **SPZ** | ✅ |, | ✅ file | ✅ | ✅ packed shN when `shDegree` > 0 (caps at 3 bands) | `parse-spz.test.ts` |, |
| **LCC** (`.lcc` / `meta.lcc`, v3–v5) |, | ✅ | ✅ manifest + siblings | ✅ | ⚠️ `Quality` profile: packed SH (`shBands`); `Portable` DC | `lcc.test.ts`, `parse-lcc.test.ts` | Quality vs Portable |
| **LCC2** (XGRIDS tiles) |, | ✅ | ✅ manifest + `.sog` tiles | ✅ | ⚠️ opt-in `shBands` (palette → packed at decode; verified tiles DC-only) | `lcc2-*` tests | octree LOD orbit |
| **RAD** (Spark `.rad`) | ✅ whole-file ≤ ~16.7M leaves | ✅ prefix or **page-table** foveation | ✅ `.rad` folder (optional `.radc` chunks) | ✅ | ✅ packed SH when capture has `maxSh` | `parse-rad`, `rad-*`, `frontier-pager` | page-table fly-through |

### Format notes

- **Local folder:** self-contained files and streamed manifests (SOG dir, LCC,
 LCC2, `.rad` + `.radc`). Unbundled SOG directory via single `File` alone ❌
 (needs HTTP sibling fetches).
- **Streamed SH:** not LCC-only, opt-in `shBands` on **streamed SOG**, LCC
  `Quality`, **LCC2**, and **`.rad`** (native packed). SOG/LCC2 palette shN is
  re-quantized into the shared pool at decode (`formats/streamed-shn-notes.md`).
- **LCC manifest versions:** `.lcc` / `meta.lcc` v3.x, 4.x and 5.x share one
  binary layout; v3 often omits `fileType` (inferred). See `formats/lcc-notes.md`.
- **RAD paging:** large captures default `foveationMode: 'page-table'`
  (`FrontierPager` + `frontier-worker`). Moderate scenes budget-lift to full
  leaves via prefix `RadLodSource`. History: `history/rad-paging-history.md`.
- **Over 2 GiB PLY:** streamed window decode ✅ (including `f_rest_*` SH).
- **Manual column:** gitignored captures are not named here; use your own local
  fixtures per format notes under `docs/`.

## Renderer & platform

| Capability | WebGPU | WebGL2 | Unified (M15) | Auto tests | Manual / device |
| --- | --- | --- | --- | --- | --- |
| Core splat draw (EWA, ±3σ, premul α) | ✅ | ✅ |, | material tests | demo orbit |
| Depth sort (counting / radix adaptive) | ✅ GPU | ✅ CPU worker | ✅ work-buffer sort | `compute-sorter`, `sort-worker` | `?verifySort=1` |
| Sort within-bucket inversions | ⚠️ expected | ⚠️ radix stable; GPU counting may tie | ⚠️ same | ROADMAP M6 notes | invisible if &lt; bucket width |
| Streamed LOD / budget | ✅ | ✅ | ✅ per-source cut gathered | streamed-splat-mesh.* | `?budget=` |
| Shared budget across meshes (`BudgetGovernor`) | ✅ weighted split via `setBudget`; flat-leaf, octree-cut and RAD page-table paths | ✅ same | ⚠️ per-source meshes registrable | `budget-governor.test.ts` |, |
| Float16 pool textures | ⚠️ opt-in `poolFloatTextures: 'float16'` (centers + covA) | ⚠️ same |, | `half-float`, `splat-mesh.pool` | `?poolFloat=float16` |
| Adaptive pixel ratio | ⚠️ policy `suggestAdaptivePixelRatio`; application applies | ⚠️ same |, | `splat-budget.test.ts` | `?adaptiveDpr=1` |
| Raised WebGPU storage buffer limits | ✅ `createSplatRenderer()`; applications owning device creation pass `recommendedWebGpuRequiredLimits(adapter)` |, | ✅ early throw if pool exceeds device bind limit | `webgpu-limits.test.ts` | large LCC2 / unified capacity >8M |
| `SplatMesh.pick` (GPU depth) | ✅ | ✅ |, | `splat-mesh.pick` | click focus |
| Position queries (`queryNearest`, `queryHeight`) | ✅ | ✅ |, (per-source mesh) | `splat-mesh.query`, `streamed-splat-mesh.query` | M9 |
| Multi-view exact sort (`renderView`) | ✅ | ⚠️ async worker; sequential views | ⚠️ WebGPU: per-view gather+sort | `splat-mesh.render-view` | `?mirror=1` |
| Fully loaded multi-cloud (`MergedSplatMesh`) | ✅ | ✅ inter-sort |, (fast path) | `merged-splat-mesh.test.ts` | overlap readback |
| Heterogeneous `UnifiedSplatMesh` | ✅ | ❌ | ✅ fully loaded + streamed sources | `unified-splat-mesh.test.ts` · `src/viewer/unified-harness.html` | harness + streamed/SH pixel gates |
| `revealPreset` / `wgslFn` effects | ✅ | ❌ | ⚠️ per-source modifiers at gather | `effects.test.ts` | WebGPU only |
| `lightingPreset`, `depthOfFieldPreset`, `worldWarpPreset` | ✅ | ✅ | ⚠️ folded at gather when unified | `effects.test.ts` |, |
| `setRelighting` (proxy-mesh screen-space) | ✅ | ✅ | ✅ draw-time (no gather) | `relighting.test.ts` | `?effects=relight` |
| `SplatMesh.setDepthOfField` (core projected-2D) | ✅ | ✅ | ✅ draw-time (no gather) | `depth-of-field.test.ts` |, |
| Collision mesh (format-provided) | ✅ | ✅ |, | `collision-mesh`, `lcc2-collision`, `parse-collision-lci` | LCC / LCC2 drop |
| Volume selection + separation (M16) | ✅ CPU, backend-independent | ✅ same | ⚠️ halves register as separate sources | `selection-volume`, `splat-partition`, `lcc-collision-partition` | `?separate=1` |
| Orientation normalization (`orientation`) | ✅ | ✅ |, (per-source meshes) | `orientation`, `*.orientation` |, |
| Display-space compositing (`srgbOutput`) | ✅ | ✅ | ✅ must agree across sources | material / unified tests | color A/B |
| WebXR stereo ([`xr.md`](xr.md)) | ✅ | ✅ (the shipping Quest path) | ✅ per-eye viewport, head sort | `xr-view`, `*.xr.test.ts` | headset / Immersive Web Emulator |

### Orientation (`'y-up'` default · `'source'` opt-out)

`SplatMesh` / `StreamedSplatMesh` normalize every known format to three.js
Y-up by default (`orientation: 'y-up'`): OpenCV-frame formats
(PLY / `.splat` / `.ksplat` / SOG / `.rad`) get a 180°-about-X flip, SPZ is
already Y-up, and LCC/LCC2 carry their own Z-up→Y-up matrix. Pass
`orientation: 'source'` to render in the raw data frame, the cosmetic SOG/PLY
flip is skipped, but LCC's matrix still applies (format semantics, not
cosmetics). The correction is a rigid **object-level** transform, never baked
into splat data, so covariances and view-dependent SH stay consistent, and
`pick` / `queryNearest` / `queryHeight` answer in whichever frame the mesh
renders. Applications orienting a dynamic-capacity pool themselves use the exported
`SplatOrientation` / `yUpTransformForFormat` / `createYUpTransform`.

### Color space (`srgbOutput`)

Source formats store display-ready sRGB colors. By default the splat material
converts them to the renderer's linear working space in-shader, so the
renderer keeps its standard `SRGBColorSpace` output and ordinary meshes share
the canvas untouched. `srgbOutput: true` instead composites in display (sRGB)
space, the math 3DGS training optimizes against, and requires a renderer
configured to skip output conversion; the application owns that renderer setting.
`UnifiedSplatMesh` takes one `srgbOutput` at construction and every
registered source must match it.

### Non-uniform scale

Per-axis mesh scaling, `mesh.scale.set(2, 0.5, 1)`, non-uniform scale in an
ancestor, or a non-uniformly scaled per-source transform in a unified pool -
is supported end-to-end (Spark cannot do this by default):

- **Rendering, exact.** The EWA projection folds the *full* linear part of
 the modelView into the screen covariance (`uₐ = Wᵀ·jₐ`, so
  `Σ' = J·W·Σ·Wᵀ·Jᵀ`), which is `A·Σ·Aᵀ` for any linear `A`, non-uniform
  scale and even shear render exactly, including the ±3σ quad extent and
  `exp(−4.5·|q|²)` falloff. The unified gather likewise applies the full
 per-source linear part to Σ.
- **Sorting, exact order; conservative bounds.** Depth is view-space z via
 the modelView, linear in any `A`, so per-splat ordering is unaffected. The
 GPU sorter's depth quantization window uses the exact norm of the modelView
 depth row. Unified source bounds use a conservative matrix-norm bound, so
 both paths remain safe under hierarchy-induced shear.
- **Queries, world-correct.** `queryNearest`/`queryHeight` gather with a
 conservative local radius (`radius / min axis scale`) and rank/judge every
 candidate in **world** space, so the nearest-in-world splat wins and the
 height probe's world −Y contract holds under any rotation + per-axis scale.
- **Picking, exact.** The pick pass renders with the mesh's full
  `matrixWorld`; the depth unproject uses only the (orthonormal) camera.
- **Approximate (documented):** view-dependent SH under a *non-uniformly
  scaled source/mesh* evaluates the view direction through the inverse linear
  part (`A⁻¹·ray`, normalized) rather than a polar-decomposed rotation, exact
  for rotation + uniform scale, a small directional bias under strong
  anisotropy (the DC color term is unaffected). The `.rad` frontier LOD cut
  compares a local-units splat size against view distance, so a scaled mesh
  biases *which LOD level* is selected (rendering of the selected splats stays
  correct). Shear is exact for covariance and sorting, but outside the query
  contract (`getWorldScale` cannot represent it).

**Animated scale cost model.** Scaling never re-bakes splat data: the pool
textures are written in local space and the transform flows through per-frame
matrix uniforms only. Animating `mesh.scale` every frame on a standalone or
streamed mesh costs nothing beyond the sort re-requests the camera already
pays for (a streamed mesh may also re-evaluate its LOD cut, exactly as camera
motion does). In a `UnifiedSplatMesh`, changing a source's transform
invalidates that source's gather slice, so continuously animating it costs
**one gather compute dispatch per frame for that source**, untouched sources
reuse their slices and no gather pipeline is rebuilt. This is the same rule as
the modifier contract: a uniform-style change (matrix, opacity) is cheap and
per-frame safe; only a graph change rebuilds pipelines. Cheap in practice for
standalone/streamed meshes and small unified sources; budget for the
regather when animating a large unified source.

Try it visually with the demo's `?scale=2,0.5,1` query parameter.

## Browser & platform support

VLAM! is WebGPU-first and falls back to WebGL2 automatically through
`THREE.WebGPURenderer`, so the practical question is not "does it run" but
"which backend does it get". The table separates what this project has
**actually run on a device** from what is only *expected* to work from the
backend requirements. Unverified rows are marked as such deliberately, they
are not support claims.

**Legend:** ✅ verified on device by this project · 🔎 expected (backend
requirements met; not exercised here) · ❓ unverified, no device/report

| Platform | Backend | State | Notes |
| --- | --- | --- | --- |
| Chrome / Edge, Windows & Linux desktop | WebGPU | ✅ | Primary development target (M6 sort readbacks). Discrete Windows NVIDIA Ampere classified `gpuClass: 'discrete'` on 2026-08-21; see below. |
| Chrome / Edge desktop, WebGPU disabled or unavailable | WebGL2 | ✅ | Full-path fallback audit (M4.1). Force it in the demo with `?backend=webgl`. |
| Safari, iOS, iPhone 15 Pro | WebGPU | ✅ | Verified during M4.2 / M6.8 (core rendering + `.rad` mobile defaults). |
| Safari, iOS, iPhone 15 (non-Pro) | WebGPU | ❓ | **Open gate, ROADMAP N4.** Same A-series generation as Pro; not separately run. |
| Safari, macOS | WebGPU | ✅ | MacBook Air M3, 8 GB. Classified 2026-08-21 (`mem - desktop integrated`, no `deviceMemory`). Demo SD/HD measured 2026-08-25 in Safari and Chrome; default stays fill-constrained. |
| Chrome, Android, Galaxy S7 (Mali, no WebGPU) | WebGL2 | 🔎 | Smoke only for the no-WebGPU budget tier (ROADMAP N4). Runs, low fps expected. Not a support claim. |
| Chrome, Android, Galaxy S24 Ultra (Adreno 750) | WebGPU | ✅ | 2026-08-25, Chrome 151, public demo `?hud=1&gpuTimestamps=1`. HUD `mem 8 mobile discrete`, native dpr 2.625. Goose HD, streamed Dehaar / sandwijck SD vs HD below. Not a 60 Hz claim on dense scenes. |
| Chrome, Android, other devices | WebGPU / WebGL2 | ❓ | Not exercised by this project. |
| Firefox | WebGPU | ❓ | Firefox's WebGPU rollout status is not tracked by this project and has not been tested here. Where WebGPU is absent, the WebGL2 fallback applies. |
| Firefox | WebGL2 | 🔎 | Nothing in the fallback path is Chromium-specific, but it has not been run here. |
| Any browser without WebGPU **and** without WebGL2 |, | ❌ | Not supported; `WebGPURenderer` has nothing to fall back to. |

**Minimum versions.** This project does not publish a minimum browser version,
because it has not tested a version floor. The real requirement is
transitive: whatever `three`'s `WebGPURenderer` requires for WebGPU, or a
working WebGL2 context for the fallback. Check `three`'s own requirements for
the version you install (`>= 0.185.0` is the peer range).

**What the WebGL2 fallback costs you.** It is a first-class fallback for
standalone rendering, static `SplatMesh`, streamed `StreamedSplatMesh`,
static `MergedSplatMesh` inter-sort, picking, and spatial queries all work, but
not full parity: no heterogeneous `UnifiedSplatMesh`, no `wgslFn`-only
effect presets such as `revealPreset`, multi-view via an async worker sort,
and streamed sorting can flicker under camera motion (ROADMAP L5). The exact
list is the [WebGL2 scope statement](#webgl2-scope-statement) below.

**Mobile caveats.** Mobile devices get different defaults, not a different
code path: `performanceProfile: 'smooth'`, `maxStdDev: 3`, a 1.5 px minimum splat
radius, and a sort-cadence floor (at most 30 sorts/s below 2M active splats)
because a sort's clear and scan passes cost the same at any splat count and
sorting every frame stalls a mobile GPU outright. Streamed `shBands` defaults
to 0 on the `smooth` profile to save bandwidth and memory. Opt-in float16 pool
textures (`poolFloatTextures: 'float16'`) and the adaptive pixel-ratio policy
(`suggestAdaptivePixelRatio`) exist for tighter memory and frame-time budgets.
The **demo** performance mode (default-on on mobile and on `integrated` /
`fallback` desktops) keeps that 3σ cutoff and
turns off renderer MSAA. That is what held 60 Hz on an iPhone 15
Pro during a hard orbit, what a MacBook Air M3 still needs on streamed
million-splat scenes, and what a Galaxy S24 Ultra still needs on the same views
(see below). The library defaults above are unchanged. The HD toggle remains
for A/B. Do not ship HD as the Mac or phone default.
The minimum-radius default is mobile-only: integrated or fallback desktops may
still select the broader `smooth` fill policy, but retain a `0` px floor.

**Desktop GPU class, Windows discrete (2026-08-21).** WebGPU `adapter.info`
on this machine reported `vendor: nvidia`, `architecture: ampere`, and
`isFallbackAdapter: false`. Both `low-power` and `high-performance` preferences
returned that adapter, so `probeSplatGpuClass` selects `discrete`. With
8 GiB `deviceMemory` that is the 8M sampled budget, `recommendedMaxPixelRatio`
2, and `minSplatSizePx` 0. Confirmed on `goose.sog` (149,120 splats, WebGPU).
This is classification, not a fill-rate claim.

**Desktop GPU class, Apple Silicon (2026-08-21).** MacBook Air M3, Safari
WebGPU, public demo `?hud=1`: HUD `mem - desktop integrated`. Safari omits
`deviceMemory`. Chrome on the same machine reported 8 GiB `deviceMemory` and
WebGPU; that 8 GiB must not select the discrete 8M path, and the Safari HUD
confirms `integrated`. `minSplatSizePx` stays 0. Goose HUD `N / N` is the
loaded count, not the 2M integrated ceiling.

**Apple Silicon demo default (2026-08-25).** Same Air, 8 GB unified, Chrome and
Safari WebGPU, window often `native` dpr 1. Demo performance mode stays
**on** for every `isFillConstrainedSplatDevice`, including Apple vendor.
Goose (`goose.sog`, 149,120) looks fine in SD: Chrome ~14 ms GPU / 60 rAF at
dpr 1 and MSAA off; Safari ~4–6 ms GPU. Chrome HD (dpr 1.5, MSAA 4) still
holds 60 at ~21 ms GPU. Safari HD with adaptive pinned off is ~38 ms GPU at
the same 1.5 / 4×. That extra cost does not fix a visible SD problem on
goose.

Streamed million-splat views are already fill-bound in SD. Dehaar `.lcc2`
(~1M): Chrome SD holds 60 at ~18 ms GPU; Safari SD is ~58 rAF mean with a
~55 ms p99. HD at dpr 1 plus MSAA 4 is ~64 ms GPU in Chrome and ~183 ms in
Safari. `sandwijck-lod` streamed SOG (~900k): SD already ~45 rAF Chrome /
~40 Safari; HD MSAA is ~169 ms / ~216 ms GPU. RAD `A-lod0` canopy (~1M): SD
~29 fps, HD at dpr 1.5 ~10 fps (~114 ms render). Safari's streamed chunk
cache was 128 MiB (often FULL) against Chrome's 256 MiB, which shows as
holes, not as a reason to raise the quality preset.

A Mac-only HD default would help goose a little and break the scenes people
actually open on a laptop. Galaxy S24 Ultra Chrome agrees: keep the phone on SD.
Intel/AMD iGPUs are still unmeasured. Library `resolveSplatBudget` stays on
the 2M sampled / 1M LCC integrated caps. `vlam:performance-mode-v2` does not
need a bump. M2 Pro was on hand and was not re-run; the 8 GB Air is the
tighter machine.

**Galaxy S24 Ultra, Chrome 151 WebGPU (2026-08-25).** Public demo, portrait,
`?hud=1&gpuTimestamps=1`. HUD `Chrome 151  mem 8  mobile discrete`, native
dpr 2.625, drawing buffer 411×783 at dpr 1. Chrome privacy-caps
`deviceMemory` at 8, so extra Ultra RAM is invisible to
`resolveSplatBudget`. Snapdragon Adreno 750 has no Apple/Intel/AMD cue, so
`classifySplatGpuClass` returns `discrete`. `isMobile` still selects the
phone caps (1M sampled, 600k LCC) and fill-constrained SD. Do not read
`discrete` as the 8M workstation path.

Goose (`goose.sog`, 149,120), SD (`msaa off`, 3σ, `smooth`): 60 rAF (16.6
ms), GPU render 9.59 ms, compute 3.21 ms, CPU submit 1.5 ms, sort 28.6 Hz.
p99 60 fps, frame p95 16.7 / p99 16.8 ms, missed 0, worst frame 17 ms.
Same scene in HD (`msaa 4`, 4σ, `quality`, adaptive dpr): ~58 rAF (17.3
ms), GPU render 14.48 ms, compute 1.15 ms, CPU submit 3.4 ms. p99 30 fps,
frame p95 16.7 / p99 33.3 ms, 23 missed, worst frame 216 ms (window hitch).
Adaptive DPR already floored HD to 1. Sparse SD is locked vsync. HD still
holds the mean and spends ~5 ms of GPU on MSAA. That extra cost does not
fix goose, and it is what breaks Dehaar / sandwijck.

Dehaar `.lcc2`, SD (`msaa off`, 3σ, `smooth`), first shot (other Chrome tabs
open): ~48 rAF mean (20.9 ms), GPU render 21.02 ms, compute 6.52 ms, CPU
submit 1.0 ms, sort 21.9 Hz. p99 8 fps, frame p95 33.4 / p99 133.1 ms, 101
missed. Resident ~609k / 600k (small overshoot), 8 chunks, cache 141/256 MiB,
~4.8k holes. Same scene in HD: ~26 rAF (38.5 ms), GPU render 27.36 ms, p99
7 fps, 786 missed, cache 250/256 FULL, 13 chunks. Budget does not change
(already the LCC phone ceiling). HD's tax is MSAA and 4σ. Adaptive DPR had
already floored HD to dpr 1.

Follow-up, one Chrome tab, cinematic orbit ≥5 s, still `Streaming 1 chunk`:
~54 rAF (18.6 ms), GPU render 13.97 ms, compute 5.65 ms, CPU submit 2.1 ms.
p99 20 fps, frame p95 33.3 / p99 50.0 ms, 72 missed, worst frame 67 ms. HUD
~318k / 600k, footer ~495k, 11 chunks, cache 209/256. Closing extra tabs
cuts the hitch tail. The GPU drop is mostly a lighter cut, not a faster
600k view. Compare against the 609k shot, not this one, when judging the
phone ceiling.

`sandwijck-lod` streamed SOG, SD, still streaming after the same 5 s orbit
(197k holes, pill on): ~35 rAF (28.5 ms), GPU render 24.38 ms, compute
8.72 ms, CPU submit 10.4 ms, 895k / 1M, 7 chunks. Earlier SD mid-stream at
827k was 16.56 ms GPU / 19.1 ms CPU submit. Filling toward the 1M sampled
cap makes GPU worse; 5 s of orbit does not finish the stream. HD mid-stream
was GPU-bound instead: ~17 rAF, GPU render 61.47 ms at 482k / 1M. Do not
treat any sandwijck shot as a thermal soak.

Keep the mobile SD default. Do not raise `MOBILE_BUDGETS`. Remaining
protocol: `?pixelRatio=` steps, `?minSplatPx=`, ten-minute soak, landscape.
iPhone 15 non-Pro is still open.

**Recording a mobile device check.** Open `?hud=1` in a single foreground tab
so the perf HUD paints (a background tab reports `1 rAF` and empty HUD; extra
Chrome tabs on Android inflate p99). Wait until the Streaming pill is gone
before calling the sample steady; five seconds of cinematic orbit is not
enough on sandwijck. Copy
browser, OS, GPU / `gpuClass`, backend, dataset, splat count, and HUD FPS.
For a repeatable orbit, write median / p95 / p99 frame times plus missed
16.6 ms and 33.3 ms deadlines. A/B coverage with `?adaptiveDpr=0` and
`?pixelRatio=1`, then `0.9`, then `0.8`, before raising `maxStdDev`. A/B the
splat floor with `?minSplatPx=1.5` against `?minSplatPx=3.5` (3.5 px is the
blobby zoomed-out reference). Run a ten-minute thermal soak on one sparse
and one dense capture. Check portrait and landscape for gaps, discs, and
LOD popping. An iPhone 15 Pro or Galaxy S24 Ultra run does not close the
non-Pro 15 row.

## Sorting semantics (documented threshold)

The GPU **counting sort** buckets view-space depth linearly across the scene
range (2²² buckets on WebGPU; adaptive floor on large scenes). Splats whose
depths fall in the **same bucket** may appear in either order; inversions
within one bucket width are **acceptable**, those splats are coplanar to well
under a pixel and should not pop. The invariant that matters is an **exact
permutation** (no duplicates, no missing indices). Measured: largest depth
inversion magnitude bounded by one bucket width.

CPU **worker radix** (WebGL2) uses stable sequential scatter, exact
back-to-front order for its bit depth.

**Multi-view:** each `renderView` re-sorts for that camera (WebGPU synchronous
compute queue). Exact per-view permutation verified; primary camera re-sorts
after secondary views.

## WebGL2 scope statement

WebGL2 is a **first-class fallback for standalone rendering**: static
`SplatMesh`, streamed `StreamedSplatMesh`, static `MergedSplatMesh` multi-cloud
inter-sort, picking, and position queries. It is **not** full feature parity:

- No heterogeneous `UnifiedSplatMesh` (no CPU gather implementation).
 Gate with `supportsUnifiedSplatMesh(renderer)`, it answers `false` on
 WebGL2 and before the backend is initialized, so check it after renderer
 init and fall back to standalone meshes / static `MergedSplatMesh`.
- No `revealPreset` / other `wgslFn`-only presets.
- Multi-view uses async worker sort between sequential draws.
- Streamed LCC / Streamed SOG / RAD: CPU worker sort can flicker under camera
 motion (ROADMAP **L5**). WebGPU sorting is the supported path for those
 formats until the fallback is polished.

Force with `?backend=webgl` in the demo.

## WebGPU storage-buffer limits

WebGPU's default `maxStorageBufferBindingSize` is **128 MiB**. Unified work
buffers allocate an RGBA32F centers storage attribute at **16 B/splat**, so
capacities above ~8M exceed the default. Desktop adapters commonly advertise
~2 GiB. `createSplatRenderer()` requests them (along with the adapter's
features, which is what keeps the device out of compatibility mode); applications that
own device creation themselves pass `recommendedWebGpuRequiredLimits(adapter)`
to `WebGPURenderer` instead.
`UnifiedSplatMesh` throws a clear error when the device limit is too low
instead of cascading `GPUValidationError`s from `CreateBindGroup`.

## SH rendering summary

| Path | SH in file | SH on screen |
| --- | --- | --- |
| Static SOG (palette) | `sh` + codebook | ✅ |
| Static PLY / compressed PLY / KSPLAT / SPZ | `shPacked` | ✅ when source carries SH |
| Dynamic / streamed pool | packed or re-quantized palette | ✅ when `shBands` > 0 |
| `.rad` streamed | packed per splat | ✅ when capture has SH |

## See also

- [Format notes](formats/) for byte layouts and interoperability constraints.
- [User guides](guide/README.md) for supported integration patterns.
- [XR](xr.md) for WebXR limits and tuning.
- [Architecture](architecture.md) for renderer invariants.
