# Roadmap

Open work for **VLAM!**. Work top-down; `[v]` means implemented but awaiting the
named visual or device validation. Completed work belongs in the changelog and
Git history, not in this queue.


## Next

- **1.0 stabilization** — freeze the API, finalize migration notes, changelog,
  and release tag. The non-Pro iPhone 15 device gate is recorded in
  `docs/capabilities.md`. Galaxy S7/WebGL2 remains a smoke-test floor, not a
  performance target.

## Post-1.0 opportunities (optional)

These are candidates for future work, not 1.0 release requirements. Preserve
the WebGL2 fallback, the three.js-only library dependency, portable compute,
and the verified rendering math.

- **Cheaper exact RAD frontier traversal** — profile selection, heap draining,
  output construction and gathering separately. Replace the final ordered heap
  drain with a linear scan, then evaluate reusable heap/output storage. Preserve
  the selected global-ID set, coverage and hard budget; verify any change to
  output order does not increase pager churn or alter pixels. **Acceptance:**
  measure complete traversal distributions and camera-to-published-detail latency
  on hotel and the larger RAD, including navigation, with no frame-tail or
  coverage regression. The threshold prototype was slower and repeatedly fell
  back; keep the current heap selection policy.
- **Reduce padded staging uploads** — compare the current power-of-two staging
  buckets with reusable fixed-height tiles that upload fewer unused rows.
  **Acceptance:** count CPU upload bytes separately from GPU copies, measure
  call overhead and startup/orbit p95/p99 on WebGPU and WebGL2, and preserve
  atomic swaps, row clearing and SH alignment. Do not restore the exact-size
  texture-allocation churn previously eliminated by the bucket cache.
- **Earlier complete coarse RAD display** — publish the first complete, fully
  staged coarse cut before waiting for all requested detail, then refine through
  the existing atomic replacement path. **Acceptance:** improve first complete
  image latency with startup memory probes disabled; measure target-detail time
  separately. Verify no holes, parent/child overlap, bright flashes, cache churn
  or starvation during camera motion. A lower active-count test threshold alone
  is not an implementation of this behavior. **Current status:** page-table RAD
  now defaults to progressive first publication of a complete cover, with the
  50% allocation gate reserved for incoming crossover captures. Equivalent
  nearby-detail timing versus Spark 2.1 is still the acceptance metric.
- **Exact remote PLY streaming efficiency and scale validation** — compare
  1/4/16 MiB windows and spooling only higher-order SH values instead of full
  vertex records. Retain exact global SH quantization. **Acceptance:** real
  500 MB–multi-GB SH-bearing vertex payloads, exact decoded-array parity,
  version-2 input/scratch accounting, disk traffic, load time and cancellation
  cleanup on multiple devices. The >2 GiB padding test proves offset handling,
  not a large SH payload. Keep the loader benchmark-only until measurements
  justify promotion; approximate SH clipped late outliers without a speed win.
- **Independent empty-pool startup timing** — retain the verified published
  `skip-empty` default and its static/shared-pool exclusions. Repeat native
  hotel A/B using `startupMetrics=1` (which disables browser-wide memory
  measurement), recording first visible and target-active-count milestones
  separately from settled detail. Earlier full-scene startup numbers included
  memory-checkpoint pauses and cannot isolate the upload saving; isolated
  native pool timings improved 109.2→83.3 ms and eliminated all eight initial
  destination uploads. Keep WebGPU/WebGL2 lifecycle and pixel checks.
- **WebGL provoking-vertex evidence** — retain the benchmark-only adapter until
  a native device exposes the extension and a relevant flat-varying shader path
  is available. **Acceptance:** repeatable rendering improvement beyond noise,
  unchanged pixels and picking, and restored mixed-scene GL state. The tested
  NVIDIA path did not expose the extension; there is no default change to make.

Brush lifecycle or stale-pick fixes discovered during existing selection
validation fit stabilization. Defer new storage modes, rendering paths, and
selection features until their benefits are measured and visually validated.

- **Experimental radix sorter: r186 workgroup atomics** — after the separate
  upgrade establishes three.js r186 as the minimum supported version, replace
  the global-storage ranking bitmasks in
  [`radix-sorter.ts`](src/lib/core/radix-sorter.ts) with atomic workgroup arrays.
  Target lower global-memory traffic and GPU scratch allocation while preserving
  stable ranking and portable synchronization; never rely on cross-workgroup
  execution order. **Acceptance:** compare GPU sort time, scratch memory, and
  frame-time tails against the current radix implementation; verify exact index
  coverage, depth ordering, and equal-key stability, including partial workgroups.
  Visually validate standalone/unified rendering and confirm WebGL2 fallback
  non-regression. Keep radix experimental and retain the default counting sorter
  until measurements justify a separate policy change.
