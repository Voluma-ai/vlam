/** Public configuration and result types for SplatMesh. */
import type * as THREE from 'three/webgpu';
import type { SplatData } from './splat-data';
import type { SplatOrientation } from './orientation';
import type { SplatModifier } from './splat-modifier';
import {
  detectSplatDeviceProfile,
  isFillConstrainedSplatDevice,
  type SplatDeviceProfile,
} from './splat-budget';
import type { SplatPool } from './splat-mesh-pool';
import type { SplatShInputs, Vec3Uniform } from './splat-mesh-material';

/** Construction-time projected-footprint policy selected by a streamed format. */
export type ProjectedFilterProfile = 'default' | 'lcc';

/** Canonical `.rad` foveation modes. */
export type SplatFoveationMode = 'band' | 'frontier' | 'page-table';

/** Resolve a caller-supplied foveation mode, defaulting when unset. */
export function resolveSplatFoveationMode(
  mode: SplatFoveationMode | undefined,
  fallback: SplatFoveationMode = 'band',
): SplatFoveationMode {
  return mode ?? fallback;
}

/** True when the mode is the `.rad` page-table pager. */
export function isPageTableFoveation(mode: string | undefined): boolean {
  return mode === 'page-table';
}

/**
 * Opaque handle for a range of splats appended to a {@link SplatMesh},
 * used to remove the range again.
 */
export interface SplatRange {
  /** Number of splats in this range. */
  readonly count: number;
}

/**
 * Storage format of a per-splat channel (see {@link SplatMesh.defineChannel}).
 *
 *  - `'byte'`: one `Uint8` per splat (`r8unorm`). Compact - a good fit for
 *    masks and labels. `ctx.channel(name)` reads it back **normalized** to
 *    `[0, 1]`, so a painted `255` reads as `1.0`.
 *  - `'float'`: one `Float32` per splat (`r32float`), read back verbatim.
 */
export type SplatChannelType = 'byte' | 'float';

/** Options for {@link SplatMesh.defineChannel}. */
export interface SplatChannelOptions {
  /** Storage format; default `'float'`. */
  type?: SplatChannelType;
  /**
   * Value every splat starts at before any {@link SplatMesh.writeChannel}.
   * Default `0`. For `'byte'` channels this is a raw `0..255` value.
   */
  fill?: number;
}

/** The highest SH order this renderer evaluates (3rd → 15 coefficients). */
export const MAX_SH_BANDS = 3;

/**
 * The contribution-culling profile a mesh will use, given an optional
 * explicit override. Exported so callers that must decide something *before*
 * constructing the mesh - such as whether a streamed scene should fetch its
 * SH at all - agree with what the mesh itself will pick.
 */
export function resolveSplatPerformanceProfile(
  explicit?: SplatPerformanceProfile,
  profile: SplatDeviceProfile | undefined = detectSplatDeviceProfile(),
): SplatPerformanceProfile {
  return explicit ?? (isFillConstrainedSplatDevice(profile) ? 'smooth' : 'quality');
}

