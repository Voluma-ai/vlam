# Rendering benchmark

## Minimal Spark / VLAM comparison

The two standalone pages compare Spark **2.2.0 / WebGL2** with the current
VLAM source on **actual WebGPU**. Spark is a development dependency only.
They share Three.js, the scene bytes, camera, timing session and reporting;
each page loads only its chosen renderer. The older `/render-benchmark.html`
described below remains available with its existing defaults.

A historical Spark 2.1.0 package was recovered from the local npm cache and
aliased into one isolated benchmark server (`VLAM_SPARK_VERSION=2.1.0`,
`VITE_SPARK_VERSION=2.1.0`). Recreate the alias with:

```bash
mkdir -p .tmp/spark-2.1
npm pack @sparkjsdev/spark@2.1.0 --pack-destination .tmp/spark-2.1
tar -xzf .tmp/spark-2.1/sparkjsdev-spark-2.1.0.tgz -C .tmp/spark-2.1
VLAM_SPARK_VERSION=2.1.0 npm run benchmark:dev
```

The Vite alias resolves `.tmp/spark-2.1/package/dist/spark.module.js`. The
normal installed development dependency and lockfile remain Spark 2.2.0. In
archived 2.1.0 reports, `renderer.version` is the actual aliased 2.1.0 package;
`environment.spark` describes the installed 2.2.0 package tree and must not be
read as the active renderer.

