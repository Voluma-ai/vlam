import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { ComputeSorter, releaseRendererAttributes } from '../core/compute-sorter';
import { RadixSorter } from '../core/radix-sorter';
import { clampDepthOfFieldSettings, type DepthOfFieldSettings } from '../core/depth-of-field';
import { SplatMesh } from '../core/splat-mesh';
import type { SplatPickOptions, SplatPickResult, UnifiedSourceView } from '../core/splat-mesh';
import { isFillConstrainedSplatDevice } from '../core/splat-budget';
import { WebGpuSortScheduler } from '../core/sort-scheduler';
import { WorkBuffer, WorkBufferGather } from './work-buffer-gather';
import { createWorkBufferMaterial } from './work-buffer-material';
import type { DisplayColorModifier, FloatUniform, Vec2Uniform } from '../core/splat-mesh-material';
import { assertStorageBufferFitsDevice } from '../core/webgpu-limits';
import { estimateLargestStorageBufferBytes } from './unified-work-buffer';
import { resolveXrView } from '../core/xr-view';
import { StorageMirrorReleaser } from '../core/storage-attribute-mirror';
import type { SplatSorter } from '../core/sorter';
import type { SplatSortMetric } from '../core/splat-mesh-types';
import { cameraVisibleSortRange, radialSortState } from '../core/splat-sort-bounds';

interface SourceRecord {
  source: SplatMesh;
  gather: WorkBufferGather;
  graphRevision: number;
  priority: number;
  opacity: number;
  visible: boolean;
  /** Whether modifier uniforms are host-invalidated instead of assumed live. */
  cacheModifiers: boolean;
  originalVisible: boolean;
  lastGather: {
    activeCount: number;
    contentRevision: number;
    offset: number;
    opacity: number;
    matrixWorld: THREE.Matrix4;
    /** Local camera position used by view-dependent SH evaluation. */
    localCameraPosition: THREE.Vector3;
  } | null;
  /** Per-prepare scratch: the source view snapshot for the current frame. */
  view: UnifiedSourceView | null;
  /** Per-prepare scratch: registration index for stable priority ordering. */
  registrationOrder: number;
  /** Per-prepare scratch: this frame's admitted work-buffer offset. */
  offset: number;
}

/** One admitted source's work-buffer ownership from a prepared frame. */
interface LayoutEntry {
  source: SplatMesh;
  offset: number;
  activeCount: number;
}

/** Registration settings for one source in a {@link UnifiedSplatMesh}. */
export interface UnifiedSplatSourceOptions {
  /** Whole-source display opacity applied after gather falloff. Defaults to `1`.
   * Does not change RAD LOD classification or splat shape. */
  opacity?: number;
  /** Whether this source contributes to the unified draw. Defaults to `true`. */
  visible?: boolean;
  /** Higher values survive a fixed work-buffer overflow first. Defaults to `0`. */
  priority?: number;
  /**
   * Cache a modifier-bearing source until {@link UnifiedSplatMesh.invalidateSource}
   * is called. Defaults to `false`, which safely re-gathers live modifier
   * uniforms every frame.
   *
   * Use this for static modifiers, or when the host has a natural dirty signal
   * for every uniform/channel mutation. Forgetting to invalidate leaves the
   * unified work-buffer output stale.
   */
  cacheModifiers?: boolean;
}

/**
 * Result of a successful {@link UnifiedSplatMesh.pick}: the frontmost hit
 * across every visible registered source, tagged with the source it landed on.
 */
export interface UnifiedSplatPickResult extends SplatPickResult {
  /** The registered source mesh whose splat produced the winning hit. */
  readonly source: SplatMesh;
}

/**
 * Construction settings shared by every source in a unified renderer.
 *
 * @experimental May change in a minor release.
 */
export interface UnifiedSplatMeshOptions {
  /** Composite source colors in display (sRGB) space. Defaults to `false`. */
  srgbOutput?: boolean;
  /**
   * Global depth-sort strategy. `'radix'` provides stable quantized ordering,
   * while `'exact'` preserves every Float32 depth bit through the same stable
   * radix pipeline. `'counting'` remains the lower-cost default.
   *
   * @experimental Exact sorting trades two additional radix passes for better
   * ordering in large scenes with dense foliage or overlapping surfaces.
   */
  sortStrategy?: 'counting' | 'radix' | 'exact';
  /**
   * Camera-space key used for global ordering. Defaults to `'depth'` for
   * compatibility; `'radial'` matches Spark's rotation-invariant ordering.
   */
  sortMetric?: SplatSortMetric;
}

