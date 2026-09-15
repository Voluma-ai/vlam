# SparkJS `.rad` / `.radc`: format notes (M14)

Research notes for World Labs' Spark 2.0 `.rad` ("radiance field") LOD splat
format, read directly from the MIT-licensed Rust reference in
[`sparkjsdev/spark`](https://github.com/sparkjsdev/spark)
(`rust/spark-lib/src/rad.rs`, `splat_encode.rs`, `chunk_tree.rs`) and
cross-checked against two real captures: `bentleywar.rad` (6.3M splats, 97
chunks, SH degree 3) and the Eemhart `point_cloud-lod.rad` (53M splats, 816
chunks, no SH). Read together with `ROADMAP.md` M14. Implemented under
`src/lib/formats/rad/` (`parse-rad.ts`, `rad.ts`, `rad-frontier.ts`,
`frontier-pager.ts`, `frontier-worker.ts`) and the whole-file path in
`load-worker.ts`.

### Current streaming architecture (large captures)

- **Default `foveationMode: 'page-table'`** for `.rad` whose leaf count exceeds
  the budget-lift ceiling (~6M): Spark's selected-index model, off-thread
  [`FrontierPager`](../../src/lib/formats/rad/frontier-pager.ts) +
  [`frontier-worker`](../../src/lib/formats/rad/frontier-worker.ts) page only the CPU-
  selected frontier into a fixed pool slab; sort/vertex cost tracks **drawn**
  splats (`foveationDrawBudget`, default `PAGETABLE_DRAW_BUDGET` = 4M).
  The traversal **foveates rather than frustum-culls**, and enforces the draw
  budget inside the descent, see §"Coverage and budget" below.
- **Moderate captures** (budget auto-lift): [`RadLodSource`](../../src/lib/formats/rad/rad.ts)
  prefix frontier, uniform refinement, no worker, full leaf resolution.
- **A/B legacy modes:** `?foveationMode=band` (screen-radius band) and
  `?foveationMode=frontier` (whole-chunk GPU per-splat cut), see history doc.

`VLAM_EXPERIMENT=rad-focus` benchmark-server variant trials a separate,
request-only camera traversal on captures whose estimated decoded size exceeds
their current cache allowance (`baseline` keeps the legacy order). It coalesces
camera demand at 100 ms intervals, yields the worker walk after 4 ms, ranks
visible parents by projected coarseness with a smooth 4× center preference,
and reserves a fetch slot for boundary, uncertain or off-screen dependencies.
Only a complete reply for the newest camera may cancel unpinned downloads;
the pager's staged cut, draw budget and display publication are unaffected.
This is not the production default until paired central-detail and frame-tail
measurements, including pixel/coverage checks, pass the acceptance gate.
RAD chunks mix locations, so this can avoid obsolete or low-value requests but
cannot guarantee zero off-screen bytes.

`VLAM_EXPERIMENT=rad-indexed` selects the isolated stable-slot pager. It keeps
the published active-index list separate from a candidate, reuses unchanged
global splats in place, and writes newcomers only into free slots. A complete
candidate is handed to standalone WebGPU, unified WebGPU, or the WebGL2 sort
worker as one index generation; the worker retains the previous display slots
until that backend acknowledges its matching sorted publication. The variant
reserves 2× its maximum drawn frontier. If that reservation does not fit the
configured pool or the portable 8192-row device floor, initialization keeps the
classic pager and the benchmark JSON reports `radPager.mode: "classic"`; it
never lowers the draw target to qualify. `radPager.memory` estimates the actual
pool, index/sort storage, CPU backing, and enabled packed SH allocation.

The viewer's `?cacheMB=` supplies a cache *floor*, not a forced smaller
allowance; a capture that fits its default allowance will correctly keep the
legacy scheduler in both variants. The frame benchmark JSON includes internal
demand generations, stale replies, cancellation counts, and known inline-RAD
range bytes (not transport-level transferred-byte measurements).

For native-browser arrival comparisons, start separate local benchmark servers
with `VLAM_EXPERIMENT=baseline`, `VLAM_EXPERIMENT=rad-indexed`, and (when
measuring request policy) `VLAM_EXPERIMENT=rad-focus`, on distinct ports.
Then run `node scripts/rad-detail-benchmark.mjs --base=http://127.0.0.1:<port>
--scene=lcc --label=<variant> --allowanceMB=768 --budget=1000000
--sampleMs=60000`. The local-only `radBenchmarkAllowanceMB` viewer parameter is
accepted only while benchmark instrumentation is enabled; it makes the cache
allowance comparable on a capture that otherwise fits the machine's default.
The runner requires a headed Chromium, defaults to native WebGPU, saves sampled
frames and central-image error against the settled frame under ignored `.tmp/`,
and supports `--backend=webgpu|webgl`,
`--routes=overview-fly,direct,turn-return,orbit`, `--runs=5`,
`--cacheMode=cold|warm`, and `--memory=off|sample`. Memory defaults to `off`
so `measureUserAgentSpecificMemory()` cannot delay screenshot timestamps;
`--memory=sample` is only for separate memory runs. `--sampleMs` is sampled
through its requested endpoint, not capped at the historic 60 s table. A run
that never shows a first image, loses the GPU device, or finishes with a
streaming error is recorded as failed and yields no arrival number. In warm
mode the runner performs one unmeasured priming load of the first route, then
`--runs` measured loads on new pages that reuse the browser HTTP cache. That
does not retain a decoded GPU/JS scene; each measured run still starts from an
empty page. The prime is written to `prime.json` and is not mixed into
`results.json`.
For comparable-detail timing, capture one settled production-VLAM frame and
pass it to every run with `--reference=<final.png> --thresholdMae=<fixed>`.
Without `--reference`, each run compares against its own final frame and is
diagnostic only; it must not be used for an indexed/classic speed claim.
Its screenshot comparisons are diagnostic: choose the equivalence threshold
from inspected images before using them as an acceptance gate, and reject runs
whose reference frame is still pending. rAF frame tails exclude screenshot
pauses. Request-to-decode time currently combines transport and decode, while
known range bytes are not a measurement of actual network transfer.

On 2026-09-15, five direct-load cold and warm native WebGPU trials used one
30-second production-VLAM frame as the shared reference (central MAE threshold
0.383), a 1280×720 viewport, 1M draw budget, and 768 MiB cache allowance on the
available 10.1M-leaf LCC RAD. Indexed reached the equivalent-detail sample at a
7.501 / 7.501 s cold / warm median in all ten trials; successful classic trials
reached it at a 15.001 s median (four of five in each set). One classic cold
reference was still refining at 20 s, and one clean classic warm rerun converged
to a visibly different cut, so those trials were rejected rather than imputed.
This is a measured 50.0% earlier sampled arrival on this route. An initial
indexed build doubled median p99 to
33.4 ms by publishing and sorting every near-budget cut. Resolving slab page
bases once per publication and allowing one near-budget follow-up before an
idle final cut restored cold and warm median p95 / p99 to 16.8 / 16.8 ms; cold
worst p99 was 18.3 ms. Estimated pool-and-sort memory rose 398.8→528.7 MB
(+32.6%).

The supplied Poland capture subsequently exercised the intended scale: a
2,754,121,856-byte single-file RAD (SHA-256
`375af16fec68eea208a0e4df45ed3b25ea83eb22ffff8eeccb48df4bc42cc2d3`),
106,447,647 leaf splats, 151,581,987 tree nodes, 2,313 chunks, and no SH. Five
direct-load trials per cache mode used a bounds-derived 4×2 km aerial pose, the
same 60-second production reference, central MAE threshold 0.25, 1280×720,
4M draw budget, and 768 MiB cache allowance. Indexed reached equivalent detail
at 7.501 / 7.500 s cold / warm median versus classic 9.123 / 8.388 s: 17.8% and
10.6% earlier, respectively. Every final frame matched the shared reference;
median p95 / p99 was 16.8 / 16.8 ms for all four sets. Indexed's worst p99 was
33.2 ms cold and 20.3 ms warm versus classic's 16.8 ms, so the tail/device gate
is not yet closed. Estimated pool-and-sort memory rose 808.9→1,073.0 MB
(+32.6%), as expected from the 1.5×→2× reservation. A real-scene indexed
WebGL2 smoke reached the same 2,611,810-splat cut without errors.

The matched settled harness now truly pages Spark RAD instead of decoding the
whole 2.75 GB file, gives Spark the same 4M LOD target and a chunk-aligned 1.5×
page pool, and waits for both renderers' final pager/sort boundary. Five rotated
native timestamp trials held VLAM classic and indexed at the same ~4M cut:
median GPU time was 3.966 / 3.979 ms and median GPU p99 6.655 / 4.001 ms, with
16.7 / 16.7 ms median frame intervals. Installed Spark 2.2 held a smaller
3,382,402-splat cut and measured 3.260 ms median GPU, so that number is not an
equivalent-detail speed comparison. All fixed captures were nonblank. Keep
`rad-indexed` benchmark-only until movement routes, additional devices, and the
observed arrival/frame-tail variance pass. The real unified-WebGPU parity
harness was then run against the supplied Poland file at a 4M draw budget and
the bounds-derived aerial pose. It reached a complete 1,862,866-splat cut with
zero pending or stale residents, no page errors, and direct/unified settled
central MAE 3.82 RGB levels. The harness now accepts `budget`, `budgets`,
`cameraPosition`, `cameraTarget`, and `settleMs` query parameters and probes
local range assets with GET rather than HEAD.

The earlier five cold and five warm turn-and-return/orbit captures are retained
as loading and publication diagnostics, but they are not valid movement
evidence: the Poland manifest's aerial pose has zero horizontal radius, so the
old route traced a point, and its frame sample began after the motion interval.
The runner now derives a deterministic fallback radius for a top-down pose,
records the travelled distance, rejects zero-motion orbit/turn routes, and
reports frame tails over the motion-inclusive interval as well as the settled
tail. It also requires every RAD frontier (including Poland) to be converged
before a frame can become a shared reference. Re-run the paired cold/warm
matrix with this corrected route before making an arrival or motion-performance
claim.

The first native Chromium/WebGPU trials on the local LCC pose at a 768 MiB
allowance and 1M draw budget did **not** pass the activation gate. A request-only
scan that waited for a complete reply regressed direct loading (about 40 s
versus 15 s). Provisional demand replies removed that stall: direct loading
reached the same settled central frame at the 15 s sample in both variants.
The fly-to trials also reached it at about 10–15 s for legacy and 15 s for
focus; inspected intermediate frames showed the focus image still visibly
softer at 3.5 s in one paired run. These are exploratory, unpaired-in-time
single runs rather than a cold/warm median. Keep `baseline` as the production
default until repeated, visually audited runs meet the stated quality and
frame-tail thresholds.

Page-table fetches prioritize chunks requested by the current frontier. The
coarse-base stream runs until the first complete display; after that it keeps
pre-warming only when the whole decoded capture fits the current cache
allowance. The background whole-scene sweep follows the same fit rule. On a
larger capture, continuing either speculative stream can fill the cache with
off-view chunks, evict current-view dependencies and leave an already published
cut unable to refine. A scene-wide cache governor can re-enable pre-warming by
granting enough allowance; the draw target and coverage rules do not change.

## Container

```
RAD0 header:
  u32  magic 'RAD0' (0x30444152 LE)
  u32  metadata JSON byte length
  …    metadata JSON (RadMeta)          ← padded to an 8-byte boundary
  …    chunk stream (one or more RADC chunks)

RADC chunk:
  u32  magic 'RADC' (0x43444152 LE)
  u32  chunk-metadata JSON byte length
  …    chunk metadata JSON (RadChunkMeta) ← padded to 8
  u64  payload byte length
  …    payload: each property's column, in order, every column padded to 8
```

`RadMeta` fields we use: `version` (must be 1), `type` (`"gsplat"`), `count`
(total splats), `maxSh`, `lodTree` (bool), `chunkSize` (always 65536 in
practice), `chunks[]` = `{offset, bytes, filename?}`. **There are no scene
bounds and no per-chunk splat counts in the header**, `base`/`count` on a
chunk range are `#[serde(skip)]` in the encoder. So chunk `c` spans global
splats `[c·chunkSize, min((c+1)·chunkSize, count))`, and we derive bounds by
decoding chunk 0 (which coarsely covers the whole scene).

`filename` present on a chunk range ⇒ it is an external `.radc` file (the
`spark build-lod --rad-chunked` layout). Whole-file loading rejects those (it
needs one self-contained file); **streaming supports them** (M14.3):
`buildRadScene` resolves each `filename` against the manifest and the worker
fetches it whole (`RadChunkRangeRequest` with no `start`/`length`), vs a byte
range for a single-file `.rad`. Dropping a `scene.rad` + `scene-*.radc` folder
also streams, `.rad` is in the `createLocalDataset` manifest table (the
`.radc` chunks are excluded, since they end in `.radc`).

## Property columns & encodings

Payload is **planar**, one column per property (`center`, `alpha`, `rgb`,
`scales`, `orientation`, `sh1/2/3` or `sh_label`+`shN_code`, and for a LOD tree
`child_count`, `child_start`), each column independently compressed. The
metadata says `"gz"` but `miniz_oxide::deflate` emits a **raw DEFLATE** stream
(no gzip/zlib wrapper); `parse-rad.ts` sniffs the first bytes and picks
`gzip` / `deflate` / `deflate-raw` so a future wrapper change still decodes.

Per-property encodings (all ported in `parse-rad.ts`, verified against real
files): `f32`, `f16`, `f32_lebytes` / `f16_lebytes` (byte-plane transposed for
compressibility), `r8` / `r8_delta` (min/max quantized, delta = running
byte-wise diff per column), `s8` / `s8_delta` (signed, `max/127`), `ln_0r8`
(log-space scale; byte 0 = zero scale, 1–255 map across `[min,max]` in ln
space), `ln_f16`, `oct88r8` (octahedral quaternion: 2 axis bytes + 1
half-angle byte). Ranges (`min`/`max`) ride on the property metadata. **Fail
loudly on any unrecognized encoding/property**, the format is young.

The real Eemhart resolved encodings: center `f32_lebytes`, alpha `f16`, rgb
`r8_delta`, scales `ln_0r8`, orientation `oct88r8`.

## The LOD tree

Built by `chunk_tree_size` (`chunk_tree.rs`): a priority queue pops splats
largest-`feature_size` first, appends each popped node's children to a running
index list, and cuts a chunk when it fills 65536. Key invariants we rely on:

- **Chunk 0 is the coarsest whole-scene overview** (root + largest merged
  nodes); later chunks add finer detail.
- **A splat's children are the contiguous global range
  `[child_start, child_start + child_count)`** (children are appended
 contiguously when a parent is expanded). `child_count == 0` marks a leaf.
- **A splat's children always have a higher global index than the splat**, so
 every node's ancestors live in earlier-or-equal chunks. Verified: on both
 test files, decoding the whole tree recovers exactly the reported
  `input_splat_count` leaves (37,082,064 for Eemhart; 4,351,017 for
  bentleywar).

Internal (merged) nodes approximate their subtree with one gaussian; with a
LOD tree, `alpha` is encoded in `[0,2]` (values >1 encode a size-expansion
factor in Spark's renderer). The display and unified shaders recover that
encoded value from the original texture channel and apply visual opacity
(source fades, alpha modifiers) only after merged-vs-leaf classification.
`writeSplat` applies it: opacity is `min(alpha,1)`
and the scales are multiplied by `radExpansion(alpha)` (1 for leaves, up to 3.8
at alpha=2) so coarse nodes render enlarged enough to cover their subtree,
matching Spark. Without it merged nodes render up to ~3.8× too small and leave
gaps in the foveated far field.

## Whole-file vs. streamed

- **Whole-file** (`parseRad`, small files via `loadSplatData`): decode every chunk,
  keep **leaf splats only** (drop merged nodes), producing a `SplatData`
  identical to the source capture. Only viable under the ~16.7M-splat single-
  texture cap; a 53M capture must stream. That cap is enforced **in `parseRad`
  only**, `parseRadHeaderMeta` is shared with the streamed reader, where the
  header count sizes nothing, so it bounds `count` structurally instead (no
  more than `chunkSize × chunks.length`) and lets a 53M-node tree through.
- **Streamed** (`buildRadScene` + `RadLodSource`, `StreamedSplatMesh`): keep
  every splat of each resident chunk and render the **frontier** of a resident
  prefix `{0…k−1}`. A splat draws iff it is a leaf **or** its `child_start ≥`
  the prefix's total splat count (its children are not resident). Loading chunk
  k reveals its splats and hides the parents whose children it now contains -
  no double-draw; a transient hole only at a chunk-boundary straddle mid-fetch.

### Why the frontier maps cleanly onto the existing pool

`LodRun.leafStart/leafEnd` are **global splat indices**. Runs within resident
chunks diff against the resident set as usual; when chunk k arrives, the same
`computeDesiredRuns` both drops the now-hidden parent runs and adds chunk k's
frontier runs, so the swap machinery applies both in one tick. The per-splat
tree columns reach the source via `SplatData.radTree` +
`LodSource.onChunkDecoded` (called the same tick the chunk becomes cache-
resident), so discovery and residency stay in lockstep.

**Per-chunk splat reorder (load-bearing).** Spark orders a chunk's splats by
feature size, so leaves and internal nodes interleave. The frontier test
("draw iff leaf or `child_start ≥ residentCount`") over that raw order is
maximally fragmented, a deep prefix of a 6M capture produced ~1.6M single-
splat runs, which the coalescing pool cannot absorb (it filled to ~7K of a
3.7M frontier and stalled). So `chunkToSplatData` reorders each chunk's splats
by **descending frontier key** (leaves first, key `+∞`; then internal nodes
by `child_start` descending). The drawn set of any chunk is then a contiguous
*prefix*, so the frontier coalesces to **one run per chunk** (~80 runs, not
1.6M). The reorder is sound because it never moves a splat's children out of
their chunk, and the reader only threshold-tests `child_start`, never follows
it to a specific child. Verified in-engine: the pool then fills to the full
3.7M frontier and renders on WebGPU. This bug is invisible to a headless test
that checks only `computeDesiredRuns` counts, it needs the real pool.

### Discovery & growth

`discoveredDepth` is the longest contiguous decoded prefix. `computeDesiredRuns`
emits the frontier of the largest prefix whose drawn count fits the budget
(cached, it does not depend on the camera in this cut), plus **fetch-intent
runs** for the next `PREFETCH_AHEAD` undecoded chunks (their geometry is
immaterial; only their `file` matters, to make the mesh fetch them). Growth
stops once the drawn count reaches `budget · FILL`, so the prefix, and the
pool, sized to the budget, never chases the full 53M total.

## Blob suppression (M14.5, shipped)

The user's ask, "skip the coarse LOD levels when they're close", ships as a
screen-space cull: `SplatMesh`'s `maxSplatScreenRadius` (px) culls any splat
whose *unclamped* projected radius exceeds the threshold (a hole, not a quad).
A coarse merged node spans meters, so it projects huge near the camera, while a
fine surface splat stays small, and a wall is many small splats, not one big
one, so the size test targets blobs and spares detail. In the material graph
it gates the quad write on `lambda1.sqrt()·maxStdDev ≤ threshold` (the clamped
`majorAxis` can't be used, it caps at `MAX_SPLAT_RADIUS_PX`, so every big splat
looks identically sized). On by default for `.rad` in the demo (`?blobCull`,
default 350; `0` off).

## Budget auto-lift for moderate scenes (shipped)

Because refinement is uniform (below), a budget under the leaf count leaves
coarse blobs *everywhere*, worst up close, where the eye expects the finest
detail. So `StreamedSplatMesh.fromSource` lifts a `.rad`'s budget to the full
leaf count (Spark's `input_splat_count`, parsed from the header comment;
`meta.count` as fallback) when it fits `FINEST_LEVEL_BUDGET_MAX` (6M) and the
user pinned no budget, the same `liftBudgetToFinestLevel` LCC uses. The
frontier then loads every chunk and reaches full resolution (verified:
bentleywar draws all 4,351,017 leaves, zero blobs, at the default budget). A
capture whose leaf count exceeds the cap uses the **page-table** pager (default)
for camera-distance refinement.

**An explicit `budget` suppresses the lift**, deliberately, so an A/B run gets
the cap it asked for. The trap is an application sharing a budget across several additional
meshes: passing `budget: total / N` per mesh turns the lift off and leaves
every mesh uniformly coarse, which is exactly the case the lift exists for.
Under a `BudgetGovernor` / `CameraBudgetGovernor`, pass **`maxBudget` ≥ the leaf
count** instead and let the governor set the working budget: the pool is then
sized to hold the full leaf set, and a focused additional mesh can actually be given it.
See [`../guide/multi-mesh-budgets.md`](../guide/multi-mesh-budgets.md).

**The path choice now also tests the budget (2026-07-31).** `buildRadScene`
picks between the prefix reader and the page table on
`leafCount > FOVEATION_LEAF_THRESHOLD || leafCount > effectiveBudget`, where
`effectiveBudget` applies the lift only when the caller pinned neither `budget`
nor `maxBudget`, mirroring `fromSource`'s own precondition, so the two cannot
disagree. The prefix reader's one advantage is reaching *full* leaf resolution
at `budget >= leafCount`; below that it spreads a fixed budget uniformly and
approaching a surface never sharpens it, which is strictly worse than foveating.

This softens (but does not remove) the trap above: a pinned budget too small for
the leaves now foveates rather than going uniformly coarse. Prefer `maxBudget`
anyway, a mesh that *can* hold its leaves still looks better taken whole.

Measured on the reference capture at a pinned 1M budget, same camera, both
settled, mean |gradient| over a 512² readback as a sharpness proxy:

| | prefix (before) | page table (after) |
| --- | --- | --- |
| sharpness | 12.14 | **22.00** (+81%) |
| lit coverage | 0.6998 | 0.7028 |
| active splats | 994,413 | 1,000,000 |

Coverage is the number that matters for "did foveating leave holes": within
0.4%, so the frontier still covers the scene.

## Why camera foveation is *impossible* at chunk granularity: measured

Foveation (fine near, coarse far, loading only near detail so a 53M capture
doesn't download everything) needs an **ancestor-closed** resident chunk set
(a coarse ancestor that isn't resident would double-draw over any refined
descendant). Measured on `bentleywar.rad` (decode each chunk's `child_start`,
bucket children by `⌊index / 65536⌋`, invert for parents):

- **child-chunk fan-OUT** avg 10.2, max 49.
- **parent-chunk fan-IN** avg 10.2, max 22: **only the root chunk (0) has ≤1
  parent; every other chunk has ≥2.**

That fan-in is fatal to a chunk-cut. Starting from `S = {0}`, a chunk is
addable only when *all* its parents are in `S`, but no chunk except the root
has all its parents equal to `{0}`, and each candidate second parent itself
needs ≥2 parents resident, and so on. The DAG is entangled enough that **no
ancestor-closed subset larger than `{0}` exists**, so the set can never grow:
distance-prioritized chunk selection is provably stuck at the coarse floor.
(Confirmed in-engine: a chunk-cut `RadLodSource` selected exactly `{0}` and
drew 49,718 splats regardless of camera.)

## M14.6: Foveation modes (summary; history in `history/rad-paging-history.md`)

Spark's own runtime cut (reverse-engineered from `rust/spark-rs/src/lod_tree.rs`,
`traverse_lod_trees`) is a **CPU priority-frontier traversal**, not a chunk cut:

- Each LOD node has a `size` (`= 2 · expansion · avg(scale)`, where
  `expansion = 1 + 0.7·(alpha·4 − 4)` for a merged node's `alpha ∈ (1,2]`, else
  1) and a `child_start`/`child_count`. Both are derivable from data we already
  decode (alpha, scales, tree columns), no extra file data.
- `pixel_scale(node) = size / distance · lodScale · foveate(angle)`, where
  `foveate` is 1 inside a front cone (`coneFov0`), ramps down to `coneFoveate`
 at `coneFov`, and to `behindFoveate` behind the camera.
- Traverse a max-heap by `pixel_scale` from the root: pop the largest; if
  `pixel_scale ≤ pixelScaleLimit` (small enough on screen), **stop**, output it
  and everything left in the heap. Otherwise, if its children are **resident**,
  descend (replace it with its children); if not resident, output it (coarse).
  `pixelScaleLimit` self-adjusts so the output stays within `maxSplats`.
- `children_resident` is a chunk-residency test (`chunk = index >> 16`, i.e.
 chunkSize 65536), exactly the residency we track. The traversal descends only
 into loaded chunks, so **no ancestor-closed chunk set is needed**, this is the
 way around the entangled-DAG wall above. It also records the `touched` chunks
 it wanted to descend into, which drives paging (fetch near-camera detail).

This maps onto our pool as a **per-splat GPU cull** (equivalent cut, no CPU
gather): append whole resident chunks as runs (coalesced), and in the material
draw splat `i` iff `parentPixelScale(i) > limit ≥ ownPixelScale(i)` (a leaf
draws when `parentPixelScale > limit`). That is the same frontier, evaluated
per splat, and never double-draws over resident splats.

### Legacy A/B: per-splat frontier cut (`foveationMode: 'frontier'`)

Spark's exact tree cut, evaluated per splat on the GPU: draw splat `i` iff
`parent_size/distance > limit ≥ own_size/distance` (a leaf, with no finer level,
draws whenever `parent_size/distance > limit`). One node per root→leaf ray
survives, so coverage is **full by construction**, no gaps, no band leapfrogging
when merged-node expansion enlarges a level past a fixed band's upper bound.

Implementation avoids the "two float channels" of the earlier plan:
- **`own_size` is derived in the shader** from the covariance: `Σ = R·S²·Rᵀ` so
  `own_size = 2·√(trace(Σ)/3)`. With the expanded scales (the `radExpansion`
 covariance fix) this already includes the merged-node expansion, the exact
 same measure `parent_size` uses, so level transitions are clean. No upload.
- **`parent_size` is packed into `covarianceB.w`** (otherwise unused), sign-
 encoding leaf-ness: `>0` internal, `<0` leaf, `|v|` the parent's world size,
  `FRONTIER_ROOT_SIZE` (1e30) ≈ ∞ for a root, `0` (unwritten) treated as a root.
  `RadFoveatedSource.onChunkDecoded` computes it via `RadParentSizes` over the
 trace-derived own sizes and attaches `SplatData.frontierParent`; it rides the
 covariance upload path (`sliceSplatData` → `writeSplatRows`). `radTree.size`
 (avg-based) is no longer needed for the cut, the trace measure replaces it.
- **`limit` is the `pixelScaleLimit` uniform**, set each frame to
  `foveationTargetPx / focalY` so the cut targets a fixed on-screen node size
  (`?foveationPx=` tunes it). Budget-feedback on the limit (Spark's step 4) is a
  later refinement; the foveated loader already bounds the resident set.

The legacy **screen-radius band** (`RAD_FOVEATION_BAND = {1.6, 4}` px, one level
per ray via the geometric size ratio) is kept behind `foveationMode: 'band'`
(`?foveationMode=band`) for A/B, but is no longer the default: it culls
expansion-enlarged coarse nodes past its upper bound with no resident child to
replace them, leaving the far-field holes the frontier cut removes.

Loading was `RadFoveatedSource`: chunk 0's coarse shell (a few shallow chunks,
always resident for far coverage) plus the nearest chunks by bounds distance, up
to the budget, rendered whole. No ancestor-closedness, the band cull is correct
over any resident set, so the entangled-DAG wall does not apply. Prefetch of
undecoded refinements is bounded to chunks nearer than the farthest resident, so
a fixed view does not stream the whole capture. Chosen for `.rad` whose leaf
count exceeds the 6M budget-lift ceiling; smaller captures keep the prefix reader
(`RadLodSource`), which is memory-efficient and already full-resolution.

Parked for A/B after the `cest_ca` coverage audit; production default is
**`page-table`**.

### Production default: page-table pager (`foveationMode: 'page-table'`)

Spark's CPU traversal + selected-index paging. The worker evaluates the same
frontier cut, `FrontierPager` diffs updates, and the main thread applies a
minimal plan to the pool slab. Tuning: `?foveationDraw=`, `?foveationPx=`,
`?coneFov0=`, `?coneFov=`, `?coneFoveate=`, `?behindFoveate=`.

**Display hold.** After the first complete cover fills in, `FrontierPager`
freezes `displayCount` at that prefix. Later cuts append replacements onto
the undrawn tail and only swap the drawn prefix when the worker *publishes*:
the traversal has every chunk it asked for (`touched` empty), the chunk
cache is full, the slab is at capacity, or the camera moved. Publishing
every drained intermediate cut was the remaining "LOD goes up and then
back down" loop: each newly cached chunk produced a different complete
frontier (budget redistributes) and the shader drew it immediately.
`solvedLimit` still refines while budget remains and does not coarsen
after a clamp.

**Earlier complete first image (page-table default).** The first fully staged,
complete intermediate cover is published when it reaches 50% of the initial
draw-splat budget, even if some requested child chunks have not arrived. This
was chosen after the raw chunk-0 cover looked too coarse up close and the
target-detail hold kept a large capture blank too long. It is a count of selected
splats, not 50% of an image's pixel quality or of the bytes downloaded. The
published cover remains visible until the normal atomic replacement is staged;
the final draw budget, LOD target, and near-camera fetch priority are unchanged.
The library option is `radInitialDisplayFraction`. In the viewer,
`?radInitialDisplay=0` restores the previous target-detail hold for A/B,
`?radInitialDisplay=coarse` explicitly selects the default, and a numeric
fraction in `(0, 1]` tunes the threshold. Prefix RAD and other formats are
unaffected. Watch for brief local quality changes when the first finer cut
redistributes its fixed budget; the 50% gate alone does not prevent those.

The prefix reader (`RadLodSource`, moderate captures under the 6M lift
ceiling) uses the same publish policy without a pager: every depth, including
chunk 0's overview, uploads into inactive ranges and the mesh presents only
when every `fetchIntent` prefetch file is cached, the CPU cache is full, or
the pool cannot hold both sides. After that first presented cut, a later
swap is refused if it is coarser or only a partial replacement — cache-full
eviction was still flipping the picture between a sharp prefix and a noisy
one. Prefix meshes also share the page-table capture-sized cache ceiling
(`min(2 GiB, decoded size)`), so a lone scene is not thrashed at 256 MiB.

**Per-mesh `lodScale`.** `StreamedSplatMeshOptions.lodScale` (mutable via the
accessor) is Spark's own knob: its cut is `pixel_scale × lodScale ≤ limit`, and
the traversal only ever sees one side of that comparison, so the mesh posts
`limit / lodScale` and no protocol field was needed. `> 1` refines further,
`< 1` coarsens; the draw budget still bounds the result. It applies to
`page-table` only, a prefix-read `.rad` has no per-splat cut to scale, and for
the GPU cuts (`band` / `frontier`) the equivalent is `foveationTargetPx =
1 / lodScale`.

**Governed draw budget.** `setBudget` re-derives `pageTableDrawBudget =
min(budget, foveationDrawBudget ?? 4M)` and it is posted every reschedule, so a
shared-budget governor drives the frontier's descent depth directly. A
*caller-pinned* `foveationDrawBudget` outranks the budget, and a governor growing
the mesh past it buys nothing, `setBudget` warns once when that happens rather
than leaving the mesh quietly coarse. `StreamedSplatMesh.drawBudget` exposes the
effective target.

### Coverage and budget (M14.7: Spark parity)

Two invariants of `traverseFrontier`, both taken from Spark's
`new_traverse_lod_trees` (`rust/spark-worker-rs/src/lod_tree.rs`):

- **Foveation, not culling.** A node's traversal priority is
  `size / distance × foveate(angle)`, where `foveate` is 1 inside `coneFov0`
  (90°), ramps to `coneFoveate` (0.4) at `coneFov` (120°), and to
  `behindFoveate` (0.2) behind the camera. Spark's `new_compute_pixel_scale`.
 Off-cone geometry stops *descending* earlier; it is never removed. So every
 root→leaf ray always ends in exactly one output node and the whole scene is
 covered at all times.
 A hard frustum cull (what this used to do) deleted whole subtrees from the
 selection, so the slab held no data at all outside the frustum: zooming out or
 turning exposed a **black region** that stayed black until the next plan
 landed. Behind-camera / off-cone content must be *coarse*, not absent.
- **Budget enforced inside the descent.** Before expanding a node the traversal
 checks `numSplats, 1 + childCount > maxSplats` and stops, then drains the rest
 of the heap into the output. One O(frontier) pass is therefore always complete
 *and* always within `foveationDrawBudget`, nothing for `FrontierPager` to
 truncate afterwards (`PagerPlan.dropped` is 0; a non-zero value now warns).
 The previous limit bisection (`searchLimitWithinBudget`, kept only for the
 legacy A/B cut) ran the whole traversal up to five times per reschedule and
 could still return an over-budget selection, so a camera move stalled for
 seconds and then dropped an arbitrary slice of the scene.

The cut limit is a fixed function of the projection, exactly as Spark computes
it: `foveationTargetPx / focalY`, i.e. `targetPx · 2·tan(fovY/2) / renderHeight`.
`foveationTargetPx` defaults to **1**, the same as Spark's `lodRenderScale`
(`pixelScaleLimit = 2·tan(fovY/2) / renderHeight × lodRenderScale`,
`SparkRenderer.ts`), so nodes refine until they are about a pixel and the draw
budget is the only thing that stops the descent. 

**Fetch priority.** The chunks the traversal wanted but did not have (`touched`,
biggest-on-screen first) are requested *before* the file-order background sweep,
which is capped to leave `PAGETABLE_PRIORITY_SLOTS` (3, matching Spark's
`numLodFetchers`) free and stops once the worker cache reports an eviction.
Issued after the sweep, the touched requests were dropped by the in-flight cap on
every tick, so the capture downloaded coarse→fine in file order while the region
on screen waited.

**Main-thread cost.** In `page-table` mode `RadFoveatedSource.needsParentSizes` is
false: per-splat `parent_size` is a GPU-cut input the worker never reads, and
computing it kept one pending-range object per internal node alive in
`RadParentSizes` until its child chunk decoded (tens of millions of live objects
on an 800-chunk capture). Paging plans are applied as *runs* of consecutive slots
rather than one `overwriteRangeData` call per moved splat. The worker's
`MAX_PLAN_APPEND_SPLATS` (60 k) caps both appends and publish-time stale
evictions: finishing the newcomer queue used to retire every deferred leaver in
one plan (hotel-orbit spikes of 300 k+ moves / ~150 ms apply).

**Bootstrap.** `buildRadScene` hands the chunk 0 it already decoded to the worker
via `StreamedScene.bootstrapChunk`; the tree roots come from chunk 0, so without
it every traversal returned an empty frontier until a redundant second fetch of
chunk 0 landed. It is decoded in file order (no leaves-first reorder) when
foveating, matching the order the streamed chunks use.

## Mobile, four defaults that all cost the same thing (2026-07-31)

Validated on an **iPhone 15 Pro** (Safari, WebGPU) against
`oldtimers-route-lcc-lod.rad`: 8,587,819 nodes / 5,880,090 leaves / 132 chunks /
447 MB / `maxSh: 3`. It went from **~15 fps with the device heating rapidly** to
**~60 fps at a 1M budget** with stable near-field detail and streaming that
stops. The four causes were independent, and every one of them was the renderer
paying for spherical harmonics or speculation the viewer never asked for.

1. **`.rad` forced every SH band the file carried, on every device.** The
   resolved band count never reached `buildRadScene`, and `fromSource` applied
   `scene.shBands` *after* spreading the caller's options, overriding both the
   `smooth` profile and an explicit `shBands: 0`. `.rad` was the only format
   affected. Cost: four `RGBA32UI` fetches and a 15-coefficient evaluation per
   splat per frame, plus 128 B/splat, **48% of the pool** (2,221 MB → 1,144 MB
   once declined). `buildRadScene` now takes a `maxShBands` cap, deliberately
   all-or-nothing (see its doc comment for why a partial cap renders *flat*).

2. **Declined SH was still forwarded to the page-table worker.** The decoder
   emits the file's bands regardless, and `forwardChunkToWorker` passed them
   through, so the worker's cache charged 60 B/splat for data the pool would
   never render, measured at **100 B/splat where the cache-floor estimate
   assumes 40**. The cache therefore filled at ~52 chunks' worth of its limit
   instead of 132 and the frontier **thrashed**: one eviction and one refetch
   every couple of seconds, indefinitely, on a settled view, with resident
   chunks oscillating in the low 70s. After the fix: 29 B/splat, converges to 79
   chunks at 198 MB of 330 MB, **zero** fetches and evictions once settled.

3. **The background sweep pre-warmed the whole capture.** It stops only when
   `pageTableCacheFull` latches, which needs an eviction, but the cache floor is
 sized from the capture, so anything that fits is swept to completion. A steady
 ~1 chunk/s drip pulling all 447 MB. The `smooth` profile now declines it: on
 desktop it is a good trade (a camera turn is then served from RAM), on a phone
 it is metered download, a decoded cache rivalling the pool, and decode heat,
 for a camera move that may never happen.

4. **`estimateSceneDecodedBytes` sized the cache floor from the leaf count.**
 The cache holds whole decoded *chunks*, internal nodes included, 5,880,090
 vs 8,650,752 here, a 32% under-count, so the floor sat below the working set.
 It now sizes from `chunkSize × chunkUrls.length`.

Also: `.rad` pinned `maxStdDev` to Spark's √8 on every device, bypassing the 2.5
every other format falls back to on mobile, 1.28× the fragments where rendering
is fill-bound. `recommendedRadMaxStdDev` now returns √8 on desktop only.

**Reading the remaining symptoms.** The demo's `?hud=1` panel exposes
`StreamedSplatMesh.fetchCounts` (lifetime totals by fetch kind, evictions, cache
bytes against its limit) and `planTimings.worstApplyMs`. `sweep` climbing means
speculation; `evict` climbing alongside `pri`/`base` means the working set does
not fit and streaming *cannot* end; `pri`/`base` climbing with `evict` flat is
ordinary convergence. That distinction is what separated causes 2 and 3 above -
two rounds of plausible-but-wrong guesses preceded it.

### Headed Spark parity (2026-09-04)

**VLAM fly-through (done on this machine).** Chrome WebGPU, MacBook Air M3,
`HOTEL.clean.comp-lod.rad` via `/remote/…`, hotel-core orbit
(`cameraPosition=56.68,14.91,0.48` / `cameraTarget=-33.32,-5.1,0.48`,
distance ~90), SD, `pixelRatio=0.8`, draw budget 1M:

| Check | Result |
| --- | --- |
| Coverage / holes | `hole 0` / `late 0` in HUD; aerial and orbit views show continuous hotel + tower + lot (no black wedges) |
| Drawn vs budget | ~999,998 / 1,000,000 while orbiting |
| Plan-apply hitch | `worst plan apply` ~9–20 ms (after publish-retire move cap) |
| Chunks | 65 resident; cache ~200 / 256 MiB |
| Artifacts | `.tmp/rad-parity/vlam-hotel-painted-0.png`, `vlam-hotel-q{25,50,75}.png`, `vlam-hotel-flythrough.json` |

**Marker crossfade.** Construction-timeline capture not on hand. `lodAlpha` +
modifier opacity path is unit-tested (`splat-mesh-material.lod-alpha`,
fractional display opacity); demo `?effects=demo` / effect **pulse** is the
headed stress for “fade must not reclassify merged nodes”. Re-run that once a
timeline `.rad` is available.

**Spark same-file compare (blocked here).** Spark 2.1.0
`examples/streaming-lod` was pointed at the same hotel file (local copy under
`.tmp/`). With three@0.185.1 as a stand-in vendor (Spark’s `examples/js/vendor`
was not in the shallow checkout), the page titled correctly then threw
`RangeError: offset is out of bounds` in `SplatPager.uploadPage` and showed
streak artifacts (`.tmp/rad-parity/spark-hotel-settle2.png`). Close this row
with Spark’s own `npm run` / vendor three, matching camera, and a visual A/B
against the VLAM shots above — do not treat the streak frame as a VLAM defect.

### RTX 3090 limit-feedback pacing (2026-09-10)

Chrome 152 on Windows, NVIDIA RTX 3090, AC power, commit
`272d431123b623e7509787108dcd700cf3c0493d`. The cached
`HOTEL.clean.comp-lod.rad` hash was
`413381d93b452a77d75e7998f89836db0df740127f995bf94f4d5126a129f773`.

Two headed four-run hotel slices compared Spark 2.1.0 WebGL2 with VLAM WebGPU
at the same fixed poses and proposed 1280×720 settings. Both had normal callback
cadence. Spark held its native 2.5M page table near 59 FPS. VLAM's moderate-scene
prefix reader refined from 0.82–1.17M to 2.66M or the full 3.19M during the
15-second orbit and reached 38.31–49.49 observed FPS; its frame p95/p99 was
33.4–50.0 / 50.1–66.8 ms. The fixed front and orbit captures matched in
framing, orientation, coverage and settled detail, with no black holes. Suite
IDs: `78001a56-13cd-448d-abc1-811b564d0a28` and
`065db0a8-8408-463d-b7fb-e11ee6a4d899`; artifacts are under their ignored
`.tmp/benchmark-results/` directories.

That automatic comparison selects the prefix reader on this discrete desktop,
so a second headed run pinned `budget=1000000`,
`foveationMode=page-table`, and `foveationDraw=1000000` at the documented
hotel-core camera. After a 15-second warm-up, its 30-second cinematic orbit
reported:

| Signal | Result |
| --- | ---: |
| Frontier | 998,477 / 1,000,000 splats; `hole 0`, `late 0` |
| Cache | 440 / 471 MiB; 0 evictions |
| Frame pacing | 57.68 FPS average; 16.8 / 16.9 / 200.3 ms p95 / p99 / worst |
| Swap vs non-swap frame mean | 18.38 / 16.70 ms |
| Worst attributed CPU / upload | 138.9 / 138.4 ms |
| Sort coverage | 998,477 indices; 0 duplicates, missing, or foreign indices |

An isolated repeat ran after the full preflight had released the machine. It
used a single renderer tab and extended warm-up to 45 seconds so the timed
30-second orbit began at the settled 1,000,000-splat frontier. It again recorded
an upload-dominated tail: a 183.4 ms swap frame with 121.0 ms CPU and 120.6 ms
upload work. The run averaged 56.28 FPS with 16.8 / 33.4 ms p95 / p99, exact
1,000,000-index coverage, `hole 0`, `late 0`, and 0 evictions. Its overall
216.9 ms worst frame carried no swap event, so only the attributed 183.4 ms
frame is evidence for the page-table issue. This reproduction rules out the
original hitch being solely concurrent test load.

The limit feedback therefore converged without oscillation, budget overflow,
uncovered swaps, or cache churn. Do not change its 1.6× search step from this
evidence. Refinement is not yet consistently smooth, however: rare sparse-page
texture uploads dominate the visible tail even though p99 remains on the 60 Hz
floor. The follow-up is upload preparation/pacing, not frontier-limit policy;
the roadmap carries a bounded-frame acceptance target. The raw benchmark JSON
remains in the headed page output and the comparison artifacts stay local and
ignored.

### RTX 3090 page-table upload pacing (2026-09-10)

Page-table delivery now resolves the existing `maxSplatsPerSwap` option to a
16,000-write default (classic streaming remains 32,000). The worker applies the
same ceiling to initial updates and queued drains. Appends, swap-remove moves,
and freed-tail clears all spend that allowance; relocations are additionally
kept inside a bounded destination-slot window so a sparse cut cannot dirty
nearly every texture row. The host finishes the queued atomic cut across camera
motion, then immediately solves the latest coalesced view. It never partially
applies or publishes a plan.

Two normal-cadence Chrome 152 / RTX 3090 runs repeated the same 1M hotel-core
cinematic orbit with `swapCap=16000`, 45 seconds of warm-up, and a 30-second
sample. Both reached the 1,000,000-splat frontier during warm-up. The moving cut
at the second result snapshot contained 987,033 indices; it had reached 1M
inside the sample and returned there immediately afterwards. Coverage was exact
for every measured cut.

| Signal | Repeat 1 | Repeat 2 |
| --- | ---: | ---: |
| Average FPS | 59.95 | 59.95 |
| Frame p95 / p99 / worst | 16.8 / 16.9 / 17.5 ms | 16.8 / 16.9 / 17.7 ms |
| Worst attributed CPU / upload | 9.1 / 8.1 ms | 10.2 / 9.6 ms |
| Result-snapshot frontier | 1,000,000 | 987,033 |
| Sort coverage errors | 0 duplicate / missing / foreign | 0 duplicate / missing / foreign |
| HUD / cache | `hole 0`, `late 0`, 0 evictions | `hole 0`, `late 0`, 0 evictions |

The upload-attributed acceptance ceiling was 50 ms; both repeats passed with
more than 40 ms of margin, versus the 120.6 ms isolated baseline. A separate
attempt with a 62-second background callback gap was discarded from frame
statistics; its swap-attributed work nevertheless remained below 8 ms, which
confirms the gap was not produced by a page-table upload.

## Other gaps / next steps
- **Coordinate frame:** Spark's loader documents the 180°-X OpenCV→OpenGL
  correction (`quaternion.set(1, 0, 0, 0)`) for loaded splats, including `.rad`.
  `yUpTransformForFormat('rad')` therefore applies that cosmetic correction in
 VLAM!'s default `orientation: 'y-up'` mode; `orientation: 'source'` preserves
 the raw Spark data frame. This is distinct from LCC's mandatory Z-up→Y-up
 format transform.
- **Merged-node alpha expansion** (`alpha > 1`): applied to the rendered splat's
 own extent as of the covariance fix in `writeSplat` (`radExpansion`), matching
 Spark. Also still used to derive `size` for M14.6.
