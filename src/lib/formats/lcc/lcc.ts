import * as THREE from 'three/webgpu';
import { LodScheduler } from '../../streaming/lod-scheduler';
import type { LodLeaf, LodManifest, LodRange } from '../../streaming/lod-manifest';
import type {
  LodSourceOptions,
  StreamedChunkOptions,
  StreamedScene,
} from '../../streaming/lod-source';
import { createLcc2ToThreeMatrix } from './lcc2-transform';
import { MAX_SH_BANDS } from '../../core/splat-mesh';
import {
  LCC_RECORD_BYTES,
  LCC_SH_RECORD_BYTES,
  parseLccIndex,
  parseLccManifest,
  type LccIndexCell,
  type LccManifest,
} from './parse-lcc';
import { toRequestInit, toSplatLoadError, type SplatRequestOptions } from '../../loaders/loading';
import type { SplatDatasetSource } from '../../streaming/dataset-source';

/**
 * Scene builder for XGRIDS' older LCC datasets (`.lcc` / `meta.lcc`, manifest v3–v5;
 * format details in `docs/formats/lcc-notes.md`, record decoding in
 * {@link parseLccChunk}).
 *
 * An LCC capture is a flat 2D grid of cells, each holding an independent splat
 * set at every LOD level - not the shared-ancestor octree `.lcc2` uses. This
 * builder synthesizes a {@link LodManifest} over the cells and reuses
 * {@link LodScheduler} rather than adding a second selector.
 *
 * **The whole LOD ladder is scheduled**, so a distant or over-budget cell
 * coarsens to a smaller level rather than being dropped whole - full coverage
 * at any budget, matching the XGRIDS viewer. See the note in
 * {@link buildLccScene} for the streak-vs-coverage tradeoff an LCC LOD ladder
 * carries.
 *
 * The splats live in one large `data.bin` (~300 MB), and each `(cell, level)`
 * is one contiguous slice of it. A cell whose finest level runs to millions of
 * splats (~90 MB) is **sub-chunked**: the cell becomes K sub-leaves, each
 * level partitioned K ways at shared boundaries, every `(cell, level, i)`
 * slice its own ranged chunk. Sub-leaves from one physical cell share an
 * atomic budget group: they stream independently, but the scheduler never
 * mixes their LOD levels. Some writers preserve spatial locality in record
 * order, for which independently budgeting slices would create rectangular
 * holes as refinement settles.
 * `environment.bin` becomes one extra always-resident chunk.
 */

/**
 * Target splats per sub-chunk when a cell's finest level splits. Matches the
 * scheduler's `MAX_RUN_SPLATS` (128k) so a sub-leaf's run never re-splits, and
 * keeps a slice's `data.bin` range at ~4 MB (+8 MB `shcoef.bin` on a Quality
 * capture) - small enough that fetches pipeline through the in-flight cap and
 * an abort-on-move loses little.
 */
const SUBCHUNK_SPLATS = 128_000;

/** Options for {@link buildLccScene} beyond the shared LOD knobs. */
export interface LccSceneOptions extends LodSourceOptions {
  /**
   * Higher-order SH bands to stream for a `Quality` capture: 0 disables SH
   * (nothing is fetched from `shcoef.bin`), 3 is the full 3rd order.
   * Unset means every band the capture carries. Always clamped to that -
   * a `Portable` capture has none, whatever is asked for.
   */
  shBands?: 0 | 1 | 2 | 3;
  signal?: AbortSignal;
  request?: SplatRequestOptions;
}

/**
 * Builds a streamed scene from a parsed `.lcc` manifest, fetching the small
 * sidecars (`index.bin`, and `environment.bin`'s size) it needs to lay out
 * chunks. `data.bin` itself is never fetched here.
 *
 * @param json - The parsed `.lcc` manifest.
 * @param source - Dataset used to resolve and fetch the manifest's sidecars.
 * @param options - LOD, request, cancellation, and spherical-harmonic options.
 */
