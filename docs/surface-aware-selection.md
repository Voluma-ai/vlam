# Surface-aware brush and selection

Post-1.0 implementation plan for continuous, depth-aware strokes and
orthogonal surface/through × center/footprint selection. Tracked from
[`ROADMAP.md`](../ROADMAP.md). Not a 1.0 release requirement.

References: SuperSplat's
[sphere brush](https://github.com/playcanvas/supersplat/pull/1024) and
[selection controls](https://github.com/playcanvas/supersplat/pull/1020).

## Goal

Extend the existing depth-picked sphere paint tool with continuous strokes
that split at depth discontinuities, independent visible-surface/through and
footprint/center selection controls, and scalable selection processing.
Existing point-radius APIs retain their current center-based behavior.

## Modes

Keep the two decisions orthogonal. Defaults live in one settings object
shared by paint and selection UI.

| Axis | Values | Meaning |
| --- | --- | --- |
| Depth | `surface` / `through` | `surface` limits a stroke to the visible depth corridor; `through` takes every intersected Gaussian |
| Footprint | `center` / `footprint` | `center` tests means; `footprint` tests the full VLAM ±3σ covariance ellipsoid |

## Implementation

1. Extract stroke capture from `viewer/main.ts`: collect and spacing-decimate
   pointer samples, show a radius cursor, and commit one immutable stroke on
   pointer-up/cancel rather than issuing and applying one pick per frame.
   Define the four depth × footprint combinations and their defaults in the
   shared settings object.
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

## Acceptance

On WebGPU and forced WebGL2, inspect thin surfaces, foreground/background
boundaries, grazing large anisotropic splats, transformed meshes, and small
plus largest available static/streamed captures. A continuous stroke has no
sample gaps, never crosses a depth discontinuity, and gives visibly distinct,
correct results for all four depth × footprint modes. Camera/tool/scene/pointer
changes during readback cannot corrupt the edit, and a painted streamed region
remains painted as its LOD and residency change. Record stroke latency and
retained edit memory, then run the full headless verification bar.
