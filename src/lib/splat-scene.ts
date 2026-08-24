/**
 * A scene of several independently-posed Gaussian splat clouds that all sort
 * and blend as one.
 *
 * The problem it solves: two separate {@link SplatMesh} instances are two
 * transparent draw calls, each depth-sorted only within itself, so where the
 * clouds overlap one is painted wholesale in front of the other ("pasted over")
 * - the same artifact PlayCanvas's unified rendering and Spark's accumulator
 * exist to fix. `SplatScene` concatenates every cloud into **one pool** and
 * runs **one global depth sort**, so splats from different clouds interleave
 * correctly, from any angle.
 *
 * Each cloud ("source") keeps its own world transform, applied in the shader
 * (never baked into the pool): the sorter transforms each splat's center to
 * world space before measuring depth, and the material places each splat's
 * center and covariance by its source's matrix. So {@link setSourceTransform}
 * is a handful of uniform writes - a source can be dragged or animated every
 * frame at full rate, at any splat count, with no data re-upload.
 *
 * The placement runs **before** the modifier stack, so a host effect sees each
 * splat where it visually is: an SDF light shape spanning two sources paints
 * one continuous shape, and a reveal sweeps them together. A modifier that
 * wants to travel *with* a moved source reads `ctx.sourceCenter` instead of
 * `ctx.localCenter`. See `docs/guide/effects-and-modifiers.md`.
 *
 * On WebGPU the world-depth sort runs in a compute pass; on the WebGL2
 * fallback the worker applies the same source matrices on the CPU before
 * sorting. Both backends therefore inter-sort sources correctly.
 *
 * Limitations, all inherited from the dynamic pool: sources may not carry
 * palette (SOG `shN`) view-dependent color - per-file palettes cannot be merged
 * - but DC color and per-splat (LCC) SH are fine; all sources share one
 * antialias setting (from the scene options).
 *
 * Sources are **static**: {@link addSource} takes a fully-resident
 * {@link SplatData} and copies it once into the pool, so a streaming
 * {@link StreamedSplatMesh} (which swaps its resident LOD cut every frame)
 * cannot be a source yet - keep a streamed main splat separate and unify only
 * the static sources. Streamed sources are ROADMAP M15.4.
 */
import * as THREE from 'three/webgpu';
import { SplatMesh, type SplatMeshOptions, type SplatRange } from './splat-mesh';
import type { SplatData } from './splat-data';
import { yUpTransformForFormat, type SplatOrientation } from './orientation';
import {
  MAX_SOURCES,
  SOURCE_ID_CHANNEL,
  SourceMatrixArray,
  worldBoundsOf,
  type SourceBounds,
} from './source-transform';

/** Construction options for a {@link SplatScene}. */
export interface SplatSceneOptions extends SplatMeshOptions {
  /** Total pool size in splats - must cover the sum of every source added. */
  capacity: number;
  /** Maximum number of sources (default {@link MAX_SOURCES}). */
  maxSources?: number;
}

/** Per-source placement options. */
export interface AddSourceOptions {
  /**
   * Y-up normalization for this source's data frame, like {@link SplatMesh}'s
   * `orientation`. `'y-up'` (default) applies the format's stand-up correction
   * before the placement matrix; `'source'` places the raw data frame.
   */
  orientation?: SplatOrientation;
}

/** Internal per-source record. */
interface SourceRecord extends SourceBounds {
  /** The pool range this source's splats occupy. */
  range: SplatRange;
  /** Data-frame → world correction applied before the placement matrix. */
  correction: THREE.Matrix4 | null;
  /** Live placement (world = placement · correction); kept for re-placement. */
  placement: THREE.Matrix4;
  /** The source's own data-frame bounds, for {@link SplatScene.computeSplatBounds}. */
  box: THREE.Box3;
}

/**
 * One pool, one global sort, many independently-posed splat sources - see the
 * module overview above for the artifact this exists to remove.
 *
 * @experimental May change in a minor release.
 */
export class SplatScene extends SplatMesh {
  private readonly matrices: SourceMatrixArray;
  private readonly maxSources: number;
  /** Indexed by source id; holes are left by {@link removeSource}. */
  private readonly sources: (SourceRecord | undefined)[] = [];
  private nextId = 0;

  constructor(options: SplatSceneOptions) {
    const maxSources = options.maxSources ?? MAX_SOURCES;
    super({ capacity: options.capacity }, options);
    this.matrices = new SourceMatrixArray(maxSources);
    this.maxSources = maxSources;

    // One float per pool slot naming the splat's source; read by both the
    // material graph and the world-depth sorter.
    this.defineChannel(SOURCE_ID_CHANNEL, { type: 'float' });
    const sourceIdTexture = this.channelTexture(SOURCE_ID_CHANNEL);
    if (!sourceIdTexture) throw new Error('SplatScene: sourceId channel texture missing.');
    this.perSourceSort = {
      sourceIdTexture,
      columns: this.matrices.node,
      sourceIds: this.channelBacking(SOURCE_ID_CHANNEL),
      matrices: this.matrices.matrices,
    };
    // The base constructor already built a graph, before `perSourceSort` was
    // set - rebuild so the material actually places its splats. Without this
    // every source renders at its pool-local position.
    this.rebuildGraph();
  }

