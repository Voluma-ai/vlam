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

## External blockers

| Work                        | Blocker                                  |
| --------------------------- | ---------------------------------------- |
| Apple Silicon Pro/Max tier  | Physical MacBook Pro (M-series Pro/Max)  |
| Mobile matrix               | Physical iPhone 15 (non-Pro)             |
| Streamed SH comparison      | SH-bearing streamed capture              |
| Reference pixel comparisons | External datasets and viewers            |
