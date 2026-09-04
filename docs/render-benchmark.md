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
/spark-benchmark.html?preset=matched&mode=orbit
/vlam-benchmark.html?preset=matched&mode=orbit
/vlam-benchmark.html?preset=matched&mode=stationary&backend=webgl
```

The cache command downloads Langenthal-Manola4A once to the ignored
`.tmp/benchmark-assets/` directory and records its SHA-256, byte size, splat
count, SH bands and canonical camera in a JSON manifest. Both viewers fetch
that same local copy. This avoids the remote host's missing CORS headers.
It also prepares the repository's small `goose.sog` fixture (`?scene=goose`).
Re-running the command verifies/recreates metadata from the cached bytes;
it does not silently replace the capture with a newer remote asset.

The downloaded Langenthal capture has **8,724,225 splats**, **SH3** and
**121,633,146 bytes**. Langenthal starts at the verified interior origin view,
looking down world -Z; goose is framed from its source center bounds.
A 180° X rotation is applied identically to both meshes. For other views,
set both `position=x,y,z` and `target=x,y,z` in world coordinates. The page's
renderer links preserve the resolved camera, so a pose can be shared exactly.
Both use a 45° vertical field of view, near/far 0.01/10000, black background,
1280×720 drawing buffer, pixel ratio 1, no tone mapping and no renderer MSAA.
Canvas CSS can shrink the displayed image without changing GPU resolution.

### Presets and controls

| Parameter | Default | Purpose |
| --- | --- | --- |
| `preset` | `defaults` | `defaults` or `matched` |
| `mode` | `stationary` | `stationary`, `orbit`, position-preserving `rotate`, `translate`, or five seconds of orbit then `settle` |
| `shEvaluation` | `auto` | VLAM SH evaluation: `vertex` or `compute`; `auto` selects the hybrid cache on identified Apple Silicon Macs |
| `scene` | `Langenthal-Manola4A` | Cached capture, or `goose` |
| `width`, `height` | `1280`, `720` | Drawing-buffer pixels, at pixel ratio 1 |
| `warmup`, `seconds` | `5`, `15` | Warm-up and measured seconds after initial load/sort |
| `sh=0` | source | Separate SH-disabled diagnostic |
| `backend` | `webgpu` (VLAM) | VLAM only: `webgl` forces the WebGL2 + worker-sort fallback. Spark is always WebGL2 |
| `gpuTimestamps=0` | enabled | Timing-overhead control run |
| `position`, `target` | cached scene pose | Paired comma-separated world-space vectors |
| `label` | empty | Device, power state or experiment note |
| `suite=1` | off | Sequential 32-run suite with local archiving |

`defaults` leaves mesh rendering and sorting choices at the library defaults,
with identical host canvas/camera settings. It requests ordinary full-file
loading, without creating a Spark LOD tree. The report records resolved options;
Spark's global `enableLod` alone does not mean the source has an LOD tree.

`matched` requests full detail, source SH, 3σ extent, depth sorting, no
minimum-size enlargement, classic 0.3-pixel² covariance dilation without
opacity compensation, and sRGB compositing. VLAM uses `performanceProfile:
'quality'`, `antialias: false`, `srgbOutput: true` and linear output encoding
to avoid a second sRGB conversion. Spark uses `preBlurAmount: 0.3`,
`blurAmount: 0`, `encodeLinear: false` and disables LOD explicitly.

These are aligned visual settings, not identical implementations. Spark retains
packed attributes, its native alpha/frustum/radius thresholds and asynchronous
worker sorting. VLAM retains its float covariance pool, SOG SH palette and
adaptive GPU counting-sort schedule. Record those differences when interpreting
motion quality and cost; never change VLAM's default sorter to improve a score.

### Repeatable suite and results

For the experimental standalone WebGPU SH cache, compare
`?preset=matched&shEvaluation=vertex&gpuTimestamps=0` with
`?preset=matched&shEvaluation=compute&gpuTimestamps=0`. Repeat each three times,
alternating order, for stationary and orbit modes. The existing 32-run suite
does not perform this SH-path comparison automatically. Reports include the
resolved path and fallback reason, SH/sort dispatch counts, invalidations and
cache bytes; `measuredDispatches` excludes initial preparation and warm-up.
GPU compute timings include both SH preparation and sorting, so use separate
timestamped diagnostic runs and dispatch counts to interpret them.

The demo also accepts `?shEvaluation=compute`; applications can pass
`shEvaluation: 'compute'` to `SplatMesh`. This manual override applies only
to fully loaded standalone WebGPU meshes with SH and sufficient device buffer
limits. It allocates 12 bytes per pool slot and releases its temporary CPU
mirror after initialization. WebGL, SH0, shared/dynamic pools, merged placement,
unified sources and XR retain their existing path. `auto` selects this hybrid
path when both the browser platform identifies macOS and WebGPU adapter details
identify Apple/Metal. Touch-capable desktop-UA devices are excluded so iPadOS
does not enter the cohort. Unidentified adapters retain vertex evaluation. On
moving cameras the cache refreshes with accepted GPU sorts and is reused between
them; content changes remain immediate and stationary cameras incur no dispatch.

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

```text
/spark-benchmark.html?suite=1&label=RTX4070Ti-Linux-Chrome-AC
/spark-benchmark.html?suite=1&label=M4Max-macOS-Chrome-AC
```

The suite runs three repetitions of each preset × stationary/orbit × renderer,
alternating which renderer runs first on successive repetitions (24 runs).
It then runs matched stationary/orbit on both renderers at **640×360**, and
separately at **SH0 with 1280×720** (eight diagnostic runs). These probes do not
replace the repeated baselines. Each run gets a fresh page; no pair of renderers
runs concurrently. A browser lock prevents another comparison page in the same
origin from measuring at the same time. Loading time is excluded.

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
dependency versions, available GPU identity, source hash, camera and settings.
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

The local report at `.tmp/benchmark-report-rtx3090/findings.md` links all 32
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

### Local findings: M3 Air / macOS / Chrome 151

A 32-run suite completed on 2026-09-04 on an Apple M3 MacBook Air (10-core
GPU, 16 GB), macOS 26.3.1, Chrome 151.0.7922.174, AC power, label
`M3Air-macOS-Chrome-AC`, commit `2d721bcc91329bcd2d50dec1a06319d850b09997`.
Spark **2.1.0 / WebGL2** versus VLAM WebGPU on the same Langenthal interior
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

Same machine, Chrome, AC power, Langenthal pose and scene hash as the M3 Air
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
the eight run directories under `.tmp/benchmark-results/`.

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
