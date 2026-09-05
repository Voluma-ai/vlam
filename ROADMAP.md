# Roadmap

Open work for **VLAM!**. Work top-down; `[v]` means implemented but awaiting the
named visual or device validation. Completed work belongs in the changelog and
Git history, not in this queue.


## Next

- **Standalone WebGPU SH cache** — experimental implementation and benchmark
  controls are available via `shEvaluation: 'compute'`. Refreshing moving-camera
  colors only with accepted GPU sorts measured 25.14 FPS stationary and 16.10
  FPS orbit on the M3 Air, versus 11.92/11.13 on vertex SH and a fresh 18.48 FPS
  Spark orbit probe. The identified Apple Mac cohort uses this path while other
  `auto` devices stay on vertex evaluation. Still needs broader SH/PLY/reference/lifecycle coverage,
  workload-size and discrete-GPU checks, and a thermal comparison. See the
  [retest and protocol](docs/render-benchmark.md#m3-air-sh-cache-retest-2026-09-04).

## Later

- **Apple Silicon GPU tiers** — design recorded in
  [capabilities](docs/capabilities.md#apple-silicon-gpu-tiers-design-not-shipped).
  Today every Apple adapter is `integrated` (correct for Air; underserves
  Pro / Max). Do not raise Mac defaults from marketing specs. Needs host/URL
  override hooks in tests, then headed M-series Pro/Max hotel-orbit matrix
  (Chrome + Safari) before any `apple-pro` budget or SD-default change.
  Blocked on physical Pro/Max validation.
- **Mobile device gate** — `[~]` iPhone 15 Pro/WebGPU core passed. Galaxy S24 Ultra
  Chrome 151 WebGPU: goose SD locked 60, HD ~58 rAF; streamed Dehaar /
  sandwijck SD vs HD on 2026-08-25; keep the phone SD default (see
  [capabilities](docs/capabilities.md)). Discrete Windows keeps
  `minSplatSizePx` 0. Still need a non-Pro iPhone 15. Galaxy S7/WebGL2 is a
  smoke-test floor, not a performance target. Protocol (also still
  unrecorded on 15 Pro; S24 Ultra is HUD snapshots only): HUD browser, OS,
  GPU, backend, dataset, splat count, FPS; orbit median / p95 / p99 plus
  missed 16.6 ms and 33.3 ms deadlines; ten-minute thermal soak on one sparse
  and one dense capture; portrait and landscape gaps, discs, popping; A/B
  `?pixelRatio=1`, `0.9`, `0.8` with `?adaptiveDpr=0` before raising
  `maxStdDev`; `?minSplatPx=1.5` vs `3.5`.
- **Streamed spherical harmonics** — `[v]` implementation is covered by tests;
  blocked on an SH-bearing streamed capture and headed `?sh=0` versus `?sh=N`.
- **RAD parity and coverage** — `[~]` page-table traversal, budget, and
  fractional-opacity/`lodAlpha` are covered by tests. **2026-09-04 headed
  VLAM** hotel-core orbit (`HOTEL.clean.comp-lod.rad`, ~4.2M nodes, 1M draw,
  Chrome WebGPU / M3 Air): coherent coverage, `hole 0`, plan-apply worst
  ~10–20 ms after the publish-retire cap; shots under
  `.tmp/rad-parity/`. **Still open:** same-camera Spark side-by-side (Spark
  2.1.0 `streaming-lod` + this file crashed in `SplatPager.uploadPage` with
  a stand-in three@0.185; needs Spark’s vendor three), and a construction-
  timeline marker crossfade capture. See
  [RAD format notes](docs/formats/rad-notes.md#headed-spark-parity-2026-09-04).
- **Multi-mesh budget** — `[v]` camera-weighted sharing and pool headroom are
  tested; visually validate several RAD meshes sharpening as the camera moves.
  See the [multi-mesh guide](docs/guide/multi-mesh-budgets.md).
- **Selection and separation** — `[v]` logic and headless flow are tested;
  verify seams, global sort, and SDF highlighting in headed WebGPU. Use
  `?tool=select` in the demo.
- **Experimental static merged auto-LOD** — `[v]` hierarchy, Gaussian parents, paging,
  cancellation, and budgets are tested; compare WebGPU and forced WebGL2 with
  Spark on small and large captures.
- **WebGL2 streamed sort flicker** — race and permutation tests pass; visually
  validate camera motion before closing.
- **RAD limit feedback** — invariants and convergence are tested; assess
  refinement pacing during the RAD headed comparison.
- **1.0 stabilization** — freeze the API, finalize migration notes, changelog,
  and release tag after the checks above pass.

## External blockers

| Work                        | Blocker                                  |
| --------------------------- | ---------------------------------------- |
| Apple Silicon Pro/Max tier  | Physical MacBook Pro (M-series Pro/Max)  |
| Mobile matrix               | Physical iPhone 15 (non-Pro)             |
| Streamed SH comparison      | SH-bearing streamed capture              |
| Reference pixel comparisons | External datasets and viewers            |
