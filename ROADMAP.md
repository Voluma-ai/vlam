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

- **RAD limit feedback** — assess refinement pacing during the RAD headed comparison.
- **1.0 stabilization** — freeze the API, finalize migration notes, changelog,
  and release tag after the checks above pass.

## Post-1.0 opportunities (optional)

These are candidates for future work, not 1.0 release requirements. Preserve
the WebGL2 fallback, the three.js-only library dependency, portable compute,
and the verified rendering math.

For 1.0, the most useful early work is a memory baseline and small fixes for
unnecessary retained copies that it identifies. Brush lifecycle or stale-pick
fixes discovered during existing selection validation also fit stabilization.
Neither adds a release gate; defer new storage modes, rendering paths, and
selection features until their benefits are measured and visually validated.

- **Lower retained scene memory** — measure peak loading memory, settled CPU
  backing, and GPU allocations separately on representative static and streamed
  scenes. GPU scratch mirrors are already released; local PLY input already
  uses windowed reads. Target remaining scene-data copies and investigate an
  opt-in rendering-only storage mode. Retain data needed by CPU queries,
  painting, pool compaction, and WebGL2 sorting. **Acceptance:** demonstrate
  lower peak or settled memory against a recorded baseline, with lifecycle,
  query, editing, and fallback checks. Upstream JS-heap savings are not a
  total-memory estimate or a predicted VLAM gain.
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
  Five alternating Windows/NVIDIA runs met the requested 27.4% interior and
  100% overview visibility bands, but failed the evidence gate: paired GPU
  median regressed 40.8% and 5.8%, respectively, while frame p95 did not
  improve. The 7.77 MB steady cache also remains an explicit cost. A larger
  supported capture is still needed to measure nonzero adaptive cadence;
  `'vertex'` remains the default.
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