- **Cull before sorting and compute projection** — prototype a WebGPU path
  that builds a dense visible-splat list before sorting, uses its GPU count
  for indirect dispatch/draw, and evaluates projection once per splat. VLAM
  already sorts on the GPU; the opportunity is reducing the sorted/drawn work
  and repeated vertex projection. **Acceptance:** compare GPU time, memory,
  and frame-time tails against the current path on interior views and views
  with most splats visible. Verify footprint-aware edge culling, exact index
  coverage, standalone/unified rendering, and per-view/XR correctness. Keep
  the current path until the additional compute/storage cost earns its place.
  **Prototype status:** implemented as the experimental
  `projectionStrategy: 'compute'` opt-in for standalone and unified mono
  WebGPU. Exact dense coverage, footprint-aware edge culling, indirect
  arguments, pixels, WebGL2 fallback and XR fallback have automated coverage.
  Goose (149k, no SH) failed the first evidence gate: paired GPU median
  regressed 40.8% interior / 5.8% overview. An 8,724,225-splat SH3 SOG on an
  RTX 3090 wins the interior (paired GPU 11.81 → 7.20 ms,
  21% visible) and missed vsync on the close exterior overview (frame p95
  16.80 → 33.40 ms at 99.9% visible) until `ShComputeCache` stayed active
  under compute projection. With the library adaptive sort cadence the
  overview paired GPU is 18.62 → 11.10 ms and frame p95 returns to 16.80 ms;
  interior compute+cache is 5.23 ms paired against PlayCanvas 5.98 ms
  cull-free. `projectionStrategy: 'auto'` now makes a one-time choice for the
  measured >=8M static SH NVIDIA Ampere cohort, with a 1 GiB configurable
  peak-allocation cap; unknown/unsupported cases retain vertex. The
  `balanced` remains an explicit SH-preserving performance profile (2 px / 3
  contribution culls), while desktop defaults to full-detail `quality`. Goose
  still regresses, and
  `sortIntervalMs=0` still refreshes SH every frame so the overview misses
  vsync. The projector records model/view, projection, viewport, active-list,
  content and DoF state, so an unchanged compute view reuses its indirect list
  without falling back to a vertex sort; the native RTX 3090 stationary probe
  records zero sampled projection, cull, sort and SH submissions. An
  intermediate 1.83M SH2 SOG exercises the missing scene-size band,
  but its median/tail split rules out a broader automatic cohort on this GPU;
  a second GPU class is still needed before the auto threshold can broaden.
  Cache compaction is tracked separately below.
- **Compact compute-projection storage** — reduce the current 52 B/slot
  projection cache, targeting 32 B/slot where precision permits. Keep the
  existing projection eligibility policy while comparing retained/peak memory,
  GPU bandwidth and frame-time tails. **Acceptance:** projection, clipping,
  DoF, SH, picking and standalone/unified pixel parity on native devices; a
  smaller allocation alone does not justify a broader automatic cohort.
- **Stochastic transparency during movement** — experiment with opt-in
  sort-free fragment coverage while navigating heavy scenes, then restore
  sorted blending when motion settles and for captures. Any automatic policy
  must distinguish sorted-frame timings from stochastic-frame timings and
  define behavior without GPU timestamps. **Acceptance:** measure navigation
  gains and inspect noise, transition quality, picking, mesh compositing, and
  stereo behavior. Include fragment-bound devices; skipping sorting alone
  does not guarantee an improvement. Do not change the default without evidence.
- **Orthographic rendering and inspection views** — extend the shared
  perspective-only projection for plan/elevation views, including clipping,
  depth sorting, SH view direction, and picking. Reference
  [SuperSplat's orthographic fix](https://github.com/playcanvas/supersplat/pull/1022).
  **Acceptance:** same-camera reference captures outside and inside scene
  bounds, correct projected size and picked positions, and perspective
  non-regression on WebGPU, WebGL2, and unified rendering.

## External blockers

| Work                        | Blocker                                  |
| --------------------------- | ---------------------------------------- |
| Reference pixel comparisons | External datasets and viewers            |