/**
 * Returns true when `renderer` can drive {@link UnifiedSplatMesh}.
 * Heterogeneous gather/sort/draw is WebGPU-only; WebGL2 hosts keep standalone
 * `SplatMesh` draws or static {@link MergedSplatMesh}.
 */
export function supportsUnifiedSplatMesh(renderer: object): boolean {
  return (
    (renderer as { backend?: { isWebGPUBackend?: boolean } }).backend?.isWebGPUBackend === true
  );
}

/**
 * One gather → global-sort → draw path for static and streamed splat sources.
 * Sources retain their own residency and update lifecycle; this mesh gathers
 * their current active pool ranges into one shared work buffer per frame.
 *
 * The unified mesh stays at identity (`matrixAutoUpdate` is off). Pose each
 * registered source mesh instead - sorter bounds and the draw material both
 * consume world-space centers written by gather.
 *
 * WebGPU only. Prefer {@link supportsUnifiedSplatMesh} before construction.
 *
 * @experimental May change in a minor release.
 */
export class UnifiedSplatMesh extends THREE.Mesh {
  private readonly workBuffer: WorkBuffer;
  private readonly workSourceIndex: THREE.StorageBufferAttribute;
  /** The sorted draw-order buffer; lives outside the geometry, freed on dispose. */
  private readonly orderAttribute: THREE.StorageInstancedBufferAttribute;
  /**
   * Frees the JS mirrors three keeps behind `workSourceIndex` and `order`.
   *
   * `workSourceIndex` is an identity ramp written once at construction; `order`
   * is written only by the sorter, on the GPU. Neither is ever read back, so
   * both mirrors are 4 B/slot of dead JS heap once uploaded.
   */
  private readonly mirrors: StorageMirrorReleaser;
  private readonly sorter: SplatSorter;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly sources: SourceRecord[] = [];
  private previousLayout: LayoutEntry[] = [];
  /** Previous layout keyed by source; kept in step with {@link previousLayout}. */
  private readonly previousLayoutBySource = new Map<SplatMesh, LayoutEntry>();
  /** Per-prepare scratch lists, reused so a steady frame allocates nothing. */
  private readonly candidateScratch: SourceRecord[] = [];
  private readonly admittedScratch: SourceRecord[] = [];
  private readonly drawingBufferSize = new THREE.Vector2();
  /** Reused target dimensions for secondary views; avoids per-view garbage. */
  private readonly secondaryViewSize = new THREE.Vector2();
  /**
   * Camera gating for the global sorter, mirroring the standalone
   * `SplatMesh.requestSortIfNeeded` path: an unchanged work buffer under a
   * stationary camera skips the whole-buffer re-sort. Content changes
   * (regather, layout change) force the next sort through the scheduler.
   */
  private readonly sortScheduler: WebGpuSortScheduler;
  /** Pose signature of the last accepted sort; starts unmatchable (zero scale). */
  private readonly lastSortedState = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly currentSortState = new THREE.Matrix4();
  /**
   * Total admitted splats in the last prepared frame. `removeSource` filters
   * {@link previousLayout} directly, so a tail source's removal can leave the
   * remaining entries identical - only this total betrays the shrink, and a
   * shrunk draw range must re-sort (the old permutation indexes past it).
   */
  private previousAdmittedTotal = 0;
  private readonly bounds = new THREE.Sphere();
  private readonly focal: Vec2Uniform;
  private readonly viewport: Vec2Uniform;
  private readonly maxStdDev: FloatUniform;
  private readonly minSplatSizePx: FloatUniform;
  private readonly antialias: FloatUniform;
  private readonly projectedLowPassVariance: FloatUniform;
  private readonly compensateProjectedLowPass: FloatUniform;
  private readonly dofFocusDistance: FloatUniform;
  private readonly dofAperture: FloatUniform;
  private displayColorModifierValue: DisplayColorModifier | null = null;
  private readonly srgbOutput: boolean;
  private readonly sortMetric: SplatSortMetric;
  private sourceMaxStdDev: number | null = null;
  private sourceAntialias: boolean | null = null;
  private sourceProjectedFilterProfile: 'default' | 'lcc' | null = null;
  private overflowedSourceCount = 0;
  private overflowedSplatCount = 0;
  private disposed = false;

