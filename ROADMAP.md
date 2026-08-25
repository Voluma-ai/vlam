# Roadmap

Open work for **VLAM!**. Work top-down; `[v]` means implemented but awaiting the
named visual or device validation. Completed work belongs in the changelog and
Git history, not in this queue.

Public development starts at **0.2.0**. Remaining items below are toward
**1.0**, not a private 0.2 gate.

## Release gate (0.2.0)

- [x] Public repository at [github.com/Voluma-ai/vlam](https://github.com/Voluma-ai/vlam).
- [x] Public demo at [https://vlam.voluma.ai](https://vlam.voluma.ai) (`Deploy` workflow on `main`).
- [ ] Green CI on `main`.
- [ ] Publish `@voluma/vlam@0.2.0` to npm.
- [ ] Tag `v0.2.0` and add its changelog section.

`@voluma/vlam@0.1.0` was a name-reservation placeholder. **1.0.0** is the
stability contract.

## Next

No blocking work for the public 0.2.0 snapshot. Pick from **Later** toward 1.0.

## Later

- **SuperSplat antialias comparison** — `[v]` implementation and tests pass;
  blocked on a representative AA-flagged SOG and headed comparison.
- **Mobile device gate** — `[~]` iPhone 15 Pro/WebGPU core passed. Discrete
  Windows keeps `minSplatSizePx` 0 (see desktop GPU tiers in the changelog).
  Still need a non-Pro iPhone 15 and Galaxy S24/Chrome WebGPU. Galaxy S7/WebGL2
  is a smoke-test floor, not a performance target. Protocol (also still
  unrecorded on 15 Pro): HUD browser, OS, GPU, backend, dataset, splat count,
  FPS; orbit median / p95 / p99 plus missed 16.6 ms and 33.3 ms deadlines;
  ten-minute thermal soak on one sparse and one dense capture; portrait and
  landscape gaps, discs, popping; A/B `?pixelRatio=1`, `0.9`, `0.8` with
  `?adaptiveDpr=0` before raising `maxStdDev`;   `?minSplatPx=1.5` vs `3.5`. See
  [capabilities](docs/capabilities.md).
- **Streamed spherical harmonics** — `[v]` implementation is covered by tests;
  blocked on an SH-bearing streamed capture and headed `?sh=0` versus `?sh=N`.
- **RAD parity and coverage** — `[v]` pagetable traversal keeps a coarse shell,
  prioritizes touched chunks, and respects the draw budget in tests. Compare a
  large capture against Spark during a headed WebGPU fly-through. See the
  [RAD format notes](docs/formats/rad-notes.md).
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
| SuperSplat AA comparison    | Representative AA-flagged SOG            |
| Mobile matrix               | Physical iPhone 15 and Galaxy S24 access |
| Streamed SH comparison      | SH-bearing streamed capture              |
| Reference pixel comparisons | External datasets and viewers            |
