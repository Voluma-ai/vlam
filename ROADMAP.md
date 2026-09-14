# Roadmap

Open work for **VLAM!**. Work top-down; `[v]` means implemented but awaiting the
named visual or device validation. Completed work belongs in the changelog and
Git history, not in this queue.


## Next

- **Mobile device gate** — validate a non-Pro iPhone 15 and complete the
  thermal and orientation matrix on sparse and dense captures. Galaxy S7/WebGL2
  is a smoke-test floor, not a performance target. Record browser, OS, GPU,
  backend, dataset, splat count, FPS, orbit median / p95 / p99 plus
  missed 16.6 ms and 33.3 ms deadlines; ten-minute thermal soak on one sparse
  and one dense capture; portrait and landscape gaps, discs, popping; A/B
  `?pixelRatio=1`, `0.9`, `0.8` with `?adaptiveDpr=0` before raising
  `maxStdDev`; `?minSplatPx=1.5` vs `3.5`.

## Later

- **1.0 stabilization** — freeze the API, finalize migration notes, changelog,
  and release tag after the checks above pass.

## Post-1.0 opportunities (optional)

These are candidates for future work, not 1.0 release requirements. Preserve
the WebGL2 fallback, the three.js-only library dependency, portable compute,
and the verified rendering math.

- **Spark 2.2-inspired loading and rendering experiments** — benchmark initial
  empty dynamic-pool upload suppression, bounded-threshold RAD traversal,
  incremental remote PLY decoding (exact and approximate SH), and WebGL
  provoking-vertex state. Keep the current sorter, rendering math, and public
  loader behavior. Promote candidates only after matched native-device A/B
  runs and WebGPU/WebGL2 pixel validation. **Status:** empty-pool
  `skip-empty` is now the published default after Apple M3 Chrome hotel
  startup A/B (WebGPU median first-usable 35.19→32.36 s with zero initial
  destination uploads; forced WebGL2 within noise) plus lifecycle probes.
  `VLAM_EXPERIMENT=baseline` still restores the prior upload for benchmarks.
  The bounded-threshold traversal was tested on hotel and a 10.1M-splat RAD with
  five native A/B pairs each; it was slower and fell back repeatedly, so keep
  the heap. Exact remote PLY streaming decoded a generated input past 2 GiB
  with bounded source memory and bit-identical SH0–3, but its OPFS second pass
  was slower on a 47 MB native benchmark; approximate SH clipped late outliers.
  Both remain benchmark-only pending real-capture quality and broader device
  validation. Native Chromium exposed no WebGL provoking-vertex extension on
  the tested NVIDIA path; state and pixel probes passed, but no performance
  conclusion is available. This does not
  replace the mobile gate.

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
  regressed 40.8% interior / 5.8% overview. Langenthal-Manola4A indoor
  (8,724,225 SH3, RTX 3090) wins the mezzanine (paired GPU 11.81 → 7.20 ms,
  21% visible) and missed vsync on the close exterior overview (frame p95
  16.80 → 33.40 ms at 99.9% visible) until `ShComputeCache` stayed active
  under compute projection. With the library adaptive sort cadence the
  overview paired GPU is 18.62 → 11.10 ms and frame p95 returns to 16.80 ms;
  interior compute+cache is 5.23 ms paired against PlayCanvas 5.98 ms
  cull-free. `projectionStrategy: 'auto'` now makes a one-time choice for the
  measured >=8M static SH NVIDIA Ampere cohort, with a 1 GiB configurable
  peak-allocation cap; unknown/unsupported cases retain vertex. The
  default desktop profile is SH-preserving `balanced` (2 px / 3 contribution
  culls), while `quality` remains full detail. Goose still regresses, and
  `sortIntervalMs=0` still refreshes SH every frame so the overview misses
  vsync. The projector records model/view, projection, viewport, active-list,
  content and DoF state, so an unchanged compute view reuses its indirect list
  without falling back to a vertex sort; the native RTX 3090 stationary probe
  records zero sampled projection, cull, sort and SH submissions. An
  intermediate 1.83M SH2 Kauz SOG now exercises the missing scene-size band,
  but its median/tail split rules out a broader automatic cohort on this GPU;
  a second GPU class is still needed before the auto threshold can broaden.
  Shrinking the 52 B/slot
  projection cache toward PlayCanvas' 32 B is separate.
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
| Mobile matrix               | Physical Android device max 4 years old  |
| Reference pixel comparisons | External datasets and viewers            |
