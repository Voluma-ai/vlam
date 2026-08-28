import * as THREE from 'three/webgpu';
import type { LodRun } from '../../lod-scheduler';
import type {
  LodSource,
  LodSourceOptions,
  StreamedChunkOptions,
  StreamedScene,
} from '../../lod-source';
import type { SplatData, RadTreeData } from '../../splat-data';
import type { SplatDatasetSource } from '../../dataset-source';
import { toRequestInit, type SplatRequestOptions } from '../../loading';
import { liftBudgetToFinestLevel } from '../../splat-budget';
import { parseRadChunkStreaming, parseRadHeaderMeta, type RadMeta } from './parse-rad';
import { RadFoveatedSource } from './rad-foveated-source';

/**
 * Streamed reader for a single-file Spark `.rad` (see `docs/formats/rad-notes.md`).
 *
 * A `.rad` is a precomputed LOD splat tree stored as a sequence of 64K-splat
 * chunks in coarsest→finest order: chunk 0 is a whole-scene overview built
 * from the largest merged nodes, and each later chunk refines detail. The
 * tree itself lives *inside* the chunks - every splat carries `child_count`
 * and `child_start` columns - so unlike LCC2 (whose octree is fully described
 * by its manifest) the structure is discovered as chunks decode.
 *
 * {@link RadLodSource} renders the *frontier* of a resident **prefix** of the
 * chunk sequence: a splat is drawn when it is a leaf, or when its children have
 * not been loaded yet (their merged approximation stands in). The prefix grows
 * - coarsest chunk first - until the drawn count reaches the budget, so a huge
 * capture shows as a coherent, budget-sized scene that sharpens as it loads.
 *
 * {@link RadLodSource} is exported for unit testing only; it is not part of
 * the public API and is reached in practice through {@link buildRadScene}.
 */

/** Chunks fetched ahead of the resident frontier to keep the pipeline full. */
const PREFETCH_AHEAD = 6;

/**
 * Builds a streamed scene from a single-file `.rad`. Fetches the header and
 * chunk table, then decodes chunk 0 (the coarsest whole-scene overview) to
 * establish scene bounds - the header carries none - and to seed the LOD
 * source with the root of the tree.
 *
 * `maxShBands` lets a caller **decline** the spherical harmonics the file
 * carries. Unlike SOG's opt-*in* `shBands` (whose manifest never declares
 * whether tiles have shN), a `.rad` names its own `maxSh`, so the question here
 * is only whether to keep it. It matters: every band costs 16 B/splat of GPU
 * pool plus as much again of CPU backing, and a texture fetch and coefficient
 * evaluation per splat per frame - exactly what the `smooth` performance profile
 * exists to decline on mobile.
 *
 * The choice is deliberately **all-or-nothing**: `0` drops SH, anything else
 * keeps every band the file has. A *partial* cap cannot be honoured, because the
 * `.rad` decoder emits the file's full band count and `SplatMesh.writePackedSh`
 * only copies packed words when the counts match exactly - a mismatch falls
 * through to neutral words, which would pay for the reduced bands' textures and
 * still render flat, view-independent color. Truncating the packed SH per splat
 * at decode would lift this restriction.
 */
