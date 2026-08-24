import * as THREE from 'three/webgpu';
import { LodScheduler, type LodRun } from './lod-scheduler';
import { parseLodManifest, type LodManifest } from './lod-manifest';
import type { ChunkFileFormat } from './loading';
import type { RadChunkRangeRequest } from './load-worker-protocol';
import type { LccChunkParams } from './formats/lcc/parse-lcc';
import type { SplatData } from './splat-data';
import type { SplatDatasetSource } from './dataset-source';

/**
 * Per-frame LOD decision maker: given the camera, returns the set of runs
 * (`{file, offset, count}` slices with a leaf interval) that should be
 * resident. Two implementations exist - {@link LodScheduler} for the flat
 * Streamed SOG leaves-with-levels model, and `OctreeLodSource` for the
 * cut-based LCC2 octree - so {@link StreamedSplatMesh} is format-agnostic.
 */
export interface LodSource {
  /** Active-splat budget the returned set stays within. */
  budget: number;
  /** World-unit distance inside which the finest LOD is used. */
  lodBaseDistance: number;
  /** Distance ratio between successive LOD levels. */
  lodMultiplier: number;
  /** The runs that should be resident for the given camera. */
  computeDesiredRuns(
    cameraLocal: THREE.Vector3,
    frustum: THREE.Frustum,
    now: number,
    cameraForward?: THREE.Vector3,
  ): LodRun[];
  /** Coarsest-level runs covering finest cells `[from, to)` - always-cached
   * substitute coverage while a finer level is fetching. */
  coarsestRunsFor(from: number, to: number): LodRun[];
  /**
   * Runs covering `[from, to)` at a requested LOD level (clamped per leaf to an
   * available rung). Used by classic-LCC startup hold to coarsen a nearby home
   * cell when the resolved L0 cut overflows the pool. Optional: sources without
   * a flat leaf ladder leave it undefined.
   */
  runsAtLevelFor?(from: number, to: number, level: number): LodRun[];
  /**
   * Notified when a chunk finishes decoding, so a source that discovers its
   * structure from chunk payloads (a `.rad` LOD tree lives in the chunks, not
   * a manifest) can incorporate it. Sources with a fully-known manifest
   * (Streamed SOG, LCC) leave this undefined.
   */
  onChunkDecoded?(file: number, data: SplatData): void;
}

/**
 * Per-chunk fetch and decode settings, for formats where the URL alone is not
 * enough. LCC (`.lcc`, manifest v3–v5) uses this to name a byte range inside the one big
 * `data.bin` and to carry that range's dequantization ranges. LCC2 and local
 * Streamed SOG use it so a `blob:` URL (no file extension) still selects the
 * SOG parser.
 */
