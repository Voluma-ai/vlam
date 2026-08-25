# XGRIDS LCC (`.lcc` / `meta.lcc`) format notes

Research notes for the **older** XGRIDS LCC format (manifest `"version": "3.0"`,
`"4.0"` or `"5.0"`), as produced by Lixel Studio / L2 Pro / PortalCam captures.
Not to be confused with the newer `.lcc2` octree format (see `lcc2-notes.md`),
which shares nothing but the vendor: `.lcc2` delivers SOG/WebP tiles, `.lcc`
delivers raw binary. v3, v4 and v5 use the same binary layout; v3 often names
the manifest `meta.lcc` and omits `fileType` (inferred as `Quality` when
`shcoef` holds trained ranges, else `Portable`. Portable stubs use
`[0,0,0]..[1,1,1]`), while v4 and v5 write it. One v4 quirk (conferencehall):
the manifest's `splats`/`totalSplats` over-count what `index.bin` holds by a
few splats, the writer leaves stale totals. `index.bin` is authoritative (its
ranges end exactly at `data.bin`'s true size), so the loader tolerates a small
manifest over-count.

Reverse-engineered from two local captures and cross-checked against the
[LCC whitepaper](https://github.com/xgrids/LCCWhitepaper). Where the whitepaper
and the bytes disagree, the bytes win, the differences are called out below.
Ground truth for the decoders came from a sibling `.ply` export of the same
capture (`oldtimers_blackcar.ply`), whose vertices are **index-aligned** with
`data.bin`'s level-0 records, giving an exact per-field comparison.

Data Organization Format originated from XGRIDS. This is an original
implementation of their openly published spec; no XGRIDS code is used, and
their capture data is never redistributed.

## Files

| File | Required | Purpose |
| --- | --- | --- |
| `<name>.lcc` | yes | JSON manifest (below) |
| `index.bin` | yes | per-cell, per-level ranges into `data.bin` |
| `data.bin` | yes | 32-byte splat records |
| `shcoef.bin` | `fileType: "Quality"` only | 64-byte per-splat SH records |
| `environment.bin` | optional | background/sky splats, no LOD |
| `collision.lci` | optional | collision meshes (below); casing may be `Collision.lci` |
| `attrs.lcp`, `thumb.jpg`, `assets/` | optional | out of scope (scene config / thumbs) |

All binary data is little-endian.

## Manifest

```jsonc
{
  "version": "5.0",
  "totalSplats": 8369676,      // sum over ALL levels, not the level-0 count
  "totalLevel": 5,             // level 0 = finest
  "cellLengthX": 30, "cellLengthY": 30,   // metres; cells tile X/Y only
  "indexDataSize": 84,         // == 4 + totalLevel * 16
  "splats": [4351017, ...],    // per-level totals, index = level
  "boundingBox": { "min": [...], "max": [...] },   // scene, Z-up
  "offset": [0,0,0],           // georeference anchor, NOT a transform, see below
  "shift": [0,0,0], "scale": [1,1,1],  // identity in every capture seen so far
  "epsg": 0,                   // projection for `offset`; 0 when unprojected
  "encoding": "COMPRESS",
  "fileType": "Portable",      // "Portable" (no SH) | "Quality" (shcoef.bin)
  "attributes": [ { "name": "scale", "min": [...], "max": [...] }, ... ]
}
```

**Gotcha:** `offset` is a *georeference anchor*, not a transform to apply. It
gives the local origin's coordinates in the `epsg` projection, a georeferenced
capture (`info/scene/TEST`: `[689605.68, 5338780.53, 565.62]`, EPSG:32632, UTM
32N) still has a local, origin-centred `boundingBox` and local record positions.
Adding it to positions double-places the scene *and* wrecks float32 precision by
baking in hundreds of kilometres, so the parser keeps it as metadata
(`LccManifest.georeference`) and leaves the geometry alone. `shift` and `scale`
would be real transforms; no capture has used them, so they are still rejected.

`attributes` carries the dequantization ranges. Only `scale`, `shcoef`,
`envscale` and `envshcoef` are load-bearing; `normal`/`color`/`opacity` are
descriptive (colors are stored as plain bytes, see below).

**Gotcha:** the `position` attribute's min/max is **not** the scene bounds, it
is the bounding box of `environment.bin`, which extends hundreds of metres past
the scene. It is not needed for decoding (positions are raw floats), but it is a
useful integrity check: decoding the environment at the right stride reproduces
it exactly. `boundingBox` is the real scene extent.

## `index.bin`

`fileSize / indexDataSize` records, one per cell:

| Field | Type | Notes |
| --- | --- | --- |
| `cellX`, `cellY` | u16, u16 | 2D grid coords; cells tile X/Y, full Z |
| per level ℓ = 0..totalLevel-1: | | repeats `totalLevel` times |
|   `count` | u32 | splats at this level |
|   `byteOffset` | u64 | into `data.bin` |
|   `byteSize` | u32 | always `count * 32` |

Verified on both captures: ranges are contiguous and cell-major (all of cell 0's
levels, then cell 1's), and the per-level totals equal the manifest's `splats`
array exactly. **Levels are independent subsamplings**, a cell's levels are
disjoint splat sets, not nested cuts like `.lcc2`. That is exactly the flat
"leaf with a range per level" model `LodScheduler` already implements.

## Sub-chunking (2026-07-18)

A cell's finest level runs to millions of splats (Casino's cell (1,0) level 0 is
2.9M = 92.6 MB), so `buildLccScene` splits big cells: K =
`ceil(finestPresentLevelCount / 128_000)` sub-leaves, every present level
partitioned K ways at shared floor boundaries, each `(cell, level, i)` slice its
own ranged chunk (label suffix `.i`, only on split cells). Dedicated files per
slice mean the scheduler's runs never coalesce across sub-leaves. All sub-leaves
from one physical cell share a scheduler budget group: detail still streams in
slice by slice, with pinned coarse coverage while each finer slice arrives, but
budget promotion/demotion selects one cut for the entire cell. The 2:1
`shcoef.bin` derivation works for any sub-range unchanged.

Record order is **not reliably spatially uncorrelated across writers**. Two
captures measured on 2026-07-18 behaved like full-cell random subsamples, but a
later capture exposed compact rectangular gaps when the budget mixed levels
between contiguous slices. The gap appeared only after initial loading because
the coarse whole-cell coverage was replaced by a partial fine cut. Consequently
L0 stays atomic per physical cell. L1+ retains independent fetch/upload and
swap transactions per sub-leaf: a ready slice replaces only its own coarse
shell while siblings wait. Classic LCC never takes the generic
pool-pressure/timeout path that deliberately retires old coverage before a
replacement can draw.

Classic LCC also keeps cell priority independent of frustum membership. Its
cells are broad XY tiles, so using the frustum as a priority multiplier caused
an orbit to demote a sharp tile as it crossed one view edge and promote it again
when it re-entered. Distance still drives the cut; camera rotation alone does
not rebuild resident detail.

## Near-first streaming (2026-08-03)

Classic LCC used to issue chunk fetches in `index.bin` / leaf order as `base`
only, so far cells' pinned coarsest slices filled the in-flight cap while the
camera cell stayed on coarse discs. The classic path now ranks missing chunks
before issuing them: visible screen-centre transactions first, then near
out-of-view and background work. LOD *selection* stays frustum-agnostic
(`frustumAware: false`) so an orbit does not thrash broad XY tiles. Concurrent
classic fetches match the pagetable cap (8).

Distance bands set the **ambition** for classic LCC; budget enforce/fill produce
the **resolved** cut that the mesh fetches and displays. Ambition never absorbs
budget demotions, so a stationary camera cannot flash L0 then settle to L1.

Cold start snaps each leaf to its distance band in one step (no dwell through
intermediate rungs). Afterward, hysteresis/dwell move ambition only when the
camera crosses into a different band.

HiRes cells are large XY tiles. Distance is to the AABB (0 if the camera is
inside), not the cell center - but a tile you stand in can still fail the
frustum test when most of it lies behind the camera. Budget demotion therefore
uses **distance only** under `frustumAware: false`. Fetch and staging add a
separate camera-forward screen-centre score, so that policy does not leave the
visible neighbour behind unrelated broad cells.

Resolved **L0** (atomic): every slice in the `coverageGroup` is one swap
transaction. No new coarsest stand-in; prior complete coverage is retained until
the full L0 group stages, then the cell snaps atomically. Empty until then when
there was no prior coverage.

Resolved **L1+** (progressive): each missing target slice gets only its own
pinned coarsest substitute. When that slice arrives, only its overlapping
substitute is retired; sibling coarse slices stay. No intermediate ambition
rungs are fetched - coarse → resolved target only.

Fetch ranking for classic work is display-transaction oriented, not global
phase-first. Resolved L0 stays atomic per physical cell; L1+ fetches and swaps
per sub-leaf, so an off-screen sibling cannot delay the visible slice. Visible
transactions rank by screen-centre angle, then distance; near out-of-view and
background work follow. A ready central L1+ slice is staged and committed ahead
of unrelated coarse shells, while the generic global coverage wave remains for
the hierarchical RAD path that needs it. Visible work maps to cross-mesh
`priority`, other work to `base`.

### Nearby-detail startup hold (`initialReveal: 'hold-near-l0'`)

Per-cell L0 commits are atomic, but many nearby cells finishing one after
another still looks like a low-detail buildup.
`StreamedSplatMeshOptions.initialReveal: 'hold-near-l0'` is the library default
for classic `.lcc` (`.lcc2` uses `'hold-coverage'` instead; other streamed
formats remain `'progressive'`) and freezes the first
schedule's **camera home coverage group** (nearest within `lodBaseDistance`, by
distance - not frustum). Prefers L0; when that set does not fit the pool
(typical on mobile / integrated-desktop budgets against HiRes captures), the
hold coarsens via the leaf ladder (`runsAtLevelFor`: L1, then L2) before
degrading to progressive. Neighbours are **not** included in the hold: they
often win `screenImportance` ranking and would steal the first fetch slots from
the cell the camera stands in. HiRes tiles also often fail `inView` when most
of the home cell sits behind the camera; requiring frustum intersection seeded
the facade instead. The mesh stays invisible until that bounded home set is
staged and committed.

During the hold, only those nearby target files use classic fetch slots. Their
coarse substitutes, far cuts, and environment tiles wait. Chunks stage into
inactive GPU ranges as they arrive (siblings need not coexist in the CPU cache).
Fully staged decoded arrays may leave the CPU cache without a refetch.

This improves time-to-useful-frame by avoiding wasted lower-LOD downloads; it
does **not** make the target detail instantaneous. If the bounded set cannot
fit the pool, startup degrades immediately to progressive streaming.
`?initialReveal=progressive` restores the old viewer behavior.

`.lcc2` does **not** use this home-L0 hold. See
[`lcc2-notes.md`](lcc2-notes.md#in-view-coverage-startup-hold)
for its in-view coarsest coverage hold.

XGRIDS LCCViewer budget division is not documented in this tree; VLAM keeps
distance → enforceBudget → ~5% fill headroom (`budgetFillFraction` /
`budgetFillCap`) as the attributed parity. Classic LCC sets
`fillPastDistance: false` so fill never climbs past the distance band, and does
**not** write budget demotions back into ambition. The steady **resolved** cut
is what we fetch, an ambition-L0 cell that budget holds at L1 follows the
progressive L1 path (orange), not atomic L0. Hysteresis will not re-climb finer
unless the camera moves at least ~0.5 m closer (band crossing + dwell).

## Distant reconstruction (2026-08-01)

The pavement-like failure at distance is not an extra LOD layer missing behind
the finest splats. LCC levels are alternatives, and drawing both permanently
would double their density and opacity. Instead, classic LCC uses a `0.1 px²`
projected-covariance low-pass and multiplies alpha by
`sqrt(det(raw) / det(filtered))`. This preserves splat mass when fine detail
becomes sub-pixel, preventing individual dark or light samples from taking over
the surface. VLAM keeps its verified ±3σ / `exp(-4.5·|q|²)` Gaussian support;
other formats retain the existing `0.3 px²` behavior.

## `data.bin`: 32-byte splat record

| Bytes | Field | Encoding |
| --- | --- | --- |
| 0–11 | position | `float32 × 3`, raw metres, Z-up |
| 12–15 | color RGBA | `u8 × 4`; RGB already `0.5 + dc·SH_C0` quantized, A = **activated** opacity (no sigmoid) |
| 16–21 | scale | `u16 × 3`, `lerp(scale.min[j], scale.max[j], v / 65535)` → **linear** scale (already exponentiated) |
| 22–25 | rotation | `u32`, smallest-three (below) |
| 26–31 | padding | always zero |

**The whitepaper's field order is wrong.** It lists Position, Scale, Rotation,
Color with a 4-byte "unused" tail; the actual order is Position, **Color**,
**Scale**, **Rotation**, with a 6-byte zero pad. Verified against the PLY:
scale matches to a relative error of 6e-8, and colors/opacity match bit-exactly.

### Rotation

Smallest-three, but **not** the whitepaper's `QLut`/`DecodeRotation` (which does
not reproduce the data), and not the sign-magnitude scheme in the LCC-Web SDK's
`parseQuat` (that decodes the SDK's own repacked GPU texture, not the file).
The file uses plain **offset binary, bias 511, in xyzw order**:

```
largest = (enc >>> 30) & 3 // index into (x, y, z, w)
b[k] = (enc >>> (10 * k)) & 0x3ff // k = 0, 1, 2
v[k] = (b[k], 511) / (511 * √2) // → [-√½, +√½]
```

`v[0..2]` fill the three components other than `largest`, in ascending index
order; the omitted one is `√(1 − |v|²)`. Median error vs the PLY is 1.1e-3,
i.e. exactly the 1.4e-3 quantization step.

## `shcoef.bin` (`fileType: "Quality"`)

Exactly `2 ×` the size of `data.bin`: 64 bytes per splat, aligned 2:1, so a node
at `data.bin` offset `O` size `S` has its SH at offset `2O`, size `2S`, no
separate index needed.

Each record is 16 LE u32: **words 0–14 are SH coefficients 0–14** (3rd order,
15 per channel), word 15 is zero padding. Per word (`DecodePacked_11_10_11`):

| Channel | Bits | Divisor |
| --- | --- | --- |
| R | 0–10 | 2047 |
| G | 11–20 | 1023 |
| B | 21–31 | 2047 |

then `lerp(shcoef.min[ch], shcoef.max[ch], code / divisor)`.

Confirmed by all three fields of a single word mapping simultaneously to one
PLY coefficient's R/G/B (error ~1e-9). The word→coefficient *permutation*
relative to the PLY (word 1 ↔ PLY coeff 0, word 2 ↔ coeff 2, word 6 ↔ coeff 3)
is the SH basis rotated into LCC's frame, bands mix only within themselves, as
a rigid rotation requires. Since the renderer evaluates SH with the camera
direction in **mesh-local** space, and `formatTransform` handles the frame,
the coefficients are consumed as-is with no re-rotation.

## `environment.bin`

Background/sky splats: no LOD, no index, always resident. The record stride
depends on `fileType`:

| `fileType` | Stride | Layout |
| --- | --- | --- |
| `Portable` | 32 | base record only |
| `Quality` | 96 | base record + its 64-byte SH block, interleaved per splat |

Splat count is `fileSize / stride`. The base record is identical to `data.bin`'s
but dequantizes scale with **`envscale`** (and SH with **`envshcoef`**) ranges -
env splats are huge (up to ~150 m) because they model the sky/surroundings.

**The stride is a property of the file, not of the reader.** A `Quality`
environment record stays 96 bytes even when its SH is being skipped; decoding
it at 32 silently yields 3× the splats out of the SH bytes (huge garbage
Gaussians, since `envscale` reaches ~150 m). `LccChunkParams.stride` therefore
carries it explicitly rather than inferring it from whether SH was requested.

Both strides divide both captures' file sizes, so size alone is ambiguous; the
stride is decided by `fileType` and confirmed by decoding, at the correct
stride the position bbox reproduces the manifest's `position` attribute exactly,
padding bytes are all zero, and every quaternion is valid. At the wrong stride
the Quality capture yields NaN positions and 7510/119400 invalid quaternions.

## Coordinate frame

Z-up, same as `.lcc2`, `createLcc2ToThreeMatrix()` is reused unchanged.
(For reference, the sibling PLY export is Y-up: `data = (ply.x, ply.z, −ply.y)`.
That relationship is only used for verification and is not part of the loader.)

## `collision.lci`

Optional collision companion. Present on many Lixel Studio / L2 Pro exports
(e.g. Kaiserpfalz); absent on others. `buildLccScene` probes `collision.lci`
then `Collision.lci` via the dataset size API and, when found, exposes one
`SceneCollision` descriptor. `loadCollisionMeshes` / `parseCollisionLci` expand
the file into per-cell triangle tiles.

Little-endian. Verified against the [LCC whitepaper](https://github.com/xgrids/LCCWhitepaper)
and live version-`2` bytes (`coll` magic). Unsupported versions are rejected.

**Global header (48 bytes), then `meshCount` × 40-byte mesh headers.**
`headerLen` is the byte offset of the first mesh payload
(`48 + meshCount * 40`):

| Offset | Field |
| --- | --- |
| 0 | `coll` magic (4 ASCII) |
| 4 | `version` u32 (`2`) |
| 8 | `headerLen` u32 |
| 12 | scene bbox `float32 × 6` (min xyz, max xyz) |
| 36 | `cellLengthX`, `cellLengthY` `float32` |
| 44 | `meshCount` u32 |

**Per-mesh header (40 bytes):** `cellX`, `cellY` u32; `dataOffset`, `dataSize`
u64; `vertexCount`, `faceCount`, `bvhByteSize`, pad u32.

**Mesh payload at `dataOffset`:** `vertexCount × float32 × 3` positions, then
`faceCount × uint32 × 3` indices, then `bvhByteSize` bytes of a proprietary
serialized BVH. Identity check: `verts×12 + faces×12 + bvh == dataSize`.
VLAM! **skips the BVH** (same stance as ignoring `.lcc2` `.btree`); hosts build
their own acceleration structure. Coordinates are Z-up source-local - apply
`formatTransform` / `matrixWorld` like the splats.

Not every splat cell has a mesh tile; coverage holes are normal.

## Viewing a local capture

Drop the capture's **folder** onto the demo, `StreamedSplatMesh.loadLocal`
reads it in place. Each file becomes a `blob:` URL, which answers `Range` with
a real 206, so the 300 MB `data.bin` streams chunk-by-chunk exactly as it would
over HTTP; nothing is copied, uploaded, or read whole. This works on the
deployed demo too, and keeps the (non-redistributable) captures off any server.

## Test captures (local, never committed)

| Capture | fileType | splats | cells | notes |
| --- | --- | --- | --- | --- |
| `Casino/Casino Eindhoven.lcc` | Portable | 9,181,141 | 6 (3×2) | 629 env splats @32B; largest chunk 92.6 MB |
| `bentleywarlcc/oldtimers_blackcar.lcc` | Quality | 8,369,676 | 37 | `shcoef.bin` 536 MB, 39,800 env splats @96B, sibling `.ply` |
| `Room_tour_L2_PRO_P2/meta.lcc` | Quality (v3.0, inferred) | 5,635,108 | 34 | older L2 Pro; no `fileType` field; 39,796 env @96B |
| `conferencehall/conferencehall.lcc` (remote) | Portable | 11,391,483 | 4 (2×2) | v4.0; manifest over-counts by 3 splats; 9,594 env @32B |
