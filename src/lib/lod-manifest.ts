import * as THREE from 'three/webgpu';
import type { SplatDatasetSource } from './dataset-source';

/**
 * Parser for the Streamed SOG manifest (`lod-meta.json`, version 1).
 *
 * The manifest describes a large scene as a binary spatial tree whose leaves
 * each cover one region at several levels of detail. LOD level 0 is the
 * finest; higher levels are progressively coarser. Each leaf references, per
 * level, a contiguous `[offset, offset + count)` splat range inside one chunk
 * file (an unbundled SOG v2 directory). One chunk file serves many leaves.
 *
 * Spec:
 * https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/
 */

/** A leaf's splat range at one LOD level. */
export interface LodRange {
  /** Index into {@link LodManifest.chunkUrls}. */
  readonly file: number;
  /** First splat row within that chunk's decoded arrays. */
  readonly offset: number;
  /** Number of splats. */
  readonly count: number;
}

/** A spatial region, present at one or more LOD levels. */
export interface LodLeaf {
  readonly bounds: THREE.Box3;
  /** Range per level; `lods[level]` is undefined if absent at that level. */
  readonly lods: readonly (LodRange | undefined)[];
  /**
   * Leaves with the same group are budgeted atomically. Formats may use this
   * when one spatial region is split into several independently streamed
   * ranges: the ranges may arrive separately, but must select one LOD cut.
   */
  readonly budgetGroup?: number;
}

export interface LodManifest {
  /** Leaves in tree-traversal order (load-bearing: adjacent leaves within a
   * chunk have contiguous ranges, which the scheduler coalesces into runs). */
  readonly leaves: readonly LodLeaf[];
  /** Absolute chunk-directory URLs, indexed by {@link LodRange.file}. */
  readonly chunkUrls: readonly string[];
  /**
   * Chunk directories relative to the manifest, aligned with {@link chunkUrls}.
   * Only the unbundled-SOG layout has them; formats whose chunks are single
   * files (LCC of either generation) leave this out.
   */
  readonly chunkDirectories?: readonly string[];
  /** Total splats per LOD level (index = level). */
  readonly counts: readonly number[];
  readonly lodLevels: number;
  /** Root bounding box of the whole scene. */
  readonly bounds: THREE.Box3;
}

interface RawNode {
  bound: { min: [number, number, number]; max: [number, number, number] };
  children?: [RawNode, RawNode];
  lods?: Record<string, { file: number; offset: number; count: number }>;
}

interface RawManifest {
  version: number;
  counts: number[];
  lodLevels: number;
  filenames: string[];
  tree: RawNode;
}

/**
 * Parses a `lod-meta.json` object into a flat, render-ready manifest.
 *
 * @param json - The parsed manifest JSON.
 * @param baseUrl - URL of the manifest, used to resolve chunk directories.
 * @throws {Error} on an unsupported version or malformed tree.
 */
export function parseLodManifest(json: unknown, source: SplatDatasetSource): LodManifest {
  const raw = json as RawManifest;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Streamed SOG manifest is not a JSON object.');
  }
  if (raw.version !== 1) {
    throw new Error(`Unsupported Streamed SOG manifest version: ${raw.version} (expected 1).`);
  }
  if (!Array.isArray(raw.filenames) || raw.filenames.some((name) => typeof name !== 'string')) {
    throw new Error('Streamed SOG manifest "filenames" must be an array of strings.');
  }
  if (
    !Array.isArray(raw.counts) ||
    raw.counts.some((count) => !Number.isSafeInteger(count) || count < 0)
  ) {
    throw new Error('Streamed SOG manifest "counts" must be an array of non-negative integers.');
  }
  if (!Number.isSafeInteger(raw.lodLevels) || raw.lodLevels < 1 || raw.lodLevels > 64) {
    throw new Error(`Streamed SOG manifest declares an invalid lodLevels: ${raw.lodLevels}.`);
  }

  // "0_0/meta.json" -> the chunk *directory* "0_0/". Over HTTP that resolves
  // to a real URL the worker fetches images beneath; from a dropped folder
  // there is nothing to resolve against, so the directory's files travel with
  // the chunk instead (see StreamedScene.chunkOptions).
  const directories = raw.filenames.map((name) => name.replace(/\/?meta\.json$/, '/'));
  const chunkUrls = directories.map(
    (directory) => source.resolve(directory) ?? `${source.manifestUrl}#${directory}`,
  );

  const leaves: LodLeaf[] = [];
  const lodLevels = raw.lodLevels;
  // Iterative depth-first traversal (explicit stack, children pushed in
  // reverse so leaf order is unchanged): a hostile manifest with a
  // pathologically deep tree must not overflow the call stack.
  const stack: RawNode[] = [raw.tree];
  while (stack.length > 0) {
    const node = stack.pop() as RawNode;
    if (typeof node !== 'object' || node === null) {
      throw new Error('Streamed SOG manifest tree contains a malformed node.');
    }
    if (node.children) {
      if (!Array.isArray(node.children) || node.children.length !== 2) {
        throw new Error('Streamed SOG manifest tree node must have exactly two children.');
      }
      stack.push(node.children[1], node.children[0]);
      continue;
    }
    const lods: (LodRange | undefined)[] = new Array<LodRange | undefined>(lodLevels).fill(
      undefined,
    );
    for (const [levelKey, range] of Object.entries(node.lods ?? {})) {
      const level = Number(levelKey);
      if (level >= 0 && level < lodLevels) {
        assertSaneRange(range, raw.filenames.length);
        lods[level] = range;
      }
    }
    leaves.push({ bounds: boxFromBound(node.bound), lods });
  }

  return {
    leaves,
    chunkUrls,
    chunkDirectories: directories,
    counts: raw.counts,
    lodLevels,
    bounds: boxFromBound(raw.tree.bound),
  };
}

/** Asserts a leaf's untrusted splat range is sane before it drives pool I/O. */
function assertSaneRange(range: LodRange, fileCount: number): void {
  if (
    typeof range !== 'object' ||
    range === null ||
    !Number.isSafeInteger(range.file) ||
    range.file < 0 ||
    range.file >= fileCount ||
    !Number.isSafeInteger(range.offset) ||
    range.offset < 0 ||
    !Number.isSafeInteger(range.count) ||
    range.count < 0
  ) {
    throw new Error(
      'Streamed SOG manifest leaf declares an invalid LOD range ' +
        `(file ${range?.file}, offset ${range?.offset}, count ${range?.count}).`,
    );
  }
}

function boxFromBound(bound: RawNode['bound']): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(bound.min[0], bound.min[1], bound.min[2]),
    new THREE.Vector3(bound.max[0], bound.max[1], bound.max[2]),
  );
}