  constructor(
    renderer: THREE.WebGPURenderer,
    capacity: number,
    options: UnifiedSplatMeshOptions = {},
  ) {
    if (!supportsUnifiedSplatMesh(renderer)) {
      throw new Error(
        'UnifiedSplatMesh requires a WebGPU backend (renderer.backend.isWebGPUBackend). ' +
          'On WebGL2 use standalone SplatMesh draws or static MergedSplatMesh.',
      );
    }
    // Fail before allocating StorageBufferAttributes that would trip a cryptic
    // CreateBindGroup validation error when the host left the 128 MiB default.
    assertStorageBufferFitsDevice(renderer, estimateLargestStorageBufferBytes(capacity), capacity);
    const workBuffer = new WorkBuffer(capacity);
    const focal = uniform(new THREE.Vector2());
    const viewport = uniform(new THREE.Vector2());
    const maxStdDev = uniform(3);
    const minSplatSizePx = uniform(0);
    const antialias = uniform(0);
    const projectedLowPassVariance = uniform(0.3);
    const compensateProjectedLowPass = uniform(0);
    const dofFocusDistance = uniform(10);
    const dofAperture = uniform(0);
    const order = new THREE.StorageInstancedBufferAttribute(new Float32Array(capacity), 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    geometry.instanceCount = 0;
    super(
      geometry,
      createWorkBufferMaterial({
        capacity,
        centers: workBuffer.centers,
        colors: workBuffer.colors,
        covarianceA: workBuffer.covarianceA,
        covarianceB: workBuffer.covarianceB,
        isotropicMix: workBuffer.isotropicMix,
        isotropicScreenRadius: workBuffer.isotropicScreenRadius,
        order,
        focal,
        viewport,
        maxStdDev,
        minSplatSizePx,
        antialias,
        projectedLowPassVariance,
        compensateProjectedLowPass,
        dofFocusDistance,
        dofAperture,
        displayColorModifier: null,
      }),
    );
    const indices = new Uint32Array(capacity);
    for (let i = 0; i < capacity; i++) indices[i] = i;
    this.workBuffer = workBuffer;
    this.focal = focal;
    this.viewport = viewport;
    this.maxStdDev = maxStdDev;
    this.minSplatSizePx = minSplatSizePx;
    this.antialias = antialias;
    this.projectedLowPassVariance = projectedLowPassVariance;
    this.compensateProjectedLowPass = compensateProjectedLowPass;
    this.dofFocusDistance = dofFocusDistance;
    this.dofAperture = dofAperture;
    this.srgbOutput = options.srgbOutput ?? false;
    this.sortMetric = options.sortMetric ?? 'depth';
    this.sortScheduler = new WebGpuSortScheduler(undefined, isFillConstrainedSplatDevice());
    this.orderAttribute = order;
    this.workSourceIndex = new THREE.StorageBufferAttribute(indices, 1);
    this.mirrors = new StorageMirrorReleaser([this.workSourceIndex, this.orderAttribute]);
    this.renderer = renderer;
    const sortInputs = {
      renderer,
      capacity,
      centersBuffer: workBuffer.centers,
      splatIndexAttribute: order,
      sourceIndexAttribute: this.workSourceIndex,
    };
    this.sorter =
      options.sortStrategy === 'radix' || options.sortStrategy === 'exact'
        ? new RadixSorter({
            ...sortInputs,
            exactDepth: options.sortStrategy === 'exact',
            sortMetric: this.sortMetric,
          })
        : new ComputeSorter({ ...sortInputs, sortMetric: this.sortMetric });
    this.frustumCulled = false;
    this.matrixAutoUpdate = false;
    this.matrix.identity();
    this.matrixWorld.identity();
  }

  /** Fixed work-buffer splat capacity chosen at construction. */
  get capacity(): number {
    return this.workBuffer.capacity;
  }

  /** Registers a source. The caller keeps ownership and may still query it. */
  addSource(source: SplatMesh, options: UnifiedSplatSourceOptions = {}): void {
    this.assertNotDisposed('addSource');
    if (this.sources.some((record) => record.source === source)) return;
    const view = source.getUnifiedSourceView();
    const resolvedVisible = options.visible ?? source.visible;
    if (view.hasSourcePlacement) {
      // The gather pass resolves one matrix per source (the mesh's
      // `matrixWorld`); it knows nothing about a pool's *inner* per-source
      // placement, so a nested scene would draw every one of its sources at
      // its pool-local position. Reject rather than draw it wrong.
      throw new Error(
        'UnifiedSplatMesh: a MergedSplatMesh is already a unified pool with its own global ' +
          'sort; add its sources individually, or draw the mesh directly.',
      );
    }
    if (view.srgbOutput !== this.srgbOutput) {
      throw new Error("UnifiedSplatMesh: every source must use the renderer's srgbOutput setting.");
    }
    if (this.sourceMaxStdDev === null) {
      this.sourceMaxStdDev = view.maxStdDev;
      this.maxStdDev.value = view.maxStdDev;
      this.minSplatSizePx.value = view.minSplatSizePx;
    } else if (this.sourceMaxStdDev !== view.maxStdDev) {
      throw new Error('UnifiedSplatMesh: every source must use the same maxStdDev setting.');
    } else if (this.minSplatSizePx.value !== view.minSplatSizePx) {
      throw new Error('UnifiedSplatMesh: every source must use the same minSplatSizePx setting.');
    }
    if (this.sourceAntialias === null) {
      this.sourceAntialias = view.antialias;
      this.antialias.value = view.antialias ? 1 : 0;
    } else if (this.sourceAntialias !== view.antialias) {
      throw new Error('UnifiedSplatMesh: every source must use the same antialias setting.');
    }
    if (this.sourceProjectedFilterProfile === null) {
      this.sourceProjectedFilterProfile = view.projectedFilterProfile;
      const lccProfile = view.projectedFilterProfile === 'lcc';
      this.projectedLowPassVariance.value = lccProfile ? 0.1 : 0.3;
      this.compensateProjectedLowPass.value = lccProfile ? 1 : 0;
    } else if (this.sourceProjectedFilterProfile !== view.projectedFilterProfile) {
      throw new Error('UnifiedSplatMesh: every source must use the same projected filter profile.');
    }
    this.sources.push({
      source,
      gather: this.createGather(view),
      graphRevision: view.graphRevision,
      priority: options.priority ?? 0,
      opacity: options.opacity ?? 1,
      visible: resolvedVisible,
      cacheModifiers: options.cacheModifiers ?? false,
      originalVisible: source.visible,
      lastGather: null,
      view: null,
      registrationOrder: 0,
      offset: 0,
    });
    source.visible = false;
    source.setUnifiedPickVisibility(resolvedVisible);
  }

  /**
   * Invalidates one registered source's cached gather output.
   *
   * Required after changing modifier uniforms or channels when that source was
   * registered with `cacheModifiers: true`. The following {@link update}
   * re-gathers the source and re-sorts because modifiers may move splats.
   * Returns `false` when the source is not registered.
   */
  invalidateSource(source: SplatMesh): boolean {
    this.assertNotDisposed('invalidateSource');
    const record = this.sources.find((candidate) => candidate.source === source);
    if (!record) return false;
    record.lastGather = null;
    return true;
  }

  /** Number of whole sources omitted in the most recent update due to capacity. */
  get droppedSourceCount(): number {
    return this.overflowedSourceCount;
  }

  /** Number of active splats omitted in the most recent update due to capacity. */
  get droppedSplatCount(): number {
    return this.overflowedSplatCount;
  }

  /**
   * Sets whole-source display opacity without rebuilding the gather pipeline.
   *
   * This scales the completed fragment after RAD merged-vs-leaf classification
   * and falloff. It must never alter LOD selection or splat shape; hosts such as
   * marker crossfades rely on that. Values `<= 0` skip drawing the source.
   */
  setSourceOpacity(source: SplatMesh, opacity: number): void {
    this.assertNotDisposed('setSourceOpacity');
    const record = this.sources.find((entry) => entry.source === source);
    if (!record) throw new Error('UnifiedSplatMesh: source is not registered.');
    record.opacity = opacity;
  }

  /** Shows or hides a source without changing its residency. */
  setSourceVisible(source: SplatMesh, visible: boolean): void {
    this.assertNotDisposed('setSourceVisible');
    const record = this.sources.find((entry) => entry.source === source);
    if (!record) throw new Error('UnifiedSplatMesh: source is not registered.');
    record.visible = visible;
    record.source.setUnifiedPickVisibility(visible);
  }

  /**
   * Core projected-2D depth of field on the unified draw pass (not gather).
   * Live uniforms - no gather-cache invalidation. Pass `aperture: 0` to disable.
   */
  setDepthOfField(settings: Partial<DepthOfFieldSettings>): void {
    this.assertNotDisposed('setDepthOfField');
    const next = clampDepthOfFieldSettings(settings, this.getDepthOfField());
    this.dofFocusDistance.value = next.focusDistance;
    this.dofAperture.value = next.aperture;
  }

  /** Current core DoF uniforms (`aperture === 0` means off). */
  getDepthOfField(): DepthOfFieldSettings {
    return {
      focusDistance: this.dofFocusDistance.value,
      aperture: this.dofAperture.value,
    };
  }

  /**
   * Optional RGB transform in the unified display draw. Replacing the callback
   * rebuilds the draw material only; gathered source data stays valid.
   */
  get displayColorModifier(): DisplayColorModifier | null {
    return this.displayColorModifierValue;
  }

  set displayColorModifier(modifier: DisplayColorModifier | null) {
    this.assertNotDisposed('displayColorModifier');
    if (modifier === this.displayColorModifierValue) return;
    this.displayColorModifierValue = modifier;
    this.rebuildDrawMaterial();
  }

  /**
   * Asynchronously picks the frontmost visible splat under an NDC coordinate
   * across every registered source.
   *
   * Semantics: each source that is
   * currently visible in this unified renderer runs its own depth-tested GPU
   * pick pass; the hit nearest the camera wins and the result names its source
   * mesh. Hidden sources (`setSourceVisible(source, false)`) never hit. A hit
   * whose source was removed, hidden, or disposed while its readback was in
   * flight is dropped rather than misattributed. Resolves `null` for misses,
   * an empty source list, and picks pending across {@link dispose}.
   *
   * Uses the construction renderer. Concurrent calls are safe: each source
   * serializes its own picks and shared renderer state is restored
   * synchronously before any await.
   */
  async pick(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    options?: SplatPickOptions,
  ): Promise<UnifiedSplatPickResult | null> {
    if (this.disposed) return null;
    const candidates = this.sources
      .filter((record) => record.visible)
      .map((record) => record.source);
    if (candidates.length === 0) return null;
    const hits = await Promise.all(
      candidates.map(async (source) => {
        const hit = await source.pick(ndc, camera, this.renderer, options);
        return hit === null ? null : { source, point: hit.point, distance: hit.distance };
      }),
    );
    if (this.disposed) return null;
    let best: UnifiedSplatPickResult | null = null;
    for (const hit of hits) {
      if (hit === null) continue;
      // Registration may have changed while the readbacks were in flight;
      // never attribute a hit to a source no longer picked by this renderer.
      const record = this.sources.find((entry) => entry.source === hit.source);
      if (record === undefined || !record.visible) continue;
      if (best === null || hit.distance < best.distance) best = hit;
    }
    return best;
  }

  /** Unregisters a source and restores its standalone draw visibility. */
  removeSource(source: SplatMesh): boolean {
    this.assertNotDisposed('removeSource');
    const index = this.sources.findIndex((entry) => entry.source === source);
    if (index < 0) return false;
    const [record] = this.sources.splice(index, 1);
    if (record) {
      record.gather.dispose();
      record.source.visible = record.originalVisible;
      record.source.setUnifiedPickVisibility(null);
      record.lastGather = null;
    }
    this.previousLayout = this.previousLayout.filter((entry) => entry.source !== source);
    this.previousLayoutBySource.delete(source);
    if (this.sources.length === 0) {
      this.sourceMaxStdDev = null;
      this.sourceAntialias = null;
      this.sourceProjectedFilterProfile = null;
      this.previousLayout = [];
      this.previousLayoutBySource.clear();
    }
    return true;
  }

  /** Updates source LODs, gathers their active splats, then globally sorts them. */
  update(camera: THREE.PerspectiveCamera): void {
    if (this.disposed) return;
    this.prepare(camera);
  }

  /**
   * Re-sorts and draws this unified source list for a secondary camera.
   * Mirrors and portals use this instead of rendering the hidden source meshes
   * individually, so their reflection keeps one global transparent order.
   */
  renderView(
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGPURenderer,
    target: THREE.RenderTarget | null = null,
  ): void {
    if (this.disposed) return;
    if (renderer !== this.renderer) {
      throw new Error('UnifiedSplatMesh: renderView must use its construction renderer.');
    }
    if (!supportsUnifiedSplatMesh(renderer)) {
      throw new Error(
        'UnifiedSplatMesh requires a WebGPU backend (renderer.backend.isWebGPUBackend).',
      );
    }
    // A secondary view must sort for its own camera regardless of cadence, and
    // it leaves a foreign order in the shared buffer - invalidate afterwards so
    // the next primary update re-sorts even if its camera has not moved.
    const targetSize = target ? this.secondaryViewSize.set(target.width, target.height) : undefined;
    this.prepare(camera, targetSize, true);
    const previousTarget = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(target);
      renderer.render(this, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      // `prepare` left the shared order buffer sorted for the secondary view.
      // Invalidate even when its draw throws, or a stationary primary view can
      // render through that foreign order after the host recovers.
      this.sortScheduler.invalidate();
    }
  }

  private prepare(
    camera: THREE.PerspectiveCamera,
    targetSize?: THREE.Vector2,
    forceSort = false,
  ): void {
    if (!supportsUnifiedSplatMesh(this.renderer)) {
      throw new Error(
        'UnifiedSplatMesh requires a WebGPU backend (renderer.backend.isWebGPUBackend).',
      );
    }
    // Hosts must not pose this mesh; world centers already include source transforms.
    this.matrix.identity();
    this.matrixWorld.identity();
    // A secondary view (`renderView`) states its own size and camera; the
    // primary one follows the renderer, which in XR means a *per-eye* viewport
    // and a cyclopean head pose. Taking the drawing buffer there would be twice
    // the true width and halve every splat's horizontal size, and sorting from
    // the application camera would order the scene from wherever that camera
    // was left standing.
    const xrView = targetSize ? null : resolveXrView(camera, this.renderer);
    const projectionCamera: THREE.Camera = xrView?.eye ?? camera;
    // One global sort from the head serves both eyes (see `xr-view.ts`).
    const viewCamera: THREE.Camera = xrView?.head ?? camera;
    const viewport = this.drawingBufferSize;
    if (targetSize) viewport.copy(targetSize);
    else if (xrView) viewport.set(xrView.width, xrView.height);
    else this.renderer.getDrawingBufferSize(viewport);
    const projection = projectionCamera.projectionMatrix.elements;
    this.viewport.value.copy(viewport);
    const focalX = projection[0] ?? 0;
    const focalY = projection[5] ?? 0;
    this.focal.value.set((focalX * viewport.x) / 2, (focalY * viewport.y) / 2);
    const updated = this.candidateScratch;
    updated.length = 0;
    for (let i = 0; i < this.sources.length; i++) {
      const record = this.sources[i] as SourceRecord;
      // Children take the application camera: they resolve the XR view for
      // themselves, and a streamed source needs it for LOD scheduling.
      record.source.update(camera, this.renderer, { sort: false });
      record.view = record.source.getUnifiedSourceView();
      record.registrationOrder = i;
      updated.push(record);
    }
    // Overflow is deterministic and region-safe: preserve whole sources rather
    // than gathering a prefix of a streamed cut. Higher priority wins; matching
    // priorities retain registration order.
    updated.sort((a, b) => b.priority - a.priority || a.registrationOrder - b.registrationOrder);

    this.overflowedSourceCount = 0;
    this.overflowedSplatCount = 0;
    this.bounds.makeEmpty();

    const admitted = this.admittedScratch;
    admitted.length = 0;
    let offset = 0;
    for (const record of updated) {
      const view = record.view as UnifiedSourceView;
      if (record.graphRevision !== view.graphRevision) {
        // Build the replacement before disposing the old pipeline: a modifier
        // stack that throws at graph-build time must leave the record holding
        // a live gather (and an unchanged revision) so the next update can
        // retry after the caller fixes the stack.
        const rebuilt = this.createGather(view);
        record.gather.dispose();
        record.gather = rebuilt;
        record.graphRevision = view.graphRevision;
        record.lastGather = null;
      }
      if (!record.visible) {
        record.lastGather = null;
        continue;
      }
      if (view.activeCount === 0) {
        // An empty cut (e.g. a streamed source before its first chunk lands)
        // owns no work slice: skip the zero-splat gather dispatch and keep the
        // sorter bounds limited to sources that contribute splats.
        record.lastGather = null;
        continue;
      }
      if (offset + view.activeCount > this.workBuffer.capacity) {
        this.overflowedSourceCount++;
        this.overflowedSplatCount += view.activeCount;
        record.lastGather = null;
        continue;
      }
      record.offset = offset;
      admitted.push(record);
      this.bounds.union(view.worldBounds);
      offset += view.activeCount;
    }

    // Geometry under the draw order changed (layout, active cut, transform,
    // opacity, content revision). Camera-only SH / modifier color refreshes
    // re-gather the *same* world centers and must not force a sort.
    let geometryInvalidated = false;
    for (const record of admitted) {
      const view = record.view as UnifiedSourceView;
      const sliceOffset = record.offset;
      const previous = this.previousLayoutBySource.get(record.source);
      const ownedSameSlice =
        previous !== undefined &&
        previous.offset === sliceOffset &&
        previous.activeCount === view.activeCount;
      const last = record.lastGather;
      const geometryMatches =
        last !== null &&
        ownedSameSlice &&
        last.activeCount === view.activeCount &&
        last.contentRevision === view.contentRevision &&
        last.offset === sliceOffset &&
        last.opacity === record.opacity &&
        last.matrixWorld.equals(view.matrixWorld);
      const reusable =
        geometryMatches &&
        // SH depends on camera position, not orientation. A stationary camera
        // can reuse the resolved colors instead of re-running a full-source
        // gather every frame; camera motion invalidates only SH-bearing slices.
        (view.sh === null || last.localCameraPosition.equals(view.localCameraPosition.value)) &&
        (view.modifiers.length === 0 || record.cacheModifiers) &&
        // Belt-and-braces: a placed pool's splats move without its own
        // `matrixWorld` changing, so a cached gather would go stale silently.
        // `addSource` already rejects these.
        !view.hasSourcePlacement;
      if (!reusable) {
        record.gather.gather(
          this.renderer,
          view.activeCount,
          sliceOffset,
          view.matrixWorld,
          viewCamera.matrixWorldInverse,
          record.opacity,
        );
        if (!geometryMatches) geometryInvalidated = true;
        if (record.lastGather === null) {
          record.lastGather = {
            activeCount: view.activeCount,
            contentRevision: view.contentRevision,
            offset: sliceOffset,
            opacity: record.opacity,
            matrixWorld: view.matrixWorld.clone(),
            localCameraPosition: view.localCameraPosition.value.clone(),
          };
        } else {
          record.lastGather.activeCount = view.activeCount;
          record.lastGather.contentRevision = view.contentRevision;
          record.lastGather.offset = sliceOffset;
          record.lastGather.opacity = record.opacity;
          record.lastGather.matrixWorld.copy(view.matrixWorld);
          record.lastGather.localCameraPosition.copy(view.localCameraPosition.value);
        }
      }
    }

    // Commit ownership only after every gather for this preparation has run.
    let layoutChanged =
      admitted.length !== this.previousLayout.length || offset !== this.previousAdmittedTotal;
    this.previousAdmittedTotal = offset;
    if (!layoutChanged) {
      for (let i = 0; i < admitted.length; i++) {
        const record = admitted[i] as SourceRecord;
        const entry = this.previousLayout[i] as LayoutEntry;
        if (
          entry.source !== record.source ||
          entry.offset !== record.offset ||
          entry.activeCount !== (record.view as UnifiedSourceView).activeCount
        ) {
          layoutChanged = true;
          break;
        }
      }
    }
    if (layoutChanged) {
      this.previousLayout = admitted.map((record) => ({
        source: record.source,
        offset: record.offset,
        activeCount: (record.view as UnifiedSourceView).activeCount,
      }));
      this.previousLayoutBySource.clear();
      for (const entry of this.previousLayout) this.previousLayoutBySource.set(entry.source, entry);
    }

    // Work-buffer *geometry* moved underneath the current draw order: the next
    // sort must run whatever the camera did. Camera-driven SH/modifier color
    // refreshes re-gather without geometryInvalidated and deliberately skip
    // this. DoF is a live draw uniform and reaches neither branch.
    if (geometryInvalidated || layoutChanged) this.sortScheduler.invalidateContent();

    if (offset > 0) {
      const now = performance.now();
      const viewInverse = viewCamera.matrixWorldInverse;
      const sortState =
        this.sortMetric === 'radial'
          ? radialSortState(this.matrixWorld, viewCamera.matrixWorld, this.currentSortState)
          : viewInverse;
      if (
        forceSort ||
        this.sortScheduler.shouldSubmit(sortState, this.lastSortedState, offset, now)
      ) {
        if (
          this.sorter.sort(
            viewInverse,
            offset,
            this.bounds,
            cameraVisibleSortRange(projectionCamera, this.sortMetric),
          )
        ) {
          this.lastSortedState.copy(sortState);
          this.sortScheduler.markAccepted(now);
        }
      }
    }
    (this.geometry as THREE.InstancedBufferGeometry).instanceCount = offset;
    // Both are uploaded by the first frame's gather/sort dispatches, and neither
    // is ever read back - see the field comment. The work buffer's own mirrors
    // are released by `WorkBufferGather.gather`.
    if (!this.mirrors.settled) this.mirrors.release(this.renderer);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.sources) {
      record.gather.dispose();
      record.source.visible = record.originalVisible;
      record.source.setUnifiedPickVisibility(null);
      record.lastGather = null;
    }
    this.sources.length = 0;
    this.previousLayout = [];
    this.previousLayoutBySource.clear();
    this.candidateScratch.length = 0;
    this.admittedScratch.length = 0;
    this.sourceMaxStdDev = null;
    this.sourceAntialias = null;
    this.sourceProjectedFilterProfile = null;
    this.sorter.dispose();
    this.geometry.dispose();
    (this.material as THREE.Material).dispose();
    // The work buffer, its source-index list and the draw-order buffer are
    // storage attributes outside the geometry, so nothing above frees their
    // GPU buffers - ~72 B per work slot leaked per scene swap without this.
    releaseRendererAttributes(this.renderer, [
      this.workBuffer.centers,
      this.workBuffer.colors,
      this.workBuffer.covarianceA,
      this.workBuffer.covarianceB,
      this.workBuffer.isotropicMix,
      this.workBuffer.isotropicScreenRadius,
      this.workSourceIndex,
      this.orderAttribute,
    ]);
  }

