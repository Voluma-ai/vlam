import {
  MAX_SH_BANDS,
  resolveSplatPerformanceProfile,
  type ProjectedFilterProfile,
  type SplatChannelOptions,
  type SplatChannelType,
  type SplatHeightResult,
  type SplatMeshOptions,
  type SplatNearestResult,
  type SplatPerformanceProfile,
  type SplatPickOptions,
  type SplatPickResult,
  type SplatRayResult,
  type SplatRange,
  type SplatSortStrategy,
  type SplatUpdateOptions,
  type UnifiedSourceView,
  resolveSplatFoveationMode,
  type SplatFoveationMode,
} from './splat-mesh-types';
export * from './splat-mesh-types';
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { SplatData } from './splat-data';
import { type SplatOrientation, yUpTransformForFormat } from './orientation';
import type { SplatModifier } from './splat-modifier';
import type { SplatSorter } from './sorter';
import {
  ComputeSorter,
  releaseRendererAttributes,
  type PerSourceSortTransform,
} from './compute-sorter';
import { WorkerSorter } from './worker-sorter';
import { WebGpuSortScheduler, validateSortIntervalMs } from './sort-scheduler';
import { detectSplatDeviceProfile } from './splat-budget';
import { encodeFloat32ToHalf } from './half-float';
import { SplatPicker } from './splat-mesh-picking';
import { clampDepthOfFieldSettings, type DepthOfFieldSettings } from './depth-of-field';
import {
  clampRelightingSettings,
  createPlaceholderRelightTexture,
  DEFAULT_RELIGHT_BACKGROUND,
  DEFAULT_RELIGHT_BRIGHTNESS,
  DEFAULT_RELIGHT_SOFTNESS,
  type RelightingSettings,
  type RelightingUniforms,
} from './relighting';
import {
  applySplatMaterialGraph,
  shCoefficientCount,
  vec3Uniform,
  type SplatMaterialBuildInputs,
  type SplatMaterialTextures,
  type SplatShInputs,
  type Vec3Uniform,
} from './splat-mesh-material';
import {
  neutralShWord as neutralShWordFor,
  packedRangesEqual,
  requantizeShWord,
  type ShRange,
} from './sh-pack';
import { UniformGrid } from './splat-query';
import { resolveXrView } from './xr-view';
import {
  SPLAT_DATA_TEXTURE_WIDTH,
  SplatPool,
  addMergedUpdateRange,
  allocateRowSpan,
  createDataTexture,
  deviceMaxTextureSize,
  releaseRowSpan,
  type SplatPoolBacking,
  type SplatPoolRange,
  type SplatPoolTenant,
} from './splat-mesh-pool';
import { warn } from './logging';

interface ChannelRecord {
  readonly type: SplatChannelType;
  /** Default value; rows are reset to it when {@link SplatMesh.appendRange} reuses them. */
  readonly fill: number;
  readonly backing: Uint8Array | Float32Array;
  readonly texture: THREE.DataTexture;
  readonly textureType: THREE.TextureDataType;
  /** Row spans written since the last flush, awaiting GPU upload. */
  pendingRows: { start: number; count: number }[];
}

/** Reusable GPU source texture for a same-layout pool upload. */
/** Number of exact-size upload textures retained per data channel. */
const UPLOAD_STAGING_CACHE_SIZE = 4;

interface RangeRecord {
  startRow: number;
  rowCount: number;
  /** First pool splat index (startRow · texture width). */
  start: number;
  count: number;
  active: boolean;
  /** When set, only the first `activePrefix` splats of the range participate in
   * the active (drawn/sorted) list - the rest stay allocated but invisible.
   * Used by the page-table slab, whose used slots are densely packed at the
   * front; drawing the full slab would sort and vertex-process every
   * degenerate tail slot each frame. Undefined = the whole range. */
  activePrefix?: number;
}

/**
 * Renders a set of 3D Gaussians with three.js's WebGPURenderer.
 *
 * Rendering technique: EWA splatting per the 3DGS paper (Kerbl et al.,
 * SIGGRAPH 2023). Each splat is an instanced quad; the vertex stage projects
 * the splat's 3D covariance to a screen-space ellipse (the same math used by
 * antimatter15/splat and PlayCanvas, both MIT) and the fragment stage applies
 * the Gaussian falloff. Shaders are written in TSL, so three.js compiles
 * them to WGSL on WebGPU and to GLSL on the automatic WebGL2 fallback.
 *
 * Splat data lives in pool data textures, indexed through one small
 * per-instance `splatIndex` attribute. Correct alpha blending needs
 * back-to-front ordering, so the indices are depth-sorted whenever the
 * camera moves - only that index buffer is rewritten, never the splat data
 * itself. On the WebGPU backend the sort runs in TSL compute passes
 * (`ComputeSorter`); the WebGL2 fallback uses a Web Worker (`WorkerSorter`).
 *
 * Two construction modes:
 *
 *  - `new SplatMesh(data)` - static: capacity equals the data's count and
 *    the whole scene is resident. Works on WebGPU and the WebGL2 fallback,
 *    including SOG view-dependent color (shN).
 *  - `new SplatMesh({ capacity })` - dynamic: an empty pool for up to
 *    `capacity` splats. Content is managed with {@link appendRange} /
 *    {@link removeRange} (ranges are row-aligned in the pool textures, so
 *    uploads are rectangular). This mode is the substrate for LOD
 *    streaming and works on both backends - the WebGL2 fallback sorts the
 *    active pool spans on the CPU. shN data on appended ranges is ignored
 *    (palettes are per-file and cannot be merged here).
 */
export class SplatMesh extends THREE.Mesh implements SplatPoolTenant {
  private static readonly DATA_TEXTURE_WIDTH = SPLAT_DATA_TEXTURE_WIDTH;

  /**
   * The storage this mesh draws from. Held rather than inlined because a
   * splat's draw identity is already independent of its pool slot (`splatIndex`
   * indirects every instance), so the pool is a separable concern - see
   * {@link SplatPool}.
   */
  private readonly pool: SplatPool;
  /** False when the pool was supplied by the caller, and so outlives this mesh. */
  private readonly ownsPool: boolean;
  private readonly splatIndexAttribute: THREE.StorageInstancedBufferAttribute;
  private readonly sourceIndexAttribute: THREE.StorageBufferAttribute;
  private dataTextures: readonly THREE.DataTexture[];

  /**
   * Pool index → this mesh's packed active-list slot. Lives on the pool: it is
   * keyed by pool index, so a per-mesh copy would span the whole pool and
   * several meshes sharing one would each pay for all of it. A row has one
   * owner at a time, so the single array is unambiguous.
   */
  private get activeSlotByPoolIndex(): Uint32Array {
    return this.pool.activeSlotByPoolIndex;
  }

  /** Rows in the pool backing this mesh. */
  private get poolRows(): number {
    return this.pool.rows;
  }
  private get centersTexture(): THREE.DataTexture {
    return this.pool.centersTexture;
  }
  private get backing(): SplatPoolBacking {
    return this.pool.backing;
  }
  private get freeRowSpans(): { start: number; count: number }[] {
    return this.pool.freeRowSpans;
  }
  private set freeRowSpans(spans: { start: number; count: number }[]) {
    this.pool.freeRowSpans = spans;
  }
  private get poolFloatTextures(): 'float32' | 'float16' {
    return this.pool.floatTextures;
  }
  /** Bands of per-splat (non-palette) SH this pool stores; 0 when disabled. */
  private get packedShBands(): 0 | 1 | 2 | 3 {
    return this.pool.packedShBands;
  }
  private get shPackedTextures(): readonly THREE.DataTexture[] {
    return this.pool.shPackedTextures;
  }

  /** True when constructed from a complete SplatData (single fixed range). */
  private readonly isStatic: boolean;
  /** Constructor-created range, retained for static in-place LOD replacement. */
  private staticRange: SplatRange | undefined;
  private readonly shEnabled: boolean;
  /**
   * Dequantization range for the packed SH, shared by every coefficient.
   * Uniforms rather than constants: the first chunk to arrive supplies it,
   * long after the material is built.
   */
  private readonly shRange: { min: Vec3Uniform; max: Vec3Uniform };
  /** Set once the first packed-SH chunk has supplied {@link shRange}. */
  private shRangeSet = false;
  /** Whether SH-less rows were neutral-filled before the scene range locked. */
  private wrotePreLockNeutralSh = false;

  private readonly ranges = new Map<SplatRange, RangeRecord>();
  private activeCount = 0;

  /**
   * Bumped whenever the resident splat set or its positions change (activate,
   * deactivate, compact) - the signal the lazy spatial-query grid rebuilds on.
   * A depth re-sort reorders the active list but changes neither, so it does
   * not bump this. See {@link queryNearest}.
   */
  private queryEpoch = 0;
  private queryGrid: UniformGrid | null = null;
  private queryGridEpoch = -1;

  /**
   * True when the shared depth-order buffer holds a *secondary* view's order
   * (left by {@link renderView}), so the next primary {@link update} must
   * re-sort even if its camera has not moved. See {@link renderView} (M10).
   */
  private orderIsForeign = false;
  /**
   * True while the draw list holds a CPU-worker depth permutation rather than
   * the identity active order. Active-list mutations must then resync the
   * whole drawn prefix instead of patching slots: patching a *permutation*
   * with identity active-list values creates duplicates and drops live splats
   * for every frame until the worker's next order lands (the WebGL2 streamed
   * flicker, ROADMAP L5).
   */
  private drawListSorted = false;
  /** CPU timings from the most recent render-preparation update (reset in place per frame). */
  private readonly updateTimings = {
    activeListMs: 0,
    uploadMs: 0,
    sortSubmitMs: 0,
    stagingTextureAllocations: 0,
    activeListUpdateRanges: 0,
  };
  // Protected so a unified {@link MergedSplatMesh} subclass can substitute a
  // world-space sort bound (see {@link refreshSortBounds}).
  protected readonly localBounds = new THREE.Box3().makeEmpty();
  protected readonly boundingSphereLocal = new THREE.Sphere();
  protected boundsDirty = true;
  /** Cached {@link getUnifiedSourceView} result; see the invalidation checks there. */
  private cachedUnifiedView: UnifiedSourceView | null = null;
  private readonly cachedUnifiedViewMatrixWorld = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly cachedUnifiedViewLocalBounds = new THREE.Sphere();
  private readonly cachedUnifiedViewWorldBounds = new THREE.Sphere();

  /** Row spans written since the last flush, awaiting GPU upload. */
  private pendingUploadRows: { start: number; count: number }[] = [];
  /** Row spans awaiting mirroring to the CPU sort worker (WebGL2 path). */
  private workerDirtyRows: { start: number; count: number }[] = [];
  /** Persistent copy sources avoid allocating four temporary textures per upload region. */
  private readonly uploadStaging = new Map<string, Map<number, THREE.DataTexture>>();
  /** Reusable float→half encode buffers keyed like {@link uploadStaging}. */
  private readonly halfEncodeBuffers = new Map<string, Uint16Array>();

  /** Opt-in per-splat channels by name; see {@link defineChannel}. */
  private readonly channels = new Map<string, ChannelRecord>();

  /** Created on the first update, when the renderer backend is known. */
  private sorter: SplatSorter | null = null;

  /**
   * Set by a unified {@link MergedSplatMesh} subclass before the first sort: makes
   * the WebGPU sorter transform each splat's center to world space by its
   * source's matrix before measuring depth. `null` for an ordinary mesh, whose
   * sorter is byte-identical to before. See `source-transform.ts`.
   */
  protected perSourceSort: PerSourceSortTransform | null = null;

  /** Effect hooks folded into the vertex graph; see {@link modifiers}. */
  private modifierList: SplatModifier[] = [];
  /** Increments when a unified gather must rebuild its source graph. */
  private graphRevision = 0;
  /** Version for unified work-buffer caching; source pool writes are observable. */
  private contentRevision = 0;
  /** Material-graph inputs kept for rebuilds when the modifier list changes. */
  private materialInputs!: {
    textures: SplatMaterialTextures;
    sh: SplatShInputs | null;
  };

  /** Projection focal lengths in pixels; updated every frame. */
  private readonly focal = uniform(new THREE.Vector2());
  /** Drawing-buffer size in pixels; updated every frame. */
  private readonly viewport = uniform(new THREE.Vector2());
  /** Camera position in this mesh's local space, for SH view dependence. */
  private readonly localCameraPosition = uniform(new THREE.Vector3());
  /**
   * Frontier-cut limit for `foveationMode: 'frontier'` - the maximum
   * `own_size / distance` a splat may have and still draw (Spark's
   * `pixelScaleLimit`). Set each frame to `foveationTargetPx / focalPx` so the
   * cut targets a fixed on-screen size. Unused in `'band'` mode.
   */
  private readonly pixelScaleLimit = uniform(0);
  /**
   * Core projected-2D depth of field (live uniforms). Aperture `0` disables.
   * Prefer this over the M13 `depthOfFieldPreset` modifier for camera DoF.
   */
  private readonly dofFocusDistance = uniform(10);
  private readonly dofAperture = uniform(0);
  /**
   * Proxy-mesh screen-space relighting (live uniforms + map). `blend === 0`
   * disables. Swapping the map rebuilds the material graph once.
   */
  private readonly relightPlaceholder = createPlaceholderRelightTexture();
  private relightMap: THREE.Texture = this.relightPlaceholder;
  private readonly relightBlend = uniform(0);
  private readonly relightBrightness = uniform(DEFAULT_RELIGHT_BRIGHTNESS);
  private readonly relightBackground = uniform(DEFAULT_RELIGHT_BACKGROUND);
  private readonly relightSoftness = uniform(DEFAULT_RELIGHT_SOFTNESS);
  /**
   * Live screen-radius band bounds (px), seeded from
   * {@link SplatMeshOptions.minSplatScreenRadius} / `maxSplatScreenRadius` and
   * moved by {@link setScreenRadiusBand} - so a foveated mesh can widen the band
   * as its LOD cut refines rather than culling the detail the refinement bought.
   */
  private readonly screenBandMin = uniform(0);
  private readonly screenBandMax = uniform(0);

