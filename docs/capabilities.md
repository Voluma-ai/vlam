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
| **Streamed SOG** (`lod-meta.json`) |, | ✅ | ✅ directory | ✅ | ✅ peek `meta.json` `shN` (re-quantized packed; off on `smooth`) | `lod-scheduler`, `sog-scene-shn`, `peek-sog-sh` | `?sh=0` vs `?sh=N` |
| **SPLAT** (antimatter15) | ✅ |, | ✅ file | ✅ | ❌ DC only (32-byte record has no SH) | `parse-splat.test.ts` |, |
| **KSPLAT** | ✅ |, | ✅ file | ✅ | ✅ packed shN (SH degrees 1–2) | `parse-ksplat.test.ts` |, |
| **SPZ** | ✅ |, | ✅ file | ✅ | ✅ packed shN when `shDegree` > 0 (caps at 3 bands) | `parse-spz.test.ts` |, |
| **LCC** (`.lcc` / `meta.lcc`, v3–v5) |, | ✅ | ✅ manifest + siblings | ✅ | ⚠️ `Quality` profile: packed SH (`shBands`); `Portable` DC | `lcc.test.ts`, `parse-lcc.test.ts` | Quality vs Portable |
| **LCC2** (XGRIDS tiles) |, | ✅ | ✅ manifest + `.sog` tiles | ✅ | ✅ peek tile `meta.json` `shN` (palette → packed; off on `smooth`) | `lcc2-*`, `peek-sog-sh` | Tempel SH0/SH3 octree orbit (Chrome/Windows, WebGPU + WebGL2) |
| **RAD** (Spark `.rad`) | ✅ whole-file ≤ ~16.7M leaves | ✅ prefix or **page-table** foveation | ✅ `.rad` folder (optional `.radc` chunks) | ✅ | ✅ packed SH when capture has `maxSh` | `parse-rad`, `rad-*`, `frontier-pager` | page-table fly-through |

### Format notes

- **Local folder:** self-contained files and streamed manifests (SOG dir, LCC,
 LCC2, `.rad` + `.radc`). Unbundled SOG directory via single `File` alone ❌
 (needs HTTP sibling fetches).
- **Streamed SH:** not LCC-only. Unset `shBands` means every band the capture
  carries on **streamed SOG**, LCC `Quality`, **LCC2**, and **`.rad`**, declined
  on the `smooth` profile. SOG/LCC2 peek one tile's `meta.json` because those
  manifests omit `shN`; palette shN is re-quantized into the shared pool at
  decode ([streamed SH notes](formats/streamed-shn-notes.md)).
- **LCC manifest versions:** `.lcc` / `meta.lcc` v3.x, 4.x and 5.x share one
  binary layout; v3 often omits `fileType` (inferred). See `formats/lcc-notes.md`.
- **RAD paging:** large captures default `foveationMode: 'page-table'`
  (`FrontierPager` + `frontier-worker`). Moderate scenes budget-lift to full
  leaves via prefix `RadLodSource`. History: `history/rad-paging-history.md`.
- **Over 2 GiB PLY:** streamed window decode ✅ (including `f_rest_*` SH).
- **Manual column:** gitignored captures are not named here; use your own local
  fixtures per format notes under `docs/`.

## Renderer & platform