For build-time experiments, start a separate server for each variant with
`VLAM_EXPERIMENT=baseline npm run benchmark:dev` or
`VLAM_EXPERIMENT=skip-empty npm run benchmark:dev`. The effective settings are
saved in comparison and memory reports. Empty-pool `skip-empty` is the
published default; `baseline` restores the prior initial upload for A/B.
Other selectable names (`one-pass`, `heap`, `bounded-threshold`, `rad-decode-2`,
`rad-decode-4`, `exact-stream`, `approximate-sh-stream`, `first-vertex`) remain
independent benchmark-only configurations. `one-pass` is the page-table
production default (Spark 2.1's single best-first walk). `heap` restores main's
extra budget-filling walks for A/B. Decode stays on one worker unless a
`rad-decode-*` server is started. The bounded-threshold traversal has been
evaluated and is not recommended for promotion. Remote PLY streaming is
implemented as an isolated benchmark experiment. The WebGL candidate is also
isolated and cannot be evaluated on the tested Chrome GPU path because its
extension is unavailable.

```bash
npm install
npm run benchmark:cache
npm run dev
```

If another local VitePress instance already occupies port 5170, start this
isolated harness on a different port without stopping it:

```bash
VLAM_DEV_PORT=5171 npm run dev
```

Open these paths on the dev server printed by the last command:

```text
/spark-benchmark.html
/vlam-benchmark.html
/playcanvas-benchmark.html
/spark-benchmark.html?preset=controlled&mode=orbit
/vlam-benchmark.html?preset=controlled&mode=orbit
/vlam-benchmark.html?preset=reference&mode=stationary&backend=webgl
/spark-benchmark.html?scene=hotel&mode=orbit
/vlam-benchmark.html?scene=hotel&mode=orbit
/vlam-benchmark.html?scene=hotel&radBudget=1000000&preset=reference
```

The cache command downloads Tempel (`.lcc2` plus its SOG tiles) and the
hotel-core Spark `.rad` once to the ignored `.tmp/benchmark-assets/` directory
and records SHA-256, byte size, splat count, SH bands and canonical camera in
a JSON manifest. Both viewers fetch that same local copy so tile URLs and
`.rad` byte ranges resolve without remote CORS. It also prepares the
repository's small `goose.sog` fixture (`?scene=goose`).
An additional `?scene=lcc` RAD can be placed at
`.tmp/benchmark-assets/lcc/render.rad` with metadata in
`.tmp/benchmark-assets/lcc.json`; it is an optional local capture, not part of
the default cache download.
Re-running the command verifies/recreates metadata from the cached bytes;
it does not silently replace the capture with a newer remote asset.

The downloaded Tempel capture has **12,847,768 splats** across five LOD levels
(**6,635,642** at finest) and **SH3**. VLAM streams the `.lcc2` octree cut.
Spark 2.2.0 has no LCC2 reader, so it fully decodes every listed SOG tile (all
LOD levels plus the environment tile). Tempel starts at the docs-example
interior view, already in the LCC2→Three basis both engines use; goose is
framed from its source center bounds. Goose (SOG) gets a 180° X rotation on
both meshes. Hotel (`?scene=hotel`) is `HOTEL.clean.comp-lod.rad` from
[assets.voluma.ai](https://assets.voluma.ai/voluma/veersetoren/HOTEL.clean.comp-lod.rad),
the headed hotel-core orbit (~4.2M tree nodes). VLAM opens it with
`StreamedSplatMesh`; Spark uses its native paged `.rad` loader. Both keep LOD
enabled (controlled/reference must not flatten this tree). The local
benchmark server answers HTTP Range so neither engine downloads the file
whole. Goose and hotel both get a 180° X rotation. For other views, set both
`position=x,y,z` and `target=x,y,z` in world coordinates. The page's renderer
links preserve the resolved camera, so a pose can be shared exactly.
The standalone harness normally uses a 45° vertical field of view and near/far
0.01/10000. `preset=supplied` uses the supplied application's 60° and
0.01/500 camera plus renderer MSAA. All configurations use a black background,
fixed drawing buffer, pixel ratio 1 and no tone mapping.
Canvas CSS can shrink the displayed image without changing GPU resolution.

### Presets and controls

| Parameter | Default | Purpose |
| --- | --- | --- |
| `preset` | `proposed` | `supplied`, `proposed`, `controlled`, or `reference`; legacy `defaults` and `matched` remain accepted |
| `mode` | `stationary` | `stationary`, `orbit`, position-preserving `rotate`, `translate`, or five seconds of orbit in warm-up then `settle` |
| `shEvaluation` | `auto` | VLAM SH evaluation: `vertex` or generated final `compute`; `auto` selects the latter on identified Apple Silicon Macs only for static SH pools with at least 8,000,000 splats, and alongside a qualifying automatic compute-projection choice. Smaller eligible Apple pools use vertex SH (`apple-mac-small-workload`); explicit `compute` remains available. |
| `scene` | `Tempel` | Cached `.lcc2` capture, `goose`, streamed `hotel`, or optional `lcc` (`.rad`) |
| `radBudget` | device default | VLAM-only `.rad` splat budget; `1000000` forces hotel through the page-table traversal |
| `width`, `height` | `1280`, `720` | Drawing-buffer pixels, at pixel ratio 1 |
| `warmup`, `seconds` | `5`, `30` | Warm-up and measured seconds after initial load/sort |
| `sh=0..3` | source | Benchmark-only SH band cap; `0` is the suite's disabled diagnostic |
| `backend` | `webgpu` (VLAM) | VLAM only: `webgl` forces the WebGL2 + worker-sort fallback. Spark is always WebGL2 |
| `maxStdDev` | preset | Explicit quad extent diagnostic, in Gaussian standard deviations |
| `sortMetric` | preset | `depth` or `radial` |
| `sortStrategy` | library default | VLAM-only `counting`, `radixSort()`, `exactSort()`, or `worker` diagnostic; the viewer passes the corresponding factory |
| `sortIntervalMs` | library adaptive default | VLAM-only cadence override; use `0` for the projection A/B's every-changed-frame pass |
| `projectionStrategy` | `auto` | VLAM `computeProjection({ mode: 'auto' })`, full-detail `vertex`, or explicit experimental `computeProjection()` |
| `minPixelSize` | profile | VLAM contribution cull: drop splats whose on-screen diameter is below this many px |
| `minContribution` | profile | VLAM contribution cull: drop splats whose opacity × major × minor is below this |
| `visibilityPose` | unset | Cached `interior` or `overview` pose used by the projection A/B |
| `msaa` | `0` (`1` for `supplied`) | Renderer MSAA control |
| `gpuTimestamps=0` | enabled | Disable timestamp instrumentation; primary suite runs set this to `0` |
| `position`, `target` | cached scene pose | Paired comma-separated world-space vectors |
| `label` | empty | Device, power state or experiment note |
| `suite=1` | off | Sequential suite with local archiving. Compact default is 12 runs (Tempel 720p+QHD plus hotel 720p, proposed, 15 s). `suiteDensity=full` restores the 32-run matrix for the current scene |
| `suitePreset` | proposed (compact) / all (full) | With `suite=1`, run only the proposed or controlled cases |
| `suiteDensity` | `compact` | `full` restores three 720p repetitions of proposed+controlled plus QHD |

### Hotel baseline snapshot (14 September 2026)

One fresh headed Chromium tab per engine used the same cached hotel RAD
(`413381d93b452a77d75e7998f89836db0df740127f995bf94f4d5126a129f773`),
camera, 1280×720, SH3, `reference` preset, 2 s warm-up, and 5 s stationary
measurement on NVIDIA RTX 3090. Spark 2.1.0 was run from the cached package,
Spark 2.2.0 from the installed dependency, and VLAM 0.8.1 with every new
experiment disabled. Both Spark versions selected 2,295,273 active splats;
VLAM's page-table budget was set to 2,295,274 and selected that many. A separate
1,000,000-splat VLAM traversal stress run is retained in the raw results and
must not be compared as a matched baseline. The WebGL2 versus WebGPU backend
difference and one run per engine preclude an engine-speed ranking. These are
reference snapshots, not paired performance evidence for promotion.

| Engine | Backend | Active splats | Frame median / p95 / p99 | Captures |
| --- | --- | ---: | --- | --- |
| Spark 2.1.0 | WebGL2 | 2,295,273 | 16.7 / 16.8 / 16.9 ms | Nonblank front and orbit |
| Spark 2.2.0 | WebGL2 | 2,295,273 | 16.7 / 16.8 / 16.8 ms | Nonblank front and orbit |
| VLAM 0.8.1, baseline | WebGPU | 2,295,274 | 16.7 / 16.8 / 16.8 ms | Nonblank front and orbit |

The 60 Hz foreground display paced all three reports. GPU timestamps were
disabled, so these numbers cannot establish uncapped throughput. Raw reports
and PNGs are in `.tmp/benchmark-results/` under timestamps `22-13-33.767Z`,
`22-13-54.836Z`, and `22-17-24.956Z` respectively.

### Empty dynamic-pool upload (promoted 14 September 2026)

Private empty dynamic pools now skip the initial destination CPU upload by
default (`experiments.initialPoolUpload: 'skip-empty'`). Static meshes and
supplied shared pools keep the previous initialization.
`VLAM_EXPERIMENT=baseline` restores the prior upload on the isolated
benchmark server.

Five alternating fresh foreground tabs per variant used headed Chromium on an
NVIDIA RTX 3090 WebGPU adapter for the isolated probe: a private 250,000-slot
SH3 dynamic pool, empty render, one white append, and first nonblank pixel.
Both variants retained the same allocation, returned transparent empty pixels
and opaque white appended pixels, and completed the same path.

| Build | Full destination texture uploads | Median construction | Median first usable from construction |
| --- | ---: | ---: | ---: |
| Existing | 8 | 4.9 ms | 109.2 ms |
| Skip empty | 0 | 4.9 ms | 83.3 ms |

The five paired first-usable differences favored the candidate by 20–37 ms.
Actual rendered pixels also passed WebGPU and forced WebGL2 checks for append
ordering, disjoint appends, row reuse, clear, compaction, float16/float32,
and SH0–SH3. Raw isolated-pool values are in `.tmp/pool-native-results.json`.

#### Apple M3 hotel startup gate (14 September 2026)

The original promotion run used native Chrome 151.0.7922.174 on a 16 GB MacBook Air (Apple M3,
10-core GPU, Metal; WebGPU adapter vendor `apple` / `metal-3`), macOS 26.3.1,
AC power, headed foreground tabs, the pinned hotel RAD
(`413381d93b452a77d75e7998f89836db0df740127f995bf94f4d5126a129f773`), its
canonical camera, SH3, and a 1,000,000-splat budget. Five alternating pairs
per backend compared `VLAM_EXPERIMENT=baseline` (port 4187) with
`skip-empty` (port 4188). Every run reached 999,999 / 1,501,184 active /
capacity with no settle timeout or load failure. Skip-empty made zero initial
destination CPU uploads (baseline always eight / 174,137,344 bytes); staged
row uploads and staging-to-destination copies remained present.

| Backend | Existing median first usable | Skip-empty median first usable | Outcome |
| --- | ---: | ---: | --- |
| WebGPU | 35.19 s | 32.36 s | Historical instrumented timing; zero dest uploads |
| WebGL2 | 33.48 s | 35.53 s | Within ~7 s run-to-run range; no repeatable regression |

**Timing correction (14 September 2026):** these historical full-scene
milestones included awaited browser-wide memory checkpoints before loading and
rendering. They do not isolate a 2.83-second upload improvement. Keep the raw
values as historical observations; the isolated 109.2→83.3 ms pool test and
zero-upload/lifecycle evidence support retaining the optimization. Startup runs
now automatically disable browser-wide memory measurements, even with
`uaMemory=1`. Repeat native scene timing before publishing a new latency claim.
`firstUsableMs` marks a nonblank frame at `settleMinActive`, not proof of complete
coverage or settled detail.

Paired JSON summaries and fixed-pose captures are under
`.tmp/empty-pool-apple-silicon/` and
`.tmp/pool-native-scene-{webgpu,webgl}-five-pairs.json`. Native Chrome
lifecycle probes (empty → append, disjoint, reuse, clear, compaction) passed
for both variants on WebGPU and forced WebGL2; automated
`browser-tests/empty-pool.spec.ts` passed for both experiment builds.

### Bounded RAD traversal experiment (13 September 2026)

Five alternating heap / bounded-threshold pairs per scene used headed Chromium
on an NVIDIA RTX 3090, actual WebGPU, 1280×720, pixel ratio 1, SH3,
`preset=reference`, a stationary supplied camera, and 2 s warm-up plus 5 s
measurement. Each pair loaded identical cached bytes in a fresh foreground
tab. Hotel used a 1,000,000-splat budget to select its page-table path;
the larger RAD used the 4,000,000-splat device budget. The latter is the
user-supplied `lcc/render.rad` (812,213,456 bytes, SHA-256
`1163d0b4d76ea69c0f89682bdf38d4628edd3513d64f17247979eb2d51f812bf`,
10,105,638 source splats, 14,684,393 nodes). Its shared camera is
`position=2.670622,2.330199,2.810265` and
`target=1.988569,1.942181,0.970633`.

| Scene | Heap last-traversal median | Threshold last-traversal median | Threshold fallbacks per run | Frame p99 median |
| --- | ---: | ---: | ---: | ---: |
| Hotel | 340 ms | 366 ms | 12–13 | 16.8 ms for both |
| LCC RAD | 1,947 ms | 2,493 ms | 3–4 | 16.8 ms for both |

The traversal values are one final worker sample per run, not full-load worker
percentiles. The browser's 60 Hz pacing masks uncapped frame throughput in
the 5-second steady-state window. Both variants reached the same active
budget, and fixed-pose front/orbit captures were nonblank; the bridge,
foliage, and railings were visually inspected. The candidate is about 8%
slower on hotel and 28% slower on LCC in these samples, with repeated safety
fallbacks. Keep the heap default and retain bounded threshold as an isolated
benchmark experiment. Raw JSON and PNG captures are in the ignored
`.tmp/benchmark-results/` directory.

### Remote PLY streaming experiment (14 September 2026)

The `exact-stream` and `approximate-sh-stream` builds read uncompressed binary
PLY records in bounded windows. Exact SH measures the full extent while
spooling vertex records to a request-owned OPFS file, then packs in a second
bounded pass. Approximate SH samples the first 65,536 vertices, fixes a 1.25×
symmetric range, and counts later clipping. Compressed PLY retains buffered
decoding. Neither strategy changes the published loader's default.

On headed Chromium / NVIDIA RTX 3090 WebGPU, five fresh-tab cycles compared
all three modes at one camera using a deterministic 200,000-splat SH3 PLY
(47,201,477 bytes; SHA-256
`44a1e80c0c8a38460012676c728faec2b3715f1ea1e1b0b3df471edb99344d13`).
The capture is synthetic and locally generated; it is not a foliage quality
reference.

| Loader | Median fetch/decode | Legacy v1 input estimate | Temporary disk | SH clipping |
| --- | ---: | ---: | ---: | ---: |
| Buffered | 256 ms | At least 47.2 MB whole input | 0 | 0 |
| Exact stream | 353 ms | 49.3 MB | 47.2 MB | 0 |
| Approximate SH stream | 264 ms | 61.2 MB | 0 | 355 coefficients / 9 splats |

**Accounting correction (14 September 2026):** the table above preserves
legacy estimates, which omitted exact second-pass read buffers and understated
compressed fallback copying. New reports include `inputAccountingVersion: 2`
and count unique retained input/scratch backing buffers, including header and
sample storage, second-pass reads, and joined compressed input. Decoded output,
browser queues, disk caches and garbage awaiting collection are excluded. Do
not compare v1 and v2 peaks as a memory optimization; rerun for new evidence.

The 47 MB input fits under the reader's 64 MiB window, so this run cannot
demonstrate a memory win. A separate generated test places one vertex after
more than 2 GiB of preceding fixed-size PLY records and decodes it without
retaining the input. SH0–SH3 exact outputs match the buffered parser byte for
byte across one-byte network chunks. Both variants rendered on WebGPU and
forced WebGL2; concurrent exact requests left no OPFS files, and cancellation
and forced worker termination cleanup passed targeted tests. Front and side
synthetic views were inspected, but real foliage, thin features, and diverse
devices remain unvalidated. Keep exact streaming available only in benchmark
builds for further large-file study. Do not promote approximate SH: the small
load-time difference does not justify silent coefficient clipping. Raw native
reports and captures are in `.tmp/ply-native-results/`.

### WebGL provoking-vertex experiment (14 September 2026)

The `first-vertex` benchmark build asks for `WEBGL_provoking_vertex`, changes
the convention only around VLAM WebGL renders, and restores the previous GL
state. A mixed flat-varying triangle probe checks before/during/after pixels.
The adapter leaves rendering unchanged when the extension is absent. In headed
Chromium on NVIDIA RTX 3090, the extension was unavailable; the hotel WebGL2
run reported `supported=false`, `appliedRenders=0`, no generated flat-varying
shader declarations, and nonblank front/orbit captures. The WebGL2 browser
probe and state-restoration unit tests passed. There is no valid native GPU
performance comparison for this candidate, and no reason to change VLAM's
default convention. Retain it as an isolated benchmark probe until a supported
device and relevant flat-varying shader path can be tested.

The four named comparison configurations are deliberately separate:

| Configuration | Standalone harness behavior |
| --- | --- |
| `supplied` | Reproduces the supplied app's camera and MSAA around otherwise native renderer settings. It is a harness replica, not a replacement for the untouched UI run described below. |
| `proposed` | Spark defaults versus VLAM with source orientation, √8 extent and radial sorting. These are benchmark proposals, not library-default changes. |
| `controlled` | Both engines use √8, radial sorting, full detail, source SH and common color/filter settings. |
| `reference` | Preserves the historical 3σ/depth controlled comparison for regression checks. |

`defaults` remains the old native-default comparison and `matched` is an alias
for the old 3σ/depth `reference` behavior so saved links continue to work.
Spark's global `enableLod` alone does not mean the source has an LOD tree.
`mode=settle` extends a shorter requested warm-up to five seconds, so its
timed sample begins only after the fixed orbit completes.

These are aligned visual settings, not identical implementations. Spark retains
packed attributes, its native alpha/frustum/radius thresholds and asynchronous
worker sorting. VLAM retains its float covariance pool, SOG SH palette and
adaptive GPU counting-sort schedule. Record those differences when interpreting
motion quality and cost; never change VLAM's default sorter to improve a score.

### Compute-projection prototype result (Windows/NVIDIA, 2026-09-09)

The first promotion gate used Chrome 152 WebGPU on the reported NVIDIA Ampere
adapter, the 149,120-splat goose fixture, 1280×720, 3σ/depth/counting sort,
five seconds of warm-up and ten seconds of orbit sampling. Five alternating
vertex/compute repetitions used `sortIntervalMs=0`. The rows below are the
median of each run's reported percentile; raw JSON and fixed-pose screenshots
are retained under `.tmp/benchmark-results/` with label
`r186-projection-ab-sort0` (the first pair used `r186-projection-ab`).

| Pose | GPU-visible ratio | Vertex paired GPU median / p95 | Compute paired GPU median / p95 | Frame median / p95 / p99 | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Interior | 27.4% (10.1% at the fixed starting view) | 0.98 / 2.23 ms | 1.38 / 2.88 ms | 16.70 / 16.80 / 16.90 ms for both | Fail: GPU median regressed 40.8%; frame p95 did not improve |
| Overview | 100% | 3.28 / 3.47 ms | 3.47 / 4.59 ms | 16.70 / 16.80 / 16.90 ms for both | Fail: GPU median regressed 5.8% and GPU p95 regressed 32.3% |

All ten compute runs had nonblank fixed captures, no WebGPU validation errors,
no rejected timestamp samples and no device loss. The capacity-sized cache
added 7,774,244 steady GPU bytes and 15,548,488 bytes at the upload peak.
Goose's normal adaptive counting-sort interval resolves to 0 ms, so it cannot
provide a distinct adaptive-cadence comparison. A larger non-streamed or
unified capture is still required for that scheduling measurement; streamed
Tempel/hotel currently select the documented unsupported-foveation fallback.
One attempted browser-background cadence run was throttled to one callback per
second and is invalid; it is not included above. This evidence rejected an
unconditional compute default; the later cache and balanced-cull policy is
deliberately narrower.

### Large static SH3 compute-projection follow-up (Linux/RTX 3090, 2026-09-11)

An 8,724,225-splat SH3 whole-file SOG supplied two fixed poses: an interior
view (21.0% / 1.83M splats in view) and a close exterior orbit that fills the
frame (`overview`, 99.9% visible). Protocol: Chrome 152
WebGPU on NVIDIA GeForce RTX 3090, 1280×720, `preset=reference`, `mode=orbit`,
five seconds of warm-up and ten seconds of sampling. Five alternating
vertex/compute repetitions used `sortIntervalMs=0`. Rows are the median of
each run's reported percentile; archives use label `large-sh3-indoor-parity`.

| Pose | GPU-visible ratio | Vertex paired GPU median / p95 | Compute paired GPU median / p95 | Frame median / p95 | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Interior | 21.0% (1.83M) | 11.81 / 12.08 ms | 7.20 / 7.73 ms | 16.70 / 16.80 ms for both | GPU paired −39.0%; frame p95 unchanged (vsync) |
| Overview | 99.9% (8.72M) | 14.37 / 14.55 ms | 18.17 / 19.16 ms | 16.70 / 16.80 vs 16.70 / 33.40 ms | Fail: paired GPU +26.5%; frame p95 doubled |

Interior GPU render fell from 9.38 ms to 2.74 ms (SH no longer in the vertex
stage). Overview compute still projects and sorts nearly the whole file, so
paired GPU (6.74 ms render + 11.44 ms compute) misses the 16.7 ms vsync.
Adaptive cadence did not change that split. Matching PlayCanvas contribution
culls (`minPixelSize=2&minContribution=3`) dropped overview visibility to
16.0% and brought paired GPU to 5.29 ms with frame p95 16.80 ms; interior
visibility became 10.7% at 5.26 ms paired. Those culls change the image, so
they stay opt-in.

The capacity-sized projection cache was 432.7 MiB steady GPU / 865 MiB peak
(CPU+GPU). All compute runs reported `diagnostics.projection.effective ===
'compute'`, nonblank stills, and no device loss.

#### Where the overview regression comes from

An `sh=0` A/B at the same poses separates spherical harmonics from projection
and sorting (label `large-sh3-review`, 8 s sampling, `sortIntervalMs=0`):

| Pose | Path | SH3 render / compute | `sh=0` render / compute | SH cost |
| --- | --- | ---: | ---: | ---: |
| Overview | Vertex | 11.78 / 2.45 ms | 7.13 / 2.36 ms | 4.83 ms |
| Overview | Compute | 6.48 / 11.29 ms | 6.46 / 3.60 ms | 7.71 ms |
| Interior | Vertex | 9.41 / 2.40 ms | 6.73 / 2.45 ms | 2.60 ms |
| Interior | Compute | 2.76 / 4.67 ms | 2.85 / 2.56 ms | 2.08 ms |

Without SH the two paths are within 0.6 ms at the overview (10.05 vs 9.48 ms
paired), so neither the projection pass (~1.2 ms) nor the counting sort
(~2.4 ms, unchanged because 99.9% visibility keeps the survivor-scaled bucket
count at capacity) explains the regression. Evaluating SH once per survivor
costs 7.71 ms in the projector but only 4.83 ms in the vertex stage, where it
overlaps rasterization: one compute evaluation per splat is more expensive
than roughly four latency-hidden vertex evaluations. Compute projection is
therefore a win exactly in proportion to what culling removes, and the SH
relocation is a loss whenever most of the file survives.

#### PlayCanvas 2.22.1 reference (WebGPU, GPU-sort)

`pc.Application`'s constructor is synchronous and cannot create a WebGPU
device, so the adapter awaits `createGraphicsDevice` and builds `AppBase`
instead; it asserts `deviceType === 'webgpu'` and reports
`currentRenderer` after the first frame. GPU timings come from the PlayCanvas
`GpuProfiler`, the same source as SuperSplat's Frame Timings overlay. The
harness associates each timed `GpuProfiler.report` callback with PlayCanvas's
submitted `device.renderVersion`, not with a changed duration, so consecutive
equal-duration frames are retained. It drives bounded empty frames to drain
pending timestamp reports and records `gpu.accounting` (`submitted`,
`resolved`, `rejected`, `pending`) in every archive; unresolved or invalid
results are rejected rather than silently omitted. Runs confirm
`resolvedRenderer: raster-gpu-sort` and matching stills.

| Pose | Culls | PlayCanvas GPU | VLAM vertex paired | VLAM compute paired |
| --- | --- | ---: | ---: | ---: |
| Interior | default (2 / 3) | 5.52 ms | 11.58 ms | 5.28 ms |
| Overview | default (2 / 3) | 5.29 ms | 13.33 ms | 5.51 ms |
| Interior | off | 6.02 ms | 11.79 ms | 7.40 ms |
| Overview | off | 8.61 ms | 14.31 ms | 17.76 ms |

At matched culls the two engines are level. With culls off, PlayCanvas keeps a
1.2× lead at the interior and a 1.7× lead at the overview. Its per-pass
medians explain why: `GSplatWorkBufferRenderPass`, which resolves color and
SH, costs 4.7 ms but ran in only 25 of 406 sampled frames, while its
projector is 0.36 ms, its OneSweep radix passes total 0.23 ms and forward
rasterization is 1.3-1.8 ms. Per-frame it spends more than VLAM on sort
scatter (3.1 ms vs 2.4 ms) and far less on SH, because SH is cached across
frames rather than recomputed. VLAM's own `ShComputeCache` refreshes at the
same cadence (48 dispatches over 737 frames). Those two paths now combine:
see [SH cache under compute projection](#sh-cache-under-compute-projection-linuxrtx-3090-2026-09-13).

This evidence rules out unconditional compute projection: an all-visible
overview regresses without cached SH or contribution culls. It does not rule
out a bounded automatic choice; see [automatic selection](#automatic-static-projection-selection-2026-09-13).
Do not reduce the Gaussian cutoff below 3σ as a default.

#### SH cache under compute projection (Linux/RTX 3090, 2026-09-13)

`ShComputeCache` now stays active when compute projection is eligible. The
projector is built with `sh: null` and the vertex stage samples the cached
RGBA8 color. SH still refreshes on the vertex-path sort cadence (a projector
dispatch does not change pool-indexed colors). Protocol: Chrome 152 WebGPU,
1280×720, `preset=reference`, `mode=orbit`, five seconds of warm-up and ten
seconds of sampling. PlayCanvas rows are 2.22.1 WebGPU with contribution
culls off (`minPixelSize=0&minContribution=0`). Archives use labels
`sh-coexist-large-sh3-*`. Memory is 52 B/slot projection (432.7 MiB at
8.72M) plus 4 B/splat SH cache (33.3 MiB, including 2048-wide texture
padding). Goose (149,120, SH0) cannot allocate the cache (`sh-disabled`).

Adaptive cadence (`sortIntervalMs` unset; 167 ms at 8.72M):

| Pose | Path | GPU-visible | Paired GPU median / p95 | Frame p95 | SH dispatches | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Interior | Vertex | — | 9.43 / 11.83 ms | 16.80 ms | 0 | Baseline |
| Interior | Vertex + cache | — | 6.75 / 13.00 ms | 16.80 ms | 59 | Render 9.38 → 6.74 ms |
| Interior | Compute | 21.0% (1.83M) | 7.21 / 7.69 ms | 16.80 ms | 0 | Projector SH every frame |
| Interior | Compute + cache | 21.0% (1.83M) | 5.23 / 8.87 ms | 16.80 ms | 59 | Beats PlayCanvas 5.98 ms |
| Interior | PlayCanvas | — | 5.98 / 10.45 ms | 16.80 ms | 27 / 520 work-buffer | Cull-free reference |
| Overview | Vertex | — | 12.00 / 14.42 ms | 22.30 ms | 0 | Misses vsync |
| Overview | Vertex + cache | — | 7.24 / 18.37 ms | 22.50 ms | 58 | Median wins, p95 still tails |
| Overview | Compute | 99.9% (8.72M) | 18.62 / 19.33 ms | 23.30 ms | 0 | Per-frame projector SH |
| Overview | Compute + cache | 99.9% (8.72M) | 11.10 / 19.96 ms | 16.80 ms | 58 | Restores vsync; 1.25× behind PlayCanvas 8.90 ms |
| Overview | PlayCanvas | — | 8.90 / 13.79 ms | 16.80 ms | 186 / 552 work-buffer | Cull-free reference |

#### Automatic static projection selection (2026-09-13)

The demo's `projectionStrategy=auto` control now passes
`computeProjection({ mode: 'auto' })`, while the lightweight library defaults to
vertex projection and the
SH-preserving `performanceProfile: 'balanced'` on non-fill-constrained desktop
devices. This is a one-time policy decision at first prepare, not a startup
benchmark and never a scene-name rule. It selects compute projection plus the
RGBA8 SH cache only for the measured cohort: a static, own-pool, unmodified,
mono WebGPU mesh with counting sort, at least 8M SH splats, PlayCanvas-style
2 px / 3 contribution culls, the measured NVIDIA Ampere adapter class, and an
estimated peak projection-plus-cache allocation within 1 GiB. The estimate
includes temporary projection mirrors, the dense projected-sorter's histogram
and bucket-buffer mirrors, and 2048-wide SH-cache row padding; the budget is a
conservative application cap, not a claim about available VRAM.
Hosts can tighten or disable this path with
`projectionMemoryBudgetBytes` (set `0` in `computeProjection` to force the
automatic decision to vertex) while `computeProjection()` remains an explicit
override.

Every other case—including unknown adapters, smaller or SH-free files,
streaming, unified sources, modifiers, foveation, XR, WebGL2, unvalidated
discrete, integrated and mobile devices, custom sorting, and full-detail
`performanceProfile: 'quality'`
—stays on vertex projection. `projectionStrategyStatus` reports the selected
mode and a stable `auto-*` reason. The selected path is locked for the mesh
lifetime; a WebGL/XR/device failure falls back safely without camera-driven
material rebuilds. `performanceProfile: 'quality'` or
`projectionStrategy: 'vertex'` is the full-detail escape hatch.

The automatic rule is intentionally narrower than the acceptance target. A
separate 1–2M SH2 whole-file result covers that band, but its incompatible
median and tail outcomes do not broaden eligibility. A second GPU class is
still required before the threshold is broadened.

#### Default automatic-policy retest (Linux/RTX 3090, 2026-09-13)

Native Chromium 152 on an NVIDIA GeForce RTX 3090 ran five alternating
PlayCanvas/VLAM repetitions for each fixed pose of the same 8,724,225-splat
SH3 SOG. Every run used that file, a 1280×720 viewport, WebGPU timestamp
queries, five seconds of warm-up, and twenty seconds of sampling. Both engines
used their default 2 px / 3 contribution thresholds; VLAM used its ordinary
`balanced` + `projectionStrategy: 'auto'` defaults. Pooled percentiles below
are calculated from the raw timestamp samples, rather than from rounded
per-run summaries. PlayCanvas resolved every submitted timing sample with no
rejections; all fixed captures in both engines were nonblank.

| Pose | VLAM effective path | VLAM GPU median / p95 | PlayCanvas GPU median / p95 | VLAM / PlayCanvas frame p95 | Result |
| --- | --- | ---: | ---: | ---: | --- |
| Interior | auto → compute | 5.07 / 5.19 ms | 5.82 / 7.32 ms | 16.8 / 19.0 ms | Within the 10% / 15% GPU and frame bound |
| Overview | auto → compute | 3.62 / 5.93 ms | 5.79 / 6.50 ms | 20.0 / 19.4 ms | Within the bound; one paired run had slower browser callback pacing |

VLAM kept its one-time `auto-large-static-discrete-sh` decision for every
repetition. Its final projected-list counts were 935,868 (interior) and
1,395,561 (overview); the PlayCanvas adapter currently records source count,
not its post-cull survivor count, so those figures are not directly comparable.
The revised estimate was 505,413,924 B steady GPU and 1,010,827,848 B peak
CPU+GPU, including projected-sorter scratch and first-upload mirrors. This is
evidence for the single static desktop cohort only: nonblank fixed captures do
not prove pixel equivalence, and the repeated motion, cull-free, smaller-scene,
streaming, native-format, and second-GPU gates remain open. Local raw archives
are labelled `auto-parity-interior-rerun-2026-09-13` and
`auto-parity-overview-2026-09-13`.

#### Visible-list SH-cache refresh (Linux/RTX 3090, 2026-09-13)

The earlier overview-orbit default-policy retest found the remaining measured
miss: VLAM paired GPU p95 was 14.07 ms against PlayCanvas's 9.95 ms. Its raster
p95 was only 2.14 ms; the periodic full-pool SH-cache refresh was 12.34 ms
p95. A diagnostic with SH disabled held the same projection/sort path to 3.88
ms compute p95, identifying cache refresh granularity rather than
rasterization or the projected sorter as the bottleneck.

The cache now evaluates the projector's GPU-written dense survivor list with
its indirect workgroup count on camera/view refreshes. It retains a full
pool-indexed pass for initial, content, and graph invalidations, so a splat is
initialized before it can enter a later view. This adds no persistent buffer:
the list and indirect arguments already belong to the projected pipeline.

Five fresh alternating repetitions per engine used the same ordinary default
protocol as above, now in `mode=orbit`. All fixed captures were nonblank;
PlayCanvas resolved every submitted GPU timing with no rejections. The native
hardware probe separately compares cached and vertex-SH pixels through camera
changes. Pooled raw GPU timestamps show:

| Pose | VLAM paired GPU median / p95 | PlayCanvas GPU median / p95 | VLAM / PlayCanvas frame p95 | Result |
| --- | ---: | ---: | ---: | --- |
| Interior | 5.20 / 6.81 ms | 5.66 / 10.86 ms | 22.20 / 20.64 ms | Within the GPU and frame bounds |
| Overview | 5.35 / 7.80 ms | 5.55 / 9.90 ms | 22.00 / 20.50 ms | Within the GPU and frame bounds |

The updated overview compute p95 is 5.75 ms (12.34 ms before the change); its
paired p95 is consequently below the reference rather than 41% above it.
Each VLAM run performed 113–117 visible-list cache refreshes during sampling.
The 18 ms callback cadence in these foreground desktop runs is a browser
pacing caveat shared by both engines, which is why the GPU timestamp samples,
not FPS, decide the gate. Raw archives are labelled
`auto-parity-orbit-interior-visible-cache-2026-09-13` and
`auto-parity-orbit-overview-visible-cache-2026-09-13`.

#### Small static fallback check (Linux/RTX 3090, 2026-09-13)

Goose is a 149,120-splat SH0 whole-file SOG, so it is deliberately outside the
large-SH compute cohort. Five **order-balanced** default stationary repetitions
(the first engine alternated between repetitions) confirmed the locked
`auto-small-static-scene` vertex decision rather than allocating a projected
list and cache. Pooled GPU timestamps were VLAM 0.87 ms median / 1.11 ms p95
against PlayCanvas 1.01 ms / 1.40 ms p95; frame p95 was 16.8 ms for both
engines. Every fixed capture was nonblank and PlayCanvas resolved every
submitted timing sample.

An earlier one-sided execution order produced 18–19 ms callback pacing and is
superseded by this order-balanced result. Goose therefore passes the measured
small-scene fallback gate, but it remains a single SH0 scene and is not evidence
for broadening the large-SH automatic compute cohort. Raw archives are labelled
`auto-parity-goose-stationary-order-balanced-2026-09-13`.

#### Intermediate static SH2 check (Linux/RTX 3090, 2026-09-13)

A separate 1,827,467-splat palette-SH2 whole-file SOG supplied two aerial
poses: a closer view and an elevated overview. Five alternating
PlayCanvas/VLAM repetitions per pose used
1280×720, ordinary 2 px / 3 contribution culls, five seconds of warm-up, and
twenty seconds of orbit sampling. VLAM used explicit compute projection plus
the SH cache; PlayCanvas resolved every submitted timestamp with no rejection.
All fixed captures were nonblank.

| Pose | VLAM visible count / ratio | VLAM paired GPU median / p95 | PlayCanvas GPU median / p95 | VLAM / PlayCanvas frame p95 | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Closer view | 554,929 / 30.4% | 4.33 / 4.96 ms | 3.67 / 6.14 ms | 16.8 / 16.8 ms | p95 and frame pass; median is 18.1% slower, so fails the 10% gate |
| Elevated overview | 380,462 / 20.8% | 2.48 / 8.08 ms | 4.25 / 5.64 ms | 21.7 / 18.4 ms | Median wins 41.6%; compute p95 (+43.3%) and frame p95 (+17.9%) fail |

The 110.9 MiB steady / 221.7 MiB first-upload projection allocation is within
the policy budget. It does not qualify this cohort for `auto`: no single locked
mode meets both the median and tail bound across its two poses. The current
vertex fallback is therefore retained. An SH-disabled overview diagnostic still
reported 8.39 ms paired p95 (6.29 ms compute p95), and a 33 ms SH-cache cadence
experiment reported 7.95 ms paired p95; the remaining tail is projector/cull/
counting-sort work, not SH-cache frequency. The sorter deliberately keeps at
least one depth bucket per visible splat to avoid rendering-order popping, so
that invariant was not weakened. Raw archives are labelled
`sh2-intermediate-interior-alternating-2026-09-13` and
`sh2-intermediate-overview-alternating-2026-09-13`.

A follow-up 5-second-warm-up / 8-second overview pass profile on the same
native adapter retained each resolved compute submission before grouping it by
frame. The projector batch (reset, project, finalize) was 0.36 ms median /
2.96 ms p95; histogram and scatter were 0.06 / 0.32 ms and 0.05 / 0.11 ms;
the scan batch was 0.39 / 1.24 ms; and visible-list SH was 0.43 / 1.36 ms.
The highest frames raised several of those batches together (for example,
9.03 ms at one frame: 2.96 ms projector, 3.25 ms scans and 2.34 ms SH), so a
visible-list atomic-compaction prototype was rejected rather than retained on
a single attribution theory. Archive:
`sh2-intermediate-overview-pass-profile-smoke-2026-09-13`.

#### Streaming automatic-fallback smoke (Linux/RTX 3090, 2026-09-13)

One native 1280×720 interior-orbit run was taken for each locally cached
streamed format after five seconds of warm-up and twenty seconds of sampling.
Both preserve the conservative vertex path:

| Scene / format | Auto result | Active-splat range | Paired GPU median / p95 | Frame p95 | Lifecycle result |
| --- | --- | ---: | ---: | ---: | --- |
| Tempel LCC2 | vertex / `auto-dynamic-or-shared-pool` | 2.91M–6.65M | 5.75 / 8.63 ms | 33.30 ms | Nonblank captures; no device errors; 206 timed sorts |
| Hotel RAD | vertex / `auto-dynamic-or-shared-pool` | 0.47M–3.19M | 4.29 / 7.00 ms | 16.80 ms | Nonblank captures; no device errors; 504 timed sorts |

Neither run allocated projected-list or SH-cache storage. These are lifecycle
and fallback checks, not reference-parity results: the PlayCanvas adapter does
not load LCC2/RAD and its whole-file GSplat path cannot represent the same
streaming/LOD behavior. They therefore do not satisfy the repeated streaming
performance or pixel-equivalence gates. Raw archives are labelled
`streaming-temple-auto-orbit-2026-09-13` and
`streaming-hotel-auto-orbit-2026-09-13`.

#### Stationary projected-list reuse (Linux/RTX 3090, 2026-09-13)

Compute projection now records the model-view matrix, camera projection,
viewport, active-list and content revisions, and depth-of-field uniforms that
its passes consume. With none changed, it preserves the existing indirect
draw/list instead of submitting projection/cull/counting-sort work or falling
back to the vertex sorter. A native Chromium 152/RTX 3090 default-policy
large-SH3 interior run (1280×720; 1 s warm-up; 3 s sampled) recorded **zero
sampled projection, cull, sort, and SH dispatches**. Its two fixed-capture
poses were nonblank; the later orbit capture added the expected submission.
The corresponding hardware probe asserts exactly two projection submissions
for two camera changes followed by two identical updates. This confirms
submission reuse, not a cross-scene performance claim; the broader repeated
motion/corpus protocol remains outstanding.

#### Move-to-settle timing correction (Linux/RTX 3090, 2026-09-13)

The comparison harness previously subtracted warm-up time from all motion
modes. That caused `mode=settle` to begin its five-second orbit at the first
timed frame, despite the mode's intended move-then-static sample. It now runs
that orbit from the first warm-up frame and extends a shorter requested warm-up
to five seconds. A native Chromium 152/RTX 3090 large-SH3 overview run with a
six-second warm-up and twenty seconds of sampling recorded zero sampled SH and
sort dispatches (and zero timestamped compute samples); the 34 camera/view
refreshes occurred during warm-up. The capture was nonblank with no WebGPU
errors. Archive: `auto-parity-overview-settle-six-second-warmup-2026-09-13`.

`sortIntervalMs=0` still sorts and therefore refreshes SH every moved frame
(~520–600 dispatches). Overview compute+cache paired GPU stays 19.75 ms with
frame p95 33.40 ms, so the cache cannot pay for itself when the sort interval
is zero. Goose paired GPU is vertex 1.82 ms, compute 2.20 ms, PlayCanvas
1.99 ms; the 149k gate is unchanged because there is no SH to cache.

The cull-free, moving overview gap above remains the relevant all-visible
stress finding: VLAM's counting sort is already cheaper than PlayCanvas scatter
(~2.4 vs 3.1 ms), but the projector is still 52 B/slot (PlayCanvas 32 B) and
rasterization is 7.00 vs 3.72 ms at 99.9% visible. The automatic rule is a
one-time first-prepare choice for the validated balanced stationary cohort, not
a claim to solve that stress case. The intermediate 1–2M whole-file SOG
slot isolates a separate projected-path tail.

### Supplied application baselines

Prepare two isolated copies of the developer-supplied app without modifying it:

```bash
npm run benchmark:prepare-supplied -- ~/repos/splatstest
```

The command hashes every source/configuration/lockfile input before and after,
runs the locked VLAM 0.6.1 / Spark 2.1.0 install in one copy, substitutes only
the packed local `@voluma/vlam` in the other, builds both, and writes package
tree hashes plus the exact dependency difference to
`.tmp/supplied-benchmark/manifest.json`. Run each copy through its existing UI;
do not add instrumentation or source changes to those copies. Capture frame
intervals and browser traces externally so its helpers, stats overlay, MSAA,
controls and render loops remain present.

#### M3 Air untouched supplied-app smoke, 2026-09-09

The prepared locked and candidate builds were run sequentially in the same
Chrome 151.0.7922.174 window on the 16 GB M3 Air. The existing UI loaded the
1,000,000-splat medium SH3 compressed PLY through its file picker with its own
DPR=2, MSAA, timestamp tracking, helpers, stats-gl overlay and animation loop
left intact. Both copies reported WebGPU and the full splat count. Grid/axes,
Orbit/FPS switching and orbit-camera motion were exercised through the UI.

The candidate retained a recognizable, complete watch before and after camera
motion. The locked 0.6.1 package reduced this compressed PLY to a tiny
star-like cluster, so it is not a valid pixel reference for this format. Native
stats snapshots in the otherwise identical full-window state showed roughly
2–4 FPS for the candidate and about 1 FPS for locked. These overlay readings
are qualitative smoke evidence, not a replacement for frame-interval samples:
the app's fixed camera poorly frames this object, stats-gl reported no usable
GPU timing, and no external browser trace was captured. A post-run hash audit
matched every supplied source/configuration/lockfile input in the manifest;
the installed VLAM package tree remained the only difference between copies.
External frame tracing therefore remains pending, while the untouched UI load,
backend, completeness and control-lifecycle checks are recorded.

### Repeatable suite and results

For the experimental standalone WebGPU generated-color path, compare
`?preset=matched&shEvaluation=vertex&gpuTimestamps=0` with
`?preset=matched&shEvaluation=compute&gpuTimestamps=0`. Repeat each three times,
alternating order, for stationary and orbit modes. The sequential suite does not
perform this explicit SH-path comparison automatically. Reports include the
resolved path and fallback reason, SH/sort dispatch counts, invalidations and
cache bytes; `measuredDispatches` excludes initial preparation and warm-up.
GPU compute timings include both SH preparation and sorting, so use separate
timestamped diagnostic runs and dispatch counts to interpret them.

The demo also accepts `?shEvaluation=compute`; applications can pass
`shEvaluation: 'compute'` to `SplatMesh`. This manual override applies only
to fully loaded, unmodified standalone WebGPU meshes with SH and sufficient
2D-texture limits. It allocates one RGBA8 final-color texel per pool slot
(4 bytes, no CPU mirror). WebGL, SH0, modifiers, shared/dynamic pools, merged
placement, unified sources and XR retain vertex evaluation. `auto` selects this
path when both the browser platform identifies macOS and WebGPU adapter details
identify Apple/Metal. Touch-capable desktop-UA devices are excluded so iPadOS
does not enter the cohort. Caches above a conservative 64 MiB safety ceiling
also retain vertex evaluation. Unidentified adapters retain vertex evaluation.
The initial pass fills every slot; moving views refresh only the same
conservative center frustum the draw shader accepts. Accepted GPU sorts still
refresh immediately, but a 150 ms cadence also refreshes newly visible regions
when radial ordering does not change, such as rotation after translation.
Content changes regenerate every slot and stationary measured frames incur no
dispatch.

A post-review 15-second M3 Air orbit probe (`cache-review-orbit`) recorded 79
accepted sorts, 79 SH dispatches and zero independent view-cadence refreshes,
confirming that continuously translating orbit does not receive duplicate
cache work. Its mean frame time was 47.67 ms; both fixed captures were valid and
the device reported no errors.

#### M3 Air SH cache retest, 2026-09-04

On a 16 GB M3 Air, macOS 26.3.1, AC power with low power mode off, the
foreground in-app Chromium 152 browser produced the following observed FPS.
These are separate from the earlier standalone Chrome 151 results. All runs
used the matched 8.72M SH3 scene at 1280×720 with timestamps disabled, five
seconds of warm-up and 15 seconds of sampling. VLAM rows use the median of
three runs; Spark and rotation-only are single diagnostic probes.

| Motion | VLAM vertex | VLAM compute cache | Spark |
| --- | ---: | ---: | ---: |
| Stationary | 11.92 | 22.35 | 21.79 |
| Orbit | 11.13 | 8.51 | 18.48 |
| Rotation only | 11.19 | 19.71 | not measured |

Stationary mean frame time improved from 83.89 to 44.74 ms, but orbit worsened
from 89.82 to 117.45 ms. Orbit median/p95 also regressed (84.3/116.7 ms to
116.7/133.4 ms), failing the rollout gate. The cache remains opt-in; there is
no validated automatic device or workload cutoff. Stationary and rotation-only
sampling performed zero SH dispatches; orbit refreshed SH on every rendered
frame. The cache used 99.84 MiB of GPU storage with a 199.69 MiB temporary
CPU-plus-GPU allocation peak, excluding other mesh/renderer memory.

The local `.tmp/benchmark-report-m3air-sh-cache/findings.md` links raw results
and screenshots. Front/orbit images were visually compared; synthetic SH1
effect checks matched exactly. Broader CPU-reference/SH/PLY/lifecycle coverage,
other scene sizes, the discrete-GPU regression check and the ten-minute thermal
comparison remain outstanding. These measurements do not validate mobile,
Pro/Max or other Apple devices, or establish cross-backend GPU-time equivalence.

#### M3 Air hybrid follow-up

A follow-up retains cached SH while camera position is stable, switches to the
existing vertex evaluator during translation, and refreshes the cache once
after 150 ms of positional stability. Three new repetitions measured **25.21
FPS stationary** and **11.02 FPS orbit**. Mean frame times were 39.67 and 90.76
ms; median/p95 were 33.4/50.1 and 83.8/116.7 ms. Compared with the preceding
three-run vertex medians, stationary improved by 52.7% in mean frame time while
orbit mean changed by 1.0%; orbit median and p95 had no material regression.

Every orbit run recorded one motion fallback and zero timed SH dispatches. A
motion-then-settle probe recorded one refresh after movement and ended on the
cache path. The synthetic SH1 effect check retained exact pixel parity.
The hybrid removes the compute-every-frame regression, but its 11.02 orbit FPS
remains well outside 15% of the single fresh 18.48 FPS Spark probe. The Apple
Mac `auto` cohort used this hybrid evaluation at this stage. Full data is in
`.tmp/benchmark-report-m3air-sh-hybrid/findings.md`.

An SH3 WGSL inspection then found that Three.js already emits one palette-label
load, one normalized direction, shared squared terms and exactly 15 palette
reads for 15 coefficients. Explicitly hoisting the few remaining repeated
polynomial products measured 11.05 FPS orbit versus 11.02 before (+0.3%), with
unchanged median/p95 and elevated p99 stalls in two runs. The optimization was
rolled back. Local evidence is retained in
`.tmp/benchmark-report-m3air-sh-hoist/findings.md`.

#### M3 Air sort-cadence follow-up

The next follow-up refreshes cached SH when the WebGPU sorter accepts a moving-
camera order and reuses that color between accepted sorts. Content and graph
changes still refresh immediately, rotation-only frames reuse the cache, and a
stopped camera receives an exact refresh after 150 ms when needed.

Three orbit repetitions measured **15.74, 16.10 and 16.11 FPS**, for a median
of **16.10 FPS** and median mean frame time of **62.13 ms**. Median/p95 frame
times were 50.0/116.7 ms in all three runs. This is 46.1% faster by observed FPS
than the preceding 11.02 FPS moving hybrid, 44.6% faster than the 11.13 FPS
vertex baseline, and 12.9% behind the fresh single 18.48 FPS Spark orbit probe.
Each sampled orbit run issued exactly one SH dispatch per accepted sort (63–64),
with 177–183 rendered frames reusing color between sorts.

A stationary regression probe measured **25.14 FPS**, zero sampled SH work and
33.4/50.1 ms median/p95. A five-second-motion-then-settle probe measured **22.18
FPS** overall and ended on the exact cache path. A synthetic, directionally
varied SH3 comparison at the orbit's approximate 0.02-radian inter-sort step
had a maximum channel difference of 1/255 and mean absolute difference of
0.052/255 against vertex SH. Static SH/effect parity remained byte-exact.

This result meets the observed within-15%-of-Spark target on the M3 Air, although
Spark is still represented by one fresh probe rather than three alternating
runs. Discrete-GPU, scene-size, physical mobile/Pro/Max and thermal validation
remain outstanding. Full local evidence is in
`.tmp/benchmark-report-m3air-sh-sort-cadence/findings.md`.

#### M3 Air large-cache correction, 2026-09-07

Revalidation with the expanded proposed-settings harness found that every
8.72M SH3 timing above which resolved to the 99.84 MiB compute cache had a blank
live canvas and blank fixed-pose screenshots. Those numbers are invalid as
rendering-performance evidence and the earlier M3 cache conclusion is
superseded. The small synthetic SH1 cache still passes effect restoration and
vertex/cache parity, so the failure is workload-specific.

Spark's MIT source was inspected for resource-shaping ideas. Two independently
implemented experiments were rejected: an RGBA32F/RGBA16F layered
storage-texture cache, and independent fixed-base bounded compute submissions
over that texture. Both produced deceptively fast frame intervals but blank
8.72M output. Capping evaluation to SH1 was also blank, which rules out SH3
arithmetic pressure as the primary cause and points to the large-resource path.
Two/five-way storage-buffer partitions (approximately 51.5/24 MiB per binding),
direct identity indexing, and even a zero-filled 99.84 MiB contribution buffer
were blank as well. The zero-fill result proves that merely consuming the large
cache resource in the vertex stage is enough to fail; SH arithmetic, palette
reads and active-list indexing are not the cause. Chromium reported no
uncaptured validation error or device loss and advertised 4 GiB buffer limits.
An independently implemented 34.9 MiB RGBA8 pool-shaped storage texture also
remained blank with nearest filtering and mipmaps disabled, so reducing cache
precision and footprint does not make Three's compute-written texture handoff a
viable path on this configuration.
Replacing that storage texture with an ordinary RGBA8 render target, populated
by a full-screen fragment pass and sampled once per splat by the vertex graph,
was also rejected: the enabled cache again produced blank live and fixed-pose
output with no reported validation error or device loss. Its invalid artifact is
`.tmp/benchmark-results-old/2026-09-07T13-43-18.787Z-e3801584-8fe3-460b-9fb1-120528336bc5`.
This narrows the failure to the large auxiliary resource consumed by Three's
vertex graph rather than compute-versus-render production of that resource.
The additive experiments are not retained. A further independent implementation
of Spark's architectural distinction did succeed: compute writes final clamped
RGBA8 color, and the display shader uses that texture *instead of* binding the
source color and SH palette alongside it. A full initial pass makes fixed-eye
rotation exact; moving views evaluate SH only for the same 1.2-NDC center
frustum accepted by the draw graph, while still dispatching at every accepted
sort. The retained 64 MiB ceiling now applies to this 4-byte-per-slot texture.
The harness records WebGPU validation errors/device loss and samples fixed-pose
screenshots after every run; a blank pose marks the result invalid and stops a
sequential suite.

One focused 5-second-warm-up/10-second-sample smoke comparison at 1280×720
measured the corrected proposed configuration as follows. This is one run per
case, not the five-run acceptance suite:

| Motion | Spark mean / p95 | VLAM mean / p95 | Mean ratio |
| --- | ---: | ---: | ---: |
| Stationary | 46.02 / 50.10 ms | 114.94 / 116.70 ms | 2.50× |
| Orbit | 55.01 / 166.60 ms | 118.82 / 133.40 ms | 2.16× |

Both retained fallback VLAM screenshots were visually nonblank and diagnostics
resolved `auto` to `vertex` with reason `workload-limit`. A separate full-detail
SH0 diagnostic measured 49.90 ms for VLAM and 50.00 ms for Spark, effectively
equal in this single run, isolating the gap to view-dependent SH.

The replacement generated-color path then passed five-repeat alternating
acceptance sets at both 1280×720 and 2560×1440 (five-second warm-up plus a
30-second sample per run). The tables report the median of five per-run
means/p95s/FPS values.

1280×720:

| Motion | Spark mean / p95 | VLAM mean / p95 | Mean ratio | Spark / VLAM FPS |
| --- | ---: | ---: | ---: | ---: |
| Stationary | 45.78 / 50.10 ms | 44.63 / 50.10 ms | **0.975×** | 21.84 / 22.41 |
| Orbit | 55.00 / 150.00 ms | 53.78 / 83.40 ms | **0.978×** | 18.18 / 18.59 |

2560×1440:

| Motion | Spark mean / p95 | VLAM mean / p95 | Mean ratio | Spark / VLAM FPS |
| --- | ---: | ---: | ---: | ---: |
| Stationary | 56.52 / 66.70 ms | 51.81 / 66.70 ms | **0.917×** | 17.69 / 19.30 |
| Orbit | 69.80 / 183.50 ms | 65.65 / 116.60 ms | **0.940×** | 14.33 / 15.23 |

All 40 runs and both fixed poses per run were valid. VLAM `auto` resolved to
`apple-mac-auto` throughout. It issued zero measured SH dispatches stationary;
median orbit counts were 152 at 720p and 144 at 1440p, so the win does not come
from reducing the accepted sort/SH refresh cadence. Both resolutions are inside
the 1.10× target without changing splat count, SH3, extent, resolution or
sorting. The retained RGBA8 cache is 34.90 MiB.
Against a fixed-pose vertex run, mean absolute screenshot differences were
0.080/255 (front) and 0.087/255 (orbit); only 557/789 of 2,764,800 RGB samples
differed by more than one level, comparable to edge/order variation between
repeated vertex captures. Raw results are labeled `final-720p-r1` through
`final-720p-r5` and `final-1440p-r1` through `final-1440p-r5`. The
discrete-GPU, medium-scene, SH-bearing PLY, untouched-app UI tracing and
ten-minute thermal checks remain pending.

#### M3 Air controlled acceptance, 2026-09-07

A subsequent controlled-only suite used the same device, scene, warm-up and
30-second sampling windows. Both engines used the aligned √8 extent, radial
sorting, full-detail SH3 and common color/filter settings. The table again
reports the median of five per-run values:

| Resolution / motion | Spark mean / p95 | VLAM mean / p95 | Mean ratio | p95 ratio |
| --- | ---: | ---: | ---: | ---: |
| 1280×720 stationary | 48.00 / 50.10 ms | 47.47 / 66.50 ms | **0.989×** | **1.327×** |
| 1280×720 orbit | 67.99 / 198.00 ms | 59.22 / 116.60 ms | **0.871×** | **0.589×** |
| 2560×1440 stationary | 64.87 / 68.60 ms | 59.71 / 66.80 ms | **0.920×** | **0.974×** |
| 2560×1440 orbit | 88.37 / 250.00 ms | 75.50 / 135.30 ms | **0.854×** | **0.541×** |

All 40 runs were nonblank and all four mean ratios pass the 1.10× target. Both
orbit p95s and 1440p stationary p95 pass. The 720p stationary p95 does not: three
of five VLAM runs landed on the next 16.7 ms cadence step while two remained at
50.1 ms. No measured stationary run submitted an SH refresh or sort. A fresh
timestamped diagnostic (`controlled-p95-diag`) then measured 50.1 ms frame p95
for both engines, with median GPU render of 44.34 ms for Spark and 43.71 ms for
VLAM. This makes end-to-end cadence/thermal variability the current evidence,
not a cache refresh stall, but the failed primary p95 remains reported as a
failure rather than being replaced by the diagnostic.

The controlled subset can be reproduced without rerunning proposed cases with
`?suite=1&suitePreset=controlled`; its suite ID was
`e240b4af-93c7-439a-9d6a-1ba7bc3c1955` and label
`final-controlled-M3Air`.

A focused five-pair rerun on 2026-09-09 repeated only the controlled 1280×720
stationary case for 30 seconds per run, alternating renderer order. Median
Spark/VLAM mean frame times were 53.95/53.03 ms (**0.983×**) and median p95s
were 66.70/66.70 ms (**1.000×**), passing the 1.10× gate. All ten runs stayed
focused and visible, all 20 fixed captures were nonblank, and representative
front/orbit images from both engines were visually inspected for framing,
orientation and completeness. Every VLAM sample reported zero measured SH
dispatches and sorts, with no validation error or device loss. The p95 cadence
step affected both engines in every repeat, so the earlier isolated 1.327×
ratio is resolved as run-to-run presentation cadence rather than a VLAM cache
stall or reproducible controlled regression. Raw results are labeled
`M3Air-controlled-p95-resolution-{spark,vlam}-r1` through `r5`.

#### M3 Air dense thermal comparison, 2026-09-09

A 16 GB M3 Air on macOS 26.3.1 ran on AC power with low power mode off in the
foreground in-app Chromium 152 browser. The proposed 1280×720 configuration
used the 8.72M SH3 scene, five seconds of warm-up and a 600-second
orbit sample on commit `9e5e547a10e7045f35636449113c46848d281d48`. The
automatic cache ran first and the explicit vertex control immediately after it:

| SH path | Mean / median / p95 / p99 | Observed FPS | First-minute FPS | Final-minute FPS |
| --- | ---: | ---: | ---: | ---: |
| `auto` → `apple-mac-auto` | 63.78 / 50.00 / 149.90 / 166.70 ms | **15.68** | 15.70 | 15.96 |
| explicit vertex | 143.95 / 133.40 / 200.00 / 216.60 ms | 6.95 | 7.36 | 7.01 |

The cache submitted 2,937 measured SH refreshes, exactly matching its accepted
sorts; it reported no independent cadence refreshes, validation errors or
device loss. Its retained GPU allocation was 34.90 MiB. Both paths retained
complete, nonblank fixed front/orbit captures, which were visually inspected
for framing, orientation and completeness. The automatic path showed no
first-to-final-minute slowdown in this dense orbit soak; the later vertex run's
observed FPS fell 4.7%. Results are the ignored local artifacts labeled
`M3Air-thermal-auto-orbit-600` and `M3Air-thermal-vertex-orbit-600`.

This completes one dense thermal A/B on the M3 Air only. It does not replace
the pending untouched-app UI or other Apple device checks.

#### M3 Air SH3 PLY validation, 2026-09-09

The same M3 Air then exercised two local compressed SH3 PLY captures at the
proposed 1280×720 settings: a 1,000,000-splat medium scene (61,283,093 bytes,
SHA-256 `147cd911…1a5f4`) and a 2,549,179-splat large scene (156,218,684 bytes,
SHA-256 `a1d797cd…db98`). The files and retained images remain ignored local
artifacts; only their identities and results are recorded here.

| Scene / motion | Mean / median / p95 / p99 | Observed FPS | Measured SH / sorts | Cache |
| --- | ---: | ---: | ---: | ---: |
| Medium stationary | 29.95 / 33.30 / 49.90 / 50.00 ms | 33.39 | 0 / 0 | 3.82 MiB |
| Medium orbit | 24.78 / 17.60 / 33.90 / 34.30 ms | 40.36 | 607 / 607 | 3.82 MiB |
| Large stationary | 62.85 / 66.60 / 83.40 / 100.00 ms | 15.91 | 0 / 0 | 9.73 MiB |
| Large orbit | 72.54 / 66.70 / 100.10 / 117.50 ms | 13.78 | 205 / 205 | 9.73 MiB |

All four WebGPU runs resolved `auto` to compute with reason
`apple-mac-auto`, retained complete nonblank fixed poses, and reported no
validation errors or device loss. The medium capture was also checked in the
main viewer while enabling and removing depth of field: the effect engaged and
the unmodified image returned when removed. This covered modifier lifecycle in
addition to the benchmark's stationary/orbit camera lifecycle.

Forced WebGL2 orbit fallbacks resolved `auto` to vertex as
`unvalidated-auto-device`; medium and large runs produced complete nonblank
poses at 42.13 and 14.53 observed FPS respectively. Safari 26.3.1 WebGPU also
resolved the medium orbit to compute, kept SH refreshes paired 768/768 with
sorts, reported no GPU error or loss, and rendered the moving view correctly.
That run exposed Safari returning the previous WebGPU presentation through
onscreen `canvas.toDataURL()`. The harness now captures VLAM WebGPU validation
poses through an offscreen render target and asynchronous GPU readback. A
follow-up Safari run retained distinct, correctly oriented front and orbit
images (611 and 389 nonblack 64×64 samples), closing the capture gap rather
than treating stale screenshots as visual evidence.

These checks complete the medium/large SH-bearing PLY, camera motion,
modifier-lifecycle, WebGL fallback, Safari, and dense thermal portions of the
M3 Air acceptance pass. Additional Apple devices, untouched supplied-app UI
tracing remain open.

Default recommendations remain separate from the benchmark configuration:

- **Source orientation:** retain as an explicit loader/viewer choice. The
  proposed harness needs it for this capture, but one SOG cannot justify a
  library-wide migration.
- **√8 extent:** do not change the current default yet. It matches Spark's
  proposed comparison and reduces coverage, so it needs multi-format silhouette
  and transparency evidence first.
- **Radial sorting:** do not change the current default yet. The M3 smoke result
  remains far from parity and the discrete-GPU/order-precision matrix is pending.
- **Automatic generated color:** retain only the existing narrow Apple/Mac
  cohort and 64 MiB workload guard. Do not expand it until discrete-GPU and
  multi-format checks pass.

```text
/spark-benchmark.html?suite=1&label=RTX4070Ti-Linux-Chrome-AC
/spark-benchmark.html?suite=1&suiteDensity=full&label=M4Max-macOS-Chrome-AC
```

The **compact** suite (the page button, `?suite=1`) is 12 runs: Tempel
proposed stationary/orbit × both engines at 720p and QHD (8), then hotel
proposed stationary/orbit × both engines at 720p only (4). Each compact run
measures 15 seconds. RTX 3090 results showed extra 720p repetitions,
`controlled`, and hotel QHD sitting on the same 16.7 ms vsync floor, so they
are omitted here. `?scene=hotel&suite=1` is the four-run hotel slice alone.
`?suite=1&suiteDensity=full` is the historical 32-run matrix (three 720p
repetitions of proposed/controlled × stationary/orbit × renderer, then QHD)
for the current scene. Renderer order alternates by repetition in the full
matrix. Timestamp instrumentation stays off. Reference, SH0 and timestamped
probes remain available as standalone URLs. Each run gets a fresh page; no
pair of renderers runs concurrently. A browser lock prevents another
comparison page in the same origin from measuring at the same time. Loading
time is excluded.

Keep the Chrome window in front and visible, close other GPU-heavy pages,
use AC power and the same power mode, and avoid resizing or interaction.
Switching tabs resets warm-up and all samples. Some automated or occluded
browser windows throttle even while reporting `visible`; the report includes
focus state and warns about slow callback cadence. Such runs are smoke tests,
not performance evidence. Stop other builds and tests before collecting a
performance baseline. Run the same suite on the RTX 4070 Ti/Linux and M4 Max;
record OS/browser/driver versions and display refresh rate in the label or
alongside the results. Other GPUs cannot validate those devices.

Each completed run automatically saves `result.json`, `front.png` and
`orbit.png` under a unique `.tmp/benchmark-results/` directory. The page also
offers downloads and retains images after disposing GPU resources. Screenshots
are captured outside measurement at fixed 0 and 12-second orbit poses, with
sorting settled first. Results include raw samples, commit/dirty state,
dependency versions, available GPU identity, the live harness `src/` and server
hashes, the packaged `dist/` hash, camera and settings. Package identities in
the supplied-app manifest include shipped `dist/` JavaScript rather than
discarding it with application build output.
Failures stop the suite instead of silently producing fallback measurements.
The artifact-writing endpoint exists only in the dev server, accepts
same-origin JSON with bounded size, and never accepts a destination path.

Read measurements separately:

- **Frame interval / observed FPS:** animation callback cadence, including
  browser scheduling and vsync. This is not physical display presentation.
- **CPU update + render:** synchronous work to update and submit rendering;
  excludes asynchronous workers and waiting for the GPU.
- **VLAM GPU:** all resolved render/compute passes grouped by submitted frame,
  with warm-up and invalidated generations excluded. Idle stationary compute
  is unavailable, not a zero-duration sort. The r185 query-pool adapter checks
  frame identities to reject cached values and has attribution tests.
  Raw `gpuRenderPasses` and `gpuComputePasses` retain the individual resolved
  submissions as well, so a tail can be diagnosed without mistaking a grouped
  total for one kernel.
- **Spark GPU:** every eighth measured synchronous render call, using
  `EXT_disjoint_timer_query_webgl2`. This includes synchronous auto-update GPU
  work but excludes work deferred outside that call and CPU worker execution.
  Disjoint events discard pending samples. No extension means unavailable.

Read median/p95/p99 and sample counts together. Never infer 100 FPS from a
10 ms GPU sample or add render/compute percentiles from different frames.
Use stationary versus orbit to locate motion-related cost; compare half
resolution for pixel-work sensitivity and SH0 for SH sensitivity. These are
diagnostic signals, not proof of a particular shader bottleneck. Inspect both
fixed screenshots and moving output before proposing quality-affecting changes.

### Local findings: RTX 3090 / Windows / Chrome 152

A 32-run suite completed on 2026-09-04, with the interior camera above. These
results do **not** validate the RTX 4070 Ti/Linux or M4 Max/macOS reports.
The original developer's versions, camera and timing method remain unknown.

The table shows the median of three per-run medians, and the median of three
observed FPS values. GPU render excludes the separate compute/worker timings.

| Preset / motion | Spark GPU render | VLAM GPU render | Spark observed FPS | VLAM observed FPS |
| --- | ---: | ---: | ---: | ---: |
| Defaults / stationary | 9.11 ms | 9.44 ms | 59.95 | 58.48 |
| Defaults / orbit | 9.81 ms | 8.19 ms | 58.62 | 59.08 |
| Matched / stationary | 8.96 ms | 7.80 ms | 55.35 | 59.95 |
| Matched / orbit | 9.76 ms | 8.00 ms | 57.29 | 59.95 |

This pose did not reproduce a persistent 2× VLAM disadvantage. One defaults
VLAM stationary run measured 21.10 ms; the other two measured 8.19 and 9.44 ms.
All are retained. Its cause is unproven. Frame intervals were generally
60 Hz paced, with occasional stalls; GPU durations must not be converted into
an uncapped FPS claim.

Half-resolution matched probes measured Spark/VLAM **8.71/8.65 ms** stationary
and **10.14/8.32 ms** orbit. There was no clear reduction from quartering pixel
count. SH0 measured **9.26/7.54 ms** stationary and **10.27/7.34 ms** orbit.
VLAM's SH0 change was modest (about 3–8% relative to the matched baseline
medians); Spark's measured render-call work did not clearly decrease. Spark
can reuse generated data for a stationary camera, and its deferred work is
not fully covered. Each diagnostic has one repetition, so neither proves a
shader bottleneck. Per-splat attribute work, memory traffic and asynchronous
scheduling remain profiling hypotheses.

VLAM orbit compute medians were approximately **9.6–9.9 ms per sorting frame**,
at roughly six sorts per second, consistent with the native 166.67 ms interval
for 8.72 million splats. Stationary compute is unavailable. Spark worker
duration is unavailable. These are materially different sorting schedules.

The local report at `.tmp/benchmark-report-rtx3090-old/findings.md` links all 32
original JSON files and image pairs, including per-run median/p95/p99, CPU
timings and timing coverage. Its `summary.json` preserves compact run metadata.
Suite ID: `97e0fe93-bf08-4ff3-b7eb-a92ffdf5a1b5`.
Private scene captures and results remain ignored local artifacts.

Matched screenshots were visually checked for framing, orientation, color and
completeness. A subsequent capture-only correction waits for Spark's queued
worker sort and VLAM's settled camera before screenshots; fresh verification
captures are separate from the unchanged measured baselines. Fixed images
cannot prove equal sorting latency during motion. One baseline reported lost
focus at completion despite normal cadence; it is flagged in the local report.
Driver/clock/power state was not independently recorded. Repeat on the target
hardware before choosing renderer optimizations.

### Local findings: RTX 3090 / Ubuntu / Chromium 152 WebGPU

A 32-run suite completed on 2026-09-05 on an NVIDIA GeForce RTX 3090, Ubuntu
26.04.1, driver 595.84, Chromium 152.0.7977.64 snap, AC power, label
`RTX3090-Ubuntu-Chromium-AC`, commit
`da461f42d70103417f887f5a0ebd9a8499bc5581`. Spark **2.1.0 / WebGL2** (ANGLE
Vulkan) versus VLAM WebGPU (nvidia/ampere, vertex SH, counting sort) on the
same cached-capture pose and scene hash as the Windows RTX 3090 suite.
These results do **not** validate the RTX 4070 Ti/Linux or M4 Max/macOS
reports. They also do not describe stock snap-Chromium on Wayland: WebGPU
required `--ozone-platform=x11` plus Vulkan/WebGPU flags. An empty-profile
Wayland default failed with no WebGPU adapter (`vkCreateInstance: Found no
drivers`).

The table shows the median of three per-run medians, and the median of three
observed FPS values. GPU render excludes the separate compute/worker timings.

| Preset / motion | Spark GPU render | VLAM GPU render | Spark observed FPS | VLAM observed FPS |
| --- | ---: | ---: | ---: | ---: |
| Defaults / stationary | 6.39 ms | 8.16 ms | 59.92 | 59.92 |
| Defaults / orbit | 7.12 ms | 8.07 ms | 59.85 | 59.92 |
| Matched / stationary | 6.39 ms | 7.83 ms | 59.92 | 59.92 |
| Matched / orbit | 7.24 ms | 7.70 ms | 59.92 | 59.92 |

Both engines sat on the **60 Hz** display cap. GPU render times were a few
milliseconds below the Windows RTX 3090 table; Spark was slightly cheaper on
defaults, matched orbit was close. Frame-interval medians were 16.70 ms with
p95 16.80 ms. All 32 runs stayed focused and visible with no slow-callback
warning. Do not convert GPU durations into an uncapped FPS claim.

Half-resolution matched probes measured Spark/VLAM **6.35/7.79 ms**
stationary and **7.04/7.58 ms** orbit. There was no clear reduction from
quartering pixel count. SH0 measured **6.39/6.32 ms** stationary and
**6.87/6.45 ms** orbit. VLAM's SH0 change was larger than Spark's (about
16–19% relative to the matched GPU-render medians). Each diagnostic has one
repetition.

VLAM orbit compute medians were approximately **2.14–2.29 ms per sorting
frame**, at roughly six sorts per second, consistent with the native 166.67 ms
interval for 8.72 million splats. Stationary compute is unavailable. Spark
worker duration is unavailable.

The local report at `.tmp/benchmark-report-rtx3090-ubuntu/findings.md` links
all 32 original JSON files and image pairs. Its `summary.json` preserves
compact run metadata. Suite ID: `c3ff80c1-2f66-4e0f-862c-6b74159e75af`.
Private scene captures and results remain ignored local artifacts.

Matched screenshots were checked for framing, orientation and completeness.
Fixed images cannot prove equal sorting latency during motion.
Driver/clock/thermal state was not independently recorded beyond AC power.

### Local findings: RTX 3090 / Ubuntu / Chromium 152 WebGL fallback

Same machine, Ubuntu, Chromium snap, AC power, cached-capture pose and scene hash
as the Ubuntu WebGPU suite above. Label
`RTX3090-Ubuntu-Chromium-AC-webgl-defaults`, empty Chromium profile, no
`chrome://flags`, `?backend=webgl`. This is the stock-browser path: both
engines used ANGLE OpenGL ES 3.2, and VLAM used worker sorting
(`sortStrategy: worker`). A 32-run suite completed on 2026-09-06. Not a
replacement for the flagged WebGPU baselines; it is the scenario a default
Ubuntu Chromium user hits when the demo falls back to WebGL.

| Preset / motion | Spark GPU render | VLAM WebGL GPU | Spark observed FPS | VLAM WebGL FPS |
| --- | ---: | ---: | ---: | ---: |
| Defaults / stationary | 6.51 ms | 7.86 ms | 59.95 | 59.95 |
| Defaults / orbit | 6.99 ms | 7.87 ms | 59.48 | 59.88 |
| Matched / stationary | 6.56 ms | 7.51 ms | 59.88 | 59.88 |
| Matched / orbit | 7.16 ms | 7.57 ms | 59.42 | 59.88 |

Observed FPS remained vsync-capped near 60. GPU render times were close to
the flagged WebGPU suite on this GPU. One defaults VLAM stationary run
measured 8.62 ms and one defaults orbit run 8.75 ms; the other two
repetitions were ~7.8–7.9 ms. All are retained.

Half-resolution matched probes measured Spark/VLAM **6.59/7.27 ms**
stationary and **6.97/7.27 ms** orbit. SH0 measured **6.56/6.58 ms**
stationary and **6.77/6.42 ms** orbit. VLAM's SH0 change was similar in
direction to the WebGPU suite; Spark barely moved. Each diagnostic has one
repetition. Worker duration is unavailable. All 32 runs stayed focused and
visible with no slow-callback warning.

The local report at `.tmp/benchmark-report-rtx3090-ubuntu/findings.md` also
links these 32 JSON files and image pairs. Suite ID:
`41d71a6d-ec33-4055-9209-9002d8640f98`.

### Local findings: M3 Air / macOS / Chrome 151

A 32-run suite completed on 2026-09-04 on an Apple M3 MacBook Air (10-core
GPU, 16 GB), macOS 26.3.1, Chrome 151.0.7922.174, AC power, label
`M3Air-macOS-Chrome-AC`, commit `2d721bcc91329bcd2d50dec1a06319d850b09997`.
Spark **2.1.0 / WebGL2** versus VLAM WebGPU on the same cached-capture interior
pose and scene hash as above. These results do **not** validate the RTX
4070 Ti/Linux or M4 Max/macOS reports; M3 Air also does not establish Pro /
Max performance.

The table shows the median of three per-run medians, and the median of three
observed FPS values. GPU render excludes the separate compute/worker timings.

| Preset / motion | Spark GPU render | VLAM GPU render | Spark observed FPS | VLAM observed FPS |
| --- | ---: | ---: | ---: | ---: |
| Defaults / stationary | 80.85 ms | 92.93 ms | 24.15 | 13.02 |
| Defaults / orbit | 89.56 ms | 81.99 ms | 21.29 | 12.07 |
| Matched / stationary | 82.00 ms | 84.67 ms | 23.88 | 12.89 |
| Matched / orbit | 90.72 ms | 77.00 ms | 21.00 | 12.03 |

On this integrated GPU, Spark held a clear **observed-FPS** lead (~21–24 vs
~12–13). VLAM frame-interval medians clustered near ~82 ms. GPU render
medians were much closer: Spark slightly ahead on stationary baselines,
VLAM slightly ahead on orbit render timestamps. Absolute GPU times are
roughly an order of magnitude above the RTX 3090 table; do not convert either
into an uncapped FPS claim. All 32 runs stayed focused and visible with no
slow-callback warning.

Half-resolution matched probes measured Spark/VLAM **76.14/80.67 ms**
stationary and **84.93/73.99 ms** orbit. There was no clear win from
quartering pixel count. SH0 measured **82.04/41.88 ms** stationary and
**83.69/40.57 ms** orbit. VLAM's SH0 change was large (about half the matched
GPU-render median, with observed FPS rising to ~23–27); Spark's measured
render-call work barely moved. Each diagnostic has one repetition.

VLAM orbit compute medians were approximately **28.7–28.8 ms per sorting
frame**, still on the adaptive 166.67 ms interval for 8.72 million splats.
Stationary compute is unavailable. Spark worker duration is unavailable.

The local report at `.tmp/benchmark-report-m3air/findings.md` links all 32
original JSON files and image pairs. Its `summary.json` preserves compact run
metadata. Suite ID: `39a295f2-274f-4334-bdad-01912d86c75f`. Private scene
captures and results remain ignored local artifacts.

Matched screenshots were checked for framing, orientation and completeness.
Fixed images cannot prove equal sorting latency during motion.
Driver/clock/thermal state was not independently recorded beyond AC power.

### Local findings: M3 Air WebGL diagnostic (one repetition)

Same machine, Chrome, AC power, cached-capture pose and scene hash as the M3 Air
suite above. Label `M3Air-macOS-Chrome-AC-webgl-probe`. Eight single-repetition
runs compare Spark WebGL2 with VLAM `backend=webgl` (Three WebGL2 fallback +
CPU worker sort). Not a replacement for the repeated WebGPU baselines.

| Preset / motion | Spark GPU render | VLAM WebGL GPU | Spark observed FPS | VLAM WebGL FPS |
| --- | ---: | ---: | ---: | ---: |
| Matched / stationary | 82.41 ms | 49.46 ms | 23.68 | 22.57 |
| Matched / orbit | 90.74 ms | 88.58 ms | 20.84 | 21.75 |
| Matched SH0 / stationary | 82.24 ms | 46.41 ms | 23.75 | 24.41 |
| Matched SH0 / orbit | 84.39 ms | 78.72 ms | 22.84 | 24.31 |

On this probe, **VLAM WebGL observed FPS matched Spark** (within ~1 FPS), while
the earlier WebGPU suite left VLAM near ~12–13 FPS on the same matched
baselines. Forcing WebGL also switched VLAM to worker sorting
(`sortStrategy: worker`), so this isolates backend + sort placement together,
not SH alone. SH0 barely moved VLAM WebGL FPS (unlike the large WebGPU SH0
gain), which is consistent with WebGL already being closer to Spark before
disabling SH.

Treat GPU-render milliseconds cautiously: both engines use
`EXT_disjoint_timer_query_webgl2` on every eighth frame and exclude worker
time. Artifacts: `.tmp/benchmark-report-m3air/webgl-probe-summary.json` and
the eight run directories under `.tmp/benchmark-results-old/`.

## Existing VLAM settled benchmark

Run `npm run dev`, then open `/render-benchmark.html` on the printed server URL.
Use the same benchmark files in both checkouts when comparing a baseline with
the optimized library. The baseline needs the benchmark harness backported;
an older checkout without this page cannot run these comparisons.

Start each checkout separately with the same command and browser. These URLs
pin the same 800×600 drawing buffer, no MSAA, source SH and 3σ extent:

```text
/render-benchmark.html?scene=/goose.sog&mode=stationary&width=800&height=600&pixelRatio=1&msaa=0&profile=quality&maxStdDev=3&warmup=5&seconds=15&gpuTimestamps=1&label=baseline
/render-benchmark.html?scene=/goose.sog&mode=stationary&width=800&height=600&pixelRatio=1&msaa=0&profile=quality&maxStdDev=3&warmup=5&seconds=15&gpuTimestamps=1&label=optimized
```

Replace `/goose.sog` with the same whole-file scene in both runs. Streamed RAD
must be tested in the main viewer; this harness loads an ordinary `SplatMesh`.
Keep the label descriptive (include the commit if useful). JSON records the
package version, Three revision, actual backend, drawing buffer and resolved SH.

## Modes and measurements

- `mode=stationary` is the default: the camera settles before measurement, so
  frame times do not include continuous re-sorting.
- `mode=orbit` runs the same camera path from elapsed benchmark time. Use it
  for motion and end-to-end frame pacing, not isolated draw performance.
- `backend=webgl` forces the fallback; omission requests WebGPU. Read the
  actual backend in the result. `msaa=0` disables MSAA; omission enables it.
- Switching away invalidates all measurements and restarts the entire warm-up
  on return. Keep the window visible and avoid resizing or interacting.
- GPU queries drain every 30 frames, including warm-up, with one readback batch
  in flight. GPU statistics describe sampled frames, not every rendered frame.
  Samples from warm-up or an interrupted run are excluded. No fresh compute
  queries during a stationary sample means compute timing is unavailable, not
  zero. Unsupported timestamps are also explicitly unavailable.
- Total draw calls include Three's output pass. `splatDrawCallsMedian` counts
  only actual submissions for the splat mesh; one splat draw can therefore
  coexist with two total draws.
- Average FPS is interval count divided by total elapsed interval time. Read
  p95/p99 alongside it; neither callback cadence nor GPU submission proves
  physical display presentation. Vsync-capped FPS can hide a real GPU saving.

Download JSON and the final PNG after each run. The PNG is captured inside the
last render callback and retained independently of the disposed renderer.

## Device validation

For a small, redistributable pixel regression check, open
`/unified-harness.html?effects-check=1` (WebGPU) or append `&backend=webgl`.
The check compares an SH1 fixture with mirrored placement, antialiasing off/on,
relighting off/on, softness changes, and depth-of-field/focus transitions.
It requires disabling effects to restore the original pixels exactly and
checks standalone/unified parity on WebGPU. Retained thumbnails allow inspection.

Verified on Windows Chromium with Three revision 185: both effect checks passed;
standalone/unified WebGPU pixels matched exactly. Normal 5-second warm-up plus
15-second stationary and orbit WebGPU runs completed without timestamp-pool
warnings. The orbit run collected 31 render and 31 compute samples. These are
correctness checks, not a baseline-versus-optimized performance claim. Synthetic
fixtures do not replace visual checks on dense captures or physical Mac testing.
The normal-length WebGL2 run also completed without warnings. Both backends
retained a decoded 800×600 PNG after disposal. Both download buttons completed
(WebGPU needed one retry). The automated browser did not expose saved download
files, so opening the downloaded PNGs from disk still needs a manual check.

On the M3 MacBook Air, run three warmed comparisons per mode on the same
browser, resolution and power configuration. Test Chrome and Safari where
supported, then run `seconds=600` on sparse and dense scenes to check thermal
behavior. Record macOS version, GPU configuration and commit labels with the
exported files. M3 Air results do not establish Pro / Max performance; Apple
Silicon still classifies as a single `integrated` tier today (see
[capabilities § Apple Silicon GPU tiers](capabilities.md#apple-silicon-gpu-tiers-design-not-shipped)).

Compare standalone and unified output with an SH-bearing capture, relighting
off/on (including softness), and depth of field off/on. Orbit around overlap
and silhouette edges; verify switching effects back off restores the image.
Finally repeat Veersetoren in the host viewer with its corrected FPS counter
and record a performance trace if motion still appears uneven. Do not change
quality defaults based on average FPS alone.
