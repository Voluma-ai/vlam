# Streamed shN, view-dependent color for streamed scenes (M11)

Feasibility note (M11.1) and the shipped design (M11.2). Read with
[`streamed-sog-notes.md`](streamed-sog-notes.md), [`lcc-notes.md`](lcc-notes.md), and `ROADMAP.md` M11.

## The problem

A fully loaded `SplatMesh` renders a SOG capture's higher-order SH straight from
the file's **palette** (`SplatShData`): each splat stores a 16-bit *label*, and
a per-file codebook image holds the coefficients the label points at. That form
is compact but **per file**, the label only means anything against *that*
file's codebook.

A streamed scene appends many chunk files into one shared GPU pool, sorted and
drawn together. Two chunks' labels index two different codebooks, so the palette
cannot ride into the pool: label 7 in chunk A and label 7 in chunk B are
unrelated colors. That is why streamed SOG / `.lcc2` dropped shN entirely
(`sliceSplatData` discarded `chunk.sh`), rendering DC color only.

LCC (`.lcc`, v3–v5) and `.rad` do *not* have this problem: they store SH **packed
per splat** (`SplatPackedShData`), one `DecodePacked_11_10_11` word per
coefficient, dequantized across one scene-wide range. No per-file table, so it
survives the pool untouched. The pool and the material already decode this form
(`writePackedSh`, `shCoefficientReader` mode `'packed'`).

## The two designs weighed

### A, palette atlas per resident chunk

Keep each chunk's codebook. Upload every resident chunk's centroid image into a
texture *atlas* (or array layer), and give every splat a `(chunkPaletteIndex,
label)` pair; the shader indirects atlas → codebook → coefficients.

- **GPU memory:** a SOG shN centroid image is ~64 entries × up to 15 coeffs ×
 RGBA. Small per chunk (tens of KB), but a 4M-splat budget keeps *hundreds* of
 chunks resident, and the atlas must hold every resident codebook plus slack
 for the ones streaming in/out. Worse, it needs a **new per-splat channel**
 (the chunk-palette index), ~4 B/splat = ~16 MB at 4M, and atlas bookkeeping
 on every LOD swap (allocate/free atlas slots as chunks come and go).
- **Complexity:** a second SH material path, atlas allocator, and eviction that
 must keep an atlas slot alive as long as *any* resident splat references it.
- **Upside:** lossless, coefficients never re-quantize.

### B, re-quantize into per-splat packed at decode (chosen)

Convert each chunk's palette shN into the **same packed per-splat form** LCC and
`.rad` already use, at decode time in the worker, then feed the existing packed
pool path. No new GPU resources, no new material path, no atlas.

- **GPU memory:** identical to the LCC/`.rad` SH cost the pool already pays -
  `ceil(coeffs/4)` × RGBA32UI textures over the pool. 3 bands (15 coeffs) = 4
 textures × 4 B = **64 B/splat** = ~256 MB at 4M, ~384 MB at 6M. 1 band = 16
 B/splat. No extra per-splat channel; the packed words *are* the storage.
- **CPU:** the conversion is a per-splat label lookup + quantize, done off the
 main thread in the decode worker. One extra pass over a chunk at decode.
- **The one range:** the pool decodes every splat through **one** dequant range
 uniform, but each SOG chunk measures its **own** codebook extent. The first
 packed-SH chunk to append sets the scene range; any later chunk whose range
 differs is **requantized into it at append** (`requantizeShWord`, generalized
 from the LCC environment path). Values outside the first chunk's extent clip -
 negligible for high-order SH, whose tail energy is tiny, and the pinned coarse
 shell (loaded first) spans the whole scene so its extent is near-global.
- **Loss:** two quantizations (palette float → packed at decode, then a possible
 requantize at append). Both are 11/10/11 over a symmetric range; the visible
 error is well under the DC color's own 8-bit step.

**Chosen: B.** It reuses the entire packed-SH pipeline (pool upload, material
decode, slicing, compaction) that already ships and is tested for LCC/`.rad`,
adds no GPU memory beyond the SH itself, and needs no new eviction logic. The
atlas design's only advantage, losslessness, buys nothing a viewer can see,
at a large complexity and bookkeeping cost.

## What shipped (M11.2)

- **`src/lib/sh-pack.ts`**: the shared SH packing/requantization primitives,
 extracted so LCC, `.rad`, SOG, and the pool use one implementation:
  `packShCoefficients`, `packPaletteSh` (palette → packed), `neutralShWord`,
  `requantizeShWord`, `packedRangesEqual`. Pure array math, safe in the worker.
- **Worker conversion**: a SOG chunk requested with `sog.packShBands` has its
 palette converted to packed shN at decode (`packSogShN` in `load-worker.ts`),
 and the palette is dropped so it is not transferred. A chunk with fewer bands
 than requested zero-pads the surplus so the packed band count matches the pool
 (a band-count mismatch would drop the SH); a chunk with no shN is left for the
 pool to neutral-fill.
- **Scene wiring**: `buildSogScene(json, source, options, shBands)` sets
  `scene.shBands` and stamps `sog.packShBands` on every chunk when `shBands ≥ 1`.
- **Pool requantize at append**: `writePackedSh` requantizes a chunk whose
  range differs from the scene's locked range instead of warning and ignoring
  it. LCC/`.rad` chunks already share one range, so for them this stays a
  verbatim copy.

### Opt-in, and why

Streamed SOG SH is **opt-in** via the `shBands` load option (default off,
preserving prior behavior). Unlike LCC, whose manifest states its band count,
so "every band the capture carries" is knowable, a Streamed SOG `lod-meta.json`
does **not** declare whether the tiles carry shN. Turning SH on speculatively
would allocate up to 384 MB of pool textures for a scene that may have none, so
the caller asks for it deliberately. (`.lcc2` tiles are verified DC-only -
[`lcc2-notes.md`](lcc2-notes.md), so the toggle is inert there, but the same path would
carry their shN if a future capture had it.)

### A/B in the demo

`?sh=N` (N = 1/2/3) turns it on for a streamed scene; the debug line's `SH n`
reports the bands actually rendered. Load the same SOG capture as a fully loaded mesh
(palette shN) and as a streamed mesh with `?sh=3` (converted packed shN) to
compare, they should match to within quantization.

### Verification note

The conversion math, zero-padding, requantization, and the pool's
range-mismatch requantize are covered by unit tests (`sh-pack.test.ts`,
`splat-mesh.packed-sh.test.ts`, `sog-scene-shn.test.ts`). End-to-end visual A/B
needs a Streamed SOG capture that actually carries shN; none is checked in
(captures are gitignored), so on-device confirmation is pending such a fixture.
