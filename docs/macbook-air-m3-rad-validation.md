# MacBook Air M3: large RAD validation and handoff

This is an executable engineering validation plan for a fresh session on a
MacBook Air M3. Review date: 2026-09-15. Read `AGENTS.md`,
[architecture](architecture.md), and `CONTRIBUTING.md` before starting.
Work in this repository; resolve its path on the Mac instead of using the
Linux checkout path. Keep private captures and raw results in ignored `.tmp/`.

## Goal and current status

Validate the original 106M-splat Poland crash and nearby-detail complaint on
Apple hardware, and decide whether the benchmark-only indexed RAD pager is
safe and beneficial. Production must retain the classic pager until this gate
passes. Do not combine the `rad-indexed` and `rad-focus` experiments, lower
quality to manufacture a win, change global defaults, or publish a release.

The reviewed starting point was `a9d56de` plus uncommitted indexed-pager,
focused-demand, comparison-harness and documentation changes. A commit ID alone
does not identify that candidate. Before running, verify that the transferred
revision includes `scripts/rad-detail-benchmark.mjs`,
`src/lib/formats/rad/indexed-frontier-pager.ts`, and this document. Record HEAD,
the working-tree diff and lockfile hash. Do not discard local changes.

The earlier swap-event attribution review is fixed: the benchmark filters
ordinary per-frame events. The current unit suite has 1,666 passing tests on
Linux. That does not validate Apple GPU behavior. Existing Linux results are
diagnostic; particularly, the recorded Poland movement claims need rerunning
after the route corrections below.

## 1. Fix these review blockers before measuring

Make focused fixes with regression tests, or verify that the transferred
revision already contains them. Keep runtime and harness fixes separately
reviewable. These are full review findings, not just inline-comment titles.

1. **Match publication acknowledgments to the candidate's active-list version.**
   `StreamedSplatMesh.onActiveListPublished(_activeListVersion)` ignores its
   argument and acknowledges whichever indexed candidate is pending. An older
   CPU-sort snapshot can finish after a newer candidate arrives; acknowledging
   that old snapshot releases slots still referenced by the visible old cut.
   Save the candidate's active-list version when replacing its indices, and
   acknowledge only its matching backend publication. Ensure that simply
   reading `getUnifiedSourceView()` does not acknowledge an unsubmitted draw.
   Test delayed older sort replies, camera-only sorting in flight, staged
   candidates, real unified gather/publication, disposal, and slot reuse with
   SH/custom channels. Assert both no premature ACK and eventual progress.

2. **Correct and validate movement, then measure movement separately.**
   The original Poland manifest has identical camera/target X and Z. Both the
   orbit's horizontal radius and the yaw route's horizontal direction are zero,
   so neither exercises navigation. Furthermore, `rad-detail-benchmark.mjs`
   filters frame intervals starting at `stopAt`, excluding the movement itself.
   Use the oblique detail pose below; fail before running a degenerate route.
   Record actual start/end timestamps and sampled camera positions/directions.
   Emit distinct motion and post-stop frame statistics. Tests must prove a
   nonzero orbit path, a changing turn direction, and attribution of a slow
   frame during motion. Relabel the previous no-motion results as invalid for
   the continuous-motion gate in `docs/formats/rad-notes.md`.

3. **Reject unfinished references for every RAD scene.**
   The runner's `runStillPending` currently checks pager convergence only when
   `scene === 'lcc'`; Poland can have zero pending fetches while its pager still
   stages or awaits publication. Test Poland and hotel as well. Reference
   readiness must require no outstanding fetch/decode work, no pending pager
   writes, no candidate awaiting publication, and the matching backend sort
   publication. Require a stable image over a further two-second observation.
   Zero pending downloads, active count, or `pager idle` alone is insufficient.
   A timeout or unfinished reference yields a failed/inconclusive run, not a
   latency number; external references need matching provenance/readiness too.

Before performance collection, also separate browser-wide memory measurement
from timing. This is done: `scripts/rad-detail-benchmark.mjs` defaults to
`--memory=off` and timestamps/screenshots before any
`measureUserAgentSpecificMemory()` call. Use `--memory=sample` only in
separate memory runs. `--sampleMs` is sampled through its requested endpoint
rather than stopping at the historic 60 s table. Page errors, renderer device
loss, streaming errors, and runs that never show a first image are recorded as
failed rows with a null arrival number. Do not revert to awaiting browser-wide
memory before the capture window.

Run focused tests after these changes. Retain production behavior when an
experiment is off. Do not proceed to performance claims with an unresolved
publication correctness failure.

