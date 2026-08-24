import * as THREE from 'three/webgpu';
import type { LodRun } from '../../lod-scheduler';
import type {
  CollisionMeshDescriptor,
  LodSource,
  LodSourceOptions,
  SceneCollision,
  StreamedScene,
} from '../../lod-source';
import type { SplatDatasetSource } from '../../dataset-source';
import { createLcc2ToThreeMatrix } from './lcc2-transform';
import { warn } from '../../logging';

/**
 * Reader for XGRIDS' `.lcc2` datasets (see `docs/formats/lcc2-notes.md`).
 *
 * An `.lcc2` manifest is a cut-based LOD octree: each node holds one splat
 * range (`{file, start, count}`) representing its spatial region at one
 * level, and every level fully tiles the scene, so rendering picks a *cut*
 * (one node per root→leaf path) rather than a level per leaf. Coarse nodes
 * are shared ancestors, so per-leaf independent selection would double-draw;
 * {@link OctreeLodSource} therefore selects a valid cut directly.
 *
 * The splat tiles are standard SOG v2 bundles (one file packs many nodes at
 * different `start` offsets), so the existing chunk cache and pool reuse
 * everything. Implemented from XGRIDS' openly published spec; no XGRIDS code
 * is used, and their capture data is never redistributed.
 */

/** Out-of-frustum nodes act this many times farther away (see LodScheduler). */
const FRUSTUM_PENALTY = 3;
/** Frustum test margin, as a fraction of each node's own size. */
const FRUSTUM_MARGIN = 0.1;
/** Hysteresis dead-band around each LOD distance threshold. */
const THRESHOLD_MARGIN = 0.1;
/** Minimum time a cell must hold a level before changing again, ms. */
const DWELL_MS = 500;

interface OctNode {
  file: number;
  offset: number;
  count: number;
  bounds: THREE.Box3;
  /** `totalLevels − depth`; 0 is finest. */
  level: number;
  children: number[];
  /** Finest-cell interval `[leafStart, leafEnd)` over this node's subtree. */
  leafStart: number;
  leafEnd: number;
}

interface RawNode {
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  child?: Record<string, RawNode>;
  data?: {
    '3dgs'?: { name: number; start: number; count: number };
    /** Collision/nav mesh for this node's region; `name` indexes `meshFiles`. */
    mesh?: { name: number; vertex: number; face: number };
    /**
     * Always-resident environment/background tile; root only. `name` indexes
     * `splatFiles`. Carries no `count` - the manifest never states how many
     * env splats there are, so it is measured when the tile decodes.
     */
    env?: { name: number };
  };
}

interface RawManifest {
  version: string;
  totalLevels: number;
  lodSplats: number[];
  root: RawNode & {
    splatFiles: string[];
    /** Triangle-mesh PLYs, referenced by nodes' `data.mesh.name`. */
    meshFiles?: string[];
    /**
     * XGRIDS' own `.btree` BVHs over `meshFiles`. Deliberately unread: the
     * format is proprietary and undocumented, and a host that wants an
     * acceleration structure builds one from the meshes itself.
     */
    bvhFiles?: string[];
  };
}