  /** The pick pass and everything it allocates; see `splat-mesh-picking.ts`. */
  private readonly picker: SplatPicker = new SplatPicker({
    mesh: this,
    isDisposed: () => this.disposed,
    getActiveCount: () => this.activeCount,
    getViewportSize: () => this.viewport.value,
    getPickVisible: () => this.effectiveVisibility,
    hasSorter: () => this.sorter !== null,
    updateWorldMatrix: () => this.updateWorldMatrix(true, false),
    prepare: (camera, renderer) => {
      this.flushPendingUploads(renderer);
      this.refreshProjectionUniforms(camera, renderer);
      // Deliberately not `createSorter`: a depth-tested pick needs a valid
      // draw list, not a sorted one, and the identity list is valid.
      if (this.sorter !== null) this.requestSortIfNeeded(camera, renderer);
    },
    setView: (camera, width, height) => this.writeViewUniforms(camera, width, height),
    applyPickGraph: (material) =>
      applySplatMaterialGraph(
        material,
        'pick',
        this.graphInputs(this.materialInputs.textures, this.materialInputs.sh),
      ),
  });
  /** Visibility supplied by an owning unified renderer for source-only picks. */
  private unifiedPickVisibility: boolean | null = null;
  /** Set by {@link dispose}; subclasses use it to drop late async results. */
  protected disposed = false;
  /** The renderer this mesh last updated with, so {@link dispose} can free
   * storage-attribute GPU buffers that never sat in a geometry. */
  private lastRenderer: THREE.WebGPURenderer | null = null;

  private readonly currentModelView = new THREE.Matrix4();
  /** Initialized to an impossible matrix so the first frame always sorts. */
  private readonly lastSortedModelView = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly sortScheduler: WebGpuSortScheduler;
  /** One-frame queue-headroom hint used before a staged atomic commit. */
  private deferSortRequestOnce = false;
  /** Bumped by every active-list mutation; identifies a draw list. */
  private activeListVersion = 0;
  /** The active list the current depth order was built from. */
  private sortedActiveListVersion = -1;
  private readonly sortStrategy: SplatSortStrategy;
  /** Resolved only when `sortStrategy === 'radix'`; see {@link ensureRadixSorter}. */
  private RadixSorterCtor: (typeof import('./radix-sorter'))['RadixSorter'] | null = null;
  private radixSorterLoad: Promise<void> | null = null;
  private performanceProfileValue: SplatPerformanceProfile;
  /** Gaussian cutoff radius in σ; baked into the material graph. */
  private maxStdDevValue: number;
  /** Screen-space minimum splat radius in px; baked into the material graph. */
  private readonly minSplatSizePx: number;
  /** Mip-Splatting 2D antialiasing filter; baked into the material graph. */
  private readonly antialias: boolean;
  /** Format-selected low-pass and opacity-compensation policy. */
  private readonly projectedFilterProfile: ProjectedFilterProfile;
  /** Emit sRGB colors for gamma-space compositing; baked into the material graph. */
  private readonly srgbOutput: boolean;
  /** Screen-radius cull threshold in px (0 = off); baked into the material graph. */
  private readonly maxSplatScreenRadius: number;
  private readonly minSplatScreenRadius: number;
  /** `.rad` foveation cut selector; baked into the material graph. */
  private readonly foveationMode: SplatFoveationMode;
  /** Finest on-screen node size (px) the frontier cut may request. */
  private readonly foveationTargetPx: number;
  /** Target upper bound on the frontier cut's drawn-splat count. */
  private readonly foveationDrawBudget: number;
  /** Rendered major/minor axis-ratio cap (0 = off); baked into the material graph. */
  private readonly maxSplatAspect: number;
  /** Spark LOD alpha encoding + merged-node rendering; baked into the material. */
  private readonly lodAlpha: boolean;
  /** Live frontier limit in px; self-adjusts between `foveationTargetPx` (finest)
   * and coarser to hold `foveationDrawBudget`. Feeds `pixelScaleLimit` each frame. */
  private foveationLimitPx: number;
  /** Throttle timestamp for the adaptive-limit estimate (ms, `performance.now`). */
  private lastFoveationAdaptAt = -Infinity;
  /** Y-up normalization policy; drives the static self-orientation below. */
  readonly orientation: SplatOrientation;
  /** Set once the pool has been checked against the device texture limit. */
  private textureLimitChecked = false;

  constructor(source: SplatData | { capacity: number }, options: SplatMeshOptions = {}) {
    const sortIntervalMs = validateSortIntervalMs(options.sortIntervalMs);
    // Mobile GPUs are fragment-bound, so several defaults below trade detail
    // no one can see for the fill rate they cost. Every one is overridable.
    // The footprint floor addresses the low-resolution mobile coverage case,
    // not every device that benefits from the broader smooth/fill policy.
    // In particular, an integrated desktop remains at the reference 0 px
    // floor unless its host explicitly opts in.
    const isMobile = detectSplatDeviceProfile()?.isMobile === true;
    // Keep the reference cutoff on every device. Raising it grows every splat's
    // quad (and therefore its fragment cost), including the already-large
    // near-camera splats that dominate mobile overdraw.
    const maxStdDev = validateMaxStdDev(options.maxStdDev) ?? 3;
    // Phones need a little extra coverage only where distant splats shrink far
    // enough to leave dark gaps. The shader floor grows those undersized discs
    // without increasing fill for the rest; callers can still disable it with 0.
    const minSplatSizePx = validateMinSplatSizePx(options.minSplatSizePx) ?? (isMobile ? 1.5 : 0);
    const isStatic = !('capacity' in source);
    const capacity = isStatic ? source.count : source.capacity;
    if (capacity <= 0) throw new Error('SplatMesh capacity must be positive.');

    // Pool data textures (CPU backing arrays kept for partial uploads):
    //   centers      RGBA32F or RGBA16F  x, y, z, (unused)
    //   colors       RGBA8    r, g, b, opacity
    //   covarianceA  RGBA32F or RGBA16F  m00, m01, m02, m11
    //   covarianceB  RGBA32F  m12, m22, shN palette label, frontier parent
    //   shPacked[t]  RGBA32UI per-splat SH coefficients 4t..4t+3, still packed
    //
    // Float16 is opt-in for centers/covA only (VRAM). CPU backing stays
    // float32; covarianceB stays float32 because it packs integer IDs.
    // Spherical harmonics a *static* mesh should actually render.
    //
    // A static mesh carries its SH in the data, and this used to read it
    // blindly: `options.shBands` and the `smooth` performance profile (the
    // mobile default) were both ignored, so no caller and no device could
    // decline it. On a 1.4M-splat band-3 capture that is four RGBA32UI pool
    // textures - 128 B/splat of GPU + CPU backing, ~180 MB - plus four texture
    // fetches and a 15-coefficient evaluation per splat *per frame*. The same
    // defect on `.rad` cost 48% of its pool.
    //
    // Resolved the way `StreamedSplatMesh.fromSource` resolves it, so both
    // paths answer the same request: an explicit `shBands` wins, otherwise the
    // performance profile decides.
    //
    // **All-or-nothing**, exactly as `buildRadScene` is: `writePackedSh` copies
    // packed words only when the counts match exactly, so asking for *fewer*
    // bands than the data carries would allocate the smaller texture set and
    // then fill it with neutral words - paying for SH and rendering flat.
    const staticShWanted =
      (options.shBands ??
        (resolveSplatPerformanceProfile(options.performanceProfile) === 'smooth'
          ? 0
          : MAX_SH_BANDS)) !== 0;
    // The dynamic branch keeps `?? 0`: a dynamic pool has no data to read bands
    // from, so defaulting it to MAX would allocate SH textures for every mesh
    // that never asked for any.
    const packedShBands: 0 | 1 | 2 | 3 = isStatic
      ? staticShWanted
        ? (source.shPacked?.bands ?? 0)
        : 0
      : (options.shBands ?? 0);
    // A supplied pool is shared: this mesh draws from it but never frees it.
    const suppliedPool = options.pool;
    const makeOwnPool = () =>
      new SplatPool({
        capacity,
        floatTextures: options.poolFloatTextures,
        packedShBands,
        packedShTextureCount:
          packedShBands === 0 ? 0 : Math.ceil(shCoefficientCount(packedShBands) / 4),
        ...(options.maxTextureSize === undefined ? {} : { maxTextureSize: options.maxTextureSize }),
      });
    // A shared pool allocates its packed-SH textures once, so it can only serve
    // tenants with its own band count. Rather than fail the load, such a mesh
    // falls back to its own pool: in a multi-mesh scene it is usually one odd
    // capture carrying SH, and sizing the shared pool for it would add
    // ~64 B/splat across storage that mostly has no SH to read.
    const shMismatch = suppliedPool !== undefined && packedShBands !== suppliedPool.packedShBands;
    if (shMismatch) {
      warn(
        `a mesh with shBands ${packedShBands} cannot share a pool built for ` +
          `${suppliedPool?.packedShBands}; it allocated its own pool instead.`,
      );
    }
    const ownsPool = suppliedPool === undefined || shMismatch;
    const pool = ownsPool ? makeOwnPool() : suppliedPool;
    // Per-mesh draw state is sized by what *this* mesh can have active, not by
    // the pool: sharing a large pool between many meshes would otherwise give
    // each of them a pool-sized draw list and active list (8 B per pool splat,
    // per mesh). Pool *indices* still range over the whole pool - only the
    // number of slots is bounded here. Identical to `pool.capacity` when the
    // mesh allocated the pool itself.
    const texelCount = Math.min(
      pool.capacity,
      Math.ceil(capacity / SplatMesh.DATA_TEXTURE_WIDTH) * SplatMesh.DATA_TEXTURE_WIDTH,
    );
    const centersTexture = pool.centersTexture;
    const colorsTexture = pool.colorsTexture;
    const covarianceATexture = pool.covarianceATexture;
    const covarianceBTexture = pool.covarianceBTexture;
    // Palette shN (SOG/`.lcc2`) takes the same gate as the packed bands above.
    // Its palette is shared rather than per-splat, so it costs little memory -
    // but the per-frame work is identical: a texture fetch per coefficient plus
    // the full evaluation, on every splat. Leaving this ungated would have made
    // `shBands: 0` silently ineffective for exactly the formats that use it.
    //
    // Gating here also stops `writeSplatRows` storing the per-splat palette
    // labels, since it keys off `shEnabled` (this texture being non-null).
    const shPaletteTexture =
      isStatic && source.sh && staticShWanted
        ? createDataTexture(
            source.sh.palette,
            source.sh.paletteWidth,
            source.sh.paletteHeight,
            THREE.FloatType,
          )
        : null;
    const shPackedTextures = pool.shPackedTextures;

    // One quad, instanced per splat. Corners span [-1, 1]; the vertex stage
    // scales them to ±3σ along the projected ellipse axes.
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    // A storage attribute so the GPU sorter can rewrite it in compute
    // passes; on the WebGL2 fallback it acts as a plain instanced
    // attribute that the worker sorter updates from the CPU.
    const splatIndexes = new Float32Array(texelCount);
    for (let i = 0; i < texelCount; i++) splatIndexes[i] = i;
    const splatIndexAttribute = new THREE.StorageInstancedBufferAttribute(splatIndexes, 1);
    geometry.setAttribute('splatIndex', splatIndexAttribute);
    geometry.instanceCount = 0;

    super(geometry, new THREE.NodeMaterial());
    this.pool = pool;
    this.ownsPool = ownsPool;
    pool.register(this);
    this.sortScheduler = new WebGpuSortScheduler(sortIntervalMs, isMobile);
    this.sortStrategy = options.sortStrategy ?? 'counting';
    if (this.sortStrategy === 'radix') this.ensureRadixSorter();
    this.performanceProfileValue = resolveSplatPerformanceProfile(options.performanceProfile);
    this.maxStdDevValue = maxStdDev;
    this.minSplatSizePx = minSplatSizePx;
    // Explicit option wins; otherwise honor the source scene's flag (SOG meta).
    this.antialias = options.antialias ?? (isStatic ? (source.antialias ?? false) : false);
    this.projectedFilterProfile = options.projectedFilterProfile ?? 'default';
    this.srgbOutput = options.srgbOutput ?? false;
    this.maxSplatScreenRadius = validateMaxSplatScreenRadius(options.maxSplatScreenRadius);
    this.minSplatScreenRadius = validateMaxSplatScreenRadius(options.minSplatScreenRadius);
    this.screenBandMin.value = this.minSplatScreenRadius;
    this.screenBandMax.value = this.maxSplatScreenRadius;
    this.foveationMode = resolveSplatFoveationMode(options.foveationMode);
    this.foveationTargetPx = validateFoveationTargetPx(options.foveationTargetPx);
    this.foveationDrawBudget = validateFoveationDrawBudget(options.foveationDrawBudget);
    this.foveationLimitPx = this.foveationTargetPx;
    this.maxSplatAspect = validateMaxSplatScreenRadius(options.maxSplatAspect); // finite ≥ 0
    this.lodAlpha = options.lodAlpha ?? false;
    this.orientation = options.orientation ?? 'y-up';
    this.splatIndexAttribute = splatIndexAttribute;
    this.sourceIndexAttribute = new THREE.StorageBufferAttribute(new Uint32Array(texelCount), 1);
    this.dataTextures = pool.coreTextures;
    this.isStatic = isStatic;
    this.shEnabled = shPaletteTexture !== null;
    this.shRange = { min: vec3Uniform(), max: vec3Uniform() };
    this.frustumCulled = false; // Culling happens per splat in the shader.
    if (shPaletteTexture) this.dataTextures = [...this.dataTextures, shPaletteTexture];
    if (shPackedTextures.length > 0)
      this.dataTextures = [...this.dataTextures, ...shPackedTextures];

    this.materialInputs = {
      textures: { centersTexture, colorsTexture, covarianceATexture, covarianceBTexture },
      sh:
        isStatic && source.sh && shPaletteTexture
          ? { mode: 'palette', bands: source.sh.bands, paletteTexture: shPaletteTexture }
          : packedShBands !== 0
            ? {
                mode: 'packed',
                bands: packedShBands,
                textures: shPackedTextures,
                range: this.shRange,
              }
            : null,
    };
    this.buildMaterial(this.materialInputs.textures, this.materialInputs.sh);

    if (isStatic) {
      this.staticRange = this.appendRange(source);
      // Constructor-time writes are covered by the textures' initial
      // `needsUpdate` upload - the GPU cannot have seen them earlier. Any
      // append after construction must go through the staging-copy path,
      // because the backend may already have uploaded the textures by then.
      this.pendingUploadRows = [];
      // Float16 GPU images are separate from the float32 backing: pack the
      // constructor write into the texture image before the initial upload.
      if (this.poolFloatTextures === 'float16') this.syncHalfFloatPoolImages();
      // Orient a known-format scene to Y-up (unless in 'source' mode). The
      // correction is a rigid object-level transform, so the GPU rotates each
      // Gaussian's covariance and view-dependent SH consistently - nothing is
      // baked into the splat data. A dynamic pool has no source format, so it
      // is never auto-oriented (its host applies yUpTransformForFormat itself).
      const correction = this.orientation === 'y-up' ? yUpTransformForFormat(source.format) : null;
      if (correction) {
        this.matrix.copy(correction);
        this.matrix.decompose(this.position, this.quaternion, this.scale);
        this.matrixWorldNeedsUpdate = true;
      }
    }
  }