export interface StreamedChunkOptions {
  readonly format: ChunkFileFormat;
  readonly lcc?: LccChunkParams;
  /** Byte range within the single-file `.rad`; carried by a `rad-chunk`. */
  readonly rad?: RadChunkRangeRequest;
  /**
   * Convert this SOG chunk's palette-compressed shN into per-splat packed shN
   * at decode, keeping this many bands, so it survives the shared pool (M11).
   * Absent leaves the palette shN to be dropped, as streamed scenes did before.
   */
  readonly sog?: { readonly packShBands: 1 | 2 | 3 };
  /**
   * For an unbundled SOG chunk from a dropped folder: the directory's files as
   * `name → blob URL`. Absent over HTTP, where the worker resolves each image
   * against the chunk's directory URL instead.
   */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * A single always-resident environment/background tile a format ships outside
 * its LOD structure - the `.lcc2` `env.sog` sky, loaded once and toggled with
 * {@link StreamedSplatMesh.setEnvironmentEnabled} rather than scheduled by
 * camera distance. Its splat count is absent from the manifest and measured
 * when the tile decodes (see `docs/formats/lcc2-notes.md`).
 */
export interface EnvironmentTile {
  /** Chunk-file index (into {@link StreamedScene.chunkUrls}) of the tile. */
  readonly file: number;
}

/** One collision-mesh tile a scene ships alongside its splats. */
export interface CollisionMeshDescriptor {
  /**
   * Fetchable URL of the tile: a binary triangle-mesh PLY (`.lcc2`), or a
   * classic-LCC `collision.lci` that expands into per-cell meshes at load.
   */
  readonly url: string;
  /**
   * The tile's source-local bounds, when the format declares them. Lets a host
   * order or cull tile work without parsing them first. Unused for a whole-file
   * `.lci` descriptor - per-cell bounds come from the parser.
   */
  readonly bounds?: THREE.Box3;
}

/**
 * Collision geometry a format ships next to its splats - absent for formats
 * that carry none (Streamed SOG), present for XGRIDS `.lcc` / `.lcc2` captures
 * that include a collision sidecar.
 *
 * Coordinates are source-local, the same frame as {@link StreamedScene.bounds}:
 * {@link StreamedScene.formatTransform} maps them to world.
 */
export interface SceneCollision {
  readonly meshes: readonly CollisionMeshDescriptor[];
}

/**
 * Everything {@link StreamedSplatMesh} needs about a scene, independent of
 * whether it came from a Streamed SOG manifest or an LCC dataset.
 */
export interface StreamedScene {
  readonly source: LodSource;
  /** Chunk-file URLs, indexed by a run's `file`. */
  readonly chunkUrls: readonly string[];
  /** How each chunk URL is fetched: an unbundled SOG directory (Streamed
   * SOG) or a single bundled `.sog`/`.ply` file (LCC2 tiles). */
  readonly chunkKind: 'directory' | 'file';
  /** Optional per-chunk overrides, aligned with {@link chunkUrls}. */
  readonly chunkOptions?: readonly (StreamedChunkOptions | undefined)[];
  /**
   * Per-splat SH bands this scene's chunks actually carry, after the format
   * has had its say - a `Portable` LCC capture reports 0 however many bands
   * the caller asked for. The pool sizes its SH textures from this, so it
   * never allocates ~64 B/splat for SH that will never arrive.
   */
  readonly shBands?: 0 | 1 | 2 | 3;
  /** Root bounds of the whole scene (valid before any chunk loads). */
  readonly bounds: THREE.Box3;
  /** Files backing the coarsest levels - pinned in cache as substitutes. */
  readonly pinnedFiles: ReadonlySet<number>;
  /** Finest-level splat total, for sizing the pool. */
  readonly maxResidentSplats: number;
  /**
   * The capture's real content size - the splat count a host would need to hold
   * it at full resolution. Distinct from {@link maxResidentSplats}, which a
   * foveated source reports as the *requested budget* because its pool holds a
   * camera-directed resident set rather than the whole tree. A host budgeting
   * across several streamed meshes needs the real number: a mesh cannot spend
   * more than it contains, so this is the clamp on any share handed to it.
   *
   * Undefined when the format does not declare it.
   */
  readonly contentSplatCount?: number;
  /** Smallest budget that can retain full-scene coarsest coverage. */
  readonly minimumCoverageSplats: number;
  /**
   * Optional local-to-world format correction applied once to the mesh at
   * load time. Bounds and LOD data remain source-local so scheduling and
   * picking consistently use the encoded coordinate frame.
   */
  readonly formatTransform?: THREE.Matrix4;
  /** Optional collision geometry the format ships; undefined when it has none. */
  readonly collision?: SceneCollision;
  /**
   * Optional always-resident environment tile the format ships outside its LOD
   * structure (the `.lcc2` sky) - present only when the dataset carries one.
   */
  readonly environment?: EnvironmentTile;
  /**
   * Screen-space foveation band (px), for a scene that renders whole resident
   * chunks and lets the material's projected-radius cull pick the LOD cut per
   * splat - a `.rad` too large to load whole. Only splats sized `(min, max]` on
   * screen draw, so near view rays land on fine leaves and far rays on coarse
   * nodes. `StreamedSplatMesh` applies it as the mesh's screen-radius band.
   */
  readonly foveation?: { readonly minScreenRadiusPx: number; readonly maxScreenRadiusPx: number };
  /**
   * Splats per chunk file, so a `(file, localIndex)` pair maps to a stable global
   * splat index (`file * chunkSize + local`). Set by `.rad`; the page-table
   * renderer (`foveationMode: 'pagetable'`) keys frontier splats by that global.
   */
  readonly chunkSize?: number;
  /**
   * A chunk the scene builder already fetched and decoded (`.rad` decodes chunk
   * 0 for the scene bounds and the SH codebook). Handing it straight to the
   * renderer saves a second round trip - and in `pagetable` mode it is what
   * seeds the worker's tree roots, without which the first traversals return an
   * empty frontier and the view stays blank until chunk 0 arrives a second time.
   */
  readonly bootstrapChunk?: { readonly file: number; readonly data: SplatData };
  /**
   * Source-local xyz subsample of the coarsest overview (`.rad` chunk 0).
   * Survives after pagetable mode transfers chunk-0 buffers to the worker, so
   * a host can estimate terrain height before any later chunk decodes.
   */
  readonly overviewPositions?: Float32Array;
}

export interface LodSourceOptions {
  budget: number;
  lodBaseDistance: number;
  lodMultiplier: number;
}

/**
 * Builds a scene from a parsed Streamed SOG manifest (JSON already fetched).
 *
 * `shBands` opts into view-dependent color (M11): when ≥ 1, each chunk's
 * palette shN is converted to per-splat packed shN at decode so it survives
 * the shared pool, and the pool allocates that many SH bands. Unset/0 keeps
 * the historical behavior (palette shN dropped). It is opt-in because the
 * manifest does not declare whether the tiles carry shN; a scene with none
 * renders unchanged but wastes the allocated SH textures, so ask deliberately.
 */
export function buildSogScene(
  json: unknown,
  source: SplatDatasetSource,
  options: LodSourceOptions,
  shBands: 0 | 1 | 2 | 3 = 0,
): StreamedScene {
  const manifest = parseLodManifest(json, source);
  const packShBands = shBands >= 1 ? (shBands as 1 | 2 | 3) : undefined;
  // A dropped folder has no directory URL to fetch images beneath, so each
  // chunk carries its own files instead. Over HTTP this is all undefined and
  // the worker resolves against the directory URL as before. When SH is
  // requested every chunk also carries the pack-bands directive.
  const chunkOptions = manifest.chunkUrls.map((_, index) => {
    const directory = manifest.chunkDirectories?.[index];
    const files = directory ? source.directoryFiles(directory) : null;
    if (!files && !packShBands) return undefined;
    return {
      format: 'sog',
      ...(files ? { files } : {}),
      ...(packShBands ? { sog: { packShBands } } : {}),
    } as const;
  });
  return {
    source: new LodScheduler(manifest, options),
    chunkUrls: manifest.chunkUrls,
    ...(chunkOptions.some(Boolean) ? { chunkOptions } : {}),
    ...(packShBands ? { shBands: packShBands } : {}),
    chunkKind: 'directory', // Streamed SOG chunks are unbundled directories
    bounds: manifest.bounds,
    pinnedFiles: computeSogPinnedFiles(manifest),
    maxResidentSplats: manifest.counts[0] ?? options.budget,
    minimumCoverageSplats: computeSogMinimumCoverage(manifest),
  };
}

/** Total of each leaf's coarsest available range. */
function computeSogMinimumCoverage(manifest: LodManifest): number {
  let total = 0;
  for (const leaf of manifest.leaves) {
    for (let level = leaf.lods.length - 1; level >= 0; level--) {
      const range = leaf.lods[level];
      if (range) {
        total += range.count;
        break;
      }
    }
  }
  return Math.max(1, total);
}

/** Files backing some leaf's coarsest level - the always-available floor. */
function computeSogPinnedFiles(manifest: LodManifest): Set<number> {
  const pinned = new Set<number>();
  for (const leaf of manifest.leaves) {
    for (let level = leaf.lods.length - 1; level >= 0; level--) {
      const range = leaf.lods[level];
      if (range) {
        pinned.add(range.file);
        break;
      }
    }
  }
  return pinned;
}