export async function buildLccScene(
  json: unknown,
  source: SplatDatasetSource,
  options: LccSceneOptions,
): Promise<StreamedScene> {
  const manifest = parseLccManifest(json);
  const require = (name: string): string => {
    const url = source.resolve(name);
    if (url === null) throw new Error(`LCC dataset is missing "${name}".`);
    return url;
  };
  const dataUrl = require('data.bin');
  const environmentUrl = source.resolve('environment.bin');

  const index = parseLccIndex(
    await fetchBytes(require('index.bin'), options, 'manifest'),
    manifest,
  );
  assertIndexMatchesManifest(index, manifest);

  // A Portable capture has no shcoef.bin at all, so it caps everyone at 0 -
  // asking for SH on one must not allocate pool textures for SH that can
  // never arrive, nor fetch a file that does not exist.
  const available = manifest.fileType === 'Quality' ? MAX_SH_BANDS : 0;
  const requested = options.shBands ?? available;
  const bands = Math.min(requested, available);
  const shBands: 1 | 2 | 3 | undefined = bands === 0 ? undefined : (bands as 1 | 2 | 3);
  const shUrl = shBands === undefined ? null : require('shcoef.bin');

  const chunkUrls: string[] = [];
  const chunkOptions: (StreamedChunkOptions | undefined)[] = [];
  const addChunk = (label: string, chunk: StreamedChunkOptions): number => {
    chunkUrls.push(label);
    chunkOptions.push(chunk);
    return chunkUrls.length - 1;
  };

  const leaves: LodLeaf[] = [];
  const pinnedFiles = new Set<number>();
  let minimumCoverageSplats = 0;
  // Every cell offers its whole LOD ladder, so the scheduler coarsens a
  // distant or over-budget cell to a smaller level instead of dropping it -
  // full coverage at any budget, the way the XGRIDS viewer behaves. (An
  // earlier revision scheduled only the finest level; on a capture whose
  // finest level dwarfs the budget that made whole central cells vanish.)
  //
  // The tradeoff an LCC LOD ladder carries: a coarser level is a decimated
  // *alternative*, not a refinement of the same surface - merging widens each
  // splat into a flat disc - so a coarse level forced near the camera reads as
  // a streak. The distance model plus `fillBudget` keep near cells at their
  // finest whenever the budget allows, so coarse levels surface only at
  // distance (where they read fine) or under a very tight budget (the accepted
  // cost).
  //
  // A big cell is split into K sub-leaves (its finest level in ~128k-splat
  // slices), every level partitioned K ways at the same boundaries and every
  // (cell, level, i) slice its own chunk file. Dedicated files mean the
  // scheduler's runs never coalesce across sub-leaves. Each slice streams on
  // its own (including resolved L0): waiting for a whole Quality cell's finest
  // cut before any swap left near detail stuck on coarse while fetches
  // churned. `budgetGroup` still keeps every slice on one scheduler cut so a
  // cell does not refine mid-ladder while a sibling is still coarse. This is
  // load-bearing for captures whose record order has spatial locality: mixing
  // levels within a cell would remove a compact patch rather than merely
  // thinning density. Each sub-leaf pins its own slice of the coarsest level
  // as substitute coverage while finer data lands farther out.
  const levelCount = manifest.totalLevel;
  for (let cellIndex = 0; cellIndex < index.length; cellIndex++) {
    const cell = index[cellIndex] as LccIndexCell;
    // K is sized from the finest *present* level; coarser levels split into
    // proportionally smaller slices at the same boundaries.
    let finestCount = 0;
    for (let level = 0; level < levelCount; level++) {
      const count = (cell.levels[level] as LccIndexCell['levels'][number]).count;
      if (count > 0) {
        finestCount = count;
        break;
      }
    }
    const subLeaves = Math.max(1, Math.ceil(finestCount / SUBCHUNK_SPLATS));
    for (let sub = 0; sub < subLeaves; sub++) {
      const lods: (LodRange | undefined)[] = new Array<LodRange | undefined>(levelCount).fill(
        undefined,
      );
      let coarsestFile = -1;
      let coarsestCount = 0;
      for (let level = 0; level < levelCount; level++) {
        const range = cell.levels[level] as LccIndexCell['levels'][number];
        // A level absent from a cell leaves a hole in `lods`; the scheduler
        // resolves to the nearest present level. A wholly empty cell keeps all
        // holes (as a single empty leaf).
        if (range.count === 0) continue;
        // This sub-leaf's slice of the level: floor boundaries partition the
        // level's records exactly across the K sub-leaves. A coarse level
        // with fewer records than sub-leaves leaves some slices empty.
        const lo = Math.floor((sub * range.count) / subLeaves);
        const hi = Math.floor(((sub + 1) * range.count) / subLeaves);
        if (hi === lo) continue;
        // The URL fragment never reaches the server; it just makes the chunk
        // legible in dev tools and in the mesh's debug stats. The `.i` suffix
        // appears only on split cells, keeping unsplit labels stable.
        const label = `${dataUrl}#c${cell.cellX}_${cell.cellY}-l${level}${
          subLeaves > 1 ? `.${sub}` : ''
        }`;
        const file = addChunk(label, {
          format: 'lcc-bin',
          lcc: {
            kind: 'splats',
            start: range.byteOffset + lo * LCC_RECORD_BYTES,
            length: (hi - lo) * LCC_RECORD_BYTES,
            stride: LCC_RECORD_BYTES,
            scale: manifest.scale,
            ...(shBands === undefined
              ? {}
              : {
                  sh: {
                    bands: shBands,
                    range: manifest.shcoef,
                    source: 'sidecar' as const,
                    // shcoef.bin is aligned 2:1 with data.bin - 64 bytes per
                    // splat against 32 - so each slice's SH is its own doubled
                    // byte range, which the loader derives from `start`/`length`.
                    url: shUrl as string,
                  },
                }),
          },
        });
        lods[level] = { file, offset: 0, count: hi - lo };
        // Levels ascend finest-to-coarsest, so the last written is the
        // coarsest this sub-leaf carries.
        coarsestFile = file;
        coarsestCount = hi - lo;
      }
      // Pin the coarsest present slice as always-cached substitute coverage;
      // an empty cell has none. The coverage floor sums those coarsest slices
      // (a partition, so the total equals the unsplit sum).
      if (coarsestFile >= 0) {
        pinnedFiles.add(coarsestFile);
        minimumCoverageSplats += coarsestCount;
      }
      leaves.push({ bounds: cellBounds(cell, manifest), lods, budgetGroup: cellIndex });
    }
  }

  const environmentCount = await environmentSplatCount(source, manifest);
  if (environmentCount > 0 && environmentUrl !== null) {
    const stride = environmentStride(manifest);
    const file = addChunk(`${environmentUrl}#env`, {
      format: 'lcc-bin',
      lcc: {
        kind: 'environment',
        start: 0,
        length: environmentCount * stride,
        // From `fileType`, never from whether SH is enabled: a Quality
        // environment record is 96 bytes even when its SH is being skipped.
        stride,
        scale: manifest.envScale,
        ...(shBands === undefined
          ? {}
          : {
              sh: {
                bands: shBands,
                range: manifest.envShcoef,
                source: 'inline' as const,
                // The environment quantizes SH against its own (wider) range;
                // re-encode into the base range so the whole scene decodes
                // through one pool uniform. See LccShParams.requantizeTo.
                requantizeTo: manifest.shcoef,
              },
            }),
      },
    });
    // Sky/background splats have no LOD ladder - a single always-resident
    // level, so its run key never churns. It stays pinned (and counts into the
    // coverage floor): a few thousand splats never worth evicting.
    pinnedFiles.add(file);
    minimumCoverageSplats += environmentCount;
    leaves.push({
      bounds: sceneBounds(manifest),
      lods: [{ file, offset: 0, count: environmentCount }],
    });
  }

  const lodManifest: LodManifest = {
    leaves,
    chunkUrls,
    // Per-level splat totals; index 0 is the finest. Informational here (the
    // pool and coverage floor are sized explicitly below), but kept accurate.
    counts: manifest.splats.slice(0, levelCount),
    lodLevels: levelCount,
    bounds: sceneBounds(manifest),
  };

  const collisionUrl = await resolveCollisionLci(source);

  return {
    // Classic LCC cells are broad XY tiles. Keep their priority independent of
    // frustum crossings so an orbit does not demote a sharp tile as it leaves
    // one edge, then rebuild it when the same tile re-enters the other edge.
    source: new LodScheduler(lodManifest, {
      ...options,
      // Classic LCC cells are broad XY tiles. Keep their priority independent of
      // frustum crossings so an orbit does not demote a sharp tile as it leaves
      // one edge, then rebuild it when the same tile re-enters the other edge.
      frustumAware: false,
      // Short range: distance bands pick the level (≤~9 m → L0, ≤20 m → L1,
      // …). Do not blanket-force finest then re-promote after demotion - that
      // loaded L0 for margin cells only to demote them with the camera still.
      forceFinestWithin: undefined,
      // Distance band is the fetch target. Do not fill past it.
      fillPastDistance: false,
      // XGRIDS retains a little budget headroom and does not turn a raised
      // ceiling into an all-finest distant cut. The cap limits only optional
      // nearest-first restoration after demotion; the distance-selected cut
      // can still spend the caller's full explicit budget when it needs it.
      budgetFillFraction: 0.95,
      budgetFillCap: 8_000_000,
      forceFinestWhenFits: false,
    }),
    chunkUrls,
    chunkOptions,
    shBands: shBands ?? 0,
    chunkKind: 'file',
    bounds: sceneBounds(manifest),
    pinnedFiles,
    // Worst case is every cell resident at its finest level, plus the sky.
    maxResidentSplats: (manifest.splats[0] ?? options.budget) + environmentCount,
    // Full coarse coverage is each cell's coarsest level plus the sky - the
    // budget floor below which even the substitute levels cannot all fit.
    minimumCoverageSplats: Math.max(1, minimumCoverageSplats),
    // Same Z-up frame as .lcc2; bounds stay source-local and matrixWorld
    // handles the conversion.
    formatTransform: createLcc2ToThreeMatrix(),
    // Optional classic-LCC collision mesh file. One descriptor for the whole
    // `.lci`; `loadCollisionMeshes` expands it into per-cell triangle tiles.
    ...(collisionUrl !== null ? { collision: { meshes: [{ url: collisionUrl }] } } : {}),
  };
}