  /**
   * Higher-order SH bands this mesh actually renders (0 when it has none),
   * whatever the source: a static mesh's palette shN, or per-splat SH in a
   * dynamic pool. Reflects what was resolved at construction, not what was
   * asked for - useful for a debug readout.
   */
  get shBands(): number {
    return this.materialInputs.sh?.bands ?? 0;
  }

  /**
   * The contribution-culling profile currently in effect (resolved at
   * construction, or the last {@link setPerformanceProfile} value).
   */
  get performanceProfile(): SplatPerformanceProfile {
    return this.performanceProfileValue;
  }

  /**
   * Changes contribution culling without changing scene data or persisted
   * settings.
   *
   * Mutator convention: state that is plain data is a property (get/set pair);
   * a `setX` method exists where the write has behavior - this one rebuilds the
   * material graph, {@link StreamedSplatMesh.setBudget} returns its clamp.
   * Every mutator has a matching readable property.
   */
  setPerformanceProfile(profile: SplatPerformanceProfile): void {
    if (profile === this.performanceProfileValue) return;
    this.performanceProfileValue = profile;
    this.buildMaterial(this.materialInputs.textures, this.materialInputs.sh);
  }

  /**
   * Gaussian cutoff radius currently in effect, in standard deviations.
   * Resolved at construction, or the last {@link setMaxStdDev} value.
   */
  get maxStdDev(): number {
    return this.maxStdDevValue;
  }

  /**
   * Changes the Gaussian cutoff without changing scene data.
   *
   * Lowering it shrinks every quad and is the main fill-rate lever in a busy
   * view; raising it restores the faint outer tail. Rebuilds the material
   * graph, same convention as {@link setPerformanceProfile}.
   */
  setMaxStdDev(value: number): void {
    const next = validateMaxStdDev(value);
    if (next === undefined || next === this.maxStdDevValue) return;
    this.maxStdDevValue = next;
    this.cachedUnifiedView = null;
    this.buildMaterial(this.materialInputs.textures, this.materialInputs.sh);
  }

  /**
   * Copies a decoded scene (or chunk) into the pool and activates it.
   * Ranges are row-aligned in the pool textures, so each allocation may
   * round up to the next multiple of the texture width internally.
   *
   * @returns A handle to pass to {@link removeRange}.
   * @throws {Error} when the remaining pool capacity cannot fit the range.
   */
  appendRange(data: SplatData): SplatRange {
    return this.appendRangeWithState(data, true);
  }

  /** Appends uploaded data without exposing it to draw/sort until activated. */
  protected appendInactiveRange(data: SplatData): SplatRange {
    return this.appendRangeWithState(data, false);
  }

  /** Reserves an inactive pool range whose data can be filled over multiple frames. */
  protected reserveInactiveRange(count: number): SplatRange {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError('SplatMesh.reserveInactiveRange: count must be a non-negative integer.');
    }
    if (count === 0) {
      const empty: SplatRange = Object.freeze({ count: 0 });
      this.ranges.set(empty, { startRow: 0, rowCount: 0, start: 0, count: 0, active: false });
      return empty;
    }
    const width = SplatMesh.DATA_TEXTURE_WIDTH;
    const rowCount = Math.ceil(count / width);
    const startRow = allocateRowSpan(this.freeRowSpans, rowCount, this.poolRows);
    const start = startRow * width;
    const handle: SplatRange = Object.freeze({ count });
    this.ranges.set(handle, { startRow, rowCount, start, count, active: false });

