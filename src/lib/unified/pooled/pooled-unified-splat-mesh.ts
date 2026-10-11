/**
 * One CPU-sorted draw over several splat sources that share a {@link SplatPool}.
 *
 * {@link UnifiedSplatMesh} needs compute passes (gather + GPU sort), so it is
 * WebGPU-only. This is the WebGL2 answer to the same artifact: two meshes
 * drawn separately are two transparent draws, each sorted only within itself,
 * so whichever draws last paints wholesale over the other. Here every source
 * is a tenant of **one** pool, so a single draw can index all of their rows;
 * the sources' exact active lists are concatenated into one worker sort keyed
 * by each source's own world matrix, and the result is drawn as one instanced
 * mesh whose `splatIndex` / `sourceId` attributes come straight from the
 * worker. No data is gathered or copied: the draw reads the pool textures the
 * sources already filled.
 *
 * Publication keeps the worker-path boundary of `SplatMesh`: every source's
 * pending texture rows are captured together with the combined index list,
 * and the rows upload only when the matching order comes back. Until then the
 * previous complete frame stays visible. Sources keep streaming meanwhile;
 * their later changes go into the next capture.
 *
 * Works on either backend (a WebGPU host would normally prefer the compute
 * path). Sources must be `editable` meshes drawing from the same pool.
 * Effects: each source's own stack ({@link setSourceModifiers}) runs in that
 * source's local frame, as the compute path's gather does; the mesh's own
 * {@link modifiers} then run on every splat in the drawn (world) frame; then
 * per-source opacity. Placement, LOD alpha and packed-SH range are per source.
 *
 * Several views that share one camera (split panes) draw different subsets of
 * the same sorted set through {@link setSourceDrawMask}: membership stays the
 * union, and the mask is a uniform write that leaves the order alone.
 */
import * as THREE from 'three/webgpu';
import type { WebGLRenderer } from 'three';
import { attribute, uniform, vec4 } from 'three/tsl';
// A value import on purpose: it makes this entry depend on everything
// `SplatMesh` already pulls in, so Rollup keeps the core chunks exactly as a
// WebGPU host loads them instead of splitting them around this entry's needs.
import { SplatMesh, type PooledPublication, type SplatPickOptions } from '../../core/splat-mesh';
import type { UnifiedSourceView, SplatSortMetric } from '../../core/splat-mesh-types';
import { SplatPool, SPLAT_DATA_TEXTURE_WIDTH } from '../../core/splat-mesh-pool';
import {
  applySplatMaterialGraph,
  type SplatMaterialBuildInputs,
  type SplatShInputs,
  type DisplayColorModifier,
} from '../../core/splat-mesh-material';
import { asNode, type Vec3Uniform } from '../../core/splat-material-types';
import { WebGpuSortScheduler } from '../../core/sort-scheduler';
import { cameraVisibleSortRange, radialSortState } from '../../core/splat-sort-bounds';
import { updateSplatFrustumMargin } from '../../core/splat-frustum';
import { resolveXrView } from '../../core/xr-view';
import { isFillConstrainedSplatDevice } from '../../core/splat-budget';
import { clampDepthOfFieldSettings, type DepthOfFieldSettings } from '../../core/depth-of-field';
import type { SplatModifier } from '../../core/splat-modifier';
import { PooledSorter } from './pooled-sorter';
import {
  PooledSourceTables,
  ROW_PARAMS,
  ROW_SH_MAX,
  ROW_SH_MIN,
  SOURCE_DATA_ROWS,
} from './pooled-source-tables';
import { createSourceStacksModifier, groupSourceStacks } from './pooled-source-stacks';
import type {
  UnifiedDrawPublicationSnapshot,
  UnifiedSplatPickResult,
  UnifiedSplatSourceOptions,
} from '../unified-splat-mesh';

/** Construction options for a {@link PooledUnifiedSplatMesh}. */
export interface PooledUnifiedSplatMeshOptions {
  /** Camera-space ordering key for the combined sort. Default `'depth'`. */
  sortMetric?: SplatSortMetric;
  /**
   * Maximum registered sources. Default 64; at most 256 (one-byte source
   * ids). Shader tables are sized to the live source count, not to this.
   */
  maxSources?: number;
  /** Whether sources composite in display (sRGB) space; every source must agree. Default `false`. */
  srgbOutput?: boolean;
  /** Minimum interval between worker sorts under camera motion, ms. Default adaptive. */
  sortIntervalMs?: number;
}

/** Registration settings for one source; same shape as the compute path's. */
export type PooledUnifiedSourceOptions = Pick<
  UnifiedSplatSourceOptions,
  'opacity' | 'visible' | 'priority'
>;

/**
 * WebGL2 resource use of the pooled draw's vertex program, against the
 * device's limits. Uniform arrays become std140 blocks there, and a vertex
 * stage may bind as few as 12 of them; a program over a limit fails to link
 * and draws nothing, so hosts check this and fall back.
 */
export interface PooledShaderBudget {
  vertexUniformBlocks: number;
  maxVertexUniformBlocks: number;
  vertexSamplers: number;
  maxVertexSamplers: number;
  /** Material build this report describes. */
  materialRevision: number;
  ok: boolean;
}

/** CPU timings of the last {@link PooledUnifiedSplatMesh.update}. */
export interface PooledUnifiedPerformanceTimings {
  totalMs: number;
  sortSubmitMs: number;
  sortSubmitted: boolean;
  sortSubmissions: number;
  sourceCount: number;
  /** Splats in the last captured sort request. */
  activeCount: number;
  /** Splats currently drawn (last installed order). */
  instanceCount: number;
  /** Worker round trip of the last completed sort, ms. */
  lastSortLatencyMs: number;
}

interface SourceRecord {
  source: SplatMesh;
  /** The source's worker publication, driven by this mesh. */
  publication: PooledPublication;
  id: number;
  opacity: number;
  visible: boolean;
  /** Per-view draw mask ({@link PooledUnifiedSplatMesh.setSourceDrawMask}); never membership. */
  drawMask: boolean;
  originalVisible: boolean;
  view: UnifiedSourceView | null;
  lastMatrix: THREE.Matrix4;
  /** Active-list token and content revision the in-flight or last capture used. */
  capturedActiveListVersion: number;
  capturedContentRevision: number;
  /** The source's own stack, evaluated in its local frame. */
  modifiers: readonly SplatModifier[];
  /** Stored-alpha multiplier (2 for `.rad` LOD alpha). */
  alphaScale: number;
}

