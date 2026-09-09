# Roadmap

Open work for **VLAM!**. Work top-down; `[v]` means implemented but awaiting the
named visual or device validation. Completed work belongs in the changelog and
Git history, not in this queue.


## Next

- **Automatic Apple Silicon SH cache** — implemented and unit-tested. The
  default `auto` path selects compute evaluation only for the identified Apple
  cohort; it is not a completed device-validation claim. **Evidence:** targeted
  browser probes and the retained benchmark protocol. **Acceptance:** inspect
  SH-bearing PLY captures at medium and large sizes through camera motion,
  lifecycle and fallback paths, then run a thermal comparison. **Open issue:**
  stationary p95 remains unresolved. **Blocker:** physical Apple devices and
  representative captures. See the [protocol](docs/render-benchmark.md).

## Later

- **Mobile device gate** — validate a non-Pro iPhone 15 and complete the
  thermal and orientation matrix on sparse and dense captures. Galaxy S7/WebGL2
  is a smoke-test floor, not a performance target. Record browser, OS, GPU,
  backend, dataset, splat count, FPS, orbit median / p95 / p99 plus
  missed 16.6 ms and 33.3 ms deadlines; ten-minute thermal soak on one sparse
  and one dense capture; portrait and landscape gaps, discs, popping; A/B
  `?pixelRatio=1`, `0.9`, `0.8` with `?adaptiveDpr=0` before raising
  `maxStdDev`; `?minSplatPx=1.5` vs `3.5`.
- **Streamed spherical harmonics** — blocked on an SH-bearing streamed capture
  and headed `?sh=0` versus `?sh=N` validation.
- **Multi-mesh budget** — visually validate several RAD meshes sharpening as the camera moves.
  See the [multi-mesh guide](docs/guide/multi-mesh-budgets.md).
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
- **Cull before sorting and compute projection** — prototype a WebGPU path
  that builds a dense visible-splat list before sorting, uses its GPU count
  for indirect dispatch/draw, and evaluates projection once per splat. VLAM
  already sorts on the GPU; the opportunity is reducing the sorted/drawn work
  and repeated vertex projection. **Acceptance:** compare GPU time, memory,
  and frame-time tails against the current path on interior views and views
  with most splats visible. Verify footprint-aware edge culling, exact index
  coverage, standalone/unified rendering, and per-view/XR correctness. Keep
  the current path until the additional compute/storage cost earns its place.
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
- [v] **Surface-aware brush and selection precision** — implemented with
  continuous depth-picked strokes, discontinuity splitting, independent
  visible-surface/through and footprint/center controls, and a bounded batched
  pick pass. References:
  [sphere brush](https://github.com/playcanvas/supersplat/pull/1024) and
  [selection controls](https://github.com/playcanvas/supersplat/pull/1020).
  Keep the two decisions orthogonal: `surface` limits a stroke to the visible
  depth corridor while `through` takes every intersected Gaussian; `center`
  tests means while `footprint` tests the full VLAM ±3σ covariance ellipsoid.
  Existing point-radius APIs retain their current center-based behavior.
  See the [implementation notes](docs/surface-aware-selection.md). Static and
  classic streamed LOD painting are covered; RAD page-table painting remains
  disabled until its worker protocol can apply channel edits by global splat ID.
  **Remaining validation:** on WebGPU and forced WebGL2, inspect thin surfaces,
  foreground/background boundaries, grazing large anisotropic splats,
  transformed meshes, and small plus largest available static/streamed
  captures. A continuous stroke must have no sample gaps, never cross a depth
  discontinuity, and give visibly distinct, correct results for all four
  depth × footprint modes. Camera/tool/scene/pointer changes during readback
  cannot corrupt the edit, and a painted streamed region remains painted as
  its LOD and residency change. Record stroke latency and retained edit memory,
  then run the full headless verification bar.

## External blockers

| Work                        | Blocker                                  |
| --------------------------- | ---------------------------------------- |
| Mobile matrix               | Physical Android device max 4 years old  |
| Streamed SH comparison      | SH-bearing streamed capture              |
| Reference pixel comparisons | External datasets and viewers            |
