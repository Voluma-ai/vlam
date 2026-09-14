# Empty-pool optimization: Apple Silicon handover

## Outcome (14 September 2026)

**Promoted.** `experiments.initialPoolUpload` is now `'skip-empty'`. Matched
hotel A/B on Chrome 151 / macOS 26.3.1 / Apple M3 (WebGPU `apple`/`metal-3`)
met the acceptance criteria: zero initial destination uploads, identical
1,501,184 capacity with 999,999 active, staging copies retained, lifecycle
probes green, WebGPU median first-usable 35.19→32.36 s, WebGL2 within noise.
Evidence: `.tmp/pool-native-scene-{webgpu,webgl}-five-pairs.json` and
`.tmp/empty-pool-apple-silicon/`. See `docs/render-benchmark.md`.

## Validation protocol (completed before promotion)

Validate `experiments.initialPoolUpload = 'skip-empty'` on a native Apple
Silicon Chromium WebGPU device and forced WebGL2. The candidate skips only the
initial CPU upload of a newly allocated, private dynamic pool. It must not
change texture allocation, later staged row uploads, pixels, picking, or any
static/shared-pool path.

The published default remained `existing` until these steps passed.

## Evidence already collected

The cached hotel RAD is
`413381d93b452a77d75e7998f89836db0df740127f995bf94f4d5126a129f773`
(202,177,968 bytes), using its canonical camera, SH3 and a 1,000,000-splat
budget.

On the desktop test device, five alternating full-scene WebGPU runs reached a
median first-usable frame of 38.73 s for existing behavior and 34.60 s for
skip-empty. Five forced-WebGL2 runs were effectively neutral (36.67 s versus
36.54 s). Every skip-empty run made zero initial destination CPU uploads;
existing behavior made eight, totaling 174,137,344 bytes. Reports are ignored
under `.tmp/pool-native-scene-*-five-pairs.json`.

## Setup

1. Use native Chrome or Chromium on an Apple Silicon Mac. Record the exact
   browser version, macOS version, and GPU/adapter identity. Do not use a
   remote desktop or hidden tab: background throttling invalidates startup
   timings.
2. Run `npm install`, then `npm run benchmark:cache`. Verify the hotel hash in
   `.tmp/benchmark-assets/hotel.json` before measuring. Do not substitute a
   newer download.
3. Start two independent benchmark servers, one in each terminal:

   ```bash
   VLAM_EXPERIMENT=baseline npm run benchmark:dev -- --host 127.0.0.1 --port 4187
   VLAM_EXPERIMENT=skip-empty npm run benchmark:dev -- --host 127.0.0.1 --port 4188
   ```

4. Use this identical query on each server, changing only its port:

   ```text
   /memory-benchmark.html?kind=streamed&scene=/benchmark-assets/hotel/HOTEL.clean.comp-lod.rad&budget=1000000&maxBudget=1000000&settleMinActive=500000&settleSeconds=25&position=56.68,14.91,0.48&target=-33.32,-5.1,0.48&startupMetrics=1
   ```

   For the WebGL2 pass add `&backend=webgl`.

## Measurement protocol

1. Open one foreground tab per run and wait for **Complete**. Save the JSON
   report and a fixed-pose canvas screenshot before closing it.
2. Make five alternating pairs: baseline → skip-empty, then skip-empty →
   baseline, continuing to alternate the leading variant. Keep the same Chrome
   profile, cached source bytes, camera, query, resolution, and no competing
   GPU work.
3. Record each report’s `scene.startup`, `scene.startupTransfers`, active
   splat count, capacity, load failures, and device errors. The report must
   show the selected experiment and backend.
4. Repeat the complete five-pair protocol with forced WebGL2.
5. Run the existing browser lifecycle checks for both variants:

   ```bash
   VLAM_EXPERIMENT=skip-empty npm run test:browser -- browser-tests/empty-pool.spec.ts
   VLAM_EXPERIMENT=baseline npm run test:browser -- browser-tests/empty-pool.spec.ts
   ```

   Manually inspect empty → append, append-before-first-render, disjoint
   appends, reuse, clear, and compaction at a fixed pose. Confirm static meshes
   and supplied shared pools still have their original initialization.

## Acceptance and decision criteria used

Promotion requires all of the following on Apple Silicon:

- eligible pools make zero initial destination CPU uploads; the four core and
  allocated packed-SH textures still allocate at identical dimensions/types;
- staged CPU uploads and staging-to-destination copies remain present for
  post-construction rows;
- active counts, screenshots, pixels, picking, and device errors match;
- no repeatable regression in median first-usable time or frame-time tail on
  either backend.

If every criterion passes, change the production value in
`src/lib/internal/experiments.ts` to `initialPoolUpload: 'skip-empty'`, retain
the benchmark-only baseline alias, add a changelog entry, and update
`docs/render-benchmark.md` plus `ROADMAP.md` with the Mac environment, paired
table, report/screenshot paths, and final outcome.

If any criterion fails, retain the experiment default and document the backend
or device-specific failure. Do not broaden the gate to static pools, supplied
pools, palette textures, channels, or generic texture helpers.