  private assertNotDisposed(operation: string): void {
    if (this.disposed) {
      throw new Error(`UnifiedSplatMesh: ${operation} called after dispose.`);
    }
  }

  /** Rebuilds the EWA draw material after a display-graph structural change. */
  private rebuildDrawMaterial(): void {
    const previous = this.material as THREE.Material;
    this.material = createWorkBufferMaterial({
      capacity: this.workBuffer.capacity,
      centers: this.workBuffer.centers,
      colors: this.workBuffer.colors,
      covarianceA: this.workBuffer.covarianceA,
      covarianceB: this.workBuffer.covarianceB,
      isotropicMix: this.workBuffer.isotropicMix,
      isotropicScreenRadius: this.workBuffer.isotropicScreenRadius,
      order: this.orderAttribute,
      focal: this.focal,
      viewport: this.viewport,
      maxStdDev: this.maxStdDev,
      minSplatSizePx: this.minSplatSizePx,
      antialias: this.antialias,
      projectedLowPassVariance: this.projectedLowPassVariance,
      compensateProjectedLowPass: this.compensateProjectedLowPass,
      dofFocusDistance: this.dofFocusDistance,
      dofAperture: this.dofAperture,
      displayColorModifier: this.displayColorModifierValue,
    });
    previous.dispose();
  }