interface CapturePart {
  record: SourceRecord;
  requestId: number;
  activeListVersion: number;
  /**
   * The source's live active-list prefix at capture. Valid only inside the
   * synchronous capture that copies it into the combined request.
   */
  indices: Uint32Array;
}

interface PendingPublication {
  parts: readonly CapturePart[];
  order: Float32Array;
  orderSources: Uint8Array;
}

interface InstalledPublication {
  parts: readonly { record: SourceRecord; activeListVersion: number }[];
  count: number;
  revision: number;
  rendered: boolean;
}

const DEFAULT_MAX_SOURCES = 64;
const MAX_SOURCES = 256;
const SOURCE_ID_ATTRIBUTE = 'sourceId';
const _identity = new THREE.Matrix4();
const _viewSize = new THREE.Vector2();
const _sortState = new THREE.Matrix4();
const _cameraWorld = new THREE.Vector3();

/**
 * Whether `renderer` can drive a {@link PooledUnifiedSplatMesh}: any
 * initialized three `WebGPURenderer` backend, WebGL2 included.
 */
export function supportsPooledUnifiedSplatMesh(renderer: object): boolean {
  return typeof (renderer as { backend?: unknown }).backend === 'object';
}

/**
 * One pool, one worker sort, one draw, dynamic tenants - see the module
 * overview. Register sources that already draw from `pool`; the pooled mesh
 * hides them, owns their publication, and draws their rows itself.
 *
 * @experimental May change in a minor release.
 */
export class PooledUnifiedSplatMesh extends THREE.Mesh {
  /** Type marker for hosts that cannot import this module eagerly. */
  readonly isPooledUnifiedSplatMesh = true as const;
  readonly pool: SplatPool;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly sortMetric: SplatSortMetric;
  private readonly maxSources: number;
  private readonly srgbOutput: boolean;
  /** Packed per-source tables; replaced (and the material rebuilt) when they grow. */
  private tables: PooledSourceTables;
  private readonly splatIndexAttribute: THREE.InstancedBufferAttribute;
  private readonly sourceIdAttribute: THREE.InstancedBufferAttribute;
  private readonly focal = uniform(new THREE.Vector2());
  private readonly viewport = uniform(new THREE.Vector2(1, 1));
  private readonly frustumMargin = uniform(new THREE.Vector2());
  private readonly localCameraPosition = uniform(new THREE.Vector3());
  private readonly pixelScaleLimit = uniform(0);
  private readonly revealMultiplier = uniform(1);
  private readonly dofFocusDistance = uniform(10);
  private readonly dofAperture = uniform(0);
  private readonly screenBandMin = uniform(0);
  private readonly screenBandMax = uniform(0);
  private readonly sortScheduler: WebGpuSortScheduler;
  private readonly bounds = new THREE.Sphere();
  private readonly lastSortedState = new THREE.Matrix4();
  private readonly sources: SourceRecord[] = [];
  private readonly freeIds: number[] = [];
  private nextId = 0;
  /** Ids freed since the last installed order; reusable once that order is replaced. */
  private quarantinedIds: number[] = [];
  private sorter: PooledSorter | null = null;
  private inFlight: {
    requestId: number;
    parts: readonly CapturePart[];
    membership: number;
  } | null = null;
  private pending: PendingPublication | null = null;
  private installed: InstalledPublication | null = null;
  private membership = 0;
  private publicationRevision = 0;
  private renderedPublicationRevision = -1;
  private lastCaptureCount = 0;
  /**
   * What the worker's retained index list describes: the drawn records, in
   * order, with the versions they were captured at. A camera-only re-sort of
   * the same list sends no indices at all.
   */
  private retainedParts:
    { record: SourceRecord; activeListVersion: number; contentRevision: number }[] | null = null;
  private pendingMirrorRows: { start: number; count: number }[] = [];
  /** Undrawn sources published outside the worker cycle, awaiting a rendered-frame acknowledgement. */
  private renderAcks: { record: SourceRecord; activeListVersion: number }[] = [];
  private modifierList: readonly SplatModifier[] = [];
  private displayColorModifierValue: DisplayColorModifier | null = null;
  private settings: {
    maxStdDev: number;
    minSplatSizePx: number;
    antialias: boolean;
    projectedFilterProfile: 'default' | 'lcc';
    minPixelSize: number;
    minContribution: number;
  } | null = null;
  private materialBuilt = false;
  /** A structural change (stacks, membership, table size) awaits the next update. */
  private materialDirty = false;
  private materialRevision = 0;
  private shaderBudgetValue: PooledShaderBudget | null = null;
  /** Pool SH bands the material was built for; a late allocation rebuilds it. */
  private builtShBands: 0 | 1 | 2 | 3 = 0;
  private disposed = false;
  private readonly performanceTimingsValue: PooledUnifiedPerformanceTimings = {
    totalMs: 0,
    sortSubmitMs: 0,
    sortSubmitted: false,
    sortSubmissions: 0,
    sourceCount: 0,
    activeCount: 0,
    instanceCount: 0,
    lastSortLatencyMs: Number.NaN,
  };

  constructor(
    renderer: THREE.WebGPURenderer,
    pool: SplatPool,
    options: PooledUnifiedSplatMeshOptions = {},
  ) {
    const maxSources = Math.max(
      1,
      Math.min(MAX_SOURCES, Math.floor(options.maxSources ?? DEFAULT_MAX_SOURCES)),
    );
    // One quad instanced per drawn splat, exactly as `SplatMesh` builds it.
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    // Draw-order attributes written from the worker reply. The pool bounds the
    // combined active count, so both are pool-sized (8 B per pool splat).
    // Default (static) usage on purpose: three's `Attributes.update` re-sends a
    // `DynamicDrawUsage` attribute's whole array every frame, which here is
    // 2 × 82 MB per frame on an 8M pool (~36 ms of CPU). With static usage the
    // version bump at publication uploads just the installed prefix.
    const splatIndexAttribute = new THREE.InstancedBufferAttribute(
      new Float32Array(pool.capacity),
      1,
    );
    const sourceIdAttribute = new THREE.InstancedBufferAttribute(
      new Float32Array(pool.capacity),
      1,
    );
    geometry.setAttribute('splatIndex', splatIndexAttribute);
    geometry.setAttribute(SOURCE_ID_ATTRIBUTE, sourceIdAttribute);
    geometry.instanceCount = 0;
    super(geometry, new THREE.NodeMaterial());
    if (pool.cpuMirrorsReleased) {
      throw new Error('PooledUnifiedSplatMesh: the pool released its CPU mirrors.');
    }
    this.renderer = renderer;
    this.pool = pool;
    this.sortMetric = options.sortMetric ?? 'depth';
    this.maxSources = maxSources;
    this.srgbOutput = options.srgbOutput ?? false;
    this.tables = new PooledSourceTables(PooledSourceTables.capacityFor(1, maxSources));
    this.splatIndexAttribute = splatIndexAttribute;
    this.sourceIdAttribute = sourceIdAttribute;
    this.sortScheduler = new WebGpuSortScheduler(
      options.sortIntervalMs,
      isFillConstrainedSplatDevice(),
    );
    // Sources are posed; this mesh stays at identity (world centers come from
    // the per-source matrices in the shader and in the worker).
    this.matrixAutoUpdate = false;
    this.frustumCulled = false;
  }