/** Builds a scene from a parsed `.lcc2` manifest (JSON already fetched). */
export function buildLcc2Scene(
  json: unknown,
  dataset: SplatDatasetSource,
  options: LodSourceOptions,
  shBands: 0 | 1 | 2 | 3 = 0,
): StreamedScene {
  const raw = json as RawManifest;
  const chunkUrls = raw.root.splatFiles.map((path) => {
    const url = dataset.resolve(path);
    if (url === null) throw new Error(`LCC2 dataset is missing the tile "${path}".`);
    return url;
  });

  const nodes: OctNode[] = [];
  const cellNodes: number[] = []; // node index of each finest cell, by cell index
  let nextLeaf = 0;
  // Flatten every node that carries splat data (all but the root). Finest
  // cells are the childless nodes, numbered in DFS order; each node's
  // [leafStart, leafEnd) spans the cells in its subtree, so ancestor
  // intervals nest over descendants (what the swap grouping needs).
  const build = (rawNode: RawNode, depth: number): number => {
    const range = rawNode.data?.['3dgs'];
    if (!range) throw new Error('LCC2 node is missing 3dgs data.');
    const index = nodes.length;
    nodes.push(null as unknown as OctNode); // reserve slot (children get later indices)

    const leafStart = nextLeaf;
    const children: number[] = [];
    const rawChildren = rawNode.child ? Object.values(rawNode.child) : [];
    if (rawChildren.length === 0) {
      cellNodes[nextLeaf] = index; // this node is one finest cell
      nextLeaf++;
    } else {
      for (const child of rawChildren) children.push(build(child, depth + 1));
    }
    const leafEnd = rawChildren.length === 0 ? leafStart + 1 : nextLeaf;

    nodes[index] = {
      file: range.name,
      offset: range.start,
      count: range.count,
      bounds: boxFromRaw(rawNode.boundingBox),
      level: raw.totalLevels - depth,
      children,
      leafStart,
      leafEnd,
    };
    return index;
  };

  const rootChildren = Object.values(raw.root.child ?? {}).map((child) => build(child, 1));

  const source = new OctreeLodSource(nodes, rootChildren, cellNodes, raw.totalLevels - 1, options);
  const pinnedFiles = new Set<number>(rootChildren.map((i) => (nodes[i] as OctNode).file));

  // The environment tile (root `data.env`) is an always-resident background -
  // one whole `.sog`, no LOD ladder, no `count` in the manifest (measured at
  // decode). Pin its file so a fetch in flight is never cancelled by an LOD
  // reschedule, and StreamedSplatMesh loads it once and toggles it live.
  const envName = raw.root.data?.env?.name;
  const environment =
    envName !== undefined && chunkUrls[envName] !== undefined ? { file: envName } : undefined;
  if (envName !== undefined && environment === undefined) {
    warn(`LCC2 root references env tile #${envName}, which the manifest does not list.`);
  }
  if (environment) pinnedFiles.add(environment.file);

  const packShBands = shBands >= 1 ? (shBands as 1 | 2 | 3) : undefined;

  return {
    source,
    chunkUrls,
    chunkKind: 'file', // LCC2 tiles are single bundled .sog (ZIP) files
    // Explicit format: a dropped folder resolves tiles to `blob:` URLs with no
    // `.sog` extension, so the chunk loader cannot sniff the parser from the URL.
    chunkOptions: chunkUrls.map(() => ({
      format: 'sog' as const,
      ...(packShBands ? { sog: { packShBands } } : {}),
    })),
    bounds: boxFromRaw(raw.root.boundingBox),
    pinnedFiles,
    maxResidentSplats: raw.lodSplats[0] ?? options.budget,
    minimumCoverageSplats: Math.max(
      1,
      rootChildren.reduce((sum, index) => sum + (nodes[index] as OctNode).count, 0),
    ),
    ...collisionFrom(raw, dataset),
    ...(environment ? { environment } : {}),
    ...(packShBands ? { shBands: packShBands } : {}),
    // Match the established XGRIDS LCC and Spark viewer coordinate frame.
    // Bounds remain source-local and matrixWorld handles the conversion.
    formatTransform: createLcc2ToThreeMatrix(),
  };
}

/**
 * Collects the dataset's collision-mesh tiles, if it ships any.
 *
 * Nodes name their mesh by index into `root.meshFiles`, and several nodes can
 * share one file, so tiles are deduped by that index and carry the bounds of
 * the first node that claimed them. Unlike a splat tile, a missing mesh is not
 * fatal - collision is optional, and a partial set still beats none.
 */
function collisionFrom(
  raw: RawManifest,
  dataset: SplatDatasetSource,
): { collision?: SceneCollision } {
  const meshFiles = raw.root.meshFiles;
  if (!meshFiles || meshFiles.length === 0) return {};

  const boundsByFile = new Map<number, THREE.Box3>();
  const visit = (node: RawNode): void => {
    const mesh = node.data?.mesh;
    if (mesh && !boundsByFile.has(mesh.name)) {
      boundsByFile.set(mesh.name, boxFromRaw(node.boundingBox));
    }
    for (const child of Object.values(node.child ?? {})) visit(child);
  };
  visit(raw.root);

  // Nodes are the authority on which files are collision meshes and where they
  // sit. A manifest that lists the files but never references them still gets
  // its meshes loaded, just without per-tile bounds.
  const wanted: { file: number; bounds?: THREE.Box3 }[] =
    boundsByFile.size > 0
      ? [...boundsByFile].map(([file, bounds]) => ({ file, bounds }))
      : meshFiles.map((_, file) => ({ file }));

  const meshes: CollisionMeshDescriptor[] = [];
  for (const { file, bounds } of wanted) {
    const path = meshFiles[file];
    if (path === undefined) {
      warn(`LCC2 node references mesh file ${file}, which the manifest does not list.`);
      continue;
    }
    const url = dataset.resolve(path);
    if (url === null) {
      warn(`LCC2 dataset is missing the collision mesh "${path}"; skipping it.`);
      continue;
    }
    meshes.push({ url, ...(bounds ? { bounds } : {}) });
  }
  return meshes.length > 0 ? { collision: { meshes } } : {};
}