## 2. Prepare the Mac and identical local assets

Use installed Google Chrome, headed, with the tab visible. Record macOS and
Chrome versions, M3 GPU/core count, RAM, display refresh rate, viewport, AC/battery
state, Low Power Mode, renderer backend and adapter information. Start plugged
in with Low Power Mode off; keep those conditions fixed. Close other heavy
renderer tabs. Do not run builds/tests during native measurements. A software
adapter is not a native pass. Safari is a separate compatibility check below.

From the repository root:

```sh
git status --short
git rev-parse HEAD
shasum -a 256 package-lock.json
npm ci
npx playwright install chromium
export VLAM_HARDWARE_CHROMIUM='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
test -x "$VLAM_HARDWARE_CHROMIUM"
mkdir -p .tmp/m3-rad-validation .tmp/benchmark-assets/poland
```

Reuse the existing file only after streaming SHA-256 verification. Otherwise
download the supplied private test asset to the ignored cache; never add it to
Git. It is 2,754,121,856 bytes, SHA-256
`375af16fec68eea208a0e4df45ed3b25ea83eb22ffff8eeccb48df4bc42cc2d3`.

```sh
curl --fail --location --retry 3 \
  'https://assets.voluma.ai/voluma/andrii-shramko/20K-Photo-103Mspats-4x2KM-Andrii_Shramko_Poland-JG-lod.rad' \
  --output .tmp/benchmark-assets/poland/scene.rad
shasum -a 256 .tmp/benchmark-assets/poland/scene.rad
```

Do not continue on a hash mismatch. Do not overwrite an existing verified
capture just to match this filename: adjust `file` in the manifest instead.
Create ignored `.tmp/benchmark-assets/poland.json` with:

```json
{
  "source": "https://assets.voluma.ai/voluma/andrii-shramko/20K-Photo-103Mspats-4x2KM-Andrii_Shramko_Poland-JG-lod.rad",
  "file": "poland/scene.rad",
  "sha256": "375af16fec68eea208a0e4df45ed3b25ea83eb22ffff8eeccb48df4bc42cc2d3",
  "bytes": 2754121856,
  "count": 106447647,
  "nodes": 151581987,
  "shBands": 0,
  "camera": {
    "position": [-214.99839, 91.81185, 511.78408],
    "target": [-245.7515, 67.35565, 475.72524]
  }
}
```

This uses the user's detail-link camera position and target, in source basis.
Confirm the actual framing against the supplied Spark view before freezing the
reference. Preserve a copy of any pre-existing manifest. Use the documented
top-down overview only as an overview; never use it for the horizontal orbit.
Prepare hotel/goose with `npm run benchmark:cache`; use an available small PLY
and an SH-bearing fixture for regressions. Missing private fixtures are named
blockers, not substitute passes.

## 3. Baseline and candidate matrix

Start separate servers in separate terminals; leave each running. Both variants
come from the same reviewed source and lockfile, differing only in the
compile-time experiment. `rad-focus` is excluded from this pager comparison.

```sh
VLAM_EXPERIMENT=baseline npm run benchmark:dev -- --host 127.0.0.1 --port 4188 --strictPort
```

```sh
VLAM_EXPERIMENT=rad-indexed npm run benchmark:dev -- --host 127.0.0.1 --port 4189 --strictPort
```

Confirm the JSON reports classic on 4188 and indexed on 4189. A reservation
fallback to classic is compatibility evidence, not an indexed result. These
benchmark builds both use `initialPoolUpload: existing`; production uses
`skip-empty`. Separately smoke-test the ordinary demo so this difference is
not mistaken for production startup behavior.

Use 1280×720, DPR 1, adaptive DPR off, source orientation, the same camera/FOV,
draw budget and 768 MiB decoded-cache allowance. Start at 1M drawn splats, then
repeat at 4M. Keep 4M as an explicit stress case, not an M3 default. Report
resource exhaustion and stop the failing case; do not silently lower its
budget or raise cache to pass. Do not infer total RAM from the pool estimate:
record actual memory pressure and process footprint in separate runs.

For each budget, generate and visually inspect a fully settled **classic**
reference at the detail pose, then copy its final PNG to a stable path under
`.tmp/m3-rad-validation/`. Start with central RGB MAE 0.25; if repeated settled
baseline images exceed this noise floor, calibrate and record one threshold
before comparing candidates. Never retune it per variant or include HUD pixels.

After the runner repairs above, use this command pattern for each variant,
budget and cache mode, substituting the correct reference:

```sh
node scripts/rad-detail-benchmark.mjs \
  --base=http://127.0.0.1:4188 --scene=poland --label=m3-classic-1m-cold \
  --budget=1000000 --allowanceMB=768 --backend=webgpu --memory=off \
  --routes=direct,overview-fly,turn-return,orbit --runs=5 --cacheMode=cold \
  --sampleMs=60000 \
  --reference=.tmp/m3-rad-validation/classic-1m-reference.png --thresholdMae=0.25
```

Use 4189 for indexed, repeat with `--cacheMode=warm`, then with budget 4000000
and its own reference. Alternate variant order across repetitions to reduce
thermal bias. Warm HTTP priming is done: the runner issues one unmeasured first
route load, writes it to `prime.json`, then records `--runs` measured loads.
Those measured pages reuse the browser HTTP cache only; decoded GPU/JS scene
state is not retained (`decodedSceneCache: "fresh-page"`). Compare both actual
motion tails and stop-to-equivalent-detail latency. Keep all failed runs in
the denominator and report timeouts rather than dropping slower runs.

Run matched Spark 2.2 comparison pages against the same cached file, position,
target, FOV and draw target using [render benchmark settings](render-benchmark.md).
Check framing and settled pixels. The current detail runner is VLAM-only;
extend the same route/measurement protocol to Spark before reporting a numeric
Spark arrival ratio. A different selected count or visible quality is not an
equivalent-detail performance comparison.

## 4. Stability, compatibility and decision

- For classic and indexed WebGPU, run three independent 10-minute stationary
  tests and three 10-minute navigation tests at 4M after the 1M smoke passes.
  Use a no-screenshot/no-memory-probe timing loop. Repeat the verified orbit,
  turn-and-return, and overview/detail transitions throughout navigation;
  record camera movement, frame intervals, device loss, cache/refetch trends
  and first-versus-last-minute performance. Allow the machine to cool between
  variants and record the order. A one-minute run is not a soak substitute.
- Separately collect memory at startup, settled view, after repeated travel,
  and after disposal. Distinguish estimates, JS heap, process memory, and
  system memory pressure; unavailable browser-wide memory is `null`, not zero.
- Repeat a small scene, PLY and SH-bearing scene visually on native WebGPU and
  forced WebGL2. On Poland, run direct, orbit and turn-return WebGL2 cases at
  1M for both pagers, including delayed-sort publication stress. Verify no
  parent/child overlap, holes, stale indices, colour changes or SH/channel drift.
- Exercise direct/unified WebGPU parity at the detail pose using
  `/rad-parity-harness.html?url=/benchmark-assets/poland/scene.rad&budget=1000000&cameraPosition=-214.99839,91.81185,511.78408&cameraTarget=-245.7515,67.35565,475.72524&settleMs=60000`.
  Inspect captures and index coverage; a nonblank image or an arbitrary MAE
  value alone does not pass parity. Repeat at 4M only after the smaller pass.
- Open the ordinary local demo in Safari for default-policy and forced-WebGL2
  smoke tests at the same small/detail views. Record the actual backend; do not
  silently accept a fallback as WebGPU validation. Keep browser-specific
  failures separate from Chrome results. Safari automation being unavailable
  is a manual-validation blocker, not permission to omit the result.

Require no device loss, invalid sort coverage, visible corruption, persistent
refetch oscillation, or unbounded settled resource growth. For promoting indexed,
require no greater than 10% regression in paired median frame p95/p99 during
motion or after stopping, no new repeated >50 ms upload/publication hitch, and
an earlier equivalent-detail median with all runs reaching the audited quality.
Report per-run outliers, not just median-of-percentiles. Any unresolved failure
keeps indexed benchmark-only. The original crash can be considered addressed
on M3 only after default-demo navigation and the soak cases pass; Linux Vulkan
device-loss reproduction remains a separate platform question.

Before finalizing, run the repository checks:

```sh
npm test
npm run test:browser
npm run lint
npm run build
npm run docs:check
npm run docs:samples
npm run test:browser:hardware
```

The ordinary browser suite uses software adapters; the hardware suite is a
separate projection/SH regression check and does not replace the RAD matrix.
If proposing a push, follow the repo's preflight and pinned Linux browser gate.

Write `.tmp/m3-rad-validation/report.md` with hardware/provenance, repaired
findings, commands, settings, valid/failed run counts, per-run and paired
results, image links, memory figures, soak results and an explicit
pass/fail/blocked decision for each gate. Add a concise non-private summary to
`docs/formats/rad-notes.md`, correcting the invalid prior movement claims.
Do not commit raw scenes/screenshots or promote the experiment automatically.
