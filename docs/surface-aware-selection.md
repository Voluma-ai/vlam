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

RAD page-table mode is intentionally excluded for now. Its chunk cache and
global-index-to-slot map live in a worker, so main-thread persistent channels
cannot identify unchanged resident slots. The demo hides paint for that mode,
and `paintPersistentStroke` throws a clear error instead of applying a partial
edit. Supporting it requires extending the worker protocol with persistent
channel operations keyed by global splat ID.

## Verification status

Automated coverage includes pointer spacing, perspective and orthographic
pixel-to-world sizing, miss/depth splits, tapered-path continuity, all four
mode combinations, ±3σ anisotropic grazing, non-uniform transforms, ordered
batched picks, and streamed LOD replacement.

The remaining headed matrix is WebGPU plus forced WebGL2 on thin surfaces,
foreground/background boundaries, transformed meshes, and small plus large
static/classic-streamed captures. Record stroke latency and retained edit
memory there; TypeScript and headless rendering alone cannot validate pixels.