export async function buildRadScene(
  source: SplatDatasetSource,
  options: LodSourceOptions,
  request?: SplatRequestOptions,
  maxShBands: 0 | 1 | 2 | 3 = 3,
  budgetLifts = true,
): Promise<StreamedScene> {
  const { meta, chunksStart } = await fetchRadHeader(source.manifestUrl, request);
  const chunkSize = meta.chunkSize ?? meta.count;
  const numChunks = meta.chunks.length;
  if (numChunks === 0) throw new Error('RAD file has no chunks.');

  // A `--rad-chunked` header names each chunk's own `.radc` file; a single-file
  // `.rad` gives byte ranges instead. An external chunk is fetched whole (its
  // URL resolves against the manifest); an inline one is a range of the `.rad`,
  // labelled with a debugging fragment the worker strips before fetching.
  const chunkUrls = meta.chunks.map((range, index) => {
    if (range.filename === undefined) return `${source.manifestUrl}#rad-chunk-${index}`;
    const url = source.resolve(range.filename);
    if (url === null) {
      throw new Error(`RAD chunk ${index} references a missing file "${range.filename}".`);
    }
    return url;
  });
  let chunkOptions: StreamedChunkOptions[] = meta.chunks.map((range) => ({
    format: 'rad-chunk',
    rad:
      range.filename === undefined
        ? { start: chunksStart + range.offset, length: range.bytes }
        : {},
  }));

  // The drawn frontier converges to the capture's leaf count (every merged node
  // hidden by its children). Spark records that as `input_splat_count` in the
  // header comment; it is the natural pool ceiling and lets a moderate scene
  // lift its budget to full resolution (see `fromSource`). Fall back to the
  // whole-tree count when the comment is absent or unparseable.
  const leafCount = parseInputSplatCount(meta.comment) ?? meta.count;
  // Prefix reader or foveated page table?
  //
  // The prefix reader is camera-*independent*: it grows a resident prefix of the
  // chunk sequence, coarsest first, until the drawn count reaches the budget. Its
  // one advantage is that at `budget >= leafCount` it reaches full leaf
  // resolution everywhere - which Spark's foveated cut never does - so a capture
  // that fits is better taken whole.
  //
  // When the budget *cannot* hold the leaves that advantage inverts, and badly:
  // the prefix spreads a fixed budget uniformly over the whole capture, so a 1M
  // budget on a 5.9M-leaf scene draws every surface at ~1/6 resolution and
  // walking up to something never sharpens it. Foveating spends the same budget
  // where the camera is looking and coarsens the distance instead.
  //
  // Hence the second test, against the budget *after* the finest-level lift
  // `fromSource` will apply - the lift is what carries a desktop over the line,
  // and mobile is deliberately exempt from it, which is exactly the case that was
  // landing on the wrong path.
  //
  // `budgetLifts` mirrors the caller's own precondition for that lift: it only
  // happens when neither `budget` nor `maxBudget` was pinned. Assuming it always
  // applies would misjudge every host that sizes its meshes explicitly - a
  // mesh given `maxBudget: pool / N` keeps that number, so it needs the
  // foveated path for the same reason a phone does.
  const effectiveBudget = budgetLifts
    ? liftBudgetToFinestLevel(options.budget, leafCount)
    : options.budget;
  const foveate = leafCount > FOVEATION_LEAF_THRESHOLD || leafCount > effectiveBudget;

  // Decode chunk 0 for bounds (the header has none) and to seed the tree root.
  // It must use the same splat order the streamed chunks will, or its
  // `child_start` links index the wrong locals: the prefix reader wants the
  // leaves-first reorder, the foveated/page-table reader wants file order.
  const chunk0Range = meta.chunks[0]!;
  const chunk0Buffer =
    chunk0Range.filename === undefined
      ? await fetchRange(
          source.manifestUrl,
          chunksStart + chunk0Range.offset,
          chunk0Range.bytes,
          request,
        )
      : await fetchWhole(chunkUrls[0]!, request);
  const chunk0Data = await parseRadChunkStreaming(chunk0Buffer, undefined, undefined, !foveate);
  // Later chunks must pack their SH against the same scene range chunk 0
  // established - the pool adopts one range for the whole scene. The codebook
  // (clustered SH) lives only in chunk 0 and rides along the same way.
  const shExtent = chunk0Data.shPacked?.range.max[0];
  if (chunk0Data.radShCodebook || shExtent !== undefined) {
    chunkOptions = chunkOptions.map((options) => ({
      ...options,
      rad: {
        ...options.rad!,
        ...(chunk0Data.radShCodebook ? { shCodebook: chunk0Data.radShCodebook } : {}),
        ...(shExtent !== undefined ? { shExtent } : {}),
      },
    }));
  }
  const bounds = boundsOf(chunk0Data);
  // Chunk 0 is a whole-scene overview. Copy a subsample of its centers before
  // page-table mode transfers the buffers to the worker, so the demo can place
  // the camera on the terrain instead of the AABB min (underground outliers).
  const overviewPositions = subsampleOverviewPositions(chunk0Data.positions, chunk0Data.count);
  // All-or-nothing, for the reason in the doc comment above: a partial cap
  // would silently degrade to neutral SH rather than to fewer bands.
  const shBands = maxShBands === 0 ? 0 : (chunk0Data.shPacked?.bands ?? 0);

  const chunkCounts = meta.chunks.map((_range, index) =>
    Math.min(chunkSize, meta.count - index * chunkSize),
  );

  // Foveated: load a camera-directed set of chunks and let the page-table
  // frontier pick the LOD cut per splat (see `docs/formats/rad-notes.md` M14.6
  // and `RadFoveatedSource`).
  if (foveate) {
    const foveated = new RadFoveatedSource(chunkSize, chunkCounts, options);
    if (chunk0Data.radTree) foveated.onChunkDecoded(0, chunk0Data);
    return {
      source: foveated,
      chunkUrls,
      chunkKind: 'file',
      // File order (no leaves-first reorder): the band cull is order-agnostic
      // and this keeps `child_start` valid for future exact-parent-size work.
      chunkOptions: chunkOptions.map((option) => ({
        ...option,
        rad: { ...option.rad!, reorder: false },
      })),
      shBands,
      bounds,
      pinnedFiles: new Set([0]),
      // Pool holds the resident set (near + coarse), not the whole tree.
      maxResidentSplats: options.budget,
      // The real capture size, which `maxResidentSplats` cannot carry here (it
      // echoes the caller's budget). A host splitting one budget across several
      // streamed meshes needs it: a mesh cannot spend more than it contains.
      contentSplatCount: leafCount,
      minimumCoverageSplats: foveated.coverageSplatCount,
      foveation: RAD_FOVEATION_BAND,
      chunkSize,
      overviewPositions,
      // Hand chunk 0 straight to the page-table worker: it holds the tree roots,
      // so until it lands every traversal returns an empty frontier. Its buffers
      // are transferred there, so nothing may read `chunk0Data` after this.
      bootstrapChunk: { file: 0, data: chunk0Data },
    };
  }

  const source_ = new RadLodSource(meta.count, chunkSize, chunkCounts, options);
  if (chunk0Data.radTree) source_.onChunkDecoded(0, chunk0Data);

  return {
    source: source_,
    chunkUrls,
    chunkKind: 'file',
    chunkOptions,
    shBands,
    bounds,
    pinnedFiles: new Set([0]),
    maxResidentSplats: leafCount,
    contentSplatCount: leafCount,
    minimumCoverageSplats: source_.coverageSplatCount,
    overviewPositions,
  };
}