    // A reused row may retain channel values from its previous occupant.
    for (const channel of this.channels.values()) {
      channel.backing.fill(channel.fill, start, start + rowCount * width);
      channel.pendingRows.push({ start: startRow, count: rowCount });
    }
    return handle;
  }

  /** Writes one contiguous segment of a reserved inactive range. */
  protected writeInactiveRange(handle: SplatRange, data: SplatData, offset: number): void {
    const record = this.ranges.get(handle);
    if (!record) throw new Error('SplatMesh.writeInactiveRange: unknown range handle.');
    if (record.active) throw new Error('SplatMesh.writeInactiveRange: range is already active.');
    if (!Number.isInteger(offset) || offset < 0 || offset + data.count > record.count) {
      throw new RangeError('SplatMesh.writeInactiveRange: write exceeds the reserved range.');
    }
    if (data.count === 0) return;
    this.warnOnIgnoredSh(data, 'writeInactiveRange');

    const destination = record.start + offset;
    this.writeSplatRows(destination, data);

    const width = SplatMesh.DATA_TEXTURE_WIDTH;
    const firstRow = Math.floor(destination / width);
    const lastRow = Math.floor((destination + data.count - 1) / width);
    this.markRowsWritten(firstRow, lastRow - firstRow + 1);
    _appendBox.setFromArray(data.positions);
    this.localBounds.union(_appendBox);
    this.boundsDirty = true;
  }

  /**
   * Overwrites splats at `offset` within a range **in place** - unlike
   * {@link writeInactiveRange} this allows an *active* range, so the frontier
   * page table can page individual slots of its always-active slab. Queues the
   * touched rows for upload; the caller must {@link invalidateSort} once per
   * batch since splat depths changed.
   */
  protected overwriteRangeData(handle: SplatRange, data: SplatData, offset: number): void {
    const record = this.ranges.get(handle);
    if (!record) throw new Error('SplatMesh.overwriteRangeData: unknown range handle.');
    if (!Number.isInteger(offset) || offset < 0 || offset + data.count > record.count) {
      throw new RangeError('SplatMesh.overwriteRangeData: write exceeds the range.');
    }
    if (data.count === 0) return;
    this.warnOnIgnoredSh(data, 'overwriteRangeData');
    const destination = record.start + offset;
    this.writeSplatRows(destination, data);
    const width = SplatMesh.DATA_TEXTURE_WIDTH;
    const firstRow = Math.floor(destination / width);
    const lastRow = Math.floor((destination + data.count - 1) / width);
    this.markRowsWritten(firstRow, lastRow - firstRow + 1);
    _appendBox.setFromArray(data.positions);
    this.localBounds.union(_appendBox);
    this.boundsDirty = true;
    // The unified renderer reuses its gathered work buffer while this is
    // unchanged. A paging plan that only relocates survivors leaves the resident
    // count alone, so without this bump the gather (and the sort that follows
    // it) would be skipped and the frame would keep the previous frontier.
    this.contentRevision++;
  }

  /**
   * Zeros splats `[offset, offset + count)` of a range so they draw nothing
   * (zero covariance → degenerate quad, zero color). Used to free frontier slab
   * slots that leave the frontier. Queues the rows for upload.
   */
  protected degenerateRange(handle: SplatRange, offset: number, count: number): void {
    const record = this.ranges.get(handle);
    if (!record) throw new Error('SplatMesh.degenerateRange: unknown range handle.');
    if (count <= 0) return;
    if (!Number.isInteger(offset) || offset < 0 || offset + count > record.count) {
      throw new RangeError('SplatMesh.degenerateRange: range out of bounds.');
    }
    const start = record.start + offset;
    const { centers, colors, covarianceA, covarianceB } = this.backing;
    centers.fill(0, start * 4, (start + count) * 4);
    colors.fill(0, start * 4, (start + count) * 4);
    covarianceA.fill(0, start * 4, (start + count) * 4);
    covarianceB.fill(0, start * 4, (start + count) * 4);
    const width = SplatMesh.DATA_TEXTURE_WIDTH;
    const firstRow = Math.floor(start / width);
    const lastRow = Math.floor((start + count - 1) / width);
    this.markRowsWritten(firstRow, lastRow - firstRow + 1);
    this.contentRevision++;
  }

  /**
   * Copies one chunk's splats into the pool's backing arrays at `destination`.
   * Shared by the append and staged-write paths, which differ only in where
   * the rows come from and when they are activated.
   */
  private writeSplatRows(destination: number, data: SplatData): void {
    const { centers, colors, covarianceA, covarianceB } = this.backing;
    colors.set(data.colors, destination * 4);
    // Everything loop-invariant is hoisted into locals, including the two
    // optional arrays. `data` reaches here from several construction sites with
    // different shapes (sliced chunks, worker paging plans, whole SplatData), so
    // reading `data.positions` / `data.frontierParent` *inside* the loop makes
    // those megamorphic property loads - measured at ~5k splats/ms, where a
    // 600k-splat paging plan cost ~139 ms of one frame. The body below touches
    // only locals and typed arrays.
    const count = data.count;
    const positions = data.positions;
    const covariances = data.covariances;
    const labels = this.shEnabled && data.sh ? data.sh.labels : null;
    // covarianceB.w is otherwise unused; the frontier cut packs each splat's
    // signed `parent_size` here (0 = unwritten, treated as a root).
    const frontierParent = data.frontierParent ?? null;
    for (let i = 0; i < count; i++) {
      const p = (destination + i) * 4;
      const p3 = i * 3;
      const p6 = i * 6;
      centers[p + 0] = positions[p3 + 0] as number;
      centers[p + 1] = positions[p3 + 1] as number;
      centers[p + 2] = positions[p3 + 2] as number;
      covarianceA[p + 0] = covariances[p6 + 0] as number;
      covarianceA[p + 1] = covariances[p6 + 1] as number;
      covarianceA[p + 2] = covariances[p6 + 2] as number;
      covarianceA[p + 3] = covariances[p6 + 3] as number;
      covarianceB[p + 0] = covariances[p6 + 4] as number;
      covarianceB[p + 1] = covariances[p6 + 5] as number;
      covarianceB[p + 2] = labels ? (labels[i] as number) : 0;
      covarianceB[p + 3] = frontierParent ? (frontierParent[i] as number) : 0;
    }
    this.writePackedSh(destination, data);
  }

  /**
   * Scatters a chunk's packed SH words into the per-group pool textures.
   *
   * A chunk without SH still writes: pool rows are reused, so leaving the
   * previous occupant's words behind would give a DC-only chunk somebody
   * else's view-dependent color. Zero is not neutral (the range is signed and
   * rarely symmetric), so the code for "0.0" in this scene's range is.
   */
  private writePackedSh(destination: number, data: SplatData): void {
    if (this.packedShBands === 0) return;
    const groups = this.backing.shPacked;
    const wanted = shCoefficientCount(this.packedShBands);
    const source = data.shPacked;

    if (source && source.bands === this.packedShBands) {
      this.applyShRange(source);
      // A chunk quantized against a different range than the scene's (a SOG
      // chunk measures its own extent - M11) is requantized into the scene
      // range word-by-word, so every splat decodes through the one pool
      // uniform. When the ranges already match (LCC/`.rad`, or the range-setting
      // first chunk) this is a verbatim copy.
      const target = this.currentShRange();
      const requantize = target !== null && !packedRangesEqual(source.range, target);
      for (let i = 0; i < data.count; i++) {
        for (let c = 0; c < wanted; c++) {
          const word = source.packed[i * wanted + c] as number;
          (groups[c >> 2] as Uint32Array)[(destination + i) * 4 + (c & 3)] = requantize
            ? requantizeShWord(word, source.range, target)
            : word;
        }
      }
      return;
    }
    // Before the range locks, the neutral word is unknowable (word 0 decodes
    // to `range.min` once a range exists - not 0.0). Write 0 for now and
    // remember to backfill every pre-lock row when the first SH chunk arrives.
    if (!this.shRangeSet) this.wrotePreLockNeutralSh = true;
    const neutral = this.neutralShWord();
    for (let i = 0; i < data.count; i++) {
      for (let c = 0; c < wanted; c++) {
        (groups[c >> 2] as Uint32Array)[(destination + i) * 4 + (c & 3)] = neutral;
      }
    }
  }

  /**
   * Adopts the first packed-SH chunk's dequantization range as the scene's one
   * pool uniform. LCC/`.rad` chunks already share one range; a streamed SOG
   * chunk measures its own extent, so later chunks are requantized into this
   * one at write time ({@link writePackedSh}) rather than ignored.
   */
  private applyShRange(source: NonNullable<SplatData['shPacked']>): void {
    if (this.shRangeSet) return;
    this.shRange.min.value.set(source.range.min[0], source.range.min[1], source.range.min[2]);
    this.shRange.max.value.set(source.range.max[0], source.range.max[1], source.range.max[2]);
    this.shRangeSet = true;

    // SH-less chunks appended before this lock were filled with word 0, which
    // now decodes to `range.min` in every channel - garbage view-dependent
    // color. Every pre-lock write was such a fill (an SH chunk would have
    // locked the range itself), so refilling the whole pool with the real
    // neutral word is correct even across compactions; the range-setting
    // chunk overwrites its own rows right after this. One-time, and only in
    // mixed captures where an SH-less chunk lands first.
    if (this.wrotePreLockNeutralSh) {
      const neutral = this.neutralShWord();
      for (const group of this.backing.shPacked) group.fill(neutral);
      this.markRowsWritten(0, this.poolRows);
      this.wrotePreLockNeutralSh = false;
    }
  }

  /** The scene's locked packed-SH range as a plain tuple, or null if unset. */
  private currentShRange(): ShRange | null {
    if (!this.shRangeSet) return null;
    const { min, max } = this.shRange;
    return {
      min: [min.value.x, min.value.y, min.value.z],
      max: [max.value.x, max.value.y, max.value.z],
    };
  }

  /** The packed word decoding to 0 in every channel under the scene's range. */
  private neutralShWord(): number {
    const range = this.currentShRange();
    if (!range) return 0;
    return neutralShWordFor(range);
  }

  /** Warns once per call site when a source's SH cannot be stored. */
  private warnOnIgnoredSh(data: SplatData, method: string): void {
    if (data.sh && !this.isStatic) {
      warn(
        `SplatMesh.${method}: palette shN data on appended ranges is ignored in dynamic-capacity mode ` +
          '(per-file palettes cannot be merged into a shared pool).',
      );
    }
    if (data.shPacked && this.packedShBands === 0) {
      warn(
        `SplatMesh.${method}: per-splat SH was supplied but the pool has none allocated ` +
          (this.isStatic
            ? '(the static source had no `shPacked` at construction).'
            : '(construct the mesh with `shBands` to store it).'),
      );
    }
  }

  /** Atomically includes or excludes a resident range on the next active-list rebuild. */
  protected setRangeActive(handle: SplatRange, active: boolean): void {
    const record = this.ranges.get(handle);
    if (!record) throw new Error('SplatMesh.setRangeActive: unknown range handle.');
    if (record.active === active) return;
    record.active = active;
    if (active) this.activateRecord(record);
    else this.deactivateRecord(record);
    this.contentRevision++;
  }

  /**
   * Activates only the first `prefix` splats of a range (see
   * {@link RangeRecord.activePrefix}). The page-table slab keeps its used slots
   * densely packed at the front, so this bounds per-frame sorting and vertex
   * work to the *drawn* frontier instead of the whole pool-sized slab. Write
   * APIs (`overwriteRangeData` / `degenerateRange`) still address the full range.
   */
  protected setRangeActivePrefix(handle: SplatRange, prefix: number): void {
    const record = this.ranges.get(handle);
    if (!record) throw new Error('SplatMesh.setRangeActivePrefix: unknown range handle.');
    const next = Math.max(0, Math.min(record.count, Math.floor(prefix)));
    const current = record.active ? (record.activePrefix ?? record.count) : 0;
    if (next === current) return;
    // Remove the old prefix from the active list, then re-add at the new length.
    if (record.active) {
      this.deactivateRecord(record);
      record.active = false;
    }
    record.activePrefix = next;
    if (next > 0) {
      record.active = true;
      this.activateRecord(record);
    }
    this.contentRevision++;
  }

  /**
   * Replaces the drawn pool indices for an immutable static hierarchy.
   *
   * This is intentionally narrower than the range API: subclasses may select
   * an arbitrary hierarchy frontier, but the referenced pool rows must remain
   * resident for the lifetime of the mesh.
   */
  protected replaceActiveIndices(indices: Uint32Array): void {
    const source = this.sourceIndexAttribute.array as Uint32Array;
    if (indices.length > source.length) {
      throw new RangeError('SplatMesh.replaceActiveIndices: frontier exceeds pool capacity.');
    }

    this.activeSlotByPoolIndex.fill(0xffffffff);
    for (let slot = 0; slot < indices.length; slot++) {
      const poolIndex = indices[slot] as number;
      if (poolIndex >= source.length) {
        throw new RangeError(
          'SplatMesh.replaceActiveIndices: frontier contains an invalid pool index.',
        );
      }
      if (this.activeSlotByPoolIndex[poolIndex] !== 0xffffffff) {
        throw new Error(
          'SplatMesh.replaceActiveIndices: frontier contains duplicate pool indices.',
        );
      }
      source[slot] = poolIndex;
      this.activeSlotByPoolIndex[poolIndex] = slot;
    }

    const previousCount = this.activeCount;
    this.activeCount = indices.length;
    this.commitActiveListMutation(0, Math.max(previousCount, this.activeCount));
    this.queryEpoch++;
    this.contentRevision++;
  }

  /** Fast identity-frontier variant that avoids allocating a large index array. */
  protected replaceActivePrefix(count: number): void {
    const source = this.sourceIndexAttribute.array as Uint32Array;
    const next = Math.max(0, Math.min(source.length, Math.floor(count)));
    this.activeSlotByPoolIndex.fill(0xffffffff);
    for (let index = 0; index < next; index++) {
      source[index] = index;
      this.activeSlotByPoolIndex[index] = index;
    }
    const previousCount = this.activeCount;
    this.activeCount = next;
    this.commitActiveListMutation(0, Math.max(previousCount, next));
    this.queryEpoch++;
    this.contentRevision++;
  }

  /** Replaces a static mesh's resident cut without increasing its fixed pool allocation. */
  protected replaceStaticData(data: SplatData): void {
    if (!this.isStatic || !this.staticRange) {
      throw new Error('SplatMesh.replaceStaticData: mesh was not constructed from static data.');
    }
    if (data.count > this.capacity) {
      throw new RangeError('SplatMesh.replaceStaticData: cut exceeds pool capacity.');
    }
    this.overwriteRangeData(this.staticRange, data, 0);
    this.setRangeActivePrefix(this.staticRange, data.count);
    this.invalidateSort();
  }

  private appendRangeWithState(data: SplatData, active: boolean): SplatRange {
    if (data.count === 0) {
      // Zero rows must not touch the free list: allocateRows(0) would return
      // a span start without consuming it, and the matching removeRange would
      // push a degenerate zero-count span.
      const empty: SplatRange = Object.freeze({ count: 0 });
      this.ranges.set(empty, { startRow: 0, rowCount: 0, start: 0, count: 0, active });
      return empty;
    }
    const width = SplatMesh.DATA_TEXTURE_WIDTH;
    const rowCount = Math.ceil(data.count / width);
    const startRow = allocateRowSpan(this.freeRowSpans, rowCount, this.poolRows);
    const start = startRow * width;

    this.warnOnIgnoredSh(data, 'appendRange');
    this.writeSplatRows(start, data);
    // Rows shared with removed ranges may hold stale splats past
    // data.count; they are inactive (not in sourceIndex), so harmless.

    const handle: SplatRange = Object.freeze({ count: data.count });
    const record: RangeRecord = { startRow, rowCount, start, count: data.count, active };
    this.ranges.set(handle, record);
    this.markRowsWritten(startRow, rowCount);

    // Reset per-splat channels for the allocated rows. Rows reused from a
    // removed range still hold the previous occupant's channel values, and
    // nothing else clears them - without this, a new chunk landing on old rows
    // renders wearing the old chunk's mask ("ghost paint").
    for (const channel of this.channels.values()) {
      channel.backing.fill(channel.fill, start, start + rowCount * width);
      channel.pendingRows.push({ start: startRow, count: rowCount });
    }

    _appendBox.setFromArray(data.positions);
    this.localBounds.union(_appendBox);
    this.boundsDirty = true;

    if (active) this.activateRecord(record);
    this.contentRevision++;
    return handle;
  }

  /**
   * Deactivates a previously appended range and frees its pool rows for
   * reuse. The bounding sphere used for depth quantization stays a
   * conservative superset until new ranges grow it again.
   */
  removeRange(handle: SplatRange): void {
    const record = this.ranges.get(handle);
    if (!record) throw new Error('SplatMesh.removeRange: unknown range handle.');
    if (record.active) this.deactivateRecord(record);
    this.ranges.delete(handle);
    if (record.rowCount > 0) {
      this.freeRowSpans = releaseRowSpan(this.freeRowSpans, record.startRow, record.rowCount);
    }
    this.contentRevision++;
  }

  /** Maximum number of splats the pool can hold (row-aligned internally). */
  get capacity(): number {
    return this.poolRows * SplatMesh.DATA_TEXTURE_WIDTH;
  }

  /** Number of splats currently active (drawn and depth-sorted). */
  get activeSplatCount(): number {
    return this.activeCount;
  }

  /**
   * Returns this mesh's current pool state for an internal unified gather.
   * Call {@link update} first for streamed sources so the active list reflects
   * the current LOD cut. Consumers must treat the returned GPU resources as
   * read-only; range lifecycle remains owned by this mesh.
   */
  getUnifiedSourceView(): UnifiedSourceView {
    this.updateWorldMatrix(true, false);
    this.refreshSortBounds();
    // The view is rebuilt only when something it reflects actually changed;
    // a steady frame returns the cached object (and its world-bounds sphere)
    // instead of re-deriving both per source per frame. Identity checks on the
    // GPU resources keep the cache safe against texture/graph replacement even
    // if a future mutation path forgets to bump a revision.
    const cached = this.cachedUnifiedView;
    if (
      cached !== null &&
      cached.contentRevision === this.contentRevision &&
      cached.graphRevision === this.graphRevision &&
      cached.activeCount === this.activeCount &&
      cached.sh === this.materialInputs.sh &&
      cached.modifiers === this.modifierList &&
      cached.hasSourcePlacement === (this.perSourceSort !== null) &&
      cached.centersTexture === this.centersTexture &&
      cached.colorsTexture === this.materialInputs.textures.colorsTexture &&
      this.cachedUnifiedViewMatrixWorld.equals(this.matrixWorld) &&
      this.cachedUnifiedViewLocalBounds.equals(this.boundingSphereLocal)
    ) {
      return cached;
    }
    this.cachedUnifiedViewMatrixWorld.copy(this.matrixWorld);
    this.cachedUnifiedViewLocalBounds.copy(this.boundingSphereLocal);
    this.cachedUnifiedViewWorldBounds.copy(this.boundingSphereLocal).applyMatrix4(this.matrixWorld);
    this.cachedUnifiedView = {
      capacity: this.capacity,
      sourceIndex: this.sourceIndexAttribute,
      activeCount: this.activeCount,
      centersTexture: this.centersTexture,
      colorsTexture: this.materialInputs.textures.colorsTexture,
      covarianceATexture: this.materialInputs.textures.covarianceATexture,
      covarianceBTexture: this.materialInputs.textures.covarianceBTexture,
      dataTextureWidth: SplatMesh.DATA_TEXTURE_WIDTH,
      matrixWorld: this.matrixWorld,
      worldBounds: this.cachedUnifiedViewWorldBounds,
      sh: this.materialInputs.sh,
      modifiers: this.modifierList,
      hasSourcePlacement: this.perSourceSort !== null,
      channels: this.channels,
      localCameraPosition: this.localCameraPosition,
      graphRevision: this.graphRevision,
      srgbOutput: this.srgbOutput,
      maxStdDev: this.maxStdDev,
      minSplatSizePx: this.minSplatSizePx,
      antialias: this.antialias,
      projectedFilterProfile: this.projectedFilterProfile,
      // Fixed at construction, so it needs no cache-invalidation key.
      lodAlpha: this.lodAlpha,
      contentRevision: this.contentRevision,
    };
    return this.cachedUnifiedView;
  }

  /**
   * Marks this mesh as a source drawn by {@link UnifiedSplatMesh}.
   * The source stays invisible to the regular scene draw, while its own picker
   * mirrors this resolved visibility so existing per-source hit testing works.
   * Internal consumers should clear the state with `null` before disposing.
   */
  setUnifiedPickVisibility(visible: boolean | null): void {
    this.unifiedPickVisibility = visible;
  }

  /**
   * The visibility that actually decides whether this mesh's splats reach the
   * screen: the owning {@link UnifiedSplatMesh}'s per-source visibility
   * while one owns the draw, else `Object3D.visible`. Consumers that gate on
   * "is this mesh showing" - the picker, `CameraBudgetGovernor` - must read
   * this rather than `visible`, which a unified renderer forces to `false` on
   * every source it owns purely to keep the regular scene draw from
   * double-drawing them.
   */
  get effectiveVisibility(): boolean {
    return this.unifiedPickVisibility ?? this.visible;
  }

  /**
   * Pool splats still allocatable, in whole rows. Because allocation is
   * row-aligned, an append of n splats fits when
   * `ceil(n / rowWidth) · rowWidth ≤ freeSplatCapacity` *and* a contiguous
   * span exists; callers use this for conservative pre-checks before
   * falling back to {@link compact}.
   */
  get freeSplatCapacity(): number {
    let rows = 0;
    for (const span of this.freeRowSpans) rows += span.count;
    return rows * SplatMesh.DATA_TEXTURE_WIDTH;
  }

  /**
   * Declares a named per-splat data channel - one extra value per pool slot,
   * in its own pool-aligned data texture. Channels are opt-in: nothing is
   * allocated until you call this. Read a channel from a modifier with
   * `ctx.channel(name)` and write values per range with {@link writeChannel}.
   *
   * Because a splat keeps its pool row for its whole residency, a channel
   * value follows the splat across depth re-sorts and pool {@link compact}ion
   * - the persistent per-splat label the SDF/selection effects build on. Call
   * this **before** assigning a modifier that reads the channel; a modifier
   * that reads an undeclared channel is a material-build error.
   *
   * @throws {Error} if a channel of this name already exists.
   */
  defineChannel(name: string, options: SplatChannelOptions = {}): void {
    if (this.channels.has(name)) {
      throw new Error(`SplatMesh.defineChannel: channel "${name}" already defined.`);
    }
    const type = options.type ?? 'float';
    const width = SplatMesh.DATA_TEXTURE_WIDTH;
    const texelCount = width * this.poolRows;
    const backing = type === 'byte' ? new Uint8Array(texelCount) : new Float32Array(texelCount);
    const fill = options.fill ?? 0;
    if (fill) backing.fill(fill);
    const textureType = type === 'byte' ? THREE.UnsignedByteType : THREE.FloatType;
    const texture = new THREE.DataTexture(
      backing,
      width,
      this.poolRows,
      THREE.RedFormat,
      textureType,
    );
    texture.needsUpdate = true;
    this.channels.set(name, { type, fill, backing, texture, textureType, pendingRows: [] });
    // No material rebuild here: a modifier that reads this channel cannot have
    // been assigned yet (assigning one before its channel exists throws at
    // build time), so no live graph references the new texture.
  }

  /**
   * Writes channel values for a resident range, at `[offset, offset + data.length)`
   * splats within it (default `offset` 0). Values ride the same staging-upload
   * path as pool data, flushed on the next {@link update}. `byte` channels take
   * raw `0..255`; `float` channels take the value verbatim.
   *
   * @throws {Error} for an unknown channel or range, or a write past the range.
   */
  writeChannel(range: SplatRange, name: string, data: ArrayLike<number>, offset = 0): void {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`SplatMesh.writeChannel: channel "${name}" is not defined.`);
    const record = this.ranges.get(range);
    if (!record) throw new Error('SplatMesh.writeChannel: unknown range handle.');
    if (offset < 0 || offset + data.length > record.count) {
      throw new Error(
        `SplatMesh.writeChannel: write of ${data.length} at offset ${offset} exceeds ` +
          `range count ${record.count}.`,
      );
    }
    if (data.length === 0) return;
    const width = SplatMesh.DATA_TEXTURE_WIDTH;
    const first = record.start + offset;
    // Both Uint8Array and Float32Array `set` accept any ArrayLike<number>;
    // values are coerced to the backing type (bytes are truncated to 0..255).
    (channel.backing as { set(a: ArrayLike<number>, o: number): void }).set(data, first);
    const startRow = Math.floor(first / width);
    const endRow = Math.floor((first + data.length - 1) / width);
    channel.pendingRows.push({ start: startRow, count: endRow - startRow + 1 });
    this.contentRevision++;
  }

  /**
   * Effect hooks, folded into the vertex stage in array order - each
   * modifier sees the running result of the ones before it. Assigning a
   * changed list rebuilds the material (a pipeline recompile); animating a
   * modifier's own uniforms or storage buffers never does. With an empty
   * list the material is exactly the unhooked renderer.
   * See `docs/guide/effects-and-modifiers.md`.
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
      this.rebuildGraph();
    } catch (error) {
      // A modifier threw at build time (e.g. reading an undeclared channel).
      // Roll back so the same list can be re-assigned after the caller fixes
      // the cause - otherwise the identity diff above would short-circuit it.
      // Deliberately `buildMaterial`, not `rebuildGraph`: restoring the graph
      // that was already compiled is not a structural change, so it must not
      // bump `graphRevision` (see modifier-slots.test.ts).
      this.modifierList = previous;
      this.buildMaterial(this.materialInputs.textures, this.materialInputs.sh);
      throw error;
    }
  }

  /**
   * Recompiles the material graph from the mesh's current inputs and publishes
   * the rebuild (`needsUpdate`, `graphRevision`, picker invalidation).
   *
   * A seam rather than inline code because a subclass can change a *build
   * input* without changing the modifier list - `MergedSplatMesh` installs its
   * per-source placement in the constructor, after the base class has already
   * built a placement-free graph. Note `defineChannel` deliberately does *not*
   * rebuild; only structural graph changes come through here.
   *
   * @internal
   */
  protected rebuildGraph(): void {
    this.buildMaterial(this.materialInputs.textures, this.materialInputs.sh);
    (this.material as THREE.Material).needsUpdate = true;
    this.graphRevision++;
    this.picker.markNeedsUpdate();
  }

  /**
   * Core projected-2D depth of field. Adds an isotropic screen-space CoC disc
   * after EWA projection (not the stylized M13 scale modifier). Live uniforms
   * - no material rebuild. Pass `aperture: 0` to disable.
   */
  setDepthOfField(settings: Partial<DepthOfFieldSettings>): void {
    const next = clampDepthOfFieldSettings(settings, this.getDepthOfField());
    this.dofFocusDistance.value = next.focusDistance;
    this.dofAperture.value = next.aperture;
  }

  /**
   * PlayCanvas-style proxy-mesh relighting. Multiplies baked splat color in the
   * **display** fragment by a screen-space sample of `map` (RGB = lit proxy,
   * A = coverage). Pass `null` to disable (`blend → 0`, placeholder map).
   *
   * Blend / brightness / background are live uniforms (no rebuild). Changing
   * the map texture identity rebuilds the material once. Does not affect the
   * pick pass. Does not invalidate a unified gather cache.
   */
  setRelighting(options: RelightingSettings | null): void {
    if (options === null) {
      this.relightBlend.value = 0;
      if (this.relightMap !== this.relightPlaceholder) {
        this.relightMap = this.relightPlaceholder;
        this.rebuildGraph();
      }
      return;
    }
    const next = clampRelightingSettings(options, this.getRelighting());
    this.relightBlend.value = next.blend;
    this.relightBrightness.value = next.brightness;
    this.relightBackground.value = next.background;
    this.relightSoftness.value = next.softness;
    if (options.map !== this.relightMap) {
      this.relightMap = options.map;
      this.rebuildGraph();
    }
  }

  /** Current relight numeric uniforms (`blend === 0` means off). */
  getRelighting(): RelightingUniforms {
    return {
      blend: this.relightBlend.value,
      brightness: this.relightBrightness.value,
      background: this.relightBackground.value,
      softness: this.relightSoftness.value,
    };
  }

  /**
   * Moves the screen-radius band (px) without rebuilding the material.
   *
   * Only meaningful on a mesh constructed *with* a band - the graph decides at
   * build time whether to cull on radius at all, from
   * {@link SplatMeshOptions.minSplatScreenRadius} / `maxSplatScreenRadius`.
   *
   * A foveated mesh uses this to keep the band aligned with its LOD cut: the
   * band spans roughly one level, so refining the cut to spend spare budget
   * selects smaller splats, and a band left where it was would cull precisely
   * the detail that refinement bought.
   */
  protected setScreenRadiusBand(minPx: number, maxPx: number): void {
    this.screenBandMin.value = Math.max(0, minPx);
    this.screenBandMax.value = Math.max(0, maxPx);
  }

  /** Current core DoF uniforms (`aperture === 0` means off). */
  getDepthOfField(): DepthOfFieldSettings {
    return {
      focusDistance: this.dofFocusDistance.value,
      aperture: this.dofAperture.value,
    };
  }

  /**
   * Packs the resident ranges toward the start of the pool, removing the
   * gaps that add/remove churn leaves behind and restoring a single
   * contiguous free span. Use this when {@link appendRange} throws despite
   * enough total free rows (row-alignment fragmentation).
   *
   * The CPU backing arrays are authoritative, so no data is re-fetched;
   * moved rows are re-uploaded to the GPU on the next {@link update}.
   */
  compact(): void {
    this.pool.compact();
  }

  /** {@link SplatPoolTenant}: the ranges this mesh holds in the pool. */
  poolRanges(): Iterable<SplatPoolRange> {
    return this.ranges.values();
  }

  /**
   * {@link SplatPoolTenant}: follow one range to its new rows. The pool has
   * already moved the splat data; this moves what the mesh keys by pool row.
   */
  relocatePoolRange(range: SplatPoolRange, targetRow: number): void {
    const record = range as RangeRecord;
    const width = SplatMesh.DATA_TEXTURE_WIDTH;
    // Channels are single-component and pool-row-aligned, so a range's channel
    // data relocates alongside its splats - this is what keeps a painted mask
    // attached to the splat across compaction.
    for (const channel of this.channels.values()) {
      const cFrom = record.startRow * width;
      const cTo = targetRow * width;
      const cLength = record.rowCount * width;
      channel.backing.copyWithin(cTo, cFrom, cFrom + cLength);
      channel.pendingRows.push({ start: targetRow, count: record.rowCount });
    }
    record.startRow = targetRow;
    record.start = targetRow * width;
    this.markRowsWritten(targetRow, record.rowCount);
  }

  /** {@link SplatPoolTenant}: rebuild everything keyed by pool index. */
  onPoolCompacted(): void {
    this.queryEpoch++; // rows moved, so pool-index → position changed
    // Pool indices changed, so rebuild immediately before another public pool
    // mutation can consult the reverse active-slot map.
    this.rebuildActiveList();
    this.contentRevision++;
  }

  /**
   * Per-frame update: uploads pending pool writes, refreshes the projection
   * uniforms and requests a depth re-sort when the camera or the content
   * has changed. Call this every frame, before `renderer.render`.
   */
  update(
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGPURenderer,
    options: SplatUpdateOptions = {},
  ): void {
    // A render loop can outlive the mesh by a frame; updating after dispose
    // would recreate a sorter and upload into disposed textures.
    if (this.disposed) return;
    this.lastRenderer = renderer;
    this.assertPoolFitsDevice(renderer);
    camera.updateMatrixWorld();
    this.updateWorldMatrix(true, false);
    this.updateTimings.activeListMs = 0;
    this.updateTimings.uploadMs = 0;
    this.updateTimings.sortSubmitMs = 0;
    this.updateTimings.stagingTextureAllocations = 0;
    this.updateTimings.activeListUpdateRanges = 0;
    const uploadStartedAt = performance.now();
    this.flushPendingUploads(renderer);
    this.updateTimings.uploadMs = performance.now() - uploadStartedAt;
    // Resolve the drawn view once: XR gives a per-eye viewport and a separate
    // head pose, everything else the whole canvas. Both consumers below must
    // agree on the size - `adaptFoveationLimit` and `writeViewUniforms` share
    // `foveationLimitPx` through a px→normalized conversion that each does
    // with its own focal length, so a size mismatch makes that loop diverge.
    const xrView = resolveXrView(camera, renderer);
    let projectionCamera: THREE.Camera = camera;
    let sortCamera: THREE.Camera = camera;
    let viewWidth: number;
    let viewHeight: number;
    if (xrView) {
      // Per-eye projection reaches the shader through three's per-render-view
      // TSL nodes; the hand-managed uniforms take the eye's focal/viewport and
      // the head's position (cyclopean - at a ~63 mm IPD the per-eye SH/order
      // difference is imperceptible). One sort from the head serves both eyes;
      // a per-eye re-sort would double the frame's dominant cost.
      projectionCamera = xrView.eye;
      sortCamera = xrView.head;
      viewWidth = xrView.width;
      viewHeight = xrView.height;
    } else {
      renderer.getDrawingBufferSize(_viewSize);
      viewWidth = _viewSize.x;
      viewHeight = _viewSize.y;
    }
    this.adaptFoveationLimit(projectionCamera, viewHeight);
    this.writeViewUniforms(projectionCamera, viewWidth, viewHeight, sortCamera);
    this.updateTimings.activeListUpdateRanges = this.sourceIndexAttribute.updateRanges.length;
    if (options.sort !== false) {
      const sortStartedAt = performance.now();
      this.requestSortIfNeeded(sortCamera, renderer);
      this.updateTimings.sortSubmitMs = performance.now() - sortStartedAt;
    }
  }

  /** Returns the render-preparation CPU timings for the current update. */
  protected getUpdateTimings(): Readonly<{
    activeListMs: number;
    uploadMs: number;
    sortSubmitMs: number;
    stagingTextureAllocations: number;
    activeListUpdateRanges: number;
  }> {
    return this.updateTimings;
  }

  /**
   * Skips one otherwise ordinary sort request, but only while the active list
   * is unchanged since the last sort. Streamed staging uses this immediately
   * before a forced commit sort so the GPU queue has a frame to drain; a
   * concurrent swap group that mutates the active list revokes the request,
   * because the depth order must always describe the list being drawn.
   */
  protected deferNextSortRequest(): void {
    this.deferSortRequestOnce = true;
  }

  /**
   * Once, on the first update (when the backend is known), fails loudly if the
   * pool's `2048 × poolRows` data textures exceed the device's maximum texture
   * dimension - otherwise the upload fails with a cryptic backend error and a
   * frozen canvas. Streamed scenes stay under the limit (budget-bounded); this
   * guards very large *static* scenes, especially on mobile (≈8192 max → about
   * 16.7 M splats). If the limit can't be read, the check is skipped rather
   * than risk a false rejection.
   */
  private assertPoolFitsDevice(renderer: THREE.WebGPURenderer): void {
    if (this.textureLimitChecked) return;
    this.textureLimitChecked = true;
    const maxSize = deviceMaxTextureSize(renderer);
    if (maxSize > 0 && this.poolRows > maxSize) {
      const width = SplatMesh.DATA_TEXTURE_WIDTH;
      throw new Error(
        `SplatMesh: this scene needs a ${width}×${this.poolRows} data texture, but this ` +
          `device caps texture dimensions at ${maxSize} (about ` +
          `${(maxSize * width).toLocaleString('en-US')} splats). Stream it with ` +
          `StreamedSplatMesh, or reduce the splat count.`,
      );
    }
  }

  /** Bounding box of the appended splats, in this mesh's local space. */
  computeSplatBounds(): THREE.Box3 {
    return this.localBounds.clone();
  }

  /**
   * Asynchronously picks the frontmost visible splat under an NDC coordinate.
   *
   * Renders a one-pixel GPU depth pass (shared projection/Gaussian math with
   * the display material), reads the encoded view depth, and reconstructs a
   * world-space point on the splat's rendered center plane. Concurrent calls
   * on this mesh are serialized. Returns `null` for misses, empty meshes,
   * out-of-canvas coordinates, or after {@link dispose}.
   *
   * Does not return a persistent splat id - LOD streaming and pool reuse make
   * identity unstable across frames.
   */
  pick(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    renderer: THREE.WebGPURenderer,
    options?: SplatPickOptions,
  ): Promise<SplatPickResult | null> {
    return this.picker.pick(ndc, camera, renderer, options);
  }

  /**
   * The resident splat center nearest a world point, within `radius` (world
   * units), or `null` if none. A synchronous CPU query over the pool's decoded
   * centers - no GPU round-trip - backed by a uniform grid rebuilt only when
   * the resident set changes (M9). The primitive behind measurement markers and
   * proximity tests.
   *
   * **Resident-only:** a {@link StreamedSplatMesh} searches only the splats
   * currently in the pool (the LOD the camera has resolved), so the answer is
   * the nearest *loaded* splat - coarser far from the camera, absent where no
   * chunk has streamed in. A static mesh searches its whole scene.
   *
   * World-correct under any rotation + per-axis (including non-uniform) scale:
   * candidates are gathered in local space with a conservative radius
   * (`radius / min axis scale`) and then ranked by **world** distance, so the
   * nearest-in-world splat wins even when the axes stretch differently. Shear
   * in an ancestor transform is not supported. Splats displaced by GPU
   * modifiers are queried at their undisplaced CPU positions.
   */
  queryNearest(worldPoint: THREE.Vector3, radius: number): SplatNearestResult | null {
    if (this.activeCount === 0 || !(radius >= 0)) return null;
    this.updateWorldMatrix(true, false);
    _queryLocal.copy(worldPoint);
    this.worldToLocal(_queryLocal);
    const grid = this.ensureQueryGrid();
    // A world sphere of `radius` maps into local space within
    // radius / minAxisScale of the local query point; gather that superset,
    // then rank each candidate by its true world distance.
    const gather = radius / this.queryWorldMinScale();
    const r2 = radius * radius;
    let bestIndex = -1;
    let bestSq = Infinity;
    grid.forEachWithin(_queryLocal.x, _queryLocal.y, _queryLocal.z, gather, (poolIndex) => {
      this.splatWorldPosition(poolIndex, _queryWorld);
      const d2 = _queryWorld.distanceToSquared(worldPoint);
      if (d2 <= r2 && d2 < bestSq) {
        bestSq = d2;
        bestIndex = poolIndex;
      }
    });
    if (bestIndex < 0) return null;
    const point = this.splatWorldPosition(bestIndex, new THREE.Vector3());
    return { point, distance: Math.sqrt(bestSq) };
  }

  /**
   * Returns the first resident splat center inside a world-space ray cone.
   * This is a synchronous CPU query, intended for interactions that cannot
   * wait for (or rely on) a GPU readback. `radiusAtUnitDistance` is the cone's
   * world-space radius one unit from the origin; `minimumRadius` keeps nearby
   * point-like splats practical to target.
   *
   * Like {@link queryNearest}, this searches resident, undisplaced CPU centers.
   */
  queryRay(
    ray: THREE.Ray,
    radiusAtUnitDistance = 0.025,
    minimumRadius = 0.05,
  ): SplatRayResult | null {
    if (
      this.activeCount === 0 ||
      !(radiusAtUnitDistance >= 0) ||
      !(minimumRadius >= 0) ||
      ray.direction.lengthSq() === 0
    ) {
      return null;
    }
    this.updateWorldMatrix(true, false);
    const active = (this.sourceIndexAttribute.array as Uint32Array).subarray(0, this.activeCount);
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (const poolIndex of active) {
      this.splatWorldPosition(poolIndex, _queryWorld);
      _queryLocal.subVectors(_queryWorld, ray.origin);
      const distance = _queryLocal.dot(ray.direction);
      if (distance < 0 || distance >= bestDistance) continue;
      _queryLocal.addScaledVector(ray.direction, -distance);
      const radius = Math.max(minimumRadius, distance * radiusAtUnitDistance);
      if (_queryLocal.lengthSq() <= radius * radius) {
        bestIndex = poolIndex;
        bestDistance = distance;
      }
    }
    if (bestIndex < 0) return null;
    return {
      point: this.splatWorldPosition(bestIndex, new THREE.Vector3()),
      distance: bestDistance,
    };
  }

  /**
   * The supporting surface beneath a world point: the highest resident splat
   * that lies no more than `maxDrop` below it (world −Y) and within `radius`
   * horizontally, or `null` if none. A downward probe over splat centers - the
   * primitive behind floor-following and teleport validation - without a GPU
   * pick or a collision mesh (M9), so it works for every format, not only the
   * `.lcc2` captures that ship collision geometry.
   *
   * `radius` (default `maxDrop / 2`) is the horizontal tolerance: splats are
   * points, so an exact vertical hit is unlikely and a small disc is searched.
   * Resident-only semantics and the world-correctness contract (rotation +
   * per-axis scale supported, shear not) are the same as {@link queryNearest};
   * every candidate is judged in world space, where the −Y probe direction is
   * defined, so the vertical test never assumes local axis alignment.
   */
  queryHeight(
    worldPoint: THREE.Vector3,
    maxDrop: number,
    radius = maxDrop / 2,
  ): SplatHeightResult | null {
    if (this.activeCount === 0 || !(maxDrop >= 0) || !(radius >= 0)) return null;
    this.updateWorldMatrix(true, false);
    _queryLocal.copy(worldPoint);
    this.worldToLocal(_queryLocal);
    const grid = this.ensureQueryGrid();
    // A supporting splat is at most `maxDrop` below and `radius` aside, so it
    // lies within (maxDrop + radius) of the query in world units - gather that
    // sphere mapped conservatively to local space (divide by the smallest axis
    // scale), then judge each candidate in world space where "down" is
    // unambiguous.
    const gatherLocal = (maxDrop + radius) / this.queryWorldMinScale();
    const r2 = radius * radius;
    let bestY = -Infinity;
    let bestIndex = -1;
    grid.forEachWithin(_queryLocal.x, _queryLocal.y, _queryLocal.z, gatherLocal, (poolIndex) => {
      this.splatWorldPosition(poolIndex, _queryWorld);
      const drop = worldPoint.y - _queryWorld.y;
      if (drop < 0 || drop > maxDrop) return; // above the point, or too far below
      const dx = _queryWorld.x - worldPoint.x;
      const dz = _queryWorld.z - worldPoint.z;
      if (dx * dx + dz * dz > r2) return; // outside the horizontal disc
      if (_queryWorld.y > bestY) {
        bestY = _queryWorld.y;
        bestIndex = poolIndex;
      }
    });
    if (bestIndex < 0) return null;
    const point = this.splatWorldPosition(bestIndex, new THREE.Vector3());
    return { point, drop: worldPoint.y - point.y };
  }

  /**
   * Renders this mesh from a second camera - into `target`, or the canvas when
   * omitted - with depth order **and** projection correct for *that* camera
   * (M10). The primitive behind mirrors, portals, split panes, and thumbnails.
   *
   * Depth order is view-dependent, but a mesh keeps one sorted order buffer:
   * `update()` sorts it for the single camera it is given, so a second view
   * drawn with that order shows transparency/pop errors. `renderView` re-sorts
   * for `camera` into the shared buffer, sets the view-dependent uniforms
   * (viewport from `target`), draws, and marks the primary order stale so the
   * next `update()` re-sorts for the main camera. GPU submissions execute in
   * order, so each view's draw reads the order and uniforms it just wrote.
   *
   * Call once per extra view per frame, before or after the primary
   * `update()` + render - both are correct. On the WebGL2 fallback the sorter
   * is an asynchronous worker owned by the primary view, so `renderView` does
   * not sort at all there: the secondary view draws with the primary view's
   * order (projection is still per-camera correct) - a documented single-view
   * ordering limitation; WebGPU gets exact per-view order.
   *
   * @param target - Destination render target, or `null`/omitted for the canvas.
   */
  renderView(
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGPURenderer,
    target: THREE.RenderTarget | null = null,
  ): void {
    if (this.disposed) return;
    this.lastRenderer = renderer;
    camera.updateMatrixWorld();
    this.updateWorldMatrix(true, false);
    this.flushPendingUploads(renderer);
    if (target) _viewSize.set(target.width, target.height);
    else renderer.getDrawingBufferSize(_viewSize);
    this.writeViewUniforms(camera, _viewSize.x, _viewSize.y);
    const sorted = this.sortForView(camera, renderer);

    const previousTarget = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(target);
      renderer.render(this, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      // The shared order buffer now holds this view's order; force the primary
      // view to re-sort even when the secondary draw throws. Only when a sort
      // actually ran: WebGL2 still holds the primary order and must not fight
      // its asynchronous worker for a redundant re-sort.
      if (sorted) this.orderIsForeign = true;
    }
  }

  /**
   * Sorts the shared order buffer for a secondary view's camera, bypassing the
   * primary view's sort scheduler and its `lastSortedModelView` record (that
   * state belongs to `update()`'s camera). WebGPU dispatches synchronously into
   * the render queue, so the following draw reads this order.
   */
  private sortForView(camera: THREE.Camera, renderer: THREE.WebGPURenderer): boolean {
    if (this.activeCount === 0) return false;
    // The WebGL2 worker sorter is asynchronous and shared with the primary
    // view: submitting the secondary camera here would land the *secondary*
    // order between frames and claim the worker every frame ahead of the
    // primary's request - permanently starving the main view of its own sort.
    // Skip instead; the secondary view draws with the primary order (the
    // documented WebGL2 limitation).
    const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    if (!isWebGPU) return false;
    this.currentModelView.multiplyMatrices(camera.matrixWorldInverse, this.matrixWorld);
    this.refreshSortBounds();
    this.sorter ??= this.createSorter(renderer);
    if (!this.sorter) return false;
    this.sorter.sort(this.currentModelView, this.activeCount, this.boundingSphereLocal);
    return true;
  }

  /** Rebuilds the query grid if the resident set changed since it was built. */
  private ensureQueryGrid(): UniformGrid {
    if (this.queryGrid && this.queryGridEpoch === this.queryEpoch) return this.queryGrid;
    const active = (this.sourceIndexAttribute.array as Uint32Array).subarray(0, this.activeCount);
    this.queryGrid = new UniformGrid(this.backing.centers, active, this.activeCount);
    this.queryGridEpoch = this.queryEpoch;
    return this.queryGrid;
  }

  /** World-space position of pool splat `poolIndex`, written into `out`. */
  private splatWorldPosition(poolIndex: number, out: THREE.Vector3): THREE.Vector3 {
    const base = poolIndex * 4;
    out.set(
      this.backing.centers[base] as number,
      this.backing.centers[base + 1] as number,
      this.backing.centers[base + 2],
    );
    return out.applyMatrix4(this.matrixWorld);
  }

  /**
   * The smallest world axis scale, for conservatively mapping a world radius
   * into local space: a world sphere of radius `r` fits inside a local sphere
   * of `r / minAxisScale`, for any per-axis (non-uniform) scale.
   */
  private queryWorldMinScale(): number {
    this.getWorldScale(_queryScale);
    // decompose() negates scale.x for mirrored (negative-determinant)
    // transforms; a mirror preserves distances, but a negative radius would
    // silently null every query.
    return Math.min(Math.abs(_queryScale.x), Math.abs(_queryScale.y), Math.abs(_queryScale.z)) || 1;
  }

  /**
   * Releases every GPU resource and worker this mesh owns. Idempotent: a
   * second call is a no-op, and a render loop that outlives the mesh by a
   * frame is safe - {@link update}, {@link renderView} and {@link pick} all
   * become no-ops after dispose.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sorter?.dispose();
    this.sorter = null;
    this.geometry.dispose();
    (this.material as THREE.Material).dispose();
    this.picker.dispose();
    this.relightPlaceholder.dispose();
    // Leaving the pool releases this mesh's rows: `compact` accounts for every
    // row against a registered tenant, so a departing one must take its
    // allocations with it.
    for (const record of this.ranges.values())
      this.pool.releaseRows(record.startRow, record.rowCount);
    this.pool.unregister(this);
    // The pool's textures are disposed only by whoever owns the pool. A mesh
    // that built its own pool owns it; one handed a shared pool does not.
    if (this.ownsPool) this.pool.dispose();
    for (const texture of this.dataTextures) {
      if (!this.ownsPool && this.pool.isPoolTexture(texture)) continue;
      texture.dispose();
    }
    for (const channel of this.channels.values()) channel.texture.dispose();
    this.channels.clear();
    for (const cache of this.uploadStaging.values()) {
      for (const texture of cache.values()) texture.dispose();
    }
    this.uploadStaging.clear();
    this.halfEncodeBuffers.clear();
    // `sourceIndex` never sits in a geometry, so `geometry.dispose()` cannot
    // free its GPU buffer - release it through the renderer that uploaded it
    // (4 B/splat leaked per scene swap otherwise).
    if (this.lastRenderer) {
      releaseRendererAttributes(this.lastRenderer, [this.sourceIndexAttribute]);
      this.lastRenderer = null;
    }
    // Drop queued CPU work and cached references so nothing uploads or
    // rebuilds after teardown, and large arrays are unreachable promptly.
    this.pendingUploadRows = [];
    this.workerDirtyRows = [];
    this.queryGrid = null;
    this.ranges.clear();
  }

  /** Matches the viewport / focal / local-camera uniforms written by {@link update}. */
  private refreshProjectionUniforms(camera: THREE.Camera, renderer: THREE.WebGPURenderer): void {
    renderer.getDrawingBufferSize(_viewSize);
    this.writeViewUniforms(camera, _viewSize.x, _viewSize.y);
  }

  /**
   * Writes the three view-dependent uniforms - viewport, focal (splat screen
   * size), and the camera position in mesh-local space (SH view direction +
   * screen-radius math) - for a camera drawing into a viewport of the given
   * pixel size. {@link update} passes the canvas size (or, while an XR session
   * presents, the per-eye viewport); {@link renderView} passes its render
   * target's size.
   *
   * @param positionCamera - Camera whose world position seeds the SH view
   * direction and screen-radius math. Defaults to `camera`; in XR it is the
   * head, so both eyes shade from one cyclopean point while each still
   * projects through its own eye.
   */
  private writeViewUniforms(
    camera: THREE.Camera,
    viewportX: number,
    viewportY: number,
    positionCamera: THREE.Camera = camera,
  ): void {
    this.viewport.value.set(viewportX, viewportY);
    const projection = camera.projectionMatrix.elements;
    const focalY = (projection[5] * viewportY) / 2;
    this.focal.value.set((projection[0] * viewportX) / 2, focalY);
    positionCamera.getWorldPosition(this.localCameraPosition.value);
    this.worldToLocal(this.localCameraPosition.value);
    // Frontier cut: a splat draws while its projected node size ≈ target px, i.e.
    // own_size · focalY / distance ≤ targetPx ⇔ own_size / distance ≤ targetPx / focalY.
    // focalY is the vertical focal length in px, matching the view-space depth the
    // material uses as `distance`.
    if (this.foveationMode === 'frontier' && focalY > 0) {
      this.pixelScaleLimit.value = this.foveationLimitPx / focalY;
    }
  }

  /**
   * Self-adjusts {@link foveationLimitPx} so the frontier cut's drawn-splat count
   * tracks {@link foveationDrawBudget} (Spark's `maxSplats` feedback). Estimates
   * the drawn count by replaying the cut on a strided sample of the pool, then
   * coarsens (grows the limit) when over budget and refines (shrinks toward the
   * finest {@link foveationTargetPx}) when comfortably under. Throttled; a no-op
   * outside `'frontier'` mode.
   *
   * `viewportY` must be the **same** height {@link writeViewUniforms} is given
   * for this frame - the two share `foveationLimitPx` in pixels and each
   * converts it with its own `focalY`, so a mismatch (the full drawing buffer
   * here against a per-eye viewport there) makes the estimator judge a cut the
   * shader is not applying, and the ratchet runs away toward the maximum.
   */
  private adaptFoveationLimit(camera: THREE.Camera, viewportY: number): void {
    if (this.foveationMode !== 'frontier') return;
    const now = performance.now();
    if (now - this.lastFoveationAdaptAt < FOVEATION_ADAPT_MS) return;
    this.lastFoveationAdaptAt = now;

    const focalY = (camera.projectionMatrix.elements[5] * viewportY) / 2;
    if (!(focalY > 0)) return;
    const limit = this.foveationLimitPx / focalY;
    camera.getWorldPosition(_camLocal);
    this.worldToLocal(_camLocal);
    // model-view-projection into mesh-local space, so the estimate can frustum-
    // cull exactly like the material's `isVisible` - the budget is about splats
    // actually *on screen*, not the whole resident set (most of which sits behind
    // or beside the camera). Without this the limit over-coarsens ~6× and blurs.
    _adaptView.copy(camera.matrixWorld).invert();
    _adaptMvp.multiplyMatrices(_adaptView, this.matrixWorld).premultiply(camera.projectionMatrix);
    const m = _adaptMvp.elements;

    // Replay the material's frontier test (own_size from covariance trace,
    // signed parent_size in covarianceB.w) on every Nth in-frustum slot.
    const { covarianceA: cA, covarianceB: cB, centers } = this.backing;
    const slots = cB.length / 4;
    let sampled = 0;
    let drawn = 0;
    for (let i = 0; i < slots; i += FOVEATION_ADAPT_STRIDE) {
      const base = i * 4;
      const packedParent = cB[base + 3] as number;
      if (packedParent === 0) continue; // empty slot or non-frontier splat
      sampled++;
      const cx = centers[base] as number;
      const cy = centers[base + 1] as number;
      const cz = centers[base + 2] as number;
      // Frustum cull (clip-space, margin 1.2·w to match the material).
      const clipW = m[3] * cx + m[7] * cy + m[11] * cz + m[15];
      const margin = clipW * 1.2;
      const clipZ = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
      if (clipZ <= -margin) continue;
      const clipX = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
      if (clipX > margin || clipX < -margin) continue;
      const clipY = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
      if (clipY > margin || clipY < -margin) continue;

      const trace = (cA[base] as number) + (cA[base + 3] as number) + (cB[base + 1] as number);
      const ownSize = 2 * Math.sqrt(Math.max(trace, 0) / 3);
      const isLeaf = packedParent < 0;
      const parentSize = Math.abs(packedParent);
      const dx = cx - _camLocal.x;
      const dy = cy - _camLocal.y;
      const dz = cz - _camLocal.z;
      const limitDist = limit * Math.sqrt(dx * dx + dy * dy + dz * dz);
      const ownCut = isLeaf ? 0 : ownSize;
      if (parentSize > limitDist && ownCut <= limitDist) drawn++;
    }
    if (sampled === 0) return;

    const estimatedDrawn = drawn * FOVEATION_ADAPT_STRIDE;
    const budget = this.foveationDrawBudget;
    if (estimatedDrawn > budget * 1.1) {
      this.foveationLimitPx = Math.min(this.foveationLimitPx * 1.15, FOVEATION_LIMIT_MAX_PX);
    } else if (estimatedDrawn < budget * 0.7) {
      this.foveationLimitPx = Math.max(this.foveationLimitPx / 1.12, this.foveationTargetPx);
    }
  }

  /** Records a written row span for GPU upload and the sort-worker mirror. */
  private markRowsWritten(start: number, count: number): void {
    this.pendingUploadRows.push({ start, count });
    // The worker mirror only needs deltas once a WorkerSorter exists; it
    // snapshots the whole pool at creation time.
    if (this.sorter?.kind === 'worker') this.workerDirtyRows.push({ start, count });
  }

  /** Appends one newly active pool range to the packed source-index list. */
  private activateRecord(record: RangeRecord): void {
    const count = record.activePrefix ?? record.count;
    if (count === 0) return;
    this.queryEpoch++;
    const source = this.sourceIndexAttribute.array as Uint32Array;
    const identity = this.getPoolIndexTemplate();
    const activeStart = this.activeCount;
    source.set(identity.subarray(record.start, record.start + count), activeStart);
    this.activeSlotByPoolIndex.set(
      identity.subarray(activeStart, activeStart + count),
      record.start,
    );
    this.activeCount += count;
    this.commitActiveListMutation(activeStart, count);
  }

  /**
   * Removes one active range and backfills its holes from the packed tail.
   * The common contiguous case uses one native block copy; the fallback
   * handles a range split by earlier tail backfills in O(record.count).
   */
  private deactivateRecord(record: RangeRecord): void {
    const activeLen = record.activePrefix ?? record.count;
    if (activeLen === 0) return;
    this.queryEpoch++;
    const source = this.sourceIndexAttribute.array as Uint32Array;
    const firstSlot = this.activeSlotByPoolIndex[record.start] as number;
    let contiguous = true;
    for (let index = 1; index < activeLen; index++) {
      if (this.activeSlotByPoolIndex[record.start + index] !== firstSlot + index) {
        contiguous = false;
        break;
      }
    }

    let dirtyStart = this.activeCount;
    let dirtyEnd = 0;
    if (contiguous) {
      const nextActiveCount = this.activeCount - activeLen;
      const copyCount = Math.min(activeLen, Math.max(0, nextActiveCount - firstSlot));
      if (copyCount > 0) {
        source.copyWithin(firstSlot, this.activeCount - copyCount, this.activeCount);
        for (let index = 0; index < copyCount; index++) {
          const movedPoolIndex = source[firstSlot + index] as number;
          this.activeSlotByPoolIndex[movedPoolIndex] = firstSlot + index;
        }
        dirtyStart = firstSlot;
        dirtyEnd = firstSlot + copyCount;
      }
      this.activeCount = nextActiveCount;
    } else {
      for (let poolIndex = record.start; poolIndex < record.start + activeLen; poolIndex++) {
        const slot = this.activeSlotByPoolIndex[poolIndex] as number;
        const lastSlot = this.activeCount - 1;
        if (slot !== lastSlot) {
          const movedPoolIndex = source[lastSlot] as number;
          source[slot] = movedPoolIndex;
          this.activeSlotByPoolIndex[movedPoolIndex] = slot;
          dirtyStart = Math.min(dirtyStart, slot);
          dirtyEnd = Math.max(dirtyEnd, slot + 1);
        }
        this.activeCount--;
      }
      dirtyEnd = Math.min(dirtyEnd, this.activeCount);
    }

    this.commitActiveListMutation(dirtyStart, Math.max(0, dirtyEnd - dirtyStart));
  }

  /** Uploads only the changed packed slots and invalidates the current depth order. */
  private commitActiveListMutation(start: number, count: number): void {
    if (count > 0) {
      addMergedUpdateRange(this.sourceIndexAttribute, start, count);
      this.sourceIndexAttribute.needsUpdate = true;
    }

    // Until the asynchronous WebGL worker returns, keep its draw list on a
    // valid unsorted active permutation. WebGPU compute sorters overwrite
    // the draw storage themselves and do not need this CPU mirror.
    if (this.sorter?.kind === 'worker' || this.sorter === null) {
      const source = this.sourceIndexAttribute.array as Uint32Array;
      const draw = this.splatIndexAttribute.array as Float32Array;
      if (this.drawListSorted) {
        // The draw list holds a depth permutation; a slot-wise patch (or a
        // bare instanceCount truncation on removal, count === 0 here) would
        // draw removed splats twice and drop live ones until the worker's
        // next order arrives. Resync the whole drawn prefix to the identity
        // active order instead - one frame unsorted beats frames of garbage.
        // Later mutations in the same tick take the cheap patch path below.
        draw.set(source.subarray(0, this.activeCount));
        if (this.activeCount > 0) {
          addMergedUpdateRange(this.splatIndexAttribute, 0, this.activeCount);
        }
        this.splatIndexAttribute.needsUpdate = true;
        this.drawListSorted = false;
      } else if (count > 0) {
        draw.set(source.subarray(start, start + count), start);
        addMergedUpdateRange(this.splatIndexAttribute, start, count);
        this.splatIndexAttribute.needsUpdate = true;
      }
    }
    (this.geometry as THREE.InstancedBufferGeometry).instanceCount = this.activeCount;
    this.activeListVersion++;
    this.sortScheduler.invalidateContent();
  }

  /** Rewrites the active-splat list (pool indices, range by range). */
  private rebuildActiveList(): void {
    const source = this.sourceIndexAttribute.array as Uint32Array;
    const identity = this.getPoolIndexTemplate();
    let cursor = 0;
    for (const record of this.ranges.values()) {
      if (!record.active) continue;
      // Honor a partial activation: only the used prefix of a page-table slab
      // participates (matching activateRecord), never the whole allocation.
      const count = record.activePrefix ?? record.count;
      source.set(identity.subarray(record.start, record.start + count), cursor);
      this.activeSlotByPoolIndex.set(identity.subarray(cursor, cursor + count), record.start);
      cursor += count;
    }
    this.activeCount = cursor;
    this.sourceIndexAttribute.clearUpdateRanges();
    if (cursor > 0) this.sourceIndexAttribute.addUpdateRange(0, cursor);
    this.sourceIndexAttribute.needsUpdate = true;

    // Without a GPU sorter the draw list must hold the active pool indices
    // itself, or the first instances would render pool slots 0..n-1
    // regardless of where the active ranges live. The CPU sorter then
    // replaces this identity order asynchronously.
    if (this.sorter?.kind === 'worker' || this.sorter === null) {
      const draw = this.splatIndexAttribute.array as Float32Array;
      draw.set(source.subarray(0, cursor));
      this.splatIndexAttribute.clearUpdateRanges();
      if (cursor > 0) this.splatIndexAttribute.addUpdateRange(0, cursor);
      this.splatIndexAttribute.needsUpdate = true;
      this.drawListSorted = false;
    }
    (this.geometry as THREE.InstancedBufferGeometry).instanceCount = cursor;

    // Pool-index changes invalidate the current draw order. Force the next
    // sort instead of displaying a stale permutation during a streaming swap.
    this.activeListVersion++;
    this.sortScheduler.invalidateContent();
  }

  /** The pool's reusable index ramp; shared by every mesh drawing from it. */
  private getPoolIndexTemplate(): Uint32Array {
    return this.pool.indexTemplate();
  }

  /**
   * Uploads rows written since the last flush by copying only those rows
   * through a staging texture. (Constructor-time writes never appear here;
   * they ride the textures' initial full upload instead.)
   */
  private flushPendingUploads(renderer: THREE.WebGPURenderer): void {
    // The four core pool textures share one dirty-row set (they are written
    // together), each RGBA (4 components).
    if (this.pendingUploadRows.length > 0) {
      const floatType =
        this.poolFloatTextures === 'float16' ? THREE.HalfFloatType : THREE.FloatType;
      this.uploadRows(renderer, this.pendingUploadRows, THREE.RGBAFormat, 4, [
        {
          key: 'centers',
          texture: this.dataTextures[0] as THREE.DataTexture,
          data: this.backing.centers,
          type: floatType,
          encodeHalf: this.poolFloatTextures === 'float16',
        },
        {
          key: 'colors',
          texture: this.dataTextures[1] as THREE.DataTexture,
          data: this.backing.colors,
          type: THREE.UnsignedByteType,
        },
        {
          key: 'covarianceA',
          texture: this.dataTextures[2] as THREE.DataTexture,
          data: this.backing.covarianceA,
          type: floatType,
          encodeHalf: this.poolFloatTextures === 'float16',
        },
        {
          key: 'covarianceB',
          texture: this.dataTextures[3] as THREE.DataTexture,
          data: this.backing.covarianceB,
          type: THREE.FloatType,
        },
      ]);
      // Packed SH is written by the same calls and so shares those dirty
      // rows, but it is an integer format and cannot ride the same copy.
      if (this.shPackedTextures.length > 0) {
        this.uploadRows(
          renderer,
          this.pendingUploadRows,
          THREE.RGBAIntegerFormat,
          4,
          this.shPackedTextures.map((texture, group) => ({
            key: `shPacked${group}`,
            texture,
            data: this.backing.shPacked[group] as Uint32Array,
            type: THREE.UnsignedIntType,
          })),
        );
      }
      this.pendingUploadRows = [];
    }
    // Each channel is single-component (Red) and tracks its own dirty rows.
    for (const [name, channel] of this.channels.entries()) {
      if (channel.pendingRows.length === 0) continue;
      this.uploadRows(renderer, channel.pendingRows, THREE.RedFormat, 1, [
        {
          key: `channel:${name}`,
          texture: channel.texture,
          data: channel.backing,
          type: channel.textureType,
        },
      ]);
      channel.pendingRows = [];
    }
  }

  /**
   * Packs float32 CPU backing into the half GPU images for centers/covA.
   * Used once after a static constructor write so the initial `needsUpdate`
   * upload carries half bits (staging is skipped for that path).
   */
  private syncHalfFloatPoolImages(): void {
    const centersTex = this.dataTextures[0] as THREE.DataTexture;
    const covATex = this.dataTextures[2] as THREE.DataTexture;
    const centersImg = centersTex.image.data as Uint16Array;
    const covAImg = covATex.image.data as Uint16Array;
    encodeFloat32ToHalf(this.backing.centers, centersImg);
    encodeFloat32ToHalf(this.backing.covarianceA, covAImg);
    centersTex.needsUpdate = true;
    covATex.needsUpdate = true;
  }

  /**
   * Uploads the given row spans of one or more same-layout pool textures via
   * per-region staging copies. Spans are merged first so consecutive appends
   * upload as one rectangle each - the copyTextureToTexture call count, not
   * the pixel volume, dominates.
   */
  private uploadRows(
    renderer: THREE.WebGPURenderer,
    rows: { start: number; count: number }[],
    format: THREE.PixelFormat,
    components: number,
    entries: {
      key: string;
      texture: THREE.DataTexture;
      data: Float32Array | Uint8Array | Uint32Array;
      type: THREE.TextureDataType;
      /** When set, `data` is float32 backing encoded to half bits for staging. */
      encodeHalf?: boolean;
    }[],
  ): void {
    const width = SplatMesh.DATA_TEXTURE_WIDTH;
    // Sorting in place is safe: every caller discards its pending-rows list
    // right after the flush, and re-passing an already-sorted list is a no-op.
    const regions = rows.sort((a, b) => a.start - b.start);
    const merged: { start: number; count: number }[] = [];
    for (const region of regions) {
      const last = merged[merged.length - 1];
      if (last && region.start <= last.start + last.count) {
        last.count = Math.max(last.count, region.start + region.count - last.start);
      } else {
        merged.push({ start: region.start, count: region.count });
      }
    }
    for (const region of merged) {
      for (const { key, texture, data, type, encodeHalf } of entries) {
        const view = data.subarray(
          region.start * width * components,
          (region.start + region.count) * width * components,
        );
        let stagingData: Float32Array | Uint8Array | Uint32Array | Uint16Array = view;
        if (encodeHalf) {
          const half = this.acquireHalfEncodeBuffer(key, view.length);
          encodeFloat32ToHalf(view as Float32Array, half, 0, view.length);
          stagingData = half;
        }
        const staging = this.acquireUploadStaging(
          key,
          stagingData,
          width,
          region.count,
          format,
          type,
        );
        renderer.copyTextureToTexture(staging, texture, null, _uploadPosition.set(0, region.start));
      }
    }
  }

  /** Reuses a same-length half encode buffer for one staging key. */
  private acquireHalfEncodeBuffer(key: string, length: number): Uint16Array {
    const existing = this.halfEncodeBuffers.get(key);
    if (existing && existing.length === length) return existing;
    const buffer = new Uint16Array(length);
    this.halfEncodeBuffers.set(key, buffer);
    return buffer;
  }

  /**
   * Reuses one of the recent same-sized staging textures for this upload. WebGPU
   * texture dimensions are immutable, so each cached entry remains exact-sized. Keeping
   * a small LRU per channel avoids recreating all core/SH staging resources when
   * a stream alternates among a few chunk heights, while bounding GPU memory.
   */
  private acquireUploadStaging(
    key: string,
    data: Float32Array | Uint8Array | Uint32Array | Uint16Array,
    width: number,
    height: number,
    format: THREE.PixelFormat,
    type: THREE.TextureDataType,
  ): THREE.DataTexture {
    let cache = this.uploadStaging.get(key);
    if (!cache) {
      cache = new Map();
      this.uploadStaging.set(key, cache);
    }
    const existing = cache.get(height);
    if (existing) {
      existing.image = { data, width, height };
      existing.needsUpdate = true;
      // Map insertion order supplies a tiny LRU without another allocation.
      cache.delete(height);
      cache.set(height, existing);
      return existing;
    }
    const texture = new THREE.DataTexture(data, width, height, format, type);
    // An integer texture cannot be filtered; a staging texture that says
    // otherwise is rejected when its GPU descriptor is built.
    if (format === THREE.RGBAIntegerFormat) {
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
    }
    texture.needsUpdate = true;
    cache.set(height, texture);
    if (cache.size > UPLOAD_STAGING_CACHE_SIZE) {
      const oldestHeight = cache.keys().next().value as number;
      cache.get(oldestHeight)?.dispose();
      cache.delete(oldestHeight);
    }
    this.updateTimings.stagingTextureAllocations++;
    return texture;
  }

  /** Gathers everything the material graph reads. See `splat-mesh-material.ts`. */
  private graphInputs(
    textures: SplatMaterialTextures,
    sh: SplatShInputs | null,
  ): SplatMaterialBuildInputs {
    return {
      textures,
      sh,
      sourcePlacement: this.perSourceSort,
      // The uniform node instances, shared with the pick graph on purpose: one
      // per-frame write then reaches both.
      uniforms: {
        focal: this.focal,
        viewport: this.viewport,
        localCameraPosition: this.localCameraPosition,
        pixelScaleLimit: this.pixelScaleLimit,
        dofFocusDistance: this.dofFocusDistance,
        dofAperture: this.dofAperture,
        screenBandMin: this.screenBandMin,
        screenBandMax: this.screenBandMax,
        relightMap: this.relightMap,
        relightBlend: this.relightBlend,
        relightBrightness: this.relightBrightness,
        relightBackground: this.relightBackground,
        relightSoftness: this.relightSoftness,
      },
      pick: this.picker.uniforms,
      settings: {
        maxStdDev: this.maxStdDev,
        minSplatSizePx: this.minSplatSizePx,
        antialias: this.antialias,
        projectedFilterProfile: this.projectedFilterProfile,
        srgbOutput: this.srgbOutput,
        performanceProfile: this.performanceProfileValue,
        maxScreenRadiusPx: this.maxSplatScreenRadius,
        minScreenRadiusPx: this.minSplatScreenRadius,
        foveationMode: this.foveationMode,
        maxAspect: this.maxSplatAspect,
        lodAlpha: this.lodAlpha,
      },
      // The live map: a rebuild after defineChannel must see the new entry.
      channels: this.channels,
      modifiers: this.modifierList,
    };
  }

  private buildMaterial(textures: SplatMaterialTextures, sh: SplatShInputs | null): void {
    applySplatMaterialGraph(
      this.material as THREE.NodeMaterial,
      'display',
      this.graphInputs(textures, sh),
    );
    // Keeps the two graphs in step; a no-op until the first pick builds one.
    this.picker.rebuildMaterial();
  }

  private requestSortIfNeeded(camera: THREE.Camera, renderer: THREE.WebGPURenderer): void {
    if (this.deferSortRequestOnce) {
      this.deferSortRequestOnce = false;
      // Only a frame whose draw list the current order still describes can be
      // skipped. A staged group asks for this drain frame before it commits,
      // but other swap groups apply within the same tick - and a sort skipped
      // over their mutation renders the new instance count against the old
      // permutation: removed splats linger and live ones vanish for a frame.
      // A foreign order (a secondary renderView's) never describes the primary
      // draw, so it can't be skipped over either.
      if (this.activeListVersion === this.sortedActiveListVersion && !this.orderIsForeign) return;
    }
    if (this.activeCount === 0) return;
    this.currentModelView.multiplyMatrices(camera.matrixWorldInverse, this.matrixWorld);

    const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    const now = isWebGPU ? performance.now() : 0;
    // A secondary renderView left its own order in the shared buffer, so the
    // primary view must re-sort this frame however little its camera moved.
    if (!this.orderIsForeign) {
      if (isWebGPU) {
        if (
          !this.sortScheduler.shouldSubmit(
            this.currentModelView,
            this.lastSortedModelView,
            this.activeCount,
            now,
          )
        ) {
          return;
        }
      } else if (
        // WebGL2 has no cadence, but a content swap under a stationary camera
        // still invalidated the draw order (the swap reset it to unsorted
        // active order) - skipping here would leave the scene blend-order
        // broken until the camera next moved.
        !this.sortScheduler.hasPendingForce() &&
        this.currentModelView.equals(this.lastSortedModelView)
      ) {
        return;
      }
    }

    this.refreshSortBounds();

    this.sorter ??= this.createSorter(renderer);
    if (!this.sorter) return;
    if (this.sorter.sort(this.currentModelView, this.activeCount, this.boundingSphereLocal)) {
      this.lastSortedModelView.copy(this.currentModelView);
      this.sortedActiveListVersion = this.activeListVersion;
      this.orderIsForeign = false; // the buffer now holds the primary order again
      // On WebGL2 `now` is 0 - harmless, cadence timing is WebGPU-only; the
      // call still clears the pending-force flag consumed above.
      this.sortScheduler.markAccepted(now);
    }
  }

  /**
   * Refreshes {@link boundingSphereLocal} - the sphere the sorter quantizes
   * depth over - when {@link boundsDirty}. The base mesh uses its local splat
   * bounds; a unified {@link MergedSplatMesh} overrides this to supply a world-space
   * bound spanning all its sources (whose transforms live in the shader).
   */
  protected refreshSortBounds(): void {
    if (!this.boundsDirty) return;
    this.localBounds.getBoundingSphere(this.boundingSphereLocal);
    this.boundsDirty = false;
  }

  /** The data texture backing a channel defined with {@link defineChannel}. */
  protected channelTexture(name: string): THREE.DataTexture | undefined {
    return this.channels.get(name)?.texture;
  }

  /** CPU backing storage of a float channel, for internal CPU-side consumers. */
  protected channelBacking(name: string): Float32Array {
    const channel = this.channels.get(name);
    if (!channel || !(channel.backing instanceof Float32Array)) {
      throw new Error(`SplatMesh: float channel "${name}" is missing.`);
    }
    return channel.backing;
  }

  /**
   * Forces the next {@link update} to re-sort even if the camera has not moved
   * - used by a unified pool when a source's transform changes, since the depth
   * order then changes without any camera motion.
   */
  protected invalidateSort(): void {
    this.sortScheduler.invalidate();
    this.boundsDirty = true;
  }

  private createSorter(renderer: THREE.WebGPURenderer): SplatSorter | null {
    const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    if (!isWebGPU) {
      return new WorkerSorter({
        capacity: this.capacity,
        rowWidth: SplatMesh.DATA_TEXTURE_WIDTH,
        centers: this.backing.centers,
        perSource: this.perSourceSort
          ? {
              sourceIds: this.perSourceSort.sourceIds,
              matrices: this.perSourceSort.matrices,
            }
          : undefined,
        splatIndexAttribute: this.splatIndexAttribute,
        takeDirtyRows: () => {
          const rows = this.workerDirtyRows;
          this.workerDirtyRows = [];
          return rows;
        },
        getActiveSpans: () => {
          const spans = new Uint32Array(this.ranges.size * 2);
          let cursor = 0;
          for (const record of this.ranges.values()) {
            if (!record.active) continue;
            // The used prefix only (matching the active list): the full slab
            // count would make the worker sort - and the draw list render -
            // the inactive page-table tail in place of live splats.
            const count = record.activePrefix ?? record.count;
            if (count === 0) continue;
            spans[cursor++] = record.start;
            spans[cursor++] = count;
          }
          return spans.subarray(0, cursor);
        },
        onOrderApplied: () => {
          this.drawListSorted = true;
        },
      });
    }
    const options = {
      renderer,
      capacity: this.poolRows * SplatMesh.DATA_TEXTURE_WIDTH,
      centersTexture: this.centersTexture,
      dataTextureWidth: SplatMesh.DATA_TEXTURE_WIDTH,
      splatIndexAttribute: this.splatIndexAttribute,
      sourceIndexAttribute: this.sourceIndexAttribute,
    };
    // A per-source world transform (unified pool) needs the counting sorter's
    // world-depth path; radix has no equivalent, so it is not offered there.
    if (this.perSourceSort) {
      return new ComputeSorter({ ...options, perSource: this.perSourceSort });
    }
    if (this.sortStrategy === 'radix' || this.sortStrategy === 'exact') {
      this.ensureRadixSorter();
      if (!this.RadixSorterCtor) return null; // skip until the module resolves
      return new this.RadixSorterCtor({ ...options, exactDepth: this.sortStrategy === 'exact' });
    }
    return new ComputeSorter(options);
  }

  /** Prefetches the experimental radix sorter; safe to call repeatedly. */
  private ensureRadixSorter(): void {
    if (this.RadixSorterCtor || this.radixSorterLoad) return;
    this.radixSorterLoad = import('./radix-sorter')
      .then((mod) => {
        this.RadixSorterCtor = mod.RadixSorter;
      })
      .finally(() => {
        this.radixSorterLoad = null;
      });
  }
}