  private createGather(view: ReturnType<SplatMesh['getUnifiedSourceView']>): WorkBufferGather {
    const gather = this.buildGather(view);
    // Compile off the critical frame. WebGPU defers compute-pipeline compilation
    // to the first dispatch, and that dispatch happens inside `update` - a
    // measured 2.0s frame on a multi-mesh scene. Warming here is best-effort:
    // if it fails or has not finished by the first real gather, the only cost is
    // the stall this avoids, so nothing waits on it.
    void gather.warmUp(this.renderer).catch(() => undefined);
    return gather;
  }

  private buildGather(view: ReturnType<SplatMesh['getUnifiedSourceView']>): WorkBufferGather {
    return new WorkBufferGather({
      capacity: this.workBuffer.capacity,
      sourceCapacity: view.capacity,
      sourceIndex: view.sourceIndex,
      centersTexture: view.centersTexture,
      colorsTexture: view.colorsTexture,
      covarianceATexture: view.covarianceATexture,
      covarianceBTexture: view.covarianceBTexture,
      dataTextureWidth: view.dataTextureWidth,
      sh: view.sh,
      modifiers: view.modifiers,
      channels: view.channels,
      localCameraPosition: view.localCameraPosition,
      srgbOutput: this.srgbOutput,
      // Per source, not a compatibility field: the gather normalizes `.rad`
      // half-alpha here so one shared draw material serves mixed scenes.
      lodAlpha: view.lodAlpha,
      workBuffer: this.workBuffer,
    });
  }
}