/**
 * Locates an optional `collision.lci` sidecar. Captures and CDNs disagree on
 * casing (`collision.lci` vs whitepaper `Collision.lci`), so both names are
 * probed via {@link SplatDatasetSource.size} - missing is fine, same as
 * `environment.bin`.
 */
async function resolveCollisionLci(source: SplatDatasetSource): Promise<string | null> {
  for (const name of ['collision.lci', 'Collision.lci'] as const) {
    const size = await source.size(name);
    if (size !== null && Number.isSafeInteger(size) && size > 0) {
      return source.resolve(name);
    }
  }
  return null;
}

/** Bytes per `environment.bin` record: Quality interleaves a 64-byte SH block. */
export function environmentStride(manifest: LccManifest): number {
  return manifest.fileType === 'Quality'
    ? LCC_RECORD_BYTES + LCC_SH_RECORD_BYTES
    : LCC_RECORD_BYTES;
}

/**
 * A cell's bounds: cells tile X/Y on a fixed grid anchored at the scene's
 * minimum corner and span the full Z range. Clamped to the scene box so the
 * outermost cells do not claim empty space beyond it.
 */
function cellBounds(cell: LccIndexCell, manifest: LccManifest): THREE.Box3 {
  const { min, max } = manifest.bounds;
  const x0 = min[0] + cell.cellX * manifest.cellLengthX;
  const y0 = min[1] + cell.cellY * manifest.cellLengthY;
  return new THREE.Box3(
    new THREE.Vector3(Math.min(x0, max[0]), Math.min(y0, max[1]), min[2]),
    new THREE.Vector3(
      Math.min(x0 + manifest.cellLengthX, max[0]),
      Math.min(y0 + manifest.cellLengthY, max[1]),
      max[2],
    ),
  );
}