/** Leaf count above which a `.rad` foveates instead of loading whole; matches
 * the budget-lift ceiling (`FINEST_LEVEL_BUDGET_MAX`). */
const FOVEATION_LEAF_THRESHOLD = 6_000_000;

/** Screen-radius band (px) for foveated `.rad`: only splats projecting to a
 * radius in `(min, max]` draw. The ~2.5× width spans one LOD level (Spark's
 * merge ratio is ~1.75), so one level per view ray lands in the band. */
const RAD_FOVEATION_BAND = { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 } as const;

/** Reads `input_splat_count` (the leaf count) from Spark's build-info comment. */
function parseInputSplatCount(comment: string | undefined): number | undefined {
  if (!comment) return undefined;
  try {
    const info = JSON.parse(comment) as { input_splat_count?: unknown };
    const value = info.input_splat_count;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Source-local splat-center subsample for camera framing. */
const MAX_OVERVIEW_SAMPLES = 8192;

function subsampleOverviewPositions(positions: Float32Array, count: number): Float32Array {
  if (count <= 0) return new Float32Array(0);
  const stride = Math.max(1, Math.floor(count / MAX_OVERVIEW_SAMPLES));
  let n = 0;
  for (let i = 0; i < count; i += stride) n++;
  const out = new Float32Array(n * 3);
  let o = 0;
  for (let i = 0; i < count; i += stride) {
    const b = i * 3;
    out[o++] = positions[b] as number;
    out[o++] = positions[b + 1] as number;
    out[o++] = positions[b + 2] as number;
  }
  return out;
}

/** World-space AABB of a decoded chunk's splat centers. */
function boundsOf(data: SplatData): THREE.Box3 {
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  const pos = data.positions;
  for (let i = 0; i < data.count; i++) {
    p.set(pos[i * 3] ?? 0, pos[i * 3 + 1] ?? 0, pos[i * 3 + 2] ?? 0);
    box.expandByPoint(p);
  }
  return box.isEmpty()
    ? new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))
    : box;
}