/**
 * Selects a budget-bounded cut through an LCC2 octree with the same
 * stability as the SOG scheduler. The stable state is a per-finest-cell
 * desired level (0 = finest), updated from camera distance with a dead-band
 * and dwell so a still or slowly-panning camera does not flip levels - this
 * is what stops the "two LODs fighting" flicker. From those levels a valid
 * cut is built (descend into a node only while some cell in its subtree
 * wants finer than the node provides), then budget-adjusted: coarsen the
 * farthest cells if over budget, refine the nearest with any leftover.
 * Because coarse nodes are shared ancestors, the cut construction - not
 * per-cell independent selection - is what guarantees no double-draw.
 */
class OctreeLodSource implements LodSource {
  budget: number;
  lodBaseDistance: number;
  lodMultiplier: number;

  private readonly nodes: OctNode[];
  private readonly rootChildren: number[];
  private readonly cellNodes: number[];
  private readonly coarsest: number;
  /** Finest available level per cell (its own node's level). */
  private readonly cellFinestLevel: Int32Array;
  /** Stable, dwelled desired level per cell. */
  private readonly cellLevel: Int32Array;
  /** Timestamp of each cell's last level change, for dwell. */
  private readonly changedAt: Float64Array;
  /** Index into {@link rootChildren} of the subtree containing each cell. */
  private readonly cellRootChild: Uint32Array;

  private readonly scratchBox = new THREE.Box3();
  private readonly scratchSize = new THREE.Vector3();

  constructor(
    nodes: OctNode[],
    rootChildren: number[],
    cellNodes: number[],
    coarsest: number,
    options: LodSourceOptions,
  ) {
    this.nodes = nodes;
    this.rootChildren = rootChildren;
    this.cellNodes = cellNodes;
    this.coarsest = coarsest;
    this.budget = options.budget;
    this.lodBaseDistance = options.lodBaseDistance;
    this.lodMultiplier = options.lodMultiplier;

    const n = cellNodes.length;
    this.cellFinestLevel = new Int32Array(n);
    this.cellLevel = new Int32Array(n).fill(coarsest);
    this.changedAt = new Float64Array(n);
    for (let c = 0; c < n; c++) {
      this.cellFinestLevel[c] = (nodes[cellNodes[c] as number] as OctNode).level;
    }
    this.cellRootChild = new Uint32Array(n);
    rootChildren.forEach((nodeIndex, r) => {
      const node = nodes[nodeIndex] as OctNode;
      for (let cell = node.leafStart; cell < node.leafEnd; cell++) this.cellRootChild[cell] = r;
    });
  }

  computeDesiredRuns(cameraLocal: THREE.Vector3, frustum: THREE.Frustum, now: number): LodRun[] {
    const cellDistance = this.updateCellLevels(cameraLocal, frustum, now);

    // resolved[] starts from the dwelled per-cell levels, then is
    // budget-adjusted; keeping the dwelled base separate (like the SOG
    // scheduler's level/resolved split) prevents budget changes from
    // feeding back into the hysteresis.
    const resolved = Int32Array.from(this.cellLevel);
    // A cell's level only affects the cut inside its own root-child subtree,
    // so per-subtree contributions are cached and each adjustment step
    // re-walks one subtree - not the whole tree, which made the enforce/fill
    // loops O(cells² · depth) on heavily over-budget scenes.
    const contributions = this.rootChildren.map((index) => this.subtreeCutTotal(index, resolved));
    let total = contributions.reduce((sum, count) => sum + count, 0);
    const adjust = (cell: number, delta: number): void => {
      resolved[cell] = (resolved[cell] as number) + delta;
      const r = this.cellRootChild[cell] as number;
      const next = this.subtreeCutTotal(this.rootChildren[r] as number, resolved);
      total += next - (contributions[r] as number);
      contributions[r] = next;
    };

    const byDistanceDesc = [...this.cellNodes.keys()].sort(
      (a, b) => (cellDistance[b] as number) - (cellDistance[a] as number),
    );
    // Enforce: coarsen the farthest cells until the cut fits the budget.
    for (let i = 0; i < byDistanceDesc.length && total > this.budget;) {
      const c = byDistanceDesc[i] as number;
      if ((resolved[c] as number) < this.coarsest) {
        adjust(c, +1);
      } else {
        i++;
      }
    }
    // Fill: spend leftover budget refining the nearest cells, to 85% - the
    // headroom keeps region-atomic swap transients (old + new runs briefly
    // co-resident) from pushing the live count past budget on a scene far
    // larger than the budget.
    const fillTarget = this.budget * 0.85;
    for (let i = byDistanceDesc.length - 1; i >= 0 && total < fillTarget;) {
      const c = byDistanceDesc[i] as number;
      if ((resolved[c] as number) > (this.cellFinestLevel[c] as number)) {
        adjust(c, -1);
        if (total > this.budget) {
          adjust(c, +1); // overshoot; revert and stop
          break;
        }
      } else {
        i--;
      }
    }

    const runs: LodRun[] = [];
    this.collectCut(resolved, (index) => runs.push(runFromNode(this.nodes[index] as OctNode)));
    return runs;
  }

