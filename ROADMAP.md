# Roadmap

Open work for **VLAM!**. Work top-down; `[v]` means implemented but awaiting the
named visual or device validation. Completed work belongs in the changelog and
Git history, not in this queue.


## Later

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
- **RAD parity and coverage** — `[v]` page-table traversal keeps a coarse shell,
  prioritizes touched chunks, and respects the draw budget in tests. Fractional
  opacity no longer changes merged-vs-leaf classification (unit + unified /
  standalone GPU harness). Compare a large capture against Spark during a headed
  WebGPU fly-through, including a marker crossfade on a construction timeline.
  See the [RAD format notes](docs/formats/rad-notes.md).
- **Multi-mesh budget** — `[v]` camera-weighted sharing and pool headroom are
  tested; visually validate several RAD meshes sharpening as the camera moves.
  See the [multi-mesh guide](docs/guide/multi-mesh-budgets.md).
- **Selection and separation** — `[v]` logic and headless flow are tested;
  verify seams, global sort, and SDF highlighting in headed WebGPU. Use
  `?tool=select` in the demo.
- **Static merged auto-LOD** — `[v]` hierarchy, Gaussian parents, paging,
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
| Mobile matrix               | Physical iPhone 15 (non-Pro)             |
| Streamed SH comparison      | SH-bearing streamed capture              |
| Reference pixel comparisons | External datasets and viewers            |