/**
 * Selects a budget-bounded prefix of a `.rad` chunk sequence and renders its
 * frontier - the splats whose children are not yet resident, plus all leaves.
 *
 * The tree is discovered incrementally: {@link onChunkDecoded} records each
 * chunk's `child_count`/`child_start` columns, and `discoveredDepth` tracks the
 * longest contiguous decoded prefix. `computeDesiredRuns` emits the frontier of
 * the largest prefix whose drawn count fits the budget (cached - it does not
 * depend on the camera), plus fetch-intent runs that pull the next chunks in.
 *
 * Refinement is **uniform** over the scene, not camera-distance foveated. Chunk-
 * granular spatial foveation is impossible for this format: the chunk graph is a
 * deeply entangled DAG - every non-root chunk has ≥2 parent chunks - so no
 * ancestor-closed chunk subset larger than `{0}` exists, and a coarse ancestor
 * that is not resident would double-draw over any refined descendant. True near-
 * camera refinement therefore needs Spark-style per-splat GPU culling (see
 * `docs/formats/rad-notes.md`, ROADMAP M14.6). Two levers help meanwhile: a budget large
 * enough to load a moderate scene's full leaf set (blobs vanish once every chunk
 * is resident), and the `maxSplatScreenRadius` blob cull for what stays coarse.
 *
 * {@link RadLodSource} is exported for unit testing only; it is not part of the
 * public API and is reached in practice through {@link buildRadScene}.
 */
export class RadLodSource implements LodSource {
  budget: number;
  lodBaseDistance: number;
  lodMultiplier: number;

  private readonly total: number;
  private readonly chunkSize: number;
  private readonly chunkCounts: readonly number[];
  private readonly numChunks: number;
  /**
   * Decoded per-splat tree columns, by chunk index.
   *
   * Grows monotonically and is deliberately never evicted. That costs ~10 B per
   * splat of every chunk ever decoded (`childCount` u16 + `childStart` u32 +
   * `size` f32) and is invisible to the chunk cache's byte accounting, so it
   * reads like a leak - but it is not reclaimable. {@link discoveredDepth} is
   * the longest *contiguous* decoded prefix and every frontier walk at or below
   * it reads these columns, so dropping an entry would either corrupt the
   * traversal or force `discoveredDepth` back and visibly coarsen the scene.
   *
   * Bounded in practice by the mode that uses it: `.rad` defaults to
   * `foveationMode: 'page-table'`, where the frontier worker owns the traversal
   * and this source is never constructed. Only the `'band'` and `'frontier'`
   * A/B modes pay it. Reducing it means changing the tree encoding, not adding
   * an eviction pass here.
   */
  private readonly decoded = new Map<number, RadTreeData>();
  /** Longest contiguous decoded prefix `{0 … discoveredDepth − 1}`. */
  private discoveredDepth = 0;

  /** Chunk-0-only frontier: the always-available coarse substitute coverage. */
  private coarseRuns: LodRun[] = [];
  /** Splats the coarse (chunk-0) coverage draws. */
  coverageSplatCount = 1;

  /** Cache of the last emitted frontier, keyed by the inputs that shape it. */
  private cachedRuns: LodRun[] = [];
  private cachedFrontierCount = 0;
  /** Frontier splat count by prefix depth; see {@link countAtDepth}. */
  private readonly depthCounts = new Map<number, number>();
  /** Budget range over which {@link cachedRuns} stays the correct frontier. */
  private cachedBudgetLo = Number.POSITIVE_INFINITY;
  private cachedBudgetHi = Number.NEGATIVE_INFINITY;
  private cachedForDiscovered = -1;

  constructor(
    total: number,
    chunkSize: number,
    chunkCounts: readonly number[],
    options: LodSourceOptions,
  ) {
    this.total = total;
    this.chunkSize = chunkSize;
    this.chunkCounts = chunkCounts;
    this.numChunks = chunkCounts.length;
    this.budget = options.budget;
    this.lodBaseDistance = options.lodBaseDistance;
    this.lodMultiplier = options.lodMultiplier;
  }

  onChunkDecoded(file: number, data: SplatData): void {
    if (!data.radTree || this.decoded.has(file)) return;
    this.decoded.set(file, data.radTree);
    if (file === 0) {
      // Chunk 0 alone is the coarsest whole-scene coverage (its splats' children
      // all live in later chunks), so its frontier at "only chunk 0 resident" is
      // the pinned substitute every deferred deeper region falls back to.
      this.coarseRuns = this.frontierRuns(1, this.chunkCounts[0] as number);
      this.coverageSplatCount = Math.max(1, countSplats(this.coarseRuns));
    }
    while (this.decoded.has(this.discoveredDepth)) this.discoveredDepth++;
  }

