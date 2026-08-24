# Streamed SOG, format notes (M2.0)

Research notes for the Streamed SOG format, verified 2026-07-15 against the
[PlayCanvas specification](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/)
(a formal spec, "version 1") and against a locally generated fixture
(`assets/sandwijck-lod/`, gitignored). Read together with `ROADMAP.md` M2.

## Container layout

A Streamed SOG scene is a directory:

```
scene/
├── lod-meta.json          ← manifest, always at the root
├── {lod}_{chunk}/         ← chunk = an UNBUNDLED SOG v2 directory
│   ├── meta.json
│   └── *.webp             (means_l/u, quats, scales, sh0, optional shN_*)
└── env/                   ← optional environment SOG
```

Chunks are plain SOG v2, decodable by our existing `parseSog` core once it
accepts an entry source other than a ZIP (chunk files are fetched
individually, not zipped). **The `{lod}_{chunk}/` directory naming is a
writer convention; readers must resolve chunk locations only through the
manifest's `filenames` array.**

## Manifest schema (`lod-meta.json`, version 1)

```ts
interface LodMeta {
  version: 1;
  asset?: { generator?: string };
  count: number;          // total Gaussians across all LODs
  counts: number[];       // per-LOD counts, index = LOD level
  lodLevels: number;
  environment?: string;   // relative path to environment SOG
  filenames: string[];    // chunk references, e.g. "0_0/meta.json"
  tree: Node;             // binary spatial tree
}

interface Node {
  bound: { min: [number, number, number]; max: [number, number, number] };
  children?: [Node, Node];  // interior nodes only
  // leaf nodes only, string keys are LOD levels ("0" = finest):
  lods?: Record<string, { file: number; offset: number; count: number }>;
}
```

Semantics, confirmed on the fixture:

- **LOD `0` is the highest detail**; higher levels are progressively coarser.
- Every leaf covers one spatial region and lists the *same region* at each
 available LOD; a viewer picks one level per leaf based on camera distance.
- `file` indexes into `filenames`; `offset`/`count` are **splat-row ranges
 within that chunk's images** (row-major, same indexing as static SOG).
 One chunk file serves many leaves: in the fixture, leaf ranges within a
 chunk are contiguous and ascending (0→231→348→469→…), so a chunk decodes
 once and leaves activate sub-ranges of it.
- Chunks partition subtrees per level: our 1.9M-splat fixture produced four
 LOD-0 chunks (`0_0`…`0_3`), two LOD-1, one each for LOD-2/3.

## Generating a fixture

The official path is `@playcanvas/splat-transform` (MIT): decimate the
source into coarser levels, tag inputs with `-l <level>`, and write a
`lod-meta.json` output (the output filename must be exactly
`lod-meta.json`; `meta.json` would produce static unbundled SOG):

```bash
splat-transform base.ply -d 50% lod1.ply
splat-transform base.ply -d 25% lod2.ply
splat-transform base.ply -d 10% lod3.ply
splat-transform base.ply -l 0 lod1.ply -l 1 lod2.ply -l 2 lod3.ply -l 3 out/lod-meta.json
```

### ⚠️ Flag-rename trap (cost us a day)

Upstream renamed flags (splat-transform issue #277): in v3.0.0,
**`-d/--decimate` is the decimator** and **`-F` means `--filter-floaters`**
(older docs showed `-F` as decimate). Running `-F 50%` therefore invokes the
*voxel floater filter* with garbage parameters, which crashes on large
scenes with `RangeError: Set maximum size exceeded` in `buildBlockLookup`
(a JS `Set` capped at 2²⁴ entries; known open issue #275). We initially
misread that crash as "decimation is broken" and built the fixture by
stride subsampling instead, which renders sparse/holey coarse levels.

### Why decimation quality matters (how PlayCanvas avoids gaps AND blobs)

The real decimator never voxelizes. It picks similar neighbor pairs
(KNN + edge-cost greedy matching) and **moment-matches** each merged group:
merged covariance `Σ = Σₖ pₖ(δₖδₖᵀ + Σₖ)`, the spread term grows the
merged splat exactly enough to span its parents, with mass-conserving
opacity `α = min(1, W / area)` and mass-weighted color. Coverage is
preserved adaptively, so coarse levels look like softly blurred versions of
the scene: no holes (unlike naive subsampling) and no uniformly inflated
blobs (unlike a render-time scale boost). The PlayCanvas *engine* applies
no LOD-dependent adjustment at render time at all, coarse-LOD quality
lives entirely in the data. Our fixture is regenerated with `-d` and
verified hole-free even with every leaf forced to the coarsest level.

## Verification performed (acceptance)

Reference viewer: PlayCanvas engine (latest via jsdelivr CDN) in
`assets/pc-viewer-test.html`, served by the dev server so the fixture is
same-origin. Findings:

- The `gsplat` asset type accepts the `lod-meta.json` URL directly; no
  extra configuration ("streaming is enabled simply by loading it").
- The network log shows camera-driven chunk streaming: per-chunk
  `meta.json` + WebP fetches across LOD levels as the camera moves.
- LOD selection reacts to distance and to
  `entity.gsplat.lodBaseDistance` / `lodMultiplier` (component-level knobs).
- With `lodBaseDistance = 500` (forcing LOD 0 everywhere), the streamed
  fixture renders **pixel-identical to the static `sandwijcksh1.crop.sog`**
  loaded in the same viewer, the fine level is exact.
- Our own viewer and PlayCanvas agree on scene scale and content (verified
  with matching top-down captures; scene spans ±160 units. SOG positions
  are symmetric-log encoded, so most content sits near the origin but the
  scene is much larger than its dense center).

## Implications for M2.1–M2.3 (our implementation)

- `parseSog` needs an entry-source abstraction (ZIP entry vs URL fetch) -
  chunk decode itself is already done.
- Loading granularity: fetch + decode per **chunk file** (5–8 small HTTP
  requests each); activate per **leaf sub-range**. No HTTP byte-range
  tricks required by the format.
- The manifest tree is small (binary tree over leaves); flattening leaves
  with bounds at load time is enough for distance/frustum LOD selection.
- Mirror PlayCanvas's tunables (`lodBaseDistance`, `lodMultiplier`) so
  scenes behave familiarly across viewers.
- `counts[]` gives exact per-level totals up front: useful for budget
  planning before any chunk is fetched.
- The optional `environment` SOG (present in e.g. XGRIDS exports) can be
  treated as one always-loaded chunk.