/** Construction options for {@link SplatMesh}. */
export interface SplatMeshOptions {
  /**
   * Storage for per-splat higher-order SH in a dynamic-capacity pool, in
   * bands (1, 2 or 3 → 3, 8 or 15 coefficients per channel); 0 (default)
   * allocates nothing.
   *
   * Only formats that store SH per splat can fill this - LCC `Quality`, `.rad`, etc.
   * It costs 16 bytes per splat per band-group of four
   * coefficients (64 B/splat at 3 bands), so it is opt-in. On a static mesh
   * this is ignored: packed SH is taken from `source.shPacked` when present,
   * otherwise palette `source.sh` (SOG).
   */
  shBands?: 0 | 1 | 2 | 3;
  /**
   * Minimum interval between WebGPU sorts while the camera moves. When
   * omitted, the interval adapts to the active splat count. Use `0` to sort
   * every changed frame. WebGL worker sorting is unaffected.
   */
  sortIntervalMs?: number;
  /**
   * WebGPU sorter used for A/B validation. Defaults to the proven counting
   * sorter. `'radix'` keeps the fast 24-bit key path; `'exact'` lazy-loads a
   * stable 32-bit Float32-depth radix path that avoids scene-range
   * quantization. The first frames may skip sorting until the module resolves.
   *
   * @experimental Radix strategies may change in a minor release.
   */
  sortStrategy?: SplatSortStrategy;
  /**
   * Render-quality policy. `smooth` rejects negligible projected contributions.
   *
   * The default is device-aware: `smooth` on mobile (where rejecting splats too
   * small or too faint to see is worth far more than it costs), `quality`
   * everywhere else. Passing a value opts out of the detection.
   */
  performanceProfile?: SplatPerformanceProfile;
  /**
   * How far out, in standard deviations, each Gaussian is drawn before it is
   * cut off. Every splat is an alpha-blended quad sized to this radius, so it
   * sets how much each one costs to blend - the dominant cost in a busy view.
   * Lowering it shrinks every quad and clips the faint outer tail of each
   * Gaussian; the falloff within the remaining radius is unchanged.
   *
   * Defaults to `3`, the reference 3DGS rasterizer's radius. Below ~2 the
   * truncation shows as visible splat edges; much above ~5 the extra fill is not
   * worth it. Mobile coverage gaps are handled by `minSplatSizePx` instead of
   * growing every splat.
   */
  maxStdDev?: number;
  /**
   * Floor, in viewport pixels, on each rendered splat's projected quad radius.
   *
   * A screen-space *minimum* size, the counterpart to `maxScreenRadiusPx`'s
   * maximum. When a splat projects smaller than this - because it is distant, or
   * because the whole scene is zoomed out - its quad is grown to this radius and
   * the Gaussian is stretched to fill it (the falloff normalizes to the quad, so
   * no hard edge appears). Splats already larger are untouched, so it costs no
   * extra fill on the near-camera splats that dominate overdraw.
   *
   * This is the fix for the "dark gaps when zoomed out" failure mode: a capture
   * whose finest splats are spaced farther apart than their footprint leaves the
   * background showing between them, and the effect is worst at low resolution -
   * i.e. on a phone. Raising `maxStdDev` also closes the gaps but inflates
   * *every* splat's fragment count by its square, paying the coverage cost on the
   * large splats too; this floor spends it only where a gap can actually open.
   *
   * Defaults to `1.5` px on mobile and `0` (disabled) elsewhere, including
   * fill-constrained desktops. Values around 1–3 px close typical gaps; too
   * large a floor blurs distinct small features into discs, so tune it up from
   * small on the target device. An explicit `0` always disables the floor.
   */
  minSplatSizePx?: number;
  /**
   * Apply the Mip-Splatting 2D antialiasing filter - the screen-space low-pass
   * dilation plus the opacity compensation that conserves each Gaussian's
   * integral, so small/distant splats stop over-brightening. Match the
   * exporter: enable it for scenes trained/exported with antialiasing (the SOG
   * `antialias` meta flag sets this automatically). Defaults to `false` (the
   * classic 3DGS dilation without compensation).
   */
  antialias?: boolean;
  /**
   * Internal format-selected reconstruction profile. Classic LCC uses the
   * XGRIDS-compatible 0.1 px² compensated low-pass; callers should leave this
   * unset and select a format through {@link StreamedSplatMesh.load} instead.
   *
   * @internal
   */
  projectedFilterProfile?: ProjectedFilterProfile;
  /**
   * Emit splat colors in sRGB (display) space instead of decoding them to the
   * renderer's linear working space. Pair with a renderer that skips output
   * conversion (`outputColorSpace = LinearSRGBColorSpace`, `NoToneMapping`,
   * inline sRGB encode for other materials via `renderer.contextNode`): splats
   * then alpha-composite on gamma-encoded values - the math 3DGS training
   * optimizes against, and what WebGL splat viewers render. Defaults to
   * `false` (linear working-space compositing).
   */
  srgbOutput?: boolean;
  /**
   * Cull any splat whose projected on-screen radius exceeds this many pixels,
   * rendering a hole instead. A physically large splat close to the camera -
   * a coarse merged LOD node (a Spark `.rad` "blob"), or a giant background
   * Gaussian - projects huge while a fine surface splat stays small, so this
   * removes the near-camera blobs without touching detailed geometry. `0` or
   * unset disables it (the default). Baked into the material graph.
   */
  maxSplatScreenRadius?: number;
  /**
   * Foveation band lower bound (px): cull any splat whose projected on-screen
   * radius is *below* this. Paired with {@link maxSplatScreenRadius}, only
   * splats sized `(min, max]` on screen draw. Because a `.rad` LOD tree's node
   * sizes shrink geometrically, exactly one level per view ray lands in the
   * band - near rays on fine leaves, far rays on coarse nodes - giving a
   * camera-distance foveated cut. `0` or unset disables it (the default).
   * Baked into the material graph. See `docs/formats/rad-notes.md` M14.6.
   */
  minSplatScreenRadius?: number;
  /**
   * How a `.rad` foveated mesh picks its per-splat LOD cut:
   * - `'band'` (default): the screen-radius band above
   *   ({@link minSplatScreenRadius}, {@link maxSplatScreenRadius}].
   * - `'frontier'`: Spark's exact tree cut - draw splat `i` iff its parent is
   *   too big and it is small enough (`parentPixelScale > limit ≥ ownPixelScale`),
   *   using per-splat `own_size`/`parent_size`. Full coverage by construction, no
   *   band leapfrogging. Baked into the material graph. See `docs/formats/rad-notes.md`.
   * - `'page-table'`: the {@link StreamedSplatMesh} default for `.rad` - a worker
   *   owns the tree traversal and pages only the *selected* frontier into the
   *   pool (Spark's selected-index model), so the whole splat budget buys
   *   on-screen detail. Requires the streamed `.rad` machinery; on a plain
   *   `SplatMesh` it has no worker to drive it.
   *
   * @experimental `.rad` foveation option; may change in a minor release.
   */
  foveationMode?: SplatFoveationMode;
  /**
   * Target on-screen size (px) for the frontier / page-table cut: it keeps one
   * LOD level per view ray whose projected node size is about this. Larger =
   * coarser/fewer splats, smaller = finer/denser. Default
   * {@link DEFAULT_FOVEATION_TARGET_PX} (1, matching Spark's `lodRenderScale`),
   * so the draw budget rather than the cut size is what bounds detail. Raise it
   * to trade sharpness for fill rate on weak GPUs.
   * Acts as the *finest* bound: the adaptive limit coarsens above it to hold the
   * draw budget but never dips below it.
   *
   * @experimental `.rad` foveation option; may change in a minor release.
   */
  foveationTargetPx?: number;
  /**
   * Target upper bound on the number of splats the frontier cut *draws*
   * (Spark's `maxSplats`). Each reschedule the cut's `pixelScaleLimit`
   * self-adjusts - coarsening when the estimated drawn count exceeds this - so
   * frame cost stays bounded as detail streams in. Default
   * {@link DEFAULT_FOVEATION_DRAW_BUDGET}. Only used in `'frontier'` mode.
   *
   * @experimental `.rad` foveation option; may change in a minor release.
   */
  foveationDrawBudget?: number;
  /**
   * Cap on a rendered splat's major/minor axis ratio (`0`/unset = off). A very
   * anisotropic Gaussian (a flat 3DGS disk edge-on, or an expansion-enlarged
   * coarse LOD node) otherwise projects to a long needle; this bounds its drawn
   * length to `maxSplatAspect`× its width. Baked into the material graph.
   *
   * @experimental `.rad` foveation option; may change in a minor release.
   */
  maxSplatAspect?: number;
  /**
   * Spark's LOD alpha encoding (`.rad`): the stored opacity is `alpha/2` so the
   * shader recovers `alpha ∈ [0,2]`, and `alpha > 1` marks a merged node rendered
   * with a grown σ-cutoff + super-Gaussian falloff. Set for foveated `.rad`.
   *
   * @experimental `.rad` foveation option; may change in a minor release.
   */
  lodAlpha?: boolean;
  /**
   * How the scene is oriented into the three.js Y-up world. `'y-up'` (default)
   * normalizes every known format to Y-up - 3DGS Y-down formats
   * (PLY/`.splat`/`.ksplat`/SOG) are flipped 180° about X; SPZ/`.rad` are
   * already Y-up; LCC keeps its own Z-up→Y-up matrix. `'source'` applies no
   * cosmetic flip and renders in the data frame (raw Spark / mkkellogg parity);
   * LCC still self-orients (that is format semantics, not part of the switch).
   *
   * For a fully loaded mesh the flip is chosen from {@link SplatData.format}
   * (stamped by the loaders); a dynamic-capacity mesh carries no format, so the
   * caller applies {@link yUpTransformForFormat} itself. See {@link SplatOrientation}.
   */
  orientation?: SplatOrientation;
  /**
   * GPU storage type for the pool's continuous float textures (`centers` and
   * `covarianceA`). `'float16'` uploads them as `rgba16float` (~16 B/splat
   * saved vs the default). CPU backing stays float32 (sorter, query, writes).
   *
   * `covarianceB` is always float32: it packs integer IDs (SOG palette labels,
   * RAD frontier parents) that half floats cannot represent exactly above
   * 2048. Colors and packed SH are unchanged. Construction-time only.
   */
  poolFloatTextures?: 'float32' | 'float16';
  /**
   * An existing pool to draw from instead of allocating one.
   *
   * Several meshes sharing a pool share its memory envelope: rows go to
   * whichever mesh needs them, so a mesh the camera is near can hold far more
   * than an even split would give it, and one that is far away holds almost
   * nothing - without every mesh having reserved a private ceiling up front.
   * This is the multi-mesh analogue of a single streamed mesh's LOD budget.
   *
   * The pool is *not* owned by the mesh: {@link SplatMesh.dispose} releases the
   * mesh's rows and leaves the textures alone, so the pool's creator disposes
   * it once every tenant is gone. `capacity` on the source is then only used
   * for the mesh's own draw list, not to size storage.
   *
   * Sharing costs a whole-pool stall when the pool fragments - see
   * {@link SplatMesh.compact}.
   */
  pool?: SplatPool;
  /**
   * The device's `maxTextureDimension2D`, forwarded to a pool this mesh
   * allocates for itself so an over-tall pool fails at construction with a
   * readable error instead of at first draw. Pass `deviceMaxTextureSize(renderer)`.
   *
   * Ignored when {@link SplatMeshOptions.pool} supplies the pool - that pool
   * was already checked when its creator built it.
   */
  maxTextureSize?: number;
}