  /** Splats the shared pool can hold; the combined draw never exceeds it. */
  get capacity(): number {
    return this.pool.capacity;
  }

  /** Number of registered sources. */
  get sourceCount(): number {
    return this.sources.length;
  }

  /** Parity with `UnifiedSplatMesh`: a pooled draw never drops a source. */
  get droppedSourceCount(): number {
    return 0;
  }

  /** Parity with `UnifiedSplatMesh`: a pooled draw never drops splats. */
  get droppedSplatCount(): number {
    return 0;
  }

  /** CPU timings of the last update. */
  get performanceTimings(): Readonly<PooledUnifiedPerformanceTimings> {
    return this.performanceTimingsValue;
  }

  /** The last {@link checkShaderBudget} report, or `null` before one ran. */
  get shaderBudget(): Readonly<PooledShaderBudget> | null {
    return this.shaderBudgetValue;
  }

  /** Increments on every material build; compare with {@link shaderBudget}. */
  get shaderRevision(): number {
    return this.materialRevision;
  }

  /**
   * Sets the stack `source` draws through, evaluated in that source's local
   * frame (pass the source mesh's own `modifiers`). Element-wise identical
   * lists are a no-op; a change rebuilds the material on the next update.
   * Uniform-only changes inside the modifiers never rebuild.
   */
  setSourceModifiers(source: SplatMesh, modifiers: readonly SplatModifier[]): void {
    this.assertNotDisposed('setSourceModifiers');
    const record = this.recordOf(source);
    const current = record.modifiers;
    if (
      current.length === modifiers.length &&
      current.every((modifier, i) => modifier === modifiers[i])
    ) {
      return;
    }
    record.modifiers = [...modifiers];
    this.materialDirty = true;
  }