function sceneBounds(manifest: LccManifest): THREE.Box3 {
  const { min, max } = manifest.bounds;
  return new THREE.Box3(
    new THREE.Vector3(min[0], min[1], min[2]),
    new THREE.Vector3(max[0], max[1], max[2]),
  );
}

/**
 * Cross-checks the index against the manifest before anything is sized from
 * it. The manifest may over-declare slightly: the v4 writer leaves stale
 * `splats` counts (conferencehall is short 2 and 1 splats on levels 0/1 of
 * ~6.2M/2.9M), and index.bin is what every byte range is actually read from.
 * An index that *exceeds* the manifest, or falls short by more than a sliver,
 * still means a mismatched or truncated file pair and is refused.
 */
function assertIndexMatchesManifest(index: LccIndexCell[], manifest: LccManifest): void {
  for (let level = 0; level < manifest.totalLevel; level++) {
    let total = 0;
    for (const cell of index) total += (cell.levels[level] as LccIndexCell['levels'][number]).count;
    const declared = manifest.splats[level] as number;
    const shortfall = declared - total;
    const tolerance = Math.max(4, Math.ceil(declared * 0.001));
    if (shortfall < 0 || shortfall > tolerance) {
      throw new Error(
        `LCC index.bin level ${level} totals ${total} splats, but the manifest declares ${String(manifest.splats[level])}.`,
      );
    }
  }
}

/**
 * How many environment splats exist, from the file's size alone -
 * `environment.bin` has no index. A missing file is not an error: it is
 * optional, and plenty of captures have no sky.
 */
async function environmentSplatCount(
  source: SplatDatasetSource,
  manifest: LccManifest,
): Promise<number> {
  const size = await source.size('environment.bin');
  if (size === null || !Number.isSafeInteger(size) || size <= 0) return 0;
  const stride = environmentStride(manifest);
  if (size % stride !== 0) {
    throw new Error(
      `LCC environment.bin is ${size} bytes, not a multiple of the ${stride}-byte ${manifest.fileType} record.`,
    );
  }
  return size / stride;
}

async function fetchBytes(
  url: string,
  options: LccSceneOptions,
  phase: 'manifest' | 'fetch',
): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(url, toRequestInit(options.request, options.signal));
  } catch (error) {
    throw toSplatLoadError(error, { phase, url });
  }
  if (!response.ok) {
    throw toSplatLoadError(new Error(`Failed to load ${url}: HTTP ${response.status}`), {
      phase,
      url,
      status: response.status,
    });
  }
  return response.arrayBuffer();
}