  /** Number of live sources. */
  get sourceCount(): number {
    let count = 0;
    for (const source of this.sources) if (source) count++;
    return count;
  }

  /**
   * Adds a cloud at a world placement and returns its id (for
   * {@link setSourceTransform} / {@link removeSource}). The data is copied into
   * the shared pool in its own local frame; the placement is applied live in
   * the shader.
   *
   * @throws if the pool cannot fit the cloud, or the source limit is reached.
   */
  addSource(
    data: SplatData,
    placement: THREE.Matrix4 = new THREE.Matrix4(),
    options: AddSourceOptions = {},
  ): number {
    const id = this.nextId;
    if (id >= this.maxSources) {
      throw new Error(`SplatScene: source limit reached (${this.maxSources}).`);
    }
    const range = this.appendRange(data); // local space; transform is a uniform
    this.nextId++;

    const ids = new Float32Array(data.count);
    ids.fill(id);
    this.writeChannel(range, SOURCE_ID_CHANNEL, ids);

    const orientation = options.orientation ?? 'y-up';
    const correction = orientation === 'y-up' ? yUpTransformForFormat(data.sourceFormat) : null;
    const box = new THREE.Box3().setFromArray(data.positions);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const record: SourceRecord = {
      range,
      correction,
      placement: placement.clone(),
      box,
      center: sphere.center,
      radius: sphere.radius,
      matrix: new THREE.Matrix4(),
    };
    this.sources[id] = record;
    this.applyPlacement(record);
    return id;
  }

  /**
   * Re-places a source. Cheap by design: only the shared matrix uniform and the
   * sort bound change, so it is safe to call every frame while dragging.
   *
   * Bad-id semantics across the triad: this method **throws** (a write to a
   * dead source is a caller bug that would otherwise vanish silently),
   * {@link getSourceTransform} returns `undefined` (querying is how you ask
   * whether a source is live), and {@link removeSource} returns `false`
   * (removal is idempotent).
   *
   * @throws if `id` is not a live source.
   */
  setSourceTransform(id: number, placement: THREE.Matrix4): void {
    const record = this.sources[id];
    if (!record) throw new Error(`SplatScene: no live source ${id}.`);
    record.placement.copy(placement);
    this.applyPlacement(record);
  }

  /**
   * The current world matrix of a source (a copy), or `undefined` if `id` is
   * not a live source - see {@link setSourceTransform} for the bad-id triad.
   */
  getSourceTransform(id: number): THREE.Matrix4 | undefined {
    return this.sources[id]?.matrix.clone();
  }

  /**
   * Removes a source and frees its pool range. The id is not reused (later ids
   * keep their matrix slots), so long-lived churn should prefer reusing a scene
   * over unbounded add/remove.
   *
   * @returns `true` when a live source was removed, `false` when `id` was not
   * live (idempotent - see {@link setSourceTransform} for the bad-id triad).
   */
  removeSource(id: number): boolean {
    const record = this.sources[id];
    if (!record) return false;
    this.removeRange(record.range);
    this.sources[id] = undefined;
    this.invalidateSort();
    return true;
  }

  /** Recomputes a source's world matrix (placement · correction) and republishes it. */
  private applyPlacement(record: SourceRecord): void {
    if (record.correction) record.matrix.multiplyMatrices(record.placement, record.correction);
    else record.matrix.copy(record.placement);
    const id = this.sources.indexOf(record);
    this.matrices.set(id, record.matrix);
    this.invalidateSort();
  }

  /** Sort depth is quantized over the world span of every source, not the pool's local box. */
  protected override refreshSortBounds(): void {
    if (!this.boundsDirty) return;
    const live: SourceBounds[] = [];
    for (const source of this.sources) if (source) live.push(source);
    worldBoundsOf(live, this.boundingSphereLocal);
    this.boundsDirty = false;
  }

  /**
   * Mesh-local bounds spanning every source at its **current placement** -
   * the pool's own box would be the union of the sources' data frames, which
   * is not where any of them is drawn. Each source's data-frame box is
   * transformed by its matrix, so a rotated source contributes the (standard,
   * conservative) axis-aligned box of its rotated bounds.
   *
   * Hosts use this to place effects, so it has to agree with what
   * `ctx.localCenter` reports; it tracks {@link setSourceTransform}.
   */
  override computeSplatBounds(): THREE.Box3 {
    const bounds = new THREE.Box3().makeEmpty();
    const placed = new THREE.Box3();
    for (const source of this.sources) {
      if (!source) continue;
      bounds.union(placed.copy(source.box).applyMatrix4(source.matrix));
    }
    return bounds;
  }
}