  computeDesiredRuns(_cameraLocal: THREE.Vector3, _frustum: THREE.Frustum, _now: number): LodRun[] {
    this.ensureFrontier();
    // Keep pulling chunks in until the drawn count reaches the budget. The
    // frontier can never exceed the capture's leaf count, so when the budget is
    // lifted to that count (a moderate scene) this loads every chunk and the
    // scene reaches full resolution - no coarse blobs left anywhere.
    if (this.cachedFrontierCount >= this.budget) return this.cachedRuns;

    // Pull the next window of undecoded chunks in. Fetch-intent runs
    // reference undecoded chunks so the mesh fetches them; they are always
    // deferred (their chunk is never cached at the moment it would append,
    // because decoding advances the frontier in the same tick), so their
    // geometry is immaterial - only their `file` matters.
    const runs = [...this.cachedRuns];
    const until = Math.min(this.discoveredDepth + PREFETCH_AHEAD, this.numChunks);
    for (let c = this.discoveredDepth; c < until; c++) {
      if (!this.decoded.has(c)) runs.push(this.fetchIntentRun(c));
    }
    return runs;
  }

  coarsestRunsFor(from: number, to: number): LodRun[] {
    const runs: LodRun[] = [];
    for (const run of this.coarseRuns) {
      if (run.leafStart < to && run.leafEnd > from) runs.push(run);
    }
    return runs;
  }

  /**
   * Recomputes the cached frontier when the budget or discovery has moved.
   *
   * The cache is keyed on the *range* of budgets that select the same prefix
   * depth, not on the budget itself. A camera-weighted governor rewrites the
   * budget every frame - it wanders by a few percent as the camera drifts - and
   * an exact-equality key therefore missed on roughly a third of all calls while
   * choosing the very same depth. Each of those misses re-walks `frontierRuns`
   * over the whole decoded prefix (millions of splats, several times over if it
   * steps down levels): measured at 33ms mean and 1.1s worst, it was 92% of all
   * frame CPU on a multi-mesh scene. Frontier count rises monotonically with
   * depth, so the selected depth is stable for any budget in
   * `[thisDepthCount, nextDepthCount)` and the walk can be skipped outright.
   */
  private ensureFrontier(): void {
    if (
      this.cachedForDiscovered === this.discoveredDepth &&
      this.budget >= this.cachedBudgetLo &&
      this.budget < this.cachedBudgetHi
    ) {
      return;
    }
    this.cachedForDiscovered = this.discoveredDepth;

    // Largest prefix whose frontier fits the budget. Frontier count rises
    // monotonically with depth, so walk down from the deepest decoded prefix.
    let depth = this.discoveredDepth;
    let count = depth > 0 ? this.countAtDepth(depth) : 0;
    // The shallowest depth already rejected as too large - the budget at which
    // this result would stop being the right one. Nothing is deeper than the
    // discovered prefix, so without a rejection the band has no upper bound.
    let rejectedCount = Number.POSITIVE_INFINITY;
    while (depth > 1 && count > this.budget) {
      rejectedCount = count;
      depth--;
      count = this.countAtDepth(depth);
    }
    // Only the depth that wins builds runs. The search itself reads memoized
    // counts, so a budget swing that skips several levels costs one walk rather
    // than one per level tried.
    const runs =
      depth > 0 ? this.frontierRuns(depth, Math.min(depth * this.chunkSize, this.total)) : [];
    this.cachedRuns = runs;
    this.cachedFrontierCount = count;
    // Depth 1 is the floor: it is returned however small the budget gets, so
    // that case stays valid all the way down to zero.
    this.cachedBudgetLo = depth > 1 ? count : 0;
    this.cachedBudgetHi = rejectedCount;
  }

  /**
   * Splats the frontier draws at `depth`, memoized.
   *
   * `discoveredDepth` is the longest *contiguous* decoded prefix, so for any
   * `depth <= discoveredDepth` every chunk the walk reads is already decoded and
   * the answer can never change afterwards - chunks are only ever added to
   * `decoded`. That makes this permanently cacheable, which is what lets the
   * depth search above run without rebuilding runs at each level it rejects.
   */
  private countAtDepth(depth: number): number {
    const memo = this.depthCounts.get(depth);
    if (memo !== undefined) return memo;
    const residentCount = Math.min(depth * this.chunkSize, this.total);
    let total = 0;
    for (let c = 0; c < depth; c++) {
      const tree = this.decoded.get(c);
      if (!tree) continue;
      const count = this.chunkCounts[c] as number;
      for (let i = 0; i < count; i++) {
        if (tree.childCount[i] === 0 || (tree.childStart[i] as number) >= residentCount) total++;
      }
    }
    this.depthCounts.set(depth, total);
    return total;
  }