  coarsestRunsFor(from: number, to: number): LodRun[] {
    const runs: LodRun[] = [];
    for (const index of this.rootChildren) {
      const node = this.nodes[index] as OctNode;
      if (node.leafStart < to && node.leafEnd > from) runs.push(runFromNode(node));
    }
    return runs;
  }

  /** Distance (frustum-penalized) to each finest cell's node bounds. */
  private cellDistanceOf(cameraLocal: THREE.Vector3, frustum: THREE.Frustum, cell: number): number {
    const node = this.nodes[this.cellNodes[cell] as number] as OctNode;
    const d = node.bounds.distanceToPoint(cameraLocal);
    this.scratchBox.copy(node.bounds);
    node.bounds.getSize(this.scratchSize);
    this.scratchBox.expandByScalar(this.scratchSize.length() * FRUSTUM_MARGIN);
    return frustum.intersectsBox(this.scratchBox) ? d : d * FRUSTUM_PENALTY;
  }

  /** Advances each cell's dwelled level toward the distance target. */
  private updateCellLevels(
    cameraLocal: THREE.Vector3,
    frustum: THREE.Frustum,
    now: number,
  ): Float64Array {
    const { lodBaseDistance: base, lodMultiplier: m } = this;
    const distances = new Float64Array(this.cellNodes.length);
    for (let c = 0; c < this.cellNodes.length; c++) {
      const d = this.cellDistanceOf(cameraLocal, frustum, c);
      distances[c] = d;

      const min = this.cellFinestLevel[c] as number;
      let level = Math.min(this.coarsest, Math.max(min, this.cellLevel[c] as number));
      // Dead-band: coarsen only past threshold·(1+margin), refine only
      // within threshold·(1−margin); threshold(L) = base·m^L.
      while (level < this.coarsest && d > base * m ** level * (1 + THRESHOLD_MARGIN)) level++;
      while (level > min && d <= base * m ** (level - 1) * (1 - THRESHOLD_MARGIN)) level--;

      if (
        level !== (this.cellLevel[c] as number) &&
        now - (this.changedAt[c] as number) >= DWELL_MS
      ) {
        this.cellLevel[c] = level;
        this.changedAt[c] = now;
      }
    }
    return distances;
  }

  /** Splat total of one subtree's cut for the given per-cell levels. */
  private subtreeCutTotal(index: number, levels: Int32Array): number {
    let total = 0;
    this.visitCut(index, levels, (i) => {
      total += (this.nodes[i] as OctNode).count;
    });
    return total;
  }

  /**
   * Walks the tree emitting the cut for the given per-cell levels: a node is
   * selected (stop) unless some cell in its subtree wants finer than the
   * node provides, in which case its children are visited. Guarantees an
   * antichain - exactly one node per root→leaf path.
   */
  private collectCut(levels: Int32Array, emit: (index: number) => void): void {
    for (const index of this.rootChildren) this.visitCut(index, levels, emit);
  }

  /** {@link collectCut} restricted to one subtree. */
  private visitCut(index: number, levels: Int32Array, emit: (index: number) => void): void {
    const node = this.nodes[index] as OctNode;
    if (node.children.length > 0) {
      let minWanted = this.coarsest;
      for (let cell = node.leafStart; cell < node.leafEnd; cell++) {
        const level = levels[cell] as number;
        if (level < minWanted) minWanted = level;
      }
      if (minWanted < node.level) {
        for (const child of node.children) this.visitCut(child, levels, emit);
        return;
      }
    }
    emit(index);
  }
}

function runFromNode(node: OctNode): LodRun {
  return {
    file: node.file,
    level: node.level,
    offset: node.offset,
    count: node.count,
    leafStart: node.leafStart,
    leafEnd: node.leafEnd,
  };
}

function boxFromRaw(bound: RawNode['boundingBox']): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(bound.min[0], bound.min[1], bound.min[2]),
    new THREE.Vector3(bound.max[0], bound.max[1], bound.max[2]),
  );
}