/** Available WebGPU depth-sort implementations. */
export type SplatSortStrategy = 'counting' | 'radix' | 'exact';

/** Controls optional work during a per-frame source update. */
export interface SplatUpdateOptions {
  /** Leave sorting to {@link UnifiedSplatMesh}; uploads and LOD state still update. */
  sort?: boolean;
}

/**
 * Read-only GPU-facing view of a mesh's current active pool. It is consumed by
 * the M15.4 unified gather path; streamed meshes expose their current LOD cut
 * through the same view because they inherit {@link SplatMesh}.
 *
 * @experimental May change in a minor release.
 */
export interface UnifiedSourceView {
  /** Total addressable pool slots. */
  readonly capacity: number;
  /** Pool indices of active splats, packed from zero. */
  readonly sourceIndex: THREE.StorageBufferAttribute;
  /** Active entries at the front of {@link sourceIndex}. */
  readonly activeCount: number;
  /** Local-space centers, RGBA32F and pool-indexed. */
  readonly centersTexture: THREE.DataTexture;
  /** Source display color and opacity, RGBA8 and pool-indexed. */
  readonly colorsTexture: THREE.DataTexture;
  /** Upper covariance rows, RGBA32F and pool-indexed. */
  readonly covarianceATexture: THREE.DataTexture;
  /** Final covariance row, RGBA32F and pool-indexed. */
  readonly covarianceBTexture: THREE.DataTexture;
  /** Centers texture row width. */
  readonly dataTextureWidth: number;
  /** Current source-local → world transform. */
  readonly matrixWorld: THREE.Matrix4;
  /** Conservative world-space bound for depth quantization. */
  readonly worldBounds: THREE.Sphere;
  /** Higher-order color data resolved by the gather pass when present. */
  readonly sh: SplatShInputs | null;
  /** Effect hooks and their source-local data channels. */
  readonly modifiers: readonly SplatModifier[];
  /**
   * True when this source is itself a unified pool with per-source placement
   * (`MergedSplatMesh`). The gather path cannot resolve nested placement, so
   * `UnifiedSplatMesh` rejects these sources.
   */
  readonly hasSourcePlacement: boolean;
  readonly channels: ReadonlyMap<string, { texture: THREE.DataTexture }>;
  /** Same uniform node the source graph updates each frame. */
  readonly localCameraPosition: Vec3Uniform;
  /** Changes whenever a modifier graph must be rebuilt. */
  readonly graphRevision: number;
  /** Whether this source intentionally composites in display (sRGB) space. */
  readonly srgbOutput: boolean;
  /** Shared draw-path settings that must agree across unified sources. */
  readonly maxStdDev: number;
  /** Screen-space minimum splat radius, px (0 = off). */
  readonly minSplatSizePx: number;
  readonly antialias: boolean;
  /** Construction-time projected-footprint policy shared by one unified pass. */
  readonly projectedFilterProfile: ProjectedFilterProfile;
  /**
   * Whether this source stores Spark LOD alpha (`alpha ÷ 2`, `.rad`). The
   * gather recovers the full `alpha ∈ [0,2]`; the draw material then treats
   * `alpha > 1` as a merged node. Per source, not a compatibility field - a
   * scene may mix `.rad` and non-`.rad` sources.
   */
  readonly lodAlpha: boolean;
  /** Increments whenever pool-backed data or active residency changes. */
  readonly contentRevision: number;
}

