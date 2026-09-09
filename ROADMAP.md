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

- **Apple Silicon GPU tiers** — design recorded in
  [capabilities](docs/capabilities.md#apple-silicon-gpu-tiers-design-not-shipped).
  Today every Apple adapter is `integrated` (correct for Air; underserves
  Pro / Max). Do not raise Mac defaults from marketing specs. Needs host/URL
  override hooks in tests, then headed M-series Pro/Max hotel-orbit matrix
  (Chrome + Safari) before any `apple-pro` budget or SD-default change.
  Blocked on physical Pro/Max validation.
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
- **RAD parity and coverage** — capture a same-camera Spark side-by-side and a
  construction-timeline marker crossfade. See the
  [RAD format notes](docs/formats/rad-notes.md#headed-spark-parity-2026-09-04).
- **Multi-mesh budget** — visually validate several RAD meshes sharpening as the camera moves.
  See the [multi-mesh guide](docs/guide/multi-mesh-budgets.md).
- **Selection and separation** — verify seams, global sort, and SDF highlighting in headed WebGPU. Use
  `?tool=select` in the demo.
- **Experimental static merged auto-LOD** — compare WebGPU and forced WebGL2 with
  Spark on small and large captures.
- **WebGL2 streamed sort flicker** — visually validate camera motion before closing.
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
- **Surface-aware brush and selection precision** — extend the existing
  depth-picked sphere paint tool with continuous strokes that split at depth
  discontinuities, independent visible-surface/through and footprint/center
  selection controls, and scalable selection processing. References:
  [sphere brush](https://github.com/playcanvas/supersplat/pull/1024) and
  [selection controls](https://github.com/playcanvas/supersplat/pull/1020).
  Keep the two decisions orthogonal: `surface` limits a stroke to the visible
  depth corridor while `through` takes every intersected Gaussian; `center`
  tests means while `footprint` tests the full VLAM ±3σ covariance ellipsoid.
  Existing point-radius APIs retain their current center-based behavior.

  **Implementation plan:**

  1. Extract stroke capture from `viewer/main.ts`: collect and spacing-decimate
     pointer samples, show a radius cursor, and commit one immutable stroke on
     pointer-up/cancel rather than issuing and applying one pick per frame.
     Define the four depth × footprint combinations and their defaults in one
     settings object shared by paint and selection UI.
  2. Add a batched depth-pick path that snapshots NDC samples, camera matrices,
     viewport, mesh/scene generation, alpha threshold, and tool settings. Use
     one tiled/bounded depth pass and start all readbacks before awaiting them.
     Misses and depth jumps split the result into subpaths; convert screen
     radius to world radius at each hit and join samples with variable-radius
     capsules without bridging foreground and background surfaces.
  3. Put the selection math in `@voluma/vlam/selection`: a pure CPU reference
     for center/covariance intersection against spheres and tapered capsule
     paths, including world transforms and non-uniform scale. Footprint mode
     uses the covariance support radius at VLAM's ±3σ extent. Avoid the
     closest-centerline shortcut for tapered capsules because it leaves gaps
     when endpoint radii differ.
  4. Evaluate a completed stroke once per resident set, union and deduplicate
     its hits, then batch channel writes by pool row/range. Benchmark the CPU
     reference at representative 100k/1M/6M counts; if it misses the interaction
     budget, add a portable WebGPU bitset compute path with the CPU result as
     its oracle and a bounded, yielding CPU/WebGL2 fallback. Do not add a second
     rendering projection convention merely for selection.
  5. For streamed meshes, persist immutable geometric stroke operations (path,
     radii, camera/depth snapshot, mode, and value), not only the IDs resident
     when the stroke landed. Replay only spatially overlapping operations when
     a run is appended so coarse↔fine LOD swaps, eviction, and reload reproduce
     the edit; preserve first-paint-wins ordering and the existing edit cap.
  6. Treat an in-flight stroke as a transaction. Scene replacement, dispose,
     tool/effect changes, pointer cancellation, and superseding input must
     either invalidate it or leave it to commit wholly against its captured
     state; none may paint the new scene, use a later camera, leak pointer
     capture, or partially apply a stale result.
  7. Add unit coverage for sample spacing, miss/depth splits, perspective
     pixel-to-world sizing, tapered paths, all four mode combinations, ±3σ
     footprint grazing, transforms, and deterministic union/order. Extend pick
     lifecycle and streamed-channel tests for batched readback, concurrent
     strokes, LOD replacement, eviction/reload, clear, edit caps, and dispose.
     Update the picking/effects guides, capability table, public JSDoc, and
     changelog with the implementation.

  **Acceptance:** on WebGPU and forced WebGL2, inspect thin surfaces,
  foreground/background boundaries, grazing large anisotropic splats,
  transformed meshes, and small plus largest available static/streamed
  captures. A continuous stroke has no sample gaps, never crosses a depth
  discontinuity, and gives visibly distinct, correct results for all four
  depth × footprint modes. Camera/tool/scene/pointer changes during readback
  cannot corrupt the edit, and a painted streamed region remains painted as
  its LOD and residency change. Record stroke latency and retained edit memory,
  then run the full headless verification bar.

## External blockers

| Work                        | Blocker                                  |
| --------------------------- | ---------------------------------------- |
| Apple Silicon Pro/Max tier  | Physical MacBook Pro (M-series Pro/Max)  |
| Mobile matrix               | Physical iPhone 15 (non-Pro)             |
| Streamed SH comparison      | SH-bearing streamed capture              |
| Reference pixel comparisons | External datasets and viewers            |