| Capability | WebGPU | WebGL2 | Unified | Auto tests | Manual / device |
| --- | --- | --- | --- | --- | --- |
| Core splat draw (EWA, ±3σ, premul α) | ✅ | ✅ |, | material tests | demo orbit |
| Depth sort (counting / radix adaptive) | ✅ GPU | ✅ CPU worker | ✅ work-buffer sort | `compute-sorter`, `sort-worker` | `?verifySort=1` |
| Compute projection + cull before sort | ⚠️ `computeProjection({ mode: 'auto' })` selects the measured large static SH discrete-GPU cohort once; `computeProjection()` remains experimental | ✅ deliberate vertex fallback | ⚠️ opt-in after gather | `projection/compute`, `projected-splat-pipeline`, `*.xr.test.ts` | `?projectionStrategy=auto`; Langenthal-Manola4A harness |
| Sort within-bucket inversions | ⚠️ expected | ⚠️ radix stable; GPU counting may tie | ⚠️ same | sorter tests | invisible if &lt; bucket width |
| Streamed LOD / budget | ✅ | ✅ | ✅ per-source cut gathered | streamed-splat-mesh.* | `?budget=` |
| Shared budget across meshes (`BudgetGovernor`) | ✅ weighted split via `setBudget`; flat-leaf, octree-cut and RAD page-table paths | ✅ same | ⚠️ per-source meshes registrable | `budget-governor.test.ts` | 3× Hotel RAD camera A/B (Chrome/macOS WebGPU) |
| Float16 pool textures | ⚠️ opt-in `poolFloatTextures: 'float16'` (centers + covA) | ⚠️ same |, | `half-float`, `splat-mesh.pool` | `?poolFloat=float16` |
| Render-only CPU storage | ⚠️ opt-in static own-pool `storageMode: 'render-only'` | ❌ CPU worker needs backing | ❌ source lifetime can require direct-draw mirrors | `splat-mesh.render-only`, memory browser test | RTX 3090: Goose, 8.72M SH3 SOG, 1M SH3 PLY (2026-09-10) |
| Adaptive pixel ratio | ⚠️ policy `suggestAdaptivePixelRatio`; application applies | ⚠️ same |, | `splat-budget.test.ts` | `?adaptiveDpr=1` |
| Raised WebGPU storage buffer limits | ✅ `createWebGPURenderer()`; applications owning device creation pass `recommendedWebGpuRequiredLimits(adapter)` |, | ✅ early throw if pool exceeds device bind limit | `webgpu-limits.test.ts` | large LCC2 / unified capacity >8M |
| `SplatMesh.pick` / `pickMany` (GPU depth) | ✅ | ✅ |, | `splat-mesh.pick` | click focus / continuous paint |
| Surface-aware brush selection | ✅ CPU reference; surface/through × center/±3σ footprint | ✅ same | ✅ classic streamed and RAD page-table LOD replay geometry | `brush-stroke`, streamed channel tests | thin edges, anisotropic grazing, large RAD replacement |
| Position queries (`queryNearest`, `queryHeight`) | ✅ | ✅ |, (per-source mesh) | `splat-mesh.query`, `streamed-splat-mesh.query` | query harness |
| Multi-view exact sort (`renderView`) | ✅ | ⚠️ async worker; sequential views | ⚠️ WebGPU: per-view gather+sort | `splat-mesh.render-view` | `?mirror=1` |
| Fully loaded multi-cloud (`MergedSplatMesh`) | ✅ | ✅ inter-sort |, (fast path) | `merged-splat-mesh.test.ts` | overlap readback |
| Heterogeneous `UnifiedSplatMesh` | ✅ | ❌ | ✅ fully loaded + streamed sources | `unified-splat-mesh.test.ts` · `src/viewer/unified-harness.html` | harness + streamed/SH pixel gates |
| `revealPreset` / `wgslFn` effects | ✅ | ❌ | ⚠️ per-source modifiers at gather | `effects.test.ts` | WebGPU only |
| `lightingPreset`, `depthOfFieldPreset`, `worldWarpPreset` | ✅ | ✅ | ⚠️ folded at gather when unified | `effects.test.ts` |, |
| `/relighting` proxy screen-space attachment | ✅ | ✅ | ✅ draw-time (no gather) | `relighting.test.ts` | runnable relight example |
| `SplatMesh.setDepthOfField` (core projected-2D) | ✅ | ✅ | ✅ draw-time (no gather) | `depth-of-field.test.ts` |, |
| Collision mesh (format-provided) | ✅ | ✅ |, | `collision-mesh`, `lcc2-collision`, `parse-collision-lci` | LCC / LCC2 drop |
| Volume selection + separation | ✅ CPU, backend-independent | ✅ same | ⚠️ halves register as separate sources | `selection-volume`, `splat-partition`, `lcc-collision-partition` | `?separate=1` |
| Orientation normalization (`orientation`) | ✅ | ✅ | N/A (per-source meshes) | `orientation`, `*.orientation` | manual capture pending |
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
| Chrome / Edge, Windows & Linux desktop | WebGPU | ✅ | Primary development target. Discrete Windows NVIDIA Ampere is classified `gpuClass: 'discrete'`; see below. |
| Chrome / Edge desktop, WebGPU disabled or unavailable | WebGL2 | ✅ | Full-path fallback. Force it in the demo with `?backend=webgl`. |
| Safari, iOS, iPhone 15 Pro | WebGPU | ✅ | Core rendering and `.rad` mobile defaults are verified. |
| Safari, iOS, iPhone 15 (non-Pro) | WebGPU | ✅ | 2026-09-23, iOS 26.6.2. Viewport 393×852 at 3×, adapter `apple / apple / apple`, classified `mobile integrated`. Goose holds 60 Hz; Tempel and hotel below. |
| Safari, macOS | WebGPU | ✅ | MacBook Air M3, 8 GB. Classified 2026-08-21 (`mem - desktop integrated`, no `deviceMemory`). Demo SD/HD measured 2026-08-25 in Safari and Chrome; default stays fill-constrained. |
| Chrome, Android, Galaxy S7 (Mali, no WebGPU) | WebGL2 | 🔎 | Smoke only for the no-WebGPU budget tier. Runs, low fps expected. Not a support claim. |
| Chrome, Android, Galaxy S24 Ultra (Adreno 750) | WebGPU | ✅ | 2026-08-25, Chrome 151, public demo `?hud=1&gpuTimestamps=1`. HUD `mem 8 mobile discrete`, native dpr 2.625. Goose HD, streamed Dehaar / sandwijck SD vs HD below. Not a 60 Hz claim on dense scenes. |
| Chrome, Android, Pixel 8a (Mali-G715) | WebGPU / WebGL2 | ✅ | 2026-09-15, Chrome 152 on Android 16/API 36, adapter `arm / valhall`. Three-repeat Goose/Kauz static matrix, main-viewer Tempel/hotel defaults, portrait/landscape DPR and coverage A/B, startup probes, and ten-minute Goose/Tempel thermal soaks. Device-neutral instrumentation and the predecessor adaptive controller were exercised on this Mali device; no global candidate promoted. |
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
effect presets such as `revealPreset` and synchronous per-view ordering. Its
async worker sort deliberately delays a changed stream until a full snapshot
can publish; it retains the previous complete scene rather than flickering.
The exact list is the [WebGL2 scope statement](#webgl2-scope-statement) below.

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

### Apple Silicon GPU tiers (design, not shipped)

**Problem.** `classifySplatGpuClass` maps every Apple vendor string to
`integrated`. That is correct for unified memory, but it also folds a MacBook
Air M3 and a MacBook Pro M5 Max into the same fill-constrained policy: demo SD
on by default, integrated budgets (~1M LCC / RAD, ~2M sampled SOG), and
adaptive DPR that only fights for headroom *below* dpr 1. Air measurements
justify that path. Public M5 Max positioning (high-end Pro GPU, large unified
memory, multi-display) does not: that machine is underserved by Air defaults,
not missing an M5-specific shader.

**Do not** flip all Apple Silicon to HD or to the discrete 8M path from
marketing specs alone. An Air-class default that protects phones and thin
laptops must stay until a Max (or Pro) headed matrix says otherwise.

**Goals.**

1. Keep Air / base M-series on today's fill-constrained defaults.
2. Let Pro / Max-class Macs take a higher quality ceiling (HD-leaning demo
   defaults, larger budgets, adaptive DPR that can rise toward 1.5) without
   inventing a fake `discrete` GPU.
3. Remain safe when WebGPU only exposes `vendor: apple` and Safari omits
   `deviceMemory`.

**Proposed signals (prefer in this order).**

| Signal | Use | Caveat |
| --- | --- | --- |
| Host / URL override (`deviceProfile.gpuClass`, demo `?gpuClass=`) | Force `integrated` or a future Apple tier for A/B and embedders that know the SKU | Must stay explicit; never infer Max from user agent alone |
| `navigator.deviceMemory` when present | Soft hint only (e.g. ≥16 GiB → candidate for a higher Apple tier) | Chrome often privacy-caps at 8; Safari macOS often omits it entirely |
| `adapter.info` architecture / device strings | If browsers ever distinguish base vs Pro/Max | Today often blank or generic `apple` |
| Adapter limits (`maxBufferSize`, storage binding sizes) | Optional capability score as a last resort | Correlates loosely with class; needs calibration on real devices |

**Proposed tiers (names illustrative).**

| Tier | Who | Policy sketch |
| --- | --- | --- |
| `apple-integrated` (today's `integrated`) | Air, base M-series, unknown Apple | SD default; adaptive DPR floor 0.8 / ceiling 1 under SD; 1M LCC / 2M sampled |
| `apple-pro` (new) | Pro / Max class once validated | Prefer HD-leaning or SD-off default; adaptive between 1 and `recommendedMaxPixelRatio` (1.5); budgets between integrated and discrete, raised only after hotel-orbit / streamed measures |
| `discrete` | Unchanged (NVIDIA / AMD / Arc) | Current workstation path |

Until `apple-pro` exists in code, Max owners can A/B with performance mode off
and pinned `?budget=` / `?pixelRatio=` / `?adaptiveDpr=1`; library hosts can
pass an explicit `deviceProfile`.

**Validation gate before shipping a higher Apple tier.** Same hotel-core
Veersetoren orbit used on the M3 Air (dense XZ pivot, not the outlier
cinematic shell), Chrome and Safari WebGPU, SD vs HD, adaptive on/off,
`?hud=1&gpuTimestamps=1`. Record browser, macOS, chip marketing name if known,
`gpuClass`, memory signal, active splat count, median / p95 / p99, observed
callback cadence, supplied display refresh interval, missed refresh opportunities,
and the literal >33.33 ms threshold count. M3 Air results do not close an M5 Max row (see also
[render benchmark](render-benchmark.md)).

**Implementation order.** Document here → unit-test classification hooks and
host overrides → headed Max matrix → only then change demo / budget defaults.
RAD swap-upload cost and Air adaptive behavior remain separate work; they help
every Mac tier.

**Galaxy S24 Ultra, Chrome 151 WebGPU (2026-08-25).** Public demo, portrait,
`?hud=1&gpuTimestamps=1`. HUD `Chrome 151  mem 8  mobile discrete`, native
dpr 2.625, drawing buffer 411×783 at dpr 1. Chrome privacy-caps
`deviceMemory` at 8, so extra Ultra RAM is invisible to
`resolveSplatBudget`. Snapdragon Adreno 750 has no Apple/Intel/AMD cue, so
`classifySplatGpuClass` returns `discrete`. `isMobile` still selects the
phone caps (1M sampled, 750k LCC) and fill-constrained SD. Do not read
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

Keep the mobile SD default. Do not raise `MOBILE_BUDGETS`. The non-Pro
iPhone 15 run of the pixel-ratio steps, splat-floor A/B, landscape check, and
ten-minute soak is below.

**Pixel 8a, Chrome 152 WebGPU/WebGL2 (2026-09-15).** The connected Pixel 8a
reported Android 16/API 36, 1080×2400 at 420 dpi, USB power, battery saver off,
and an active 60 Hz mode. WebGPU exposed `vendor: arm`, `architecture: valhall`
with no device string; Chrome exposed 8 GiB and the viewer classified it as
`mobile discrete`. The rerun used one foreground Chrome tab, fixed
`refreshHz=60`, SD (`smooth`, 3σ, MSAA off), initial loading settled, manual benchmark
start, 10 seconds of warm-up, and 60 seconds of sampling. Settings were restored
to automatic brightness, portrait, 60 Hz, and battery saver off.

| Scene / backend / motion | Splats | Frame median / p95 / p99 | Result |
| --- | ---: | ---: | --- |
| Goose / WebGPU / stationary | 149,120 | 16.8 / 16.9 / 16.9 ms | Nonblank, 3 runs |
| Goose / WebGPU / orbit | 149,120 | 16.8 / 16.9 / 17.0 ms | Nonblank, 3 runs |
| Goose / WebGL2 / stationary | 149,120 | 16.8 / 16.9 / 16.9 ms | Nonblank, 3 runs |
| Goose / WebGL2 / orbit | 149,120 | 16.8 / 16.9 / 16.9 ms | Nonblank, 3 runs |
| Kauz SH2 source, rendered SH0 / WebGPU / orbit | 1,827,467 | 50.2 / 67.1 / 83.8 ms | Nonblank, 3 runs |
| Kauz SH2 source, rendered SH0 / WebGL2 / orbit | 1,827,467 | 50.3 / 67.1 / 83.7 ms | Nonblank, 3 runs |

**Foreground 60-second adaptive/pinned measurements.** All runs used fixed
`refreshHz=60`, SD/smooth/3σ, MSAA off, and an orbiting streamed workload after
initial loading settled. Values below are
median / p95 / p99; normalized refresh source was `provided` in every run.

| Scene / mode | Final DPR | Median / p95 / p99 | Result |
| --- | ---: | ---: | --- |
| Goose / WebGPU / adaptive (3 runs) | 1.0, 1.0, 1.0 at report | 16.8 / 16.9 / 16.9–17.0 ms | One run spent about 27.5 s at DPR 0.8; a later HUD capture also reached 0.8 |
| Goose / WebGPU / pinned 0.8 (3 runs) | 0.8 | 16.8 / 16.9 / 16.9 ms | Control |
| Goose / WebGPU / pinned 1.0 (3 runs) | 1.0 | 16.8 / 16.9 / 16.9 ms | Control |
| Tempel / WebGPU / adaptive (3 runs) | 0.8 | 16.8 / 33.6 / 33.7–50.2 ms | Failed probes obeyed the 30 s active-time backoff during active streaming |
| Tempel / WebGPU / pinned 0.8 (3 runs) | 0.8 | 16.8 / 33.6–33.7 / 33.8–50.3 ms | Control |
| Tempel / WebGPU / pinned 1.0 (3 runs) | 1.0 | 16.8 / 33.6–33.7 / 33.7–33.8 ms | Control; dense callback cadence remains visible |
| Goose / WebGL2 / adaptive (1 smoke) | 1.0 | 16.8 / 16.9 / 16.9 ms | Nonblank; no transition |

All adaptive and pinned outputs reported display refresh source `provided`,
display interval 16.7 ms, and callback p10 about 16.7 ms. Their aggregate frame
times stayed within 5%, but the Tempel runs contained 181–263 swap frames and
4.3–6.6 million staged uploads, so they are streaming-orbit measurements rather
than settled-residency comparisons. The captures motivated a 250 ms continuous-
pressure dwell to protect Goose quality; that revision has not been rerun on the
Pixel. Probe retries in the captured predecessor were separated by active-time
backoff rather than rapid oscillation.

The earlier main-viewer product-default captures were Goose 149,120 splats at
16.8 / 16.9 / 17.0 ms, Tempel LCC2 596,842 residents at 16.8 / 33.7 / 33.7
ms, and hotel RAD 320,336 residents at 16.8 / 16.9 / 33.5 ms. Their JSON
predates the corrected refresh-normalized fields; the literal >33.33 ms
counts remain threshold counts only. Tempel's tails aligned with staged
uploads and compaction; hotel remained page-table CPU-bound while its settled
view stayed near 60 Hz.

The landscape Tempel DPR A/B, minimum-splat-size A/B, and swap-cap A/B are
diagnostic only: resident counts differed, streaming was active, and the DPR
and minimum-size conditions were not each repeated three times. The observed
landscape DPR p95 was 33.6 ms for 1.0, 0.9, and 0.8; p99 was 33.7, 33.7, and
50.3 ms respectively. The 1.5 px coverage floor was nonblank; 3.5 px reduced
the captured resident cut from 570,509 to 492,613 and worsened p95/p99 from
33.7/50.4 to 51.8/84.0 ms. Halving the classic Tempel swap cap from 32k to
16k left p95/p99 unchanged at 33.6/33.7 ms, reduced the settled cut to 497,208,
and produced 84–185 ms outliers. None justifies a global default change.

The budget-controller run was not promotion evidence: Chrome kept the budget
tab in the background and reported a 1 rAF / ~1008 ms cadence, so the run was
stopped rather than used to justify a governor. Contribution culling, float16
pool textures, and compute projection remain opt-in; the browser suite covers
their behavior, but no valid Pixel cross-scene performance gate promoted them.

The scene reset, timing instrumentation, and adaptive controller are
device-neutral viewer behavior. The timing changes and predecessor controller
were exercised on Mali-G715; the continuous-pressure revision still needs a
device rerun. Broad Android performance claims remain pending a repeat on the
Adreno Galaxy S24 Ultra. The Galaxy S7 remains a WebGL2 correctness smoke test,
not a performance target.

Startup probes (`startupMetrics=1&uaMemory=0`) reached first usable Goose in
0.98–1.34 s and Tempel in 3.53–3.72 s across three runs. Accounted mesh memory
was 20.85 MiB for Goose and 123.21 MiB plus 37.64 MiB streamed cache for
Tempel. The hotel memory probe timed out at a 30,567-splat coarse cut without
a nonblank pixel and is diagnostic only.

Ten-minute thermal samples stayed at 100% battery. Goose battery temperature
was 39.0 °C in the first minute and 38.0 °C in the last (39.1 °C maximum);
Tempel was 38.0 °C and 40.5 °C (40.5 °C maximum), with virtual skin averaging
39.9→43.3 °C. No crash or device loss occurred; the final Android thermal
status was moderate (2), not severe. The high-refresh diagnostic could not
leave the active display mode because the Pixel service kept the requested
display at 60 Hz.

Raw JSON, screenshots, logs, thermal samples, and controllers (including the
generalized foreground matrix) are in the ignored
`.tmp/android-pixel-8a/20260915-144500/` directory. This validates the
Android gate only. It does not generalize the result to Android GPUs beyond
this Mali device.

**iPhone 15 non-Pro, Safari WebGPU (2026-09-23).** iOS 26.6.2, one foreground
Safari tab, local demo over HTTPS. The logical screen is 393×852 at
`devicePixelRatio` 3, which is also the iPhone 15 Pro size. The handset was
identified as the non-Pro 15. WebGPU adapter info was `vendor: apple`,
`architecture: apple`, `device: apple`, with no `deviceMemory`. The viewer
classified it `mobile integrated`. The page was a secure context and
`navigator.gpu` was present. Safari omitted `screen.refreshRate`, so every
timed run supplied `refreshHz=60`. Callback p10 on the Goose runs was 16 ms
against a supplied 16.67 ms display interval (`refreshSource: provided`).
Runs used `?hud=1`, manual benchmark start after the scene settled, SD
(`smooth`, 3σ, MSAA off), and `?orbit=0` so the sample motion is the
benchmark rotate. The portrait drawing buffer at pixel ratio 1 was 393×695,
inside Safari chrome on the 393×852 screen. GPU sort checks passed on every
WebGPU run (`sortok`). No global default change.

| Scene / backend / motion | Splats | Frame median / p95 / p99 | Result |
| --- | ---: | ---: | --- |
| Goose / WebGPU / stationary | 149,120 | 17.0 / 17.0 / 17.0 ms | 3 runs, pixel ratio 1, missed 1 / 0 / 0 |
| Goose / WebGPU / orbit | 149,120 | 17.0 / 17.0 / 17.0 ms | 3 runs, pixel ratio 1, missed 1 / 0 / 1 |
| Goose / WebGL2 / stationary | 149,120 | 17.0 / 17.0 / 17.0 ms | 1 smoke run, missed 2. No GPU sort check |
| Tempel / WebGPU / orbit, portrait | 752,694 | 17.0 / 17.0 / 24.0 ms | 1 run, pixel ratio 1, missed 50, 11 frames >33.33 ms |
| Hotel RAD / WebGPU / orbit, portrait | 262,240 | 17.0 / 51.0 / 86.0 ms | 1 run, pixel ratio 0.8, missed 666, 221 frames >33.33 ms |
| Tempel / WebGPU / orbit, landscape | 752,694 | 17.0 / 18.0 / 45.0 ms | 1 run, pixel ratio 0.8, buffer 587×263, missed 311, 47 frames >33.33 ms |

Goose pixel-ratio pins (`adaptiveDpr=0`) stayed on the 17 ms median: 1.0 was
17.0 / 17.0 / 17.0 ms, 0.9 was 17.0 / 17.0 / 18.0 ms (25 missed, 6 frames
>33.33 ms), and 0.8 was 17.0 / 17.0 / 18.0 ms. The 1.5 px and 3.5 px splat
floors on static Goose both kept all 149,120 splats and a 17.0 ms median, so
that pair does not show the resident-cut change measured on streamed Tempel
elsewhere. Landscape layout was 734×329. The Tempel landscape orbit showed no
gaps, discs, or LOD popping.

The ten-minute Goose soak was skipped: a 149k static scene does not add
thermal pressure beyond dense Tempel. The Tempel soak (30 s warm-up, 600 s
sample) held 740,514 splats at pixel ratio 0.8, frame times 17.0 / 29.0 /
178.0 ms, 28,704 frames, 7,768 missed refreshes, and 1,037 frames >33.33 ms.
The median stayed on the 60 Hz cadence. The page did not crash or lose the
device. Safari does not expose battery temperature, so there is no °C sample.
The >33.33 ms figures are threshold counts, not missed-vsync totals.

The compact log is in the ignored `.tmp/iphone-15/run.jsonl` file. This
closes the non-Pro iPhone 15 row. It does not change mobile budgets or the
SD default.

**Recording a mobile device check.** Open `?hud=1` in a single foreground tab
so the perf HUD paints (a background tab reports `1 rAF` and empty HUD; extra
Chrome tabs on Android inflate p99). Wait until the Streaming pill is gone
before calling the sample steady; five seconds of cinematic orbit is not
enough on sandwijck. Copy
browser, OS, GPU / `gpuClass`, backend, dataset, splat count, and HUD FPS.
For a repeatable orbit, write median / p95 / p99 frame times, observed callback
cadence (p10), display refresh interval when supplied by `?refreshHz=` or
`screen.refreshRate`, its source (`provided`, `screen`, or `unavailable`), and
missed refresh opportunities. Use `?refreshHz=60` when the display mode is fixed;
callback cadence alone never becomes a display-rate estimate, including for
slow or background runs.
Report any literal >33.33 ms count as a threshold count, not missed vsyncs. A/B coverage with `?adaptiveDpr=0` and
`?pixelRatio=1`, then `0.9`, then `0.8`, before raising `maxStdDev`. A/B the
splat floor with `?minSplatPx=1.5` against `?minSplatPx=3.5` (3.5 px is the
blobby zoomed-out reference). Run a ten-minute thermal soak on one sparse
and one dense capture. Check portrait and landscape for gaps, discs, and
LOD popping. An iPhone 15 Pro or Galaxy S24 Ultra run does not stand in
for a non-Pro 15 check. The 2026-09-23 non-Pro run above closes that row.

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
- Streamed LCC / Streamed SOG / RAD publish CPU-worker snapshots
 asynchronously. The last complete scene remains visible until matching data,
 order, and count are ready, so detail can lag one worker request but does not
 flash during a replacement or LOD swap.

Force with `?backend=webgl` in the demo.

## WebGPU storage-buffer limits

WebGPU's default `maxStorageBufferBindingSize` is **128 MiB**. Unified work
buffers allocate an RGBA32F centers storage attribute at **16 B/splat**, so
capacities above ~8M exceed the default. Desktop adapters commonly advertise
~2 GiB. `createWebGPURenderer()` requests them (along with the adapter's
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