  /**
   * Counts the uniform blocks and samplers the pooled vertex program binds on
   * WebGL2 and compares them with the device's limits. Resolves `null` on a
   * WebGPU backend (bind-group limits apply there instead). Compiles the
   * current material if needed, so call it after a structural change rather
   * than every frame; {@link shaderBudget} keeps the last report.
   */
  async checkShaderBudget(camera: THREE.Camera): Promise<PooledShaderBudget | null> {
    const backend = this.renderer.backend as {
      isWebGPUBackend?: boolean;
      gl?: WebGL2RenderingContext;
    };
    const gl = backend.gl;
    if (backend.isWebGPUBackend === true || !gl || !this.materialBuilt) return null;
    const revision = this.materialRevision;
    const scene = new THREE.Scene();
    const { vertexShader } = await this.renderer.debug.getShaderAsync(scene, camera, this);
    const source = String(vertexShader);
    const vertexUniformBlocks = (source.match(/layout\(\s*std140\s*\)\s*uniform/g) ?? []).length;
    const vertexSamplers = (source.match(/uniform\s+(?:\w+\s+)?[iu]?sampler\w*/g) ?? []).length;
    const maxVertexUniformBlocks = gl.getParameter(gl.MAX_VERTEX_UNIFORM_BLOCKS) as number;
    const maxVertexSamplers = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) as number;
    const report: PooledShaderBudget = {
      vertexUniformBlocks,
      maxVertexUniformBlocks,
      vertexSamplers,
      maxVertexSamplers,
      materialRevision: revision,
      ok: vertexUniformBlocks <= maxVertexUniformBlocks && vertexSamplers <= maxVertexSamplers,
    };
    if (revision === this.materialRevision) this.shaderBudgetValue = report;
    return report;
  }

  /**
   * The one modifier stack applied to every drawn splat. Sources' own stacks
   * are not evaluated by this draw; `ctx.sourceCenter` is the pool-local
   * center and `ctx.localCenter` the placed world center. Modifiers reading
   * per-splat channels are not supported here (the pooled mesh defines none).
   */
  get modifiers(): readonly SplatModifier[] {
    return this.modifierList;
  }

  set modifiers(value: readonly SplatModifier[]) {
    const unchanged =
      value.length === this.modifierList.length &&
      value.every((modifier, i) => modifier === this.modifierList[i]);
    if (unchanged) return;
    const previous = this.modifierList;
    this.modifierList = [...value];
    try {
      this.rebuildMaterial();
    } catch (error) {
      this.modifierList = previous;
      this.rebuildMaterial();
      throw error;
    }
  }

  /** Optional RGB transform in the display fragment; replacing it rebuilds the material. */
  get displayColorModifier(): DisplayColorModifier | null {
    return this.displayColorModifierValue;
  }

  set displayColorModifier(modifier: DisplayColorModifier | null) {
    if (modifier === this.displayColorModifierValue) return;
    this.displayColorModifierValue = modifier;
    this.rebuildMaterial();
  }

  /** Core projected-2D depth of field on the pooled draw. Live uniforms. */
  setDepthOfField(settings: Partial<DepthOfFieldSettings>): void {
    const next = clampDepthOfFieldSettings(settings, this.getDepthOfField());
    this.dofFocusDistance.value = next.focusDistance;
    this.dofAperture.value = next.aperture;
  }

  /** Current core DoF uniforms (`aperture === 0` means off). */
  getDepthOfField(): DepthOfFieldSettings {
    return { focusDistance: this.dofFocusDistance.value, aperture: this.dofAperture.value };
  }

  /**
   * Registers a source drawing from this mesh's pool. The source is hidden
   * from the regular scene draw and hands its worker publication to this mesh.
   *
   * @throws when the source draws from another pool, is render-only or a
   *   `MergedSplatMesh`, disagrees with the first source's draw settings, or
   *   the source table is full.
   */
  addSource(source: SplatMesh, options: PooledUnifiedSourceOptions = {}): void {
    this.assertNotDisposed('addSource');
    if (this.sources.some((record) => record.source === source)) return;
    if (!(source instanceof SplatMesh)) {
      throw new TypeError('PooledUnifiedSplatMesh: sources must be SplatMesh instances.');
    }
    if (source.storageMode === 'render-only') {
      throw new Error('PooledUnifiedSplatMesh: storageMode "render-only" sources cannot join.');
    }
    const view = source.getUnifiedSourceView();
    if (view.hasSourcePlacement) {
      throw new Error(
        'PooledUnifiedSplatMesh: a MergedSplatMesh already places its own sources; ' +
          'add its sources individually.',
      );
    }
    if (view.centersTexture !== this.pool.centersTexture) {
      throw new Error(
        'PooledUnifiedSplatMesh: every source must draw from the pool this mesh was built on.',
      );
    }
    if (view.srgbOutput !== this.srgbOutput) {
      throw new Error(
        "PooledUnifiedSplatMesh: every source must use the mesh's srgbOutput setting.",
      );
    }
    if (this.settings === null) {
      this.settings = {
        maxStdDev: view.maxStdDev,
        minSplatSizePx: view.minSplatSizePx,
        antialias: view.antialias,
        projectedFilterProfile: view.projectedFilterProfile,
        minPixelSize: view.minPixelSize,
        minContribution: view.minContribution,
      };
    } else {
      const s = this.settings;
      if (s.maxStdDev !== view.maxStdDev) {
        throw new Error(
          'PooledUnifiedSplatMesh: every source must use the same maxStdDev setting.',
        );
      }
      if (s.minSplatSizePx !== view.minSplatSizePx) {
        throw new Error(
          'PooledUnifiedSplatMesh: every source must use the same minSplatSizePx setting.',
        );
      }
      if (s.antialias !== view.antialias) {
        throw new Error(
          'PooledUnifiedSplatMesh: every source must use the same antialias setting.',
        );
      }
      if (s.projectedFilterProfile !== view.projectedFilterProfile) {
        throw new Error(
          'PooledUnifiedSplatMesh: every source must use the same projected filter profile.',
        );
      }
      if (s.minPixelSize !== view.minPixelSize || s.minContribution !== view.minContribution) {
        throw new Error(
          'PooledUnifiedSplatMesh: every source must use the same contribution-culling settings.',
        );
      }
    }
    const id = this.allocateId();
    const visible = options.visible ?? source.visible;
    const record: SourceRecord = {
      source,
      publication: source.adoptPooledPublication(this),
      id,
      opacity: options.opacity ?? 1,
      visible,
      drawMask: true,
      originalVisible: source.visible,
      view: null,
      lastMatrix: new THREE.Matrix4().copy(view.matrixWorld),
      capturedActiveListVersion: -1,
      capturedContentRevision: -1,
      modifiers: [],
      // Multiplier recovering alpha from the stored byte: `.rad` halves it.
      alphaScale: view.lodAlpha ? 2 : 1,
    };
    this.sources.push(record);
    this.tables.setMatrix(id, view.matrixWorld);
    this.tables.setParams(id, 0, record.alphaScale);
    this.writeShRange(record, view);
    source.visible = false;
    source.setUnifiedPickVisibility(visible);
    // Rows this source wrote before joining are already in the pool backing;
    // a sorter created earlier mirrored them at construction only if they
    // existed then. Resend them with the next request to be safe.
    if (this.sorter !== null) {
      for (const range of source.poolRanges()) {
        this.pendingMirrorRows.push({ start: range.startRow, count: range.rowCount });
      }
    }
    if (!this.materialBuilt) this.rebuildMaterial();
    this.noteMembershipChange();
  }

  /** Unregisters a source and restores its standalone draw. */
  removeSource(source: SplatMesh): boolean {
    this.assertNotDisposed('removeSource');
    const index = this.sources.findIndex((record) => record.source === source);
    if (index < 0) return false;
    const [record] = this.sources.splice(index, 1);
    if (!record) return false;
    this.detachRecord(record);
    if (record.modifiers.length > 0) this.materialDirty = true;
    this.noteMembershipChange();
    if (this.sources.length === 0) this.settings = null;
    return true;
  }

  /**
   * Whole-source display opacity. Values `<= 0` skip the source's splats in
   * the draw at once (uniform), without waiting for a new order.
   */
  setSourceOpacity(source: SplatMesh, opacity: number): void {
    this.assertNotDisposed('setSourceOpacity');
    const record = this.recordOf(source);
    const wasDrawn = record.opacity > 0;
    record.opacity = opacity;
    if (wasDrawn !== opacity > 0) this.noteMembershipChange();
  }

  /** Shows or hides a source without changing its residency. */
  setSourceVisible(source: SplatMesh, visible: boolean): void {
    this.assertNotDisposed('setSourceVisible');
    const record = this.recordOf(source);
    if (record.visible === visible) return;
    record.visible = visible;
    record.source.setUnifiedPickVisibility(visible);
    this.noteMembershipChange();
  }

  /**
   * Draws or skips a source in the next draw **without** changing membership.
   * Unlike {@link setSourceVisible} and {@link setSourceOpacity}, the installed
   * order and any in-flight sort survive: the mask is one uniform write and
   * takes effect on the next render. Use it to draw different subsets of one
   * sorted set, for example two split panes that share the camera (keep the
   * union visible, flip the mask before each pane). Masked sources are not
   * picked. Defaults to drawn; the mask is dropped with the source.
   */
  setSourceDrawMask(source: SplatMesh, drawn: boolean): void {
    this.assertNotDisposed('setSourceDrawMask');
    const record = this.recordOf(source);
    if (record.drawMask === drawn) return;
    record.drawMask = drawn;
    this.tables.setDrawMask(record.id, drawn);
  }

  /** Updates, captures, publishes and requests a combined sort. Call before rendering. */
  update(camera: THREE.PerspectiveCamera): void {
    if (this.disposed) return;
    const startedAt = performance.now();
    const renderer = this.renderer;
    const timings = this.performanceTimingsValue;
    timings.sortSubmitted = false;
    timings.sortSubmitMs = 0;
    // Children take the application camera: streamed sources resolve XR and
    // schedule their LOD for themselves; `sort: false` keeps their own
    // publication idle (this mesh owns it).
    for (const record of this.sources) record.source.update(camera, renderer, { sort: false });
    camera.updateMatrixWorld();
    this.matrix.identity();
    this.matrixWorld.identity();

    let contentChanged = this.sortScheduler.hasPendingForce();
    this.bounds.makeEmpty();
    let boundsEmpty = true;
    for (const record of this.sources) {
      const view = record.source.getUnifiedSourceView();
      record.view = view;
      if (!record.lastMatrix.equals(view.matrixWorld)) {
        record.lastMatrix.copy(view.matrixWorld);
        this.tables.setMatrix(record.id, view.matrixWorld);
        contentChanged = true;
      }
      this.writeShRange(record, view);
      const drawn = record.visible && record.opacity > 0 && view.activeCount > 0;
      this.tables.setOpacity(record.id, drawn ? record.opacity * view.revealMultiplier : 0);
      const changed =
        view.activeListVersion !== record.capturedActiveListVersion ||
        view.contentRevision !== record.capturedContentRevision;
      if (!drawn) {
        // Nothing of this source is in the draw list, so its rows and active
        // list can publish right away, without the worker: a streamed source
        // still waits for that acknowledgement to continue staging (an empty
        // main at startup, a hidden marker that keeps streaming).
        if (changed) this.publishUndrawn(record, view, renderer);
        continue;
      }
      if (changed) contentChanged = true;
      if (boundsEmpty) {
        this.bounds.copy(view.worldBounds);
        boundsEmpty = false;
      } else {
        this.bounds.union(view.worldBounds);
      }
    }
    for (const id of this.quarantinedIds) this.tables.setOpacity(id, 0);
    if (
      this.materialBuilt &&
      (this.materialDirty || this.builtShBands !== this.pool.packedShBands)
    ) {
      this.rebuildMaterial();
    }

    if (this.pending !== null) this.publishPending(renderer);

    // View uniforms: drawing-buffer size, or the XR eye's. One sort from the
    // head serves both eyes, as `SplatMesh` does.
    const xrView = resolveXrView(camera, renderer);
    this.sortScheduler.setXrJitterTolerance(xrView !== null);
    const projectionCamera: THREE.Camera = xrView?.eye ?? camera;
    const sortCamera: THREE.Camera = xrView?.head ?? camera;
    if (xrView) _viewSize.set(xrView.width, xrView.height);
    else renderer.getDrawingBufferSize(_viewSize);
    this.writeViewUniforms(projectionCamera, _viewSize.x, _viewSize.y, sortCamera);
    this.writeSourceCameras(sortCamera);

    const sortStartedAt = performance.now();
    if (contentChanged) this.sortScheduler.invalidateContent();
    timings.sortSubmitted = this.requestSortIfNeeded(sortCamera, projectionCamera);
    timings.sortSubmitMs = performance.now() - sortStartedAt;
    timings.sortSubmissions = this.sorter?.submissionCount ?? 0;
    timings.sourceCount = this.sources.length;
    timings.activeCount = this.lastCaptureCount;
    timings.instanceCount = (this.geometry as THREE.InstancedBufferGeometry).instanceCount;
    timings.lastSortLatencyMs = this.sorter?.lastLatencyMs ?? Number.NaN;
    timings.totalMs = performance.now() - startedAt;
  }

  /**
   * Draws the current combined order into `target` from another camera. The
   * worker order is asynchronous, so a secondary view draws through the
   * primary order rather than re-sorting (the documented WebGL2 behaviour of
   * standalone meshes). Returns `false` when nothing is published yet.
   */
  renderView(
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGPURenderer,
    target: THREE.RenderTarget | null = null,
  ): boolean {
    if (this.disposed) return false;
    if (renderer !== this.renderer) {
      throw new Error('PooledUnifiedSplatMesh: renderView must use its construction renderer.');
    }
    if ((this.geometry as THREE.InstancedBufferGeometry).instanceCount === 0) return false;
    camera.updateMatrixWorld();
    const restore = this.captureView();
    if (target) this.writeViewUniforms(camera, target.width, target.height);
    else {
      renderer.getDrawingBufferSize(_viewSize);
      this.writeViewUniforms(camera, _viewSize.x, _viewSize.y);
    }
    // Source stacks read the camera in each source's frame; the primary
    // values come back with the rest of the view uniforms below.
    const sourceCameras = this.tables.snapshotCameraLocal();
    this.writeSourceCameras(camera);
    const previousTarget = renderer.getRenderTarget();
    const wasVisible = this.visible;
    try {
      this.visible = true;
      renderer.setRenderTarget(target);
      renderer.render(this, camera);
    } finally {
      this.visible = wasVisible;
      renderer.setRenderTarget(previousTarget);
      restore();
      this.tables.restoreCameraLocal(sourceCameras);
    }
    return true;
  }

  /**
   * Picks the frontmost visible splat under an NDC coordinate across every
   * drawn source, through each source's own depth-tested pick pass.
   */
  async pick(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    options?: SplatPickOptions,
  ): Promise<UnifiedSplatPickResult | null> {
    if (this.disposed) return null;
    const candidates = this.sources.filter(
      (record) => record.visible && record.drawMask && record.opacity > 0,
    );
    if (candidates.length === 0) return null;
    const hits = await Promise.all(
      candidates.map(async (record) => {
        const opacity = record.opacity;
        const hit = await record.source.pick(ndc, camera, this.renderer, {
          ...options,
          alphaThreshold: (options?.alphaThreshold ?? 0.1) / opacity,
        });
        return hit === null ? null : { record, opacity, hit };
      }),
    );
    if (this.disposed) return null;
    let best: UnifiedSplatPickResult | null = null;
    for (const result of hits) {
      if (result === null) continue;
      const { record, opacity, hit } = result;
      if (!this.sources.includes(record) || !record.visible || record.opacity !== opacity) continue;
      if (best === null || hit.distance < best.distance) {
        best = { source: record.source, point: hit.point, distance: hit.distance };
      }
    }
    return best;
  }

  /** Whether a primary draw has rendered the latest installed publication. */
  getDrawPublicationSnapshot(): UnifiedDrawPublicationSnapshot {
    const installed = this.installed;
    const instanceCount = (this.geometry as THREE.InstancedBufferGeometry).instanceCount;
    return {
      ready:
        installed !== null &&
        this.renderedPublicationRevision === installed.revision &&
        installed.count > 0 &&
        instanceCount === installed.count,
      publicationRevision: this.publicationRevision,
      renderedPublicationRevision: this.renderedPublicationRevision,
      contentRevision: this.publicationRevision,
      orderRevision: this.publicationRevision,
      sourceCount: this.sources.length,
      activeCount: installed?.count ?? 0,
      instanceCount,
      computeProjection: false,
    };
  }

  override onAfterRender(
    _renderer: WebGLRenderer,
    _scene: THREE.Scene,
    _camera: THREE.Camera,
  ): void {
    if (this.disposed) return;
    const acks = this.renderAcks;
    if (acks.length > 0) this.renderAcks = [];
    const installed = this.installed;
    const firstRender = installed !== null && !installed.rendered;
    if (installed !== null && firstRender) {
      installed.rendered = true;
      this.renderedPublicationRevision = installed.revision;
    }
    if (!firstRender && acks.length === 0) return;
    // Sources learn of the rendered frame off the render traversal, as the
    // compute path does, so a streamed source may continue its staged swap.
    queueMicrotask(() => {
      if (this.disposed) return;
      if (firstRender && installed !== null && this.installed === installed) {
        for (const part of installed.parts) {
          if (this.sources.includes(part.record)) {
            part.record.source.notifyUnifiedPublication(part.activeListVersion);
          }
        }
      }
      for (const ack of acks) {
        if (this.sources.includes(ack.record)) {
          ack.record.source.notifyUnifiedPublication(ack.activeListVersion);
        }
      }
    });
  }

  /** Releases every source back to its standalone draw and frees the draw resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.sources) this.detachRecord(record);
    this.sources.length = 0;
    this.sorter?.dispose();
    this.sorter = null;
    this.retainedParts = null;
    this.inFlight = null;
    this.pending = null;
    this.installed = null;
    this.renderAcks = [];
    this.geometry.dispose();
    (this.material as THREE.Material).dispose();
  }

  // --- internals ---

  private assertNotDisposed(method: string): void {
    if (this.disposed) throw new Error(`PooledUnifiedSplatMesh.${method}: mesh was disposed.`);
  }

  private recordOf(source: SplatMesh): SourceRecord {
    const record = this.sources.find((entry) => entry.source === source);
    if (!record) throw new Error('PooledUnifiedSplatMesh: source is not registered.');
    return record;
  }

  private allocateId(): number {
    const reused = this.freeIds.pop();
    if (reused !== undefined) return reused;
    if (this.nextId >= this.maxSources) {
      throw new Error(`PooledUnifiedSplatMesh: source limit reached (${this.maxSources}).`);
    }
    const id = this.nextId++;
    if (id >= this.tables.capacity) {
      // Tables are sized to the live count; growing replaces the uniform
      // arrays, so the material binds the new ones on its next build.
      this.tables = PooledSourceTables.grownFrom(
        this.tables,
        PooledSourceTables.capacityFor(id + 1, this.maxSources),
      );
      this.materialDirty = true;
    }
    return id;
  }

  /** Camera position in every source's local frame, for source stacks. */
  private writeSourceCameras(camera: THREE.Camera): void {
    camera.getWorldPosition(_cameraWorld);
    for (const record of this.sources) {
      this.tables.setCameraLocal(record.id, _cameraWorld, record.lastMatrix);
    }
  }

  private detachRecord(record: SourceRecord): void {
    record.publication.release();
    record.source.visible = record.originalVisible;
    record.source.setUnifiedPickVisibility(null);
    this.tables.setOpacity(record.id, 0);
    // The installed order may still name this id; keep it out of reuse until
    // the next publication replaces that order.
    this.quarantinedIds.push(record.id);
  }

  /**
   * Membership (which sources' splats belong in the combined list) changed:
   * an in-flight order would draw a stale set, and a pending one too.
   */
  private noteMembershipChange(): void {
    this.membership++;
    // Source ids can be reassigned after a removal; never reuse a list built
    // under the previous membership.
    this.retainedParts = null;
    if (this.pending !== null) {
      for (const part of this.pending.parts) part.record.publication.discard();
      this.pending = null;
    }
    this.sortScheduler.invalidateContent();
  }

  /** Captures and publishes a source that contributes nothing to the draw list. */
  private publishUndrawn(
    record: SourceRecord,
    view: UnifiedSourceView,
    renderer: THREE.WebGPURenderer,
  ): void {
    const { publication } = record;
    const capture = publication.capture();
    // `null`: an earlier capture of this source is still in a worker cycle
    // (it was drawn when captured); that cycle publishes it.
    if (capture === null || !publication.queue(capture.requestId)) return;
    record.capturedActiveListVersion = view.activeListVersion;
    record.capturedContentRevision = view.contentRevision;
    if (publication.publish(renderer)) {
      this.renderAcks.push({ record, activeListVersion: view.activeListVersion });
    }
  }

  private writeShRange(record: SourceRecord, view: UnifiedSourceView): void {
    // Packed SH dequantizes over each source's own range; `min = max = 0`
    // contributes no SH term (sources without packed SH in an SH pool).
    const sh = view.sh;
    if (sh !== null && sh.mode === 'packed') {
      this.tables.setShRange(record.id, sh.range.min.value, sh.range.max.value);
    } else {
      this.tables.setShRange(record.id, null, null);
    }
  }

  private writeViewUniforms(
    camera: THREE.Camera,
    viewportX: number,
    viewportY: number,
    positionCamera: THREE.Camera = camera,
  ): void {
    this.viewport.value.set(viewportX, viewportY);
    updateSplatFrustumMargin(
      this.viewport.value,
      this.frustumMargin.value,
      this.settings?.minSplatSizePx ?? 0,
    );
    const projection = camera.projectionMatrix.elements;
    this.focal.value.set((projection[0] * viewportX) / 2, (projection[5] * viewportY) / 2);
    // This mesh is at identity, so the local camera position is the world one.
    positionCamera.getWorldPosition(this.localCameraPosition.value);
  }

  private captureView(): () => void {
    const viewport = this.viewport.value.clone();
    const focal = this.focal.value.clone();
    const margin = this.frustumMargin.value.clone();
    const position = this.localCameraPosition.value.clone();
    return () => {
      this.viewport.value.copy(viewport);
      this.focal.value.copy(focal);
      this.frustumMargin.value.copy(margin);
      this.localCameraPosition.value.copy(position);
    };
  }

  private requestSortIfNeeded(sortCamera: THREE.Camera, projectionCamera: THREE.Camera): boolean {
    let total = 0;
    for (const record of this.sources) {
      if (record.visible && record.opacity > 0 && record.view !== null) {
        total += record.view.activeCount;
      }
    }
    if (total === 0) {
      // Nothing to draw: drop the installed order rather than keep drawing
      // sources that have since emptied or hidden.
      if (this.installed !== null && this.pending === null && this.inFlight === null) {
        this.installOrder([], new Float32Array(0), new Uint8Array(0));
      }
      return false;
    }
    const modelView = sortCamera.matrixWorldInverse;
    const sortState =
      this.sortMetric === 'radial'
        ? radialSortState(_identity, sortCamera.matrixWorld, _sortState)
        : modelView;
    // One request in flight, and none while a finished order awaits
    // publication. Re-sort when the camera's sort key moved or content changed.
    if (this.inFlight !== null || this.pending !== null) return false;
    if (!this.sortScheduler.hasPendingForce() && sortState.equals(this.lastSortedState)) {
      return false;
    }
    const sorter = (this.sorter ??= new PooledSorter(
      this.pool.capacity,
      this.pool.backing.centers,
      this.sortMetric,
      (requestId, order, orderSources) => this.onOrderReady(requestId, order, orderSources),
      (requestId) => this.onSortFailure(requestId),
    ));
    if (sorter.busy) return false;
    const capture = this.capture(sorter);
    if (capture === null) return false;
    sorter.write(capture.centerWrites);
    sorter.sort(
      capture.requestId,
      modelView,
      this.tables.matrices,
      this.bounds,
      cameraVisibleSortRange(projectionCamera, this.sortMetric, this.viewport.value),
      capture.list,
    );
    this.lastSortedState.copy(sortState);
    this.sortScheduler.markAccepted(0);
    return true;
  }

  /**
   * One combined capture across every drawn source: each source's pending rows
   * plus, unless the worker already holds the identical list, the concatenated
   * active indices and their source ids.
   */
  private capture(sorter: PooledSorter): {
    requestId: number;
    centerWrites: { start: number; centers: Float32Array }[];
    list?: { indices: Uint32Array; indexSources: Uint8Array };
  } | null {
    const drawn: SourceRecord[] = [];
    for (const record of this.sources) {
      const view = record.view;
      if (record.visible && record.opacity > 0 && view !== null && view.activeCount > 0) {
        drawn.push(record);
      }
    }
    // Same drawn sources at the same versions as the list the worker holds:
    // send no indices and let the worker sort its retained list again.
    const retained = this.retainedParts;
    const reuse =
      retained !== null &&
      sorter.retainsIndices &&
      retained.length === drawn.length &&
      retained.every((entry, i) => {
        const record = drawn[i] as SourceRecord;
        const view = record.view as UnifiedSourceView;
        return (
          entry.record === record &&
          entry.activeListVersion === view.activeListVersion &&
          entry.contentRevision === view.contentRevision
        );
      });
    const parts: CapturePart[] = [];
    const centerWrites: { start: number; centers: Float32Array }[] = [];
    let total = 0;
    for (const record of drawn) {
      const view = record.view as UnifiedSourceView;
      const snapshot = record.publication.capture();
      if (snapshot === null) {
        // A source could not capture (its own boundary is busy). Release the
        // others so none of them holds a snapshot nobody will publish.
        for (const part of parts) part.record.publication.restore(part.requestId);
        return null;
      }
      parts.push({
        record,
        requestId: snapshot.requestId,
        activeListVersion: view.activeListVersion,
        // The live list, read in this same synchronous pass: one copy below.
        indices: (view.sourceIndex.array as Uint32Array).subarray(0, view.activeCount),
      });
      record.capturedActiveListVersion = view.activeListVersion;
      record.capturedContentRevision = view.contentRevision;
      for (const row of snapshot.centerWrites) centerWrites.push(row);
      total += view.activeCount;
    }
    let list: { indices: Uint32Array; indexSources: Uint8Array } | undefined;
    if (!reuse) {
      // Built fresh and handed to the worker by transfer; it keeps them.
      const indices = new Uint32Array(total);
      const indexSources = new Uint8Array(total);
      let cursor = 0;
      for (const part of parts) {
        indices.set(part.indices, cursor);
        indexSources.fill(part.record.id, cursor, cursor + part.indices.length);
        cursor += part.indices.length;
      }
      list = { indices, indexSources };
      this.retainedParts = parts.map((part) => ({
        record: part.record,
        activeListVersion: part.activeListVersion,
        contentRevision: part.record.capturedContentRevision,
      }));
    }
    // Rows written before a source joined: resend their centers so the worker
    // mirror matches the pool backing it sorts from.
    const width = SPLAT_DATA_TEXTURE_WIDTH;
    for (const row of this.pendingMirrorRows) {
      const start = row.start * width * 4;
      const end = (row.start + row.count) * width * 4;
      centerWrites.push({
        start: row.start * width,
        centers: this.pool.backing.centers.slice(start, end),
      });
    }
    this.pendingMirrorRows = [];
    const requestId = ++this.nextRequestId;
    this.inFlight = { requestId, parts, membership: this.membership };
    this.lastCaptureCount = total;
    return list ? { requestId, centerWrites, list } : { requestId, centerWrites };
  }

  private nextRequestId = 0;

  private onOrderReady(requestId: number, order: Float32Array, orderSources: Uint8Array): void {
    const inFlight = this.inFlight;
    if (inFlight === null || inFlight.requestId !== requestId || this.disposed) return;
    this.inFlight = null;
    if (inFlight.membership !== this.membership) {
      for (const part of inFlight.parts) part.record.publication.restore(part.requestId);
      this.sortScheduler.invalidateContent();
      return;
    }
    let complete = true;
    for (const part of inFlight.parts) {
      if (!part.record.publication.queue(part.requestId)) complete = false;
    }
    if (!complete) {
      // Some source dropped its capture (strategy change, dispose): its rows
      // would be missing under this order. Discard the whole publication.
      for (const part of inFlight.parts) part.record.publication.discard();
      this.sortScheduler.invalidateContent();
      return;
    }
    this.pending = { parts: inFlight.parts, order, orderSources };
  }

  private onSortFailure(requestId: number): void {
    const inFlight = this.inFlight;
    if (inFlight === null || inFlight.requestId !== requestId) return;
    this.inFlight = null;
    for (const part of inFlight.parts) part.record.publication.restore(part.requestId);
    this.retainedParts = null;
    this.sortScheduler.invalidateContent();
  }

  /** Uploads every captured source row, then installs the matching order. */
  private publishPending(renderer: THREE.WebGPURenderer): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    const published: { record: SourceRecord; activeListVersion: number }[] = [];
    for (const part of pending.parts) {
      if (part.record.publication.publish(renderer)) {
        published.push({ record: part.record, activeListVersion: part.activeListVersion });
      }
    }
    this.installOrder(published, pending.order, pending.orderSources);
  }

  private installOrder(
    parts: readonly { record: SourceRecord; activeListVersion: number }[],
    order: Float32Array,
    orderSources: Uint8Array,
  ): void {
    const count = order.length;
    const indexes = this.splatIndexAttribute.array as Float32Array;
    const ids = this.sourceIdAttribute.array as Float32Array;
    indexes.set(order, 0);
    ids.set(orderSources, 0);
    this.splatIndexAttribute.clearUpdateRanges();
    this.sourceIdAttribute.clearUpdateRanges();
    if (count > 0) {
      this.splatIndexAttribute.addUpdateRange(0, count);
      this.sourceIdAttribute.addUpdateRange(0, count);
    }
    this.splatIndexAttribute.needsUpdate = true;
    this.sourceIdAttribute.needsUpdate = true;
    (this.geometry as THREE.InstancedBufferGeometry).instanceCount = count;
    this.installed = { parts, count, revision: ++this.publicationRevision, rendered: false };
    // Ids the old order still named are free again.
    for (const id of this.quarantinedIds) this.freeIds.push(id);
    this.quarantinedIds = [];
  }

  private rebuildMaterial(): void {
    const settings = this.settings;
    if (settings === null) return;
    // Per-source terms, all keyed by the instance's source id and built here
    // so the shared material graph only needs its generic hooks.
    const sourceId = asNode<'int'>(attribute<'float'>(SOURCE_ID_ATTRIBUTE, 'float').toInt());
    const tables = this.tables;
    const dataBase = sourceId.mul(SOURCE_DATA_ROWS);
    const dataRow = (row: number) => asNode<'vec4'>(tables.dataNode.element(dataBase.add(row)));
    // Display opacity times the per-view draw mask (setSourceDrawMask).
    const params = dataRow(ROW_PARAMS);
    const opacity = asNode<'float'>(asNode<'float'>(params.x).mul(asNode<'float'>(params.z)));
    const sourceStacks = createSourceStacksModifier({
      groups: groupSourceStacks(this.sources),
      sourceId,
      columns: tables.columnsNode,
      data: tables.dataNode,
    });
    // Whole-source opacity, last in the stack (as the compute path applies it
    // after each source's own effects); `<= 0` drops the splat outright.
    const sourceOpacity: SplatModifier = (ctx) => ({
      color: asNode<'vec4'>(vec4(ctx.color.rgb, ctx.color.a.mul(opacity))),
      visible: asNode<'bool'>(ctx.visible.and(opacity.greaterThan(0))),
    });
    const sh: SplatShInputs | null =
      this.pool.packedShBands !== 0
        ? {
            mode: 'packed',
            bands: this.pool.packedShBands,
            textures: this.pool.shPackedTextures,
            range: {
              min: asNode<'vec3'>(dataRow(ROW_SH_MIN).xyz) as unknown as Vec3Uniform,
              max: asNode<'vec3'>(dataRow(ROW_SH_MAX).xyz) as unknown as Vec3Uniform,
            },
          }
        : null;
    const inputs: SplatMaterialBuildInputs = {
      textures: {
        centersTexture: this.pool.centersTexture,
        colorsTexture: this.pool.colorsTexture,
        covarianceATexture: this.pool.covarianceATexture,
        covarianceBTexture: this.pool.covarianceBTexture,
      },
      sh,
      sourcePlacement: { sourceId, columns: tables.columnsNode },
      lodAlphaScale: asNode<'float'>(dataRow(ROW_PARAMS).y),
      displayColorModifier: this.displayColorModifierValue,
      uniforms: {
        focal: this.focal,
        viewport: this.viewport,
        frustumMargin: this.frustumMargin,
        localCameraPosition: this.localCameraPosition,
        pixelScaleLimit: this.pixelScaleLimit,
        revealMultiplier: this.revealMultiplier,
        dofFocusDistance: this.dofFocusDistance,
        dofAperture: this.dofAperture,
        screenBandMin: this.screenBandMin,
        screenBandMax: this.screenBandMax,
      },
      pick: null,
      settings: {
        maxStdDev: settings.maxStdDev,
        minSplatSizePx: settings.minSplatSizePx,
        antialias: settings.antialias,
        projectedFilterProfile: settings.projectedFilterProfile,
        srgbOutput: this.srgbOutput,
        // Explicit culls carry the sources' resolved values; the profile itself
        // must not add any on top.
        performanceProfile: 'quality',
        minPixelSize: settings.minPixelSize,
        minContribution: settings.minContribution,
        // Streamed cuts already selected their splats; no band or frontier
        // cull runs in a unified draw (the compute path gathers none either).
        foveationMode: 'page-table',
        // Always on: `lodAlphaScale` decides per source whether the stored
        // alpha is halved, and a plain source through this path reproduces
        // the Gaussian.
        lodAlpha: true,
      },
      channels: new Map(),
      // Source stacks first (each in its source's frame, as the compute path
      // gathers them), then the mesh's own drawn-frame stack, then opacity.
      modifiers: [...(sourceStacks ? [sourceStacks] : []), ...this.modifierList, sourceOpacity],
    };
    applySplatMaterialGraph(this.material as THREE.NodeMaterial, 'display', inputs);
    (this.material as THREE.Material).needsUpdate = true;
    this.materialBuilt = true;
    this.materialDirty = false;
    this.materialRevision++;
    this.builtShBands = this.pool.packedShBands;
  }
}