  /**
   * The rendered runs for a resident prefix of `depth` chunks: within each
   * chunk, the contiguous ranges of splats that are leaves or whose children
   * fall beyond `residentCount` (the prefix's total splat count). The chunk's
   * splats are child-start-descending (leaves first), so each range coalesces
   * into one run.
   */
  private frontierRuns(depth: number, residentCount: number): LodRun[] {
    const runs: LodRun[] = [];
    for (let c = 0; c < depth; c++) {
      const tree = this.decoded.get(c);
      if (!tree) continue; // only reachable if a prefix chunk was evicted from discovery
      const count = this.chunkCounts[c] as number;
      const base = c * this.chunkSize;
      const level = this.numChunks - c;
      let start = -1;
      for (let i = 0; i < count; i++) {
        const draws = tree.childCount[i] === 0 || (tree.childStart[i] as number) >= residentCount;
        if (draws) {
          if (start < 0) start = i;
        } else if (start >= 0) {
          runs.push(makeRun(c, level, start, i, base));
          start = -1;
        }
      }
      if (start >= 0) runs.push(makeRun(c, level, start, count, base));
    }
    return runs;
  }

  private fetchIntentRun(chunk: number): LodRun {
    const count = this.chunkCounts[chunk] as number;
    return makeRun(chunk, this.numChunks - chunk, 0, count, chunk * this.chunkSize);
  }
}

/** A run for chunk `file`'s local splats `[lo, hi)`, keyed by global index. */
function makeRun(file: number, level: number, lo: number, hi: number, base: number): LodRun {
  return { file, level, offset: lo, count: hi - lo, leafStart: base + lo, leafEnd: base + hi };
}

function countSplats(runs: readonly LodRun[]): number {
  let total = 0;
  for (const run of runs) total += run.count;
  return total;
}

/** Fetches and parses a `.rad`'s `RAD0` header and chunk table. */
async function fetchRadHeader(
  url: string,
  request?: SplatRequestOptions,
): Promise<{ meta: RadMeta; chunksStart: number }> {
  // One speculative read covers the header for any realistic chunk count; a
  // pathologically long table (very large scene) triggers one exact refetch.
  const PROBE = 262_144;
  let buffer = await fetchRange(url, 0, PROBE, request, true);
  const view = new DataView(buffer);
  if (view.byteLength >= 8) {
    const length = view.getUint32(4, true);
    if (8 + length > buffer.byteLength) {
      buffer = await fetchRange(url, 0, 8 + length, request);
    }
  }
  return parseRadHeaderMeta(buffer);
}

/**
 * Fetches `[start, start + length)` of a URL, requiring a real 206 (like the
 * LCC path). `allowShort` permits a server to return fewer bytes than asked -
 * used for the header probe, where the file may be shorter than the probe.
 */
async function fetchRange(
  url: string,
  start: number,
  length: number,
  request?: SplatRequestOptions,
  allowShort = false,
): Promise<ArrayBuffer> {
  const init = toRequestInit(request);
  const response = await fetch(url, {
    ...init,
    headers: { ...(request?.headers ?? {}), Range: `bytes=${start}-${start + length - 1}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  }
  // The header probe (`allowShort`) tolerates a `200` - a `--rad-chunked` set's
  // `.rad` header is small enough to arrive whole from a server that ignores
  // Range. Chunk-*data* reads stay strict: a single-file `.rad` that answers
  // `200` would download the whole capture, so it is rejected.
  if (response.status !== 206 && !(allowShort && response.status === 200)) {
    throw new Error(
      `${url} ignored a Range request (HTTP ${response.status}); single-file .rad streaming ` +
        'needs a server that answers 206 Partial Content.',
    );
  }
  const buffer = await response.arrayBuffer();
  if (!allowShort && buffer.byteLength !== length) {
    throw new Error(`${url} returned ${buffer.byteLength} bytes for a ${length}-byte range.`);
  }
  return buffer;
}

/** Fetches a whole file (an external `.radc` chunk, or a small chunked-set
 * `.rad` header served without range support). */
async function fetchWhole(url: string, request?: SplatRequestOptions): Promise<ArrayBuffer> {
  const response = await fetch(url, toRequestInit(request));
  if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}
