# Surface-aware brush and selection

Implementation notes for continuous, depth-aware painting with orthogonal
surface/through × center/footprint selection. This post-1.0 opportunity is
implemented and unit-tested; headed backend/device validation remains tracked
in [`ROADMAP.md`](../ROADMAP.md).

References: SuperSplat's
[sphere brush](https://github.com/playcanvas/supersplat/pull/1024) and
[selection controls](https://github.com/playcanvas/supersplat/pull/1020).

## Modes

The choices are independent and default to `surface` + `center` in the demo.

| Axis | Values | Meaning |
| --- | --- | --- |
| Depth | `surface` / `through` | `surface` limits selection to the depth-picked visible corridor; `through` takes every intersected Gaussian |
| Target | `center` / `footprint` | `center` tests Gaussian means; `footprint` includes the rendered ±3σ covariance ellipsoid |

The size control is a screen-space radius. Each pick converts it to world units
at that sample's depth, so a stroke keeps a stable visual width while crossing
surfaces at different distances.

## Public primitives

`SplatMesh.pickMany(ndcs, camera, renderer, options?)` snapshots its inputs,
renders the smallest framebuffer rectangle containing the samples once, and
returns ordered hit/miss results. Existing `pick` delegates to this path and
retains its one-point behavior.

`selectBrushStrokeInData(data, stroke, options?, worldMatrix?)` is exported from
`@voluma/vlam/selection`. It accepts immutable world-space paths and returns
matching source indices in deterministic ascending order. Center tests use the
exact union of linearly tapered capsules. Footprint tests use directional
covariance support at VLAM's rendered ±3σ extent and remain correct under
rotation and non-uniform scale.

Existing point-radius paint methods still mean through + center selection. The
viewer and `PaintTool.paintStroke` opt into the richer modes explicitly.

## Stroke lifecycle

The viewer spacing-decimates pointer samples, caps a stroke at 512 samples, and
commits on pointer-up. Misses or world/depth jumps larger than two local brush
radii split the result into separate paths, preventing a capsule from bridging
a foreground edge to the background.

Every asynchronous commit owns snapshots of the source mesh, paint tool,
camera, viewport, samples, and settings. A scene/tool change before readback
completes turns the commit into a no-op. Pointer cancellation discards the
stroke.

## Streamed meshes

Classic streamed SOG, LCC, LCC2, and RAD-prefix meshes retain an immutable
geometric stroke journal in addition to sparse `(chunk file, local index)`
values. When another run becomes resident, its geometry is tested against the
journal before its channel is uploaded. This preserves first-paint-wins across
eviction, reload, and coarse/fine LOD replacement while keeping the existing
`maxEdits` cap.

RAD page-table plans carry a stable global splat ID beside every moved or
appended splat. The main thread keeps one 32-bit ID per slab slot and selects
directly over the pool's existing CPU mirrors, without duplicating slab
geometry. Incoming slots replay the same geometric journal before upload;
slots outside stored strokes are reset to the channel fill, preventing ghost
paint after coarse/fine replacement. Sparse edits remain keyed as `(chunk
file, local index)` and obey the same first-paint-wins and `maxEdits` rules.

## CPU benchmark

Run `npm run benchmark:brush -- 100000 1000000 6000000` after a clean checkout.
It reports five through+center scans, the full temporary hit buffer, retained
result bytes, an exposed-GC estimate for the nested edit maps, and the exact
page-table identity-array cost. The benchmark is CPU/V8-specific and does not
include GPU depth-pick readback.

Reference run on 2026-09-09, Node 24.8.0, Windows x64, Intel Core i7-12700:

| Splats | Selected | Median CPU | Temporary hits | Retained edit heap | Page-table IDs |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100,000 | 1,340 | 4.71 ms | 0.4 MB | 49,552 B | 0.4 MB |
| 1,000,000 | 12,305 | 38.37 ms | 4 MB | 472,480 B | 4 MB |
| 6,000,000 | 75,777 | 206.09 ms | 24 MB | 2,530,824 B | 24 MB |

The edit-heap column is an indicative V8 measurement and should be compared in
fresh processes; the typed-array byte counts are deterministic. Page-table
painting scans only its bounded resident slab, not every splat in the capture.

## Verification status

Automated coverage includes pointer spacing, perspective and orthographic
pixel-to-world sizing, miss/depth splits, tapered-path continuity, all four
mode combinations, ±3σ anisotropic grazing, non-uniform transforms, ordered
batched picks, streamed LOD replacement, and RAD page-table slot
replacement/clearing. A browser probe also renders a painted channel on WebGPU
and forced WebGL2, asserts the four selection-mode results, and verifies the
resulting pixel change.

A headed 3.19 M-splat hotel RAD capture publishes a one-million-splat
page-table cut and stays live through a paint gesture plus camera-driven
replacement. That pass found an initial unpublished-frontier drain deadlock;
the pager now has a focused regression test. The remaining manual matrix is
continuous-stroke inspection on thin surfaces, foreground/background
boundaries, grazing large anisotropic splats, and transformed meshes across
small and largest-available static/classic-streamed captures. TypeScript and
headless rendering alone cannot validate those subjective pixels.