const _appendBox = new THREE.Box3();
const _uploadPosition = new THREE.Vector2();
const _queryLocal = new THREE.Vector3();
const _queryWorld = new THREE.Vector3();
const _queryScale = new THREE.Vector3();
const _viewSize = new THREE.Vector2();
const _camLocal = new THREE.Vector3();
const _adaptView = new THREE.Matrix4();
const _adaptMvp = new THREE.Matrix4();

/** How often the adaptive frontier limit re-estimates the drawn count (ms). */
const FOVEATION_ADAPT_MS = 180;
/** Sample every Nth pool slot when estimating the drawn count (a prime avoids
 * aliasing with the texture width). ~1/31 of the pool, throttled - a few ms. */
const FOVEATION_ADAPT_STRIDE = 31;
/** Coarsest the adaptive limit may grow to (px), so a pathological view can't
 * drive the whole scene to a single blob. */
const FOVEATION_LIMIT_MAX_PX = 64;

/**
 * Validates the public Gaussian cutoff override. `undefined` means "no
 * override", so the caller applies the device-aware default.
 */
function validateMaxStdDev(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new RangeError('SplatMesh maxStdDev must be a finite number greater than 0.');
  }
  return value;
}

/** A pixel floor of `0` disables it; negatives and non-finite values are errors. */
function validateMinSplatSizePx(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError('SplatMesh minSplatSizePx must be a finite number >= 0.');
  }
  return value;
}

/** Validates a screen-radius cull override; `0`/unset both mean "off". */
function validateMaxSplatScreenRadius(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('SplatMesh screen-radius cull must be a finite number ≥ 0.');
  }
  return value;
}

/** Default frontier-cut target size (px). Matches Spark's `lodRenderScale`
 * default of 1 - nodes refine until ~1 px on screen, so the draw budget (not a
 * coarser fixed cut) is what bounds detail. At the old value of 4 the cut
 * stopped ~2 LOD levels early everywhere the tree doesn't bottom out at
 * leaves, which made large-scale scenes visibly coarser than Spark. */
export const DEFAULT_FOVEATION_TARGET_PX = 1;

function validateFoveationTargetPx(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FOVEATION_TARGET_PX;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('SplatMesh foveationTargetPx must be a finite number > 0.');
  }
  return value;
}

/** Default target for the frontier cut's drawn-splat count (Spark's `maxSplats`).
 * Coarsens the cut once the estimate exceeds it, keeping frame cost bounded. */
export const DEFAULT_FOVEATION_DRAW_BUDGET = 900_000;

function validateFoveationDrawBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FOVEATION_DRAW_BUDGET;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('SplatMesh foveationDrawBudget must be a finite number > 0.');
  }
  return value;
}