/** Quality-compatible rendering or smoother contribution-culling rendering. */
export type SplatPerformanceProfile = 'quality' | 'smooth';

/**
 * Options for {@link SplatMesh.pick}.
 *
 * Picking returns the selected splat's rendered center plane (depth-tested
 * Gaussian coverage), not a persistent splat identifier or a collision mesh.
 */
export interface SplatPickOptions {
  /**
   * Minimum Gaussian opacity (after falloff × splat alpha) for a fragment to
   * count as a hit. Default `0.1`.
   */
  alphaThreshold?: number;
}

/**
 * Result of a successful {@link SplatMesh.pick}.
 *
 * The point lies on the frontmost splat's billboard plane at the picked
 * pixel - suitable for click-to-focus and placement anchors, not physics.
 */
export interface SplatPickResult {
  /** Hit position in world space. */
  readonly point: THREE.Vector3;
  /** Distance from the camera position to {@link point}. */
  readonly distance: number;
}

/**
 * Result of {@link SplatMesh.queryNearest}: the resident splat center closest
 * to the query point, in world space.
 */
export interface SplatNearestResult {
  /** The splat's center, in world space. */
  readonly point: THREE.Vector3;
  /** World-space distance from the query point to {@link point}. */
  readonly distance: number;
}

/** Result of a successful synchronous {@link SplatMesh.queryRay}. */
export interface SplatRayResult {
  /** Resident splat center in world space. */
  readonly point: THREE.Vector3;
  /** Distance along the ray from its origin to the center's closest plane. */
  readonly distance: number;
}

/**
 * Result of {@link SplatMesh.queryHeight}: the supporting surface found beneath
 * the query point (the highest resident splat within the drop and horizontal
 * radius), in world space.
 */
export interface SplatHeightResult {
  /** The supporting splat's center, in world space. */
  readonly point: THREE.Vector3;
  /** How far below the query point the surface sits (world units, ≥ 0). */
  readonly drop: number;
}
