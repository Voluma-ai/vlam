# Rendering benchmark

## Minimal Spark / VLAM comparison

The two standalone pages compare Spark **2.1.0 / WebGL2** with the current
VLAM source on **actual WebGPU**. Spark is a development dependency only.
They share Three.js, the scene bytes, camera, timing session and reporting;
each page loads only its chosen renderer. The older `/render-benchmark.html`
described below remains available with its existing defaults.

```bash
npm install
npm run benchmark:cache
npm run dev
```

Open these paths on the dev server printed by the last command:

```text
/spark-benchmark.html
/vlam-benchmark.html
/spark-benchmark.html?preset=controlled&mode=orbit
/vlam-benchmark.html?preset=controlled&mode=orbit
/vlam-benchmark.html?preset=reference&mode=stationary&backend=webgl
/spark-benchmark.html?scene=hotel&mode=orbit
/vlam-benchmark.html?scene=hotel&mode=orbit
```

The cache command downloads Tempel (`.lcc2` plus its SOG tiles) and the
hotel-core Spark `.rad` once to the ignored `.tmp/benchmark-assets/` directory
and records SHA-256, byte size, splat count, SH bands and canonical camera in
a JSON manifest. Both viewers fetch that same local copy so tile URLs and
`.rad` byte ranges resolve without remote CORS. It also prepares the
repository's small `goose.sog` fixture (`?scene=goose`).
Re-running the command verifies/recreates metadata from the cached bytes;
it does not silently replace the capture with a newer remote asset.

The downloaded Tempel capture has **12,847,768 splats** across five LOD levels
(**6,635,642** at finest) and **SH3**. VLAM streams the `.lcc2` octree cut.
Spark 2.1.0 has no LCC2 reader, so it fully decodes every listed SOG tile (all
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
| `mode` | `stationary` | `stationary`, `orbit`, position-preserving `rotate`, `translate`, or five seconds of orbit then `settle` |
| `shEvaluation` | `auto` | VLAM SH evaluation: `vertex` or generated final `compute`; `auto` selects the latter on identified Apple Silicon Macs |
| `scene` | `Tempel` | Cached `.lcc2` capture, `goose`, or streamed `hotel` (`.rad`) |
| `width`, `height` | `1280`, `720` | Drawing-buffer pixels, at pixel ratio 1 |
| `warmup`, `seconds` | `5`, `30` | Warm-up and measured seconds after initial load/sort |
| `sh=0..3` | source | Benchmark-only SH band cap; `0` is the suite's disabled diagnostic |
| `backend` | `webgpu` (VLAM) | VLAM only: `webgl` forces the WebGL2 + worker-sort fallback. Spark is always WebGL2 |
| `maxStdDev` | preset | Explicit quad extent diagnostic, in Gaussian standard deviations |
| `sortMetric` | preset | `depth` or `radial` |
| `sortStrategy` | library default | VLAM-only `counting`, `radix`, `exact`, or `worker` diagnostic |
| `msaa` | `0` (`1` for `supplied`) | Renderer MSAA control |
| `gpuTimestamps=0` | enabled | Disable timestamp instrumentation; primary suite runs set this to `0` |
| `position`, `target` | cached scene pose | Paired comma-separated world-space vectors |
| `label` | empty | Device, power state or experiment note |
| `suite=1` | off | Sequential suite with local archiving. Compact default is 12 runs (Tempel 720p+QHD plus hotel 720p, proposed, 15 s). `suiteDensity=full` restores the 32-run matrix for the current scene |
| `suitePreset` | proposed (compact) / all (full) | With `suite=1`, run only the proposed or controlled cases |
| `suiteDensity` | `compact` | `full` restores three 720p repetitions of proposed+controlled plus QHD |

The four named configurations are deliberately separate:

| Configuration | Standalone harness behavior |
| --- | --- |
| `supplied` | Reproduces the supplied app's camera and MSAA around otherwise native renderer settings. It is a harness replica, not a replacement for the untouched UI run described below. |
| `proposed` | Spark defaults versus VLAM with source orientation, √8 extent and radial sorting. These are benchmark proposals, not library-default changes. |
| `controlled` | Both engines use √8, radial sorting, full detail, source SH and common color/filter settings. |
| `reference` | Preserves the historical 3σ/depth controlled comparison for regression checks. |

`defaults` remains the old native-default comparison and `matched` is an alias
for the old 3σ/depth `reference` behavior so saved links continue to work.
Spark's global `enableLod` alone does not mean the source has an LOD tree.

These are aligned visual settings, not identical implementations. Spark retains
packed attributes, its native alpha/frustum/radius thresholds and asynchronous
worker sorting. VLAM retains its float covariance pool, SOG SH palette and
adaptive GPU counting-sort schedule. Record those differences when interpreting
motion quality and cost; never change VLAM's default sorter to improve a score.

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
Suite ID: `97e0fe93-bf08-4ff3-b7eb-a92ffdf5a1b5`. The scene hash is
`01c6efa1f802de1426d5e10a1d60923aa88a845d15cff63c2dcf6c0ad2cb6056`.
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
