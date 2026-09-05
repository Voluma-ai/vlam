/**
 * The TSL material graph behind `SplatMesh`.
 *
 * One graph serves both of the mesh's materials: `display` writes premultiplied
 * color, `pick` encodes linear view depth. They must stay one builder - a pick
 * that disagreed with the display about projection, covariance or visibility
 * would return hits for splats the viewer cannot see.
 *
 * Everything here runs once, at material build time, and reads only what the
 * mesh hands it, so these are free functions rather than methods. Note the two
 * inputs that must be passed live rather than copied: the uniform *node
 * instances* (display and pick share them, so a frame updates both at once) and
 * the channels map (a rebuild after `defineChannel` has to see the new entry).
 *
 * Internal. Nothing here is exported from `index.ts`.
 */
import * as THREE from 'three/webgpu';
import {
  Discard,
  Fn,
  If,
  attribute,
  colorSpaceToWorking,
  float,
  int,
  ivec2,
  mat3,
  mix,
  modelViewMatrix,
  cameraProjectionMatrix,
  positionGeometry,
  screenUV,
  storage,
  textureLoad,
  uint,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { SplatModifier } from './splat-modifier';
import { foldSplatModifierStack } from './splat-modifier-stack';
import type { SplatPerformanceProfile } from './splat-mesh';
import { SPLAT_DATA_TEXTURE_WIDTH } from './splat-mesh-pool';
import { MAX_DOF_VARIANCE } from './depth-of-field';

/**
 * Optional display-fragment RGB transform. It receives the unpremultiplied
 * splat RGB, screen UV, and drawing-buffer viewport nodes. The hook is never
 * used by picking or the vertex/gather paths.
 */
export type DisplayColorModifier = (
  rgb: THREE.Node<'vec3'>,
  screenUv: THREE.Node<'vec2'>,
  viewport: THREE.Node<'vec2'>,
) => THREE.Node<'vec3'>;

/**
 * Largest on-screen radius a splat quad may reach, in pixels. A splat crossing
 * the near plane projects to an unbounded size; clamping keeps one degenerate
 * splat from covering the screen and stalling the rasterizer.
 */
const MAX_SPLAT_RADIUS_PX = 512;

/**
 * Stand-in for an infinite `parent_size` (a root LOD node, or a splat whose
 * parent has not decoded yet) in the frontier cut: any finite `limit·distance`
 * is below it, so the node always passes the "parent too big" half of the test.
 * A large finite value avoids `Infinity` arithmetic in the shader.
 */
const FRONTIER_ROOT_SIZE = 1e30;

/** Default variance scale for isotropic point mode: (0.35 × min-axis)². */
export const DEFAULT_ISOTROPIC_VARIANCE_SCALE = 0.35 * 0.35;
/** Default isotropic screen-space sigma radius (px); only used when a modifier opts in. */
export const DEFAULT_ISOTROPIC_SCREEN_RADIUS_PX = 1.0;

/**
 * Blends `Σ` toward σ²·I where σ² = λ_min(Σ) · varianceScale. Spark point
 * mode sets every scale axis to min(scale)·0.35; since λ_min(Σ) = min(scale)²,
 * that is exactly σ² = (min·0.35)².
 *
 * λ_min is estimated without `Σ⁻¹` (near-singular on flat Gaussians, which
 * made n·Σ·n blow up into large blobs): take the min of the three axis
 * Rayleigh quotients and the Rayleigh along the longest row-cross of Σ (a
 * stable thin-axis hint when Σ is rank-deficient). The `normal` argument is
 * kept for call-site compatibility and ignored.
 */
export function applyIsotropicCovarianceOverride(
  covariance: THREE.Node<'mat3'>,
  _normal: THREE.Node<'vec3'>,
  mixFactor: THREE.Node<'float'>,
  varianceScale: THREE.Node<'float'>,
): THREE.Node<'mat3'> {
  const e0 = vec3(1, 0, 0);
  const e1 = vec3(0, 1, 0);
  const e2 = vec3(0, 0, 1);
  const row0 = covariance.mul(e0);
  const row1 = covariance.mul(e1);
  const row2 = covariance.mul(e2);
  const r0 = asNode<'float'>(row0.x);
  const r1 = asNode<'float'>(row1.y);
  const r2 = asNode<'float'>(row2.z);
  const crossA = row0.cross(row1);
  const crossB = row1.cross(row2);
  const crossC = row2.cross(row0);
  const lenA = crossA.length();
  const lenB = crossB.length();
  const lenC = crossC.length();
  const useA = lenA.greaterThanEqual(lenB).and(lenA.greaterThanEqual(lenC));
  const useB = lenB.greaterThan(lenA).and(lenB.greaterThanEqual(lenC));
  const axis = useA.select(crossA, useB.select(crossB, crossC));
  const thin = axis.div(axis.length().max(1e-12));
  const rThin = asNode<'float'>(thin.dot(covariance.mul(thin)));
  const minVar = asNode<'float'>(r0.min(r1).min(r2).min(rThin).max(1e-12));
  const isoVar = minVar.mul(varianceScale);
  const isoCov = mat3(vec3(isoVar, 0, 0), vec3(0, isoVar, 0), vec3(0, 0, isoVar));
  return asNode<'mat3'>(covariance.mul(float(1).sub(mixFactor)).add(isoCov.mul(mixFactor)));
}

/** Sets both screen-space eigenvalues to min(λ1, λ2) for a circular footprint. */
export function equalizeProjectedEigenvalues(
  lambda1: THREE.Node<'float'>,
  lambda2: THREE.Node<'float'>,
  mixFactor: THREE.Node<'float'>,
): { lambda1: THREE.Node<'float'>; lambda2: THREE.Node<'float'> } {
  const circle = lambda1.min(lambda2);
  return {
    lambda1: asNode<'float'>(mix(lambda1, circle, mixFactor)),
    lambda2: asNode<'float'>(mix(lambda2, circle, mixFactor)),
  };
}

/**
 * Caps isotropic λ to a screen-space sigma radius while blending by mix.
 * `screenRadiusPx ≤ 0` is a no-op (opt-in only; 0 must not shrink λ toward zero).
 */
export function capProjectedEigenvaluesToScreenRadius(
  lambda1: THREE.Node<'float'>,
  lambda2: THREE.Node<'float'>,
  mixFactor: THREE.Node<'float'>,
  screenRadiusPx: THREE.Node<'float'>,
  maxStdDev: THREE.Node<'float'>,
): { lambda1: THREE.Node<'float'>; lambda2: THREE.Node<'float'> } {
  const targetVariance = screenRadiusPx.div(maxStdDev).pow(2);
  const circle = lambda1.min(lambda2).min(targetVariance);
  const capped1 = asNode<'float'>(mix(lambda1, circle, mixFactor));
  const capped2 = asNode<'float'>(mix(lambda2, circle, mixFactor));
  const enabled = screenRadiusPx.greaterThan(0);
  return {
    lambda1: asNode<'float'>(enabled.select(capped1, lambda1)),
    lambda2: asNode<'float'>(enabled.select(capped2, lambda2)),
  };
}

/** The pool data textures a graph samples per splat. */
export interface SplatMaterialTextures {
  centersTexture: THREE.DataTexture;
  colorsTexture: THREE.DataTexture;
  covarianceATexture: THREE.DataTexture;
  covarianceBTexture: THREE.DataTexture;
}

/** Narrow a TSL expression to the typed {@link THREE.Node} our hook contract
 * expects. Identity at runtime - satisfies TypeScript only. */
export function asNode<T extends string>(node: unknown): THREE.Node<T> {
  return node as THREE.Node<T>;
}

/** A `vec3` uniform, named so its type can be referred to in field decls. */
export function vec3Uniform() {
  return uniform(new THREE.Vector3());
}
export type Vec3Uniform = ReturnType<typeof vec3Uniform>;

/** A boolean uniform, named for optional graph inputs. */
export function boolUniform() {
  return uniform(false);
}
export type BoolUniform = ReturnType<typeof boolUniform>;

function vec2Uniform() {
  return uniform(new THREE.Vector2());
}
/** A `vec2` uniform (focal, viewport). */
export type Vec2Uniform = ReturnType<typeof vec2Uniform>;

function floatUniform() {
  return uniform(0);
}
/** A scalar uniform (pick thresholds and planes). */
export type FloatUniform = ReturnType<typeof floatUniform>;

/**
 * How the material reads a splat's higher-order SH coefficients. The two
 * sources differ only in where a coefficient comes from - the band
 * accumulation and view-direction math are shared:
 *
 *  - `palette`: SOG/`.lcc2` shN. Coefficients live in a per-file codebook and
 *    each splat stores a label; only a static mesh can use it, because two
 *    files' palettes cannot be merged into one pool.
 *  - `packed`: LCC `Quality`, `.rad`, etc. Each splat carries its own coefficients as packed
 *    words in pool-shaped textures, so appended ranges keep their SH.
 */
export type SplatShInputs =
  | { mode: 'palette'; bands: number; paletteTexture: THREE.DataTexture }
  | {
      mode: 'packed';
      bands: 1 | 2 | 3;
      textures: readonly THREE.DataTexture[];
      range: { min: Vec3Uniform; max: Vec3Uniform };
    };

/**
 * Per-source placement inputs for a unified pool ({@link MergedSplatMesh}): the
 * splat's source id plus the shared array of source matrices. Drives two things
 * at once - the splat's mesh-local position (`M · poolCenter`, applied before
 * the modifier stack) and the frame view-dependent SH is evaluated in.
 */
export interface SplatSourcePlacement {
  /** Pool-aligned source id channel. */
  sourceIdTexture: THREE.DataTexture;
  /** Four column vectors per source world matrix. */
  columns: ReturnType<typeof uniformArray>;
}

/**
 * The `mat4 · (poolCenter, 1)` placed center for source id `s`, plus the linear
 * 3×3 part as a `mat3`, read from the shared column array (three.js
 * `Matrix4.elements` are column-major, so a column maps to
 * `elements[k*4 .. k*4+3]`).
 *
 * Lives here rather than in `source-transform.ts` because the material graph and
 * the sorter must place a splat identically. Keeping it on the material side
 * also avoids a runtime dependency from `source-transform.ts` back into the
 * material graph.
 */
export function sourceWorldTransform(
  columns: ReturnType<typeof uniformArray>,
  sourceId: THREE.Node<'int'>,
  localCenter: THREE.Node<'vec3'>,
): { worldCenter: THREE.Node<'vec3'>; linear: THREE.Node<'mat3'> } {
  const base = sourceId.mul(int(4));
  const c0 = asNode<'vec4'>(columns.element(base));
  const c1 = asNode<'vec4'>(columns.element(base.add(int(1))));
  const c2 = asNode<'vec4'>(columns.element(base.add(int(2))));
  const c3 = asNode<'vec4'>(columns.element(base.add(int(3))));
  const worldCenter = asNode<'vec3'>(
    c0.xyz
      .mul(localCenter.x)
      .add(c1.xyz.mul(localCenter.y))
      .add(c2.xyz.mul(localCenter.z))
      .add(c3.xyz),
  );
  const linear = asNode<'mat3'>(mat3(c0.xyz, c1.xyz, c2.xyz));
  return { worldCenter, linear };
}

/** Coefficients per channel for a band count (0 → none, 3 → 3rd order). */
export function shCoefficientCount(bands: number): number {
  return [0, 3, 8, 15][bands] ?? 0;
}

/**
 * Builds the per-coefficient accessor for whichever SH source the mesh has -
 * the only part of the SH graph that differs between them.
 *
 * `palette` indirects through the splat's codebook label; `packed` reads the
 * splat's own words straight out of the pool-shaped integer textures and
 * unpacks them (R: bits 0-10, G: 11-20, B: 21-31, each a unit fraction of its
 * field, dequantized across the scene's range). The packed texel loads are
 * hoisted into variables so all 15 coefficients cost at most four fetches.
 */
export function shCoefficientReader(
  sh: SplatShInputs,
  textures: { covarianceBTexture: THREE.DataTexture },
  splatTexel: THREE.Node<'ivec2'>,
): (c: number) => THREE.Node<'vec3'> {
  if (sh.mode === 'palette') {
    const label = textureLoad(textures.covarianceBTexture, splatTexel).z.toInt();
    const column = label.mod(int(64)).mul(int(shCoefficientCount(sh.bands)));
    const row = label.div(int(64));
    return (c) => textureLoad(sh.paletteTexture, ivec2(column.add(int(c)), row)).xyz;
  }

  // An RGBA32UI fetch is a uvec4; TSL's types describe textureLoad as vec4,
  // so the element type is asserted rather than inferred. `toVar` hoists each
  // fetch, so all 15 coefficients cost at most four texture reads.
  const groups = sh.textures.map((texture) =>
    asNode<'uvec4'>(textureLoad(texture, splatTexel).toVar()),
  );
  const span = sh.range.max.sub(sh.range.min);
  return (c) => {
    const group = groups[c >> 2] as THREE.Node<'uvec4'>;
    const word = asNode<'uint'>([group.x, group.y, group.z, group.w][c & 3]);
    const channels = vec3(
      word.bitAnd(uint(0x7ff)).toFloat().div(2047),
      word.shiftRight(uint(11)).bitAnd(uint(0x3ff)).toFloat().div(1023),
      word.shiftRight(uint(21)).bitAnd(uint(0x7ff)).toFloat().div(2047),
    );
    return sh.range.min.add(span.mul(channels));
  };
}

/** Spherical harmonics basis constants for bands 1–3 (3DGS convention). */
const SH_C1 = 0.4886025119029199;
const SH_C2 = [
  1.0925484305920792, -1.0925484305920792, 0.31539156525252005, -1.0925484305920792,
  0.5462742152960396,
] as const;
const SH_C3 = [
  -0.5900435899266435, 2.890611442640554, -0.4570457994644658, 0.3731763325901154,
  -0.4570457994644658, 1.445305721320277, -0.5900435899266435,
] as const;

/** Evaluates a source's higher-order SH contribution for a local view direction. */
export function evaluateSplatSh(
  sh: SplatShInputs,
  textures: { covarianceBTexture: THREE.DataTexture },
  splatTexel: THREE.Node<'ivec2'>,
  direction: THREE.Node<'vec3'>,
): THREE.Node<'vec3'> {
  const x = direction.x;
  const y = direction.y;
  const z = direction.z;
  const coefficient = shCoefficientReader(sh, textures, splatTexel);
  const band1 = coefficient(0)
    .mul(y.mul(-SH_C1))
    .add(coefficient(1).mul(z.mul(SH_C1)))
    .add(coefficient(2).mul(x.mul(-SH_C1)));
  if (sh.bands === 1) return band1;

  const xx = x.mul(x);
  const yy = y.mul(y);
  const zz = z.mul(z);
  const band2 = band1
    .add(coefficient(3).mul(x.mul(y).mul(SH_C2[0])))
    .add(coefficient(4).mul(y.mul(z).mul(SH_C2[1])))
    .add(coefficient(5).mul(zz.mul(2.0).sub(xx).sub(yy).mul(SH_C2[2])))
    .add(coefficient(6).mul(x.mul(z).mul(SH_C2[3])))
    .add(coefficient(7).mul(xx.sub(yy).mul(SH_C2[4])));
  if (sh.bands === 2) return band2;

  return (
    band2
      .add(coefficient(8).mul(y.mul(xx.mul(3.0).sub(yy)).mul(SH_C3[0])))
      .add(coefficient(9).mul(x.mul(y).mul(z).mul(SH_C3[1])))
      .add(coefficient(10).mul(y.mul(zz.mul(4.0).sub(xx).sub(yy)).mul(SH_C3[2])))
      .add(coefficient(11).mul(z.mul(zz.mul(2.0).sub(xx.mul(3.0)).sub(yy.mul(3.0))).mul(SH_C3[3])))
      .add(coefficient(12).mul(x.mul(zz.mul(4.0).sub(xx).sub(yy)).mul(SH_C3[4])))
      .add(coefficient(13).mul(z.mul(xx.sub(yy)).mul(SH_C3[5])))
      // l=3, m=3 is x(x² − 3y²), not x(x² − y²).
      .add(coefficient(14).mul(x.mul(xx.sub(yy.mul(3.0))).mul(SH_C3[6])))
  );
}

/** Everything the material graph reads, gathered by the mesh. */
export interface SplatMaterialBuildInputs {
  /** Display-only RGB contribution cache; pick always evaluates the original graph. */
  shContribution?: THREE.StorageBufferAttribute;
  /** Selects cached SH, including bounded reuse between moving-camera sort updates. */
  shContributionEnabled?: BoolUniform;
  textures: SplatMaterialTextures;
  sh: SplatShInputs | null;
  /**
   * Per-source placement for a unified pool, or `null` for a plain mesh. When
   * present, a splat's mesh-local center is `M · poolCenter` and SH is
   * evaluated in the source's own frame.
   */
  sourcePlacement: SplatSourcePlacement | null;
  /** Optional display-only RGB transform; omitted means no extra graph work. */
  displayColorModifier: DisplayColorModifier | null;
  /**
   * The mesh's uniform *node instances*, not their values: display and pick
   * share them, so a per-frame write reaches both graphs.
   */
  uniforms: {
    focal: Vec2Uniform;
    viewport: Vec2Uniform;
    localCameraPosition: Vec3Uniform;
    /** Frontier-cut limit on `own_size / distance` (`foveationMode: 'frontier'`). */
    pixelScaleLimit: FloatUniform;
    /**
     * Core projected-2D DoF focus plane (world/view units). Live uniform -
     * racking focus does not rebuild the material. See `depth-of-field.ts`.
     */
    dofFocusDistance: FloatUniform;
    /** Core DoF aperture; `0` disables. Live uniform. */
    dofAperture: FloatUniform;
    /**
     * Screen-radius band bounds in px, live so a foveated mesh can follow its
     * own LOD cut. Whether the band exists at all is still decided at build
     * time from `settings.minScreenRadiusPx` / `maxScreenRadiusPx`; only the
     * bounds move.
     *
     * They have to move: the band spans one LOD level, so a mesh that refines
     * its cut to spend spare budget would have exactly that new detail culled
     * for being smaller than a bound chosen for the coarser cut.
     */
    screenBandMin: FloatUniform;
    screenBandMax: FloatUniform;
  };
  /** Pick-only uniforms. Required when building in `'pick'` mode. */
  pick: {
    alphaThreshold: FloatUniform;
    near: FloatUniform;
    far: FloatUniform;
  } | null;
  /** Baked at build time; changing any of these needs a rebuild. */
  settings: {
    maxStdDev: number;
    /** Screen-space floor on each quad axis, px (0/undefined = off). */
    minSplatSizePx?: number;
    antialias: boolean;
    /** Classic LCC uses XGRIDS' smaller, always-compensated low-pass. */
    projectedFilterProfile: 'default' | 'lcc';
    srgbOutput: boolean;
    performanceProfile: SplatPerformanceProfile;
    /** Cull splats whose projected radius exceeds this many px (0 = off). */
    maxScreenRadiusPx?: number;
    /** Foveation band lower bound: cull splats *below* this many px (0 = off). */
    minScreenRadiusPx?: number;
    /**
     * `.rad` foveation cut. `'band'` (default/undefined) uses the screen-radius
     * band above; `'frontier'` uses Spark's exact per-splat tree cut driven by
     * `own_size` (from the covariance) and the `parent_size` packed in
     * `covarianceB.w`. See `docs/formats/rad-notes.md` M14.6.
     */
    foveationMode?: 'band' | 'frontier' | 'page-table';
    /**
     * Cap on a rendered splat's major/minor axis ratio (0/undefined = off). Tames
     * far-field needle/spike artifacts from very anisotropic Gaussians and
     * expansion-enlarged coarse LOD nodes. Baked into the material graph.
     */
    maxAspect?: number;
    /**
     * Spark's LOD alpha encoding (`.rad`): the stored opacity byte is `alpha/2`,
     * so the shader multiplies by 2 to recover `alpha ∈ [0,2]`; `alpha > 1` marks
     * a merged node whose σ-cutoff grows (`+0.7·(remap−1)`) and whose falloff
     * becomes a super-Gaussian, covering its subtree without scaling covariance.
     */
    lodAlpha?: boolean;
  };
  /**
   * The mesh's live channel map, not a copy: `defineChannel` adds to it and
   * then rebuilds, and the graph must resolve names against the new entry.
   */
  channels: ReadonlyMap<string, { texture: THREE.DataTexture }>;
  modifiers: readonly SplatModifier[];
}

/**
 * Shared TSL graph for display and pick materials: projection, covariance,
 * modifiers, visibility, and Gaussian falloff. Display writes premultiplied
 * color; pick encodes linear view depth into RGB with alpha as the hit flag.
 *
 * @param inputs.pick - Required when `mode` is `'pick'`.
 */
export function applySplatMaterialGraph(
  material: THREE.NodeMaterial,
  mode: 'display' | 'pick',
  inputs: SplatMaterialBuildInputs,
): void {
  const { textures, sh, uniforms, settings, pick } = inputs;
  const textureWidth = int(SPLAT_DATA_TEXTURE_WIDTH);
  const maxRadius = float(MAX_SPLAT_RADIUS_PX);
  // The quad spans ±maxStdDev σ, so |quadPosition| = 1 sits at maxStdDev σ
  // and the Gaussian exponent -½·(maxStdDev·|q|)² folds to this constant.
  // Vertex extent and this exponent must agree or the falloff rescales.
  const gaussianExponent = -0.5 * settings.maxStdDev * settings.maxStdDev;

  // Per-instance index -> texel coordinate in the data textures.
  const splatIndex = attribute<'float'>('splatIndex', 'float').toInt();
  const splatTexel = ivec2(splatIndex.mod(textureWidth), splatIndex.div(textureWidth));

  // Varyings (computed in the vertex stage, constant across each quad).
  // With SH data, the view-dependent contribution - the higher SH bands
  // evaluated with the local view direction (Kerbl et al. convention,
  // coefficients read from the SOG palette) - is added to the base color.
  const baseColor = textureLoad(textures.colorsTexture, splatTexel);
  /** The splat's center as stored in the pool - its own source's data frame. */
  const poolCenter = textureLoad(textures.centersTexture, splatTexel).xyz;
  // Per-source placement is resolved here, ahead of everything else, so the
  // rest of the graph - modifier stack included - sees the splat where it
  // visually is. In a `MergedSplatMesh` the pool frame is an internal storage
  // detail; the splat's real mesh-local position is `M · poolCenter`. Applying
  // it outside the fold (rather than as modifier #0, which is what this used to
  // be) also makes it impossible for a host modifier's `offset`/`rotation` to
  // overwrite the placement - the fold replaces those fields, it does not
  // accumulate them.
  const placement = inputs.sourcePlacement;
  const placed = placement
    ? sourceWorldTransform(
        placement.columns,
        asNode<'int'>(textureLoad(placement.sourceIdTexture, splatTexel).r.toInt()),
        asNode<'vec3'>(poolCenter),
      )
    : null;
  /** Splat center in mesh-local space: the pool texel, or its placed position. */
  const localCenter = placed ? placed.worldCenter : asNode<'vec3'>(poolCenter);
  const cachedSh = mode === 'display' ? inputs.shContribution : undefined;
  const cachedRgb = cachedSh ? storage(cachedSh, 'float', cachedSh.count).toReadOnly() : null;
  const cacheEnabled = inputs.shContributionEnabled;
  const cachedOffset = splatIndex.mul(3);
  const uncachedShSum =
    sh === null
      ? null
      : (() => {
          const direction = (() => {
            if (!placed) return localCenter.sub(uniforms.localCameraPosition).normalize();
            // SH coefficients stay in their source frame. Transforming the
            // camera ray by the inverse linear placement is equivalent to
            // rotating every l=1..3 coefficient band, without re-uploading
            // per-splat packed coefficients when a source moves.
            return placed.linear
              .inverse()
              .mul(localCenter.sub(uniforms.localCameraPosition))
              .normalize();
          })();
          return evaluateSplatSh(sh, textures, splatTexel, direction);
        })();
  const shSum =
    uncachedShSum === null
      ? null
      : cachedRgb && cacheEnabled
        ? Fn(() => {
            // A value-level select would evaluate both sides and retain the
            // vertex SH cost even while the cache is active.
            const selected = vec3(0).toVar();
            If(cacheEnabled, () => {
              selected.assign(
                vec3(
                  cachedRgb.element(cachedOffset),
                  cachedRgb.element(cachedOffset.add(1)),
                  cachedRgb.element(cachedOffset.add(2)),
                ),
              );
            }).Else(() => {
              selected.assign(uncachedShSum);
            });
            return selected;
          })()
        : uncachedShSum;
  const colorAfterSh =
    shSum === null ? baseColor : vec4(baseColor.rgb.add(shSum).clamp(0.0, 1.0), baseColor.a);
  /** Approximate surface normal for lighting hooks: Σ⁻¹ amplifies the
   * least-variance axis (inverse iteration, two applications), oriented
   * toward the camera. Built only when a modifier reads `ctx.normal`. */
  const makeNormal = (): THREE.Node<'vec3'> => {
    const covA = textureLoad(textures.covarianceATexture, splatTexel);
    const covB = textureLoad(textures.covarianceBTexture, splatTexel);
    const poolSigma = mat3(
      vec3(covA.x.add(1e-8), covA.y, covA.z),
      vec3(covA.y, covA.w.add(1e-8), covB.x),
      vec3(covA.z, covB.x, covB.y.add(1e-8)),
    );
    // Run the inverse iteration in the *placed* frame, so a rotated source is
    // shaded consistently with the rest of the scene. Regularizing before the
    // placement (rather than adding εI to A·Σ·Aᵀ) avoids mat3 diagonal surgery
    // in TSL and still yields A·Σ·Aᵀ + ε·A·Aᵀ, positive-definite for any
    // nonsingular A - it degrades only for a source scaled to ~0, which is
    // degenerate everywhere else too.
    //
    // Note the A⁻ᵀ·n "normal transform" shortcut does not apply here: that
    // identity is for a level-set gradient, and the least-variance eigenvector
    // of A·Σ·Aᵀ is not A⁻ᵀ times the least-variance eigenvector of Σ.
    const sigma = placed
      ? asNode<'mat3'>(placed.linear.mul(poolSigma).mul(placed.linear.transpose()))
      : asNode<'mat3'>(poolSigma);
    const inverse = sigma.inverse();
    const toCamera = uniforms.localCameraPosition.sub(localCenter);
    const axis = inverse.mul(inverse.mul(toCamera)).normalize();
    return asNode<'vec3'>(axis.mul(axis.dot(toCamera).sign()));
  };

  /** Reads a per-splat channel (M7.3). Undefined name is a build error, not
   * a silent zero. `.r` holds the value (normalized for byte channels). */
  const makeChannel = (name: string): THREE.Node<'float'> => {
    const channel = inputs.channels.get(name);
    if (!channel) {
      throw new Error(
        `SplatMesh: a modifier reads channel "${name}", which is not defined. ` +
          `Call defineChannel("${name}") before assigning the modifier.`,
      );
    }
    return asNode<'float'>(textureLoad(channel.texture, splatTexel).r);
  };

  // Fold the modifier stack (empty stack ⇒ all fragments null and the
  // graph below is emitted exactly as the unhooked renderer).
  const stack = foldSplatModifierStack(inputs.modifiers, uniforms.localCameraPosition, {
    index: asNode<'int'>(splatIndex),
    localCenter,
    sourceCenter: asNode<'vec3'>(poolCenter),
    sourceToLocal: placed?.linear,
    color: asNode<'vec4'>(colorAfterSh),
    makeNormal,
    makeChannel,
  });

  // Source formats store display-ready sRGB colors while a regular Three.js
  // scene renders in its linear working space. Keep that conversion local to
  // the splat material so standard meshes can share the renderer without
  // forcing the entire canvas into LinearSRGBColorSpace.
  // With `srgbOutput` the stored sRGB color is emitted as-is: the renderer is
  // expected to skip output conversion, so splats alpha-composite on
  // gamma-encoded values (3DGS training / WebGL-viewer semantics).
  // Pick only needs opacity (a); keep the same color path so modifiers that
  // tint/fade alpha stay consistent with the display pass.
  const splatColor = varying(
    settings.srgbOutput
      ? asNode<'vec4'>(stack.color)
      : asNode<'vec4'>(colorSpaceToWorking(stack.color, THREE.SRGBColorSpace)),
  );
  const quadPosition = varying(positionGeometry.xy);
  const viewDepthVarying = mode === 'pick' ? varying(float(0), 'pickViewDepth') : null;
  // Opacity compensation for screen-space dilation (mip antialias and/or
  // core projected-2D DoF). Always present so DoF can fade opacity when
  // antialias is off; with both disabled the fade stays 1.
  const opacityCompensation = varying(float(1), 'vOpacityCompensation');
  // Spark LOD alpha (`.rad`): per-splat σ-cutoff and the recovered `alpha ∈ [0,2]`,
  // computed in the vertex stage and used by both the quad extent and the
  // fragment falloff. Only present with `lodAlpha`, so other formats are byte-
  // identical.
  const vAdjustedStdDev = settings.lodAlpha
    ? varying(float(settings.maxStdDev), 'vAdjustedStdDev')
    : null;
  const vAlpha2 = settings.lodAlpha ? varying(float(1), 'vAlpha2') : null;
  // Visual fade (modifier alpha / original encoded alpha). Applied after LOD
  // falloff so a marker crossfade cannot reclassify a merged node as a leaf.
  const vVisualOpacity = settings.lodAlpha ? varying(float(1), 'vVisualOpacity') : null;

  material.vertexNode = Fn(() => {
    const center = stack.offset === null ? localCenter : localCenter.add(stack.offset);
    const viewCenter = modelViewMatrix.mul(vec4(center, 1.0)).toVar();
    const clipCenter = cameraProjectionMatrix.mul(viewCenter).toVar();

    // Default: outside clip space, so culled splats emit no fragments.
    const clipPosition = vec4(0.0, 0.0, 2.0, 1.0).toVar();

    // Skip splats behind the camera or far outside the frustum - and
    // splats a modifier hides. Display uses a 1.2 NDC pad around the
    // center. Pick crops one source pixel onto the full NDC cube (1 px =
    // 2 NDC), so the same pad would keep only centers inside ~0.6 px of
    // the cursor. Expand by the screen-radius cap so a splat that covers
    // the clicked pixel still emits a quad.
    const frustumNdc = mode === 'pick' ? 1.2 + 2 * MAX_SPLAT_RADIUS_PX : 1.2;
    const margin = clipCenter.w.mul(frustumNdc);
    const inFrustum = clipCenter.z
      .greaterThan(margin.negate())
      // Match Spark's explicit far-plane rejection. Without this upper bound,
      // extreme capture outliers beyond `camera.far` still projected giant
      // translucent quads and polluted both the image and motion stability.
      .and(clipCenter.z.lessThan(clipCenter.w))
      .and(clipCenter.x.abs().lessThan(margin))
      .and(clipCenter.y.abs().lessThan(margin));
    const isVisible = stack.visible === null ? inFrustum : inFrustum.and(stack.visible);

    If(isVisible, () => {
      if (viewDepthVarying) viewDepthVarying.assign(viewCenter.z.negate());

      const covA = textureLoad(textures.covarianceATexture, splatTexel);
      const covB = textureLoad(textures.covarianceBTexture, splatTexel);
      const covarianceBase = mat3(
        vec3(covA.x, covA.y, covA.z),
        vec3(covA.y, covA.w, covB.x),
        vec3(covA.z, covB.x, covB.y),
      );
      // Placement first, outside the fold: Σ_placed = A·Σ·Aᵀ = (A·M)(A·M)ᵀ,
      // exact for any linear A (rotation, non-uniform scale, shear) because Σ
      // is by definition an outer product of a linear map. A maps the source's
      // data frame to mesh-local, so it is innermost; the host stack's rigid
      // rotation is authored in mesh-local and wraps it.
      const placedCovariance = placed
        ? asNode<'mat3'>(placed.linear.mul(covarianceBase).mul(placed.linear.transpose()))
        : asNode<'mat3'>(covarianceBase);
      // Rigid rotation is covariance-exact: Σ' = R·Σ·Rᵀ.
      let covariance3d: THREE.Node<'mat3'> =
        stack.rotation === null
          ? placedCovariance
          : asNode<'mat3'>(stack.rotation.mul(placedCovariance).mul(stack.rotation.transpose()));
      if (stack.isotropicCovarianceMix !== null) {
        const varianceScale =
          stack.isotropicVarianceScale ?? float(DEFAULT_ISOTROPIC_VARIANCE_SCALE);
        covariance3d = applyIsotropicCovarianceOverride(
          covariance3d,
          vec3(0, 0, 1),
          stack.isotropicCovarianceMix,
          varianceScale,
        );
      }

      // EWA splatting: project Σ to screen space, Σ' = J·W·Σ·Wᵀ·Jᵀ, with
      // J the Jacobian of the perspective projection. Written as dot
      // products: Σ'ₐᵦ = uₐᵀ·Σ·uᵦ where uₐ = Wᵀ·jₐ and jₐ are J's rows.
      const invZ = float(1.0).div(viewCenter.z);
      const invZ2 = invZ.mul(invZ);
      const j1 = vec3(
        uniforms.focal.x.mul(invZ),
        0.0,
        uniforms.focal.x.negate().mul(viewCenter.x).mul(invZ2),
      );
      const j2 = vec3(
        0.0,
        uniforms.focal.y.mul(invZ),
        uniforms.focal.y.negate().mul(viewCenter.y).mul(invZ2),
      );
      const viewRotationT = modelViewMatrix.toMat3().transpose();
      const u1 = viewRotationT.mul(j1);
      const u2 = viewRotationT.mul(j2);

      // 2×2 screen covariance [[a, b], [b, d]], low-pass filtered so every
      // splat covers at least about one pixel (3DGS paper). Uniform splat
      // scaling factors out of the quadratic form: Σ' = s²·Σ.
      const aQ = u1.dot(covariance3d.mul(u1));
      const dQ = u2.dot(covariance3d.mul(u2));
      const bQ = u1.dot(covariance3d.mul(u2));
      const aRaw = stack.scaleSquared === null ? aQ : aQ.mul(stack.scaleSquared);
      const dRaw = stack.scaleSquared === null ? dQ : dQ.mul(stack.scaleSquared);
      const bRaw = stack.scaleSquared === null ? bQ : bQ.mul(stack.scaleSquared);

      // XGRIDS classic LCC uses a 0.1 px² low-pass with integral-preserving
      // opacity compensation. Other formats retain the 3DGS 0.3 px² path.
      const lowPassVariance = settings.projectedFilterProfile === 'lcc' ? 0.1 : 0.3;
      const a = aRaw.add(lowPassVariance).toVar();
      const d = dRaw.add(lowPassVariance).toVar();
      const b = bRaw;

      // Mass conservation: √(det Σ / det(Σ + dilation)). Classic LCC always
      // compensates its low-pass; the standard path retains the existing
      // antialias-controlled compatibility behavior. Screen-capped isotropic
      // points skip the fade.
      const detBlur = a.mul(d).sub(b.mul(b)).max(1e-9).toVar();
      if (settings.antialias || settings.projectedFilterProfile === 'lcc') {
        const detForFade = aRaw.mul(dRaw).sub(bRaw.mul(bRaw)).max(0.0);
        const mipFade = detForFade.div(detBlur).sqrt();
        opacityCompensation.assign(
          stack.isotropicCovarianceMix === null
            ? mipFade
            : mix(mipFade, float(1), stack.isotropicCovarianceMix),
        );
      }

      // Aperture is a live uniform, so this remains a shader branch. With the
      // default zero aperture, depth/atan/CoC work is absent from the hot path
      // while the low-pass behavior above remains unchanged.
      If(uniforms.dofAperture.greaterThan(0), () => {
        // Core projected-2D DoF (Spark splatVertex.glsl). Aperture maps through
        // the live focus plane, so pulling focus toward the camera widens the
        // angle and softens the whole scene - the authored effect.
        const depth = viewCenter.z.negate().max(1e-4);
        const focus = uniforms.dofFocusDistance.max(1e-4);
        const halfApertureAngle = uniforms.dofAperture.mul(0.5).div(focus).atan();
        // Spark's falloff (`/depth`). Unbounded near the camera; MAX_DOF_VARIANCE
        // below is the fill-rate guard, exactly as Spark's maxPixelRadius is.
        const focusBlur = depth.sub(focus).abs().div(depth);
        const apertureRadius = uniforms.focal.x.mul(halfApertureAngle.tan());
        const cocRadiusPx = focusBlur.mul(apertureRadius);
        const cocVar = cocRadiusPx.mul(cocRadiusPx).min(float(MAX_DOF_VARIANCE));
        a.assign(aRaw.add(lowPassVariance).add(cocVar));
        d.assign(dRaw.add(lowPassVariance).add(cocVar));
        detBlur.assign(a.mul(d).sub(b.mul(b)).max(1e-9));
        const detForFade =
          settings.antialias || settings.projectedFilterProfile === 'lcc'
            ? aRaw.mul(dRaw).sub(bRaw.mul(bRaw)).max(0.0)
            : aRaw
                .add(lowPassVariance)
                .mul(dRaw.add(lowPassVariance))
                .sub(bRaw.mul(bRaw))
                .max(1e-9);
        const fade = detForFade.div(detBlur).sqrt();
        opacityCompensation.assign(
          stack.isotropicCovarianceMix === null
            ? fade
            : mix(fade, float(1), stack.isotropicCovarianceMix),
        );
      });

      // Eigen-decomposition of the 2×2 covariance gives the ellipse axes.
      // λ is variance in px², so √λ is the standard deviation in pixels;
      // the quad reaches `maxStdDev` σ per axis (3 = the reference 3DGS
      // rasterizer). The epsilon keeps the axis-aligned case finite.
      const mid = a.add(d).mul(0.5);
      const radius = vec2(a.sub(d).mul(0.5), b).length();
      let lambda1 = mid.add(radius);
      let lambda2 = mid.sub(radius).max(0.0);
      if (stack.isotropicCovarianceMix !== null) {
        const equalized = equalizeProjectedEigenvalues(
          lambda1,
          lambda2,
          stack.isotropicCovarianceMix,
        );
        lambda1 = equalized.lambda1;
        lambda2 = equalized.lambda2;
        // Screen-radius cap is opt-in; Spark-style point mode omits it so
        // world-space dots grow mildly on zoom-in instead of locking to 1 px.
        if (stack.isotropicScreenRadiusPx !== null) {
          const capped = capProjectedEigenvaluesToScreenRadius(
            lambda1,
            lambda2,
            stack.isotropicCovarianceMix,
            stack.isotropicScreenRadiusPx,
            float(settings.maxStdDev),
          );
          lambda1 = capped.lambda1;
          lambda2 = capped.lambda2;
        }
      }
      const eigenvector1 = vec2(b, lambda1.sub(a)).add(vec2(1e-6, 0.0)).normalize();
      // Spark's LOD alpha: recover `alpha ∈ [0,2]` from the *original* texture
      // channel (stored ÷2), never from modifier-resolved opacity. A merged node
      // (`alpha > 1`) grows the σ-cutoff `maxStdDev + 0.7·(remap−1)` (remap maps
      // 1..2 → 1..5) so it covers its subtree; the covariance is untouched. A leaf
      // keeps the base cutoff. Off (`lodAlpha` false) → the plain constant cutoff.
      let stdDev: THREE.Node<'float'> = float(settings.maxStdDev);
      if (settings.lodAlpha && vAdjustedStdDev && vAlpha2 && vVisualOpacity) {
        const encodedOriginal = asNode<'float'>(colorAfterSh.a);
        const alpha2 = asNode<'float'>(encodedOriginal.mul(2.0));
        const remap = alpha2.mul(4.0).sub(3.0).min(5.0);
        stdDev = asNode<'float'>(
          alpha2
            .greaterThan(1.0)
            .select(
              float(settings.maxStdDev).add(remap.sub(1.0).mul(0.7)),
              float(settings.maxStdDev),
            ),
        );
        vAdjustedStdDev.assign(stdDev);
        vAlpha2.assign(alpha2);
        vVisualOpacity.assign(
          encodedOriginal
            .greaterThan(0)
            .select(stack.color.a.div(encodedOriginal.max(1e-8)), float(1)),
        );
      }

      // Optional aspect-ratio clamp (off by default; Spark does not clamp aspect).
      const majorLambda =
        settings.maxAspect && settings.maxAspect > 0
          ? lambda1.min(lambda2.mul(settings.maxAspect * settings.maxAspect))
          : lambda1;
      // A screen-space *minimum* on each axis, the counterpart to `maxRadius`.
      // A splat that projects below the floor - distant, or the whole scene
      // zoomed out - grows to it so its Gaussian tiles with its neighbours
      // instead of leaving the background visible between them; the falloff
      // normalizes to the quad, so the bigger quad just renders a bigger soft
      // splat. `.max` after `.min` so an already-large splat is untouched (no
      // extra fill where no gap can open), and `minSplat <= maxRadius` keeps the
      // clamp order well-defined. Composes with the isotropic-point screen cap
      // above as long as the floor stays below it.
      const minSplat = float(settings.minSplatSizePx ?? 0);
      const majorAxis = eigenvector1.mul(
        majorLambda.sqrt().mul(stdDev).min(maxRadius).max(minSplat),
      );
      const minorAxis = vec2(eigenvector1.y, eigenvector1.x.negate()).mul(
        lambda2.sqrt().mul(stdDev).min(maxRadius).max(minSplat),
      );

      const writePosition = (): void => {
        const pixelOffset = majorAxis
          .mul(positionGeometry.x)
          .add(minorAxis.mul(positionGeometry.y));
        const ndcCenter = clipCenter.xy.div(clipCenter.w);
        clipPosition.assign(
          vec4(
            ndcCenter.add(pixelOffset.mul(2.0).div(uniforms.viewport)),
            clipCenter.z.div(clipCenter.w),
            1.0,
          ),
        );
      };
      // Per-splat LOD cut. `notBlob` is the "keep this splat" predicate (named
      // for the historical blob cull); null means "no cull, always draw".
      let notBlob: THREE.Node<'bool'> | null;
      if (settings.foveationMode === 'page-table') {
        // Spark's selected-index model: the CPU frontier already picked exactly
        // one node per root→leaf ray, and only those splats are paged into the
        // slab. Draw them all - any screen-size band here would re-cull the
        // selection (e.g. a 1.6–4px band reduces the scene to point dust and
        // makes splats *vanish* as the camera approaches and they outgrow it).
        notBlob = null;
      } else if (settings.foveationMode === 'frontier') {
        // Spark's exact tree cut (see `docs/formats/rad-notes.md` M14.6): draw splat i
        // iff its parent is too big on screen but it is small enough -
        //   parent_size / distance > limit ≥ own_size / distance
        // - so exactly one node per root→leaf ray survives (full coverage, no
        // band leapfrogging). A leaf has no finer level, so it draws whenever
        // its parent does.
        //
        // `own_size` (world) is recovered from the covariance: Σ = R·S²·Rᵀ, so
        // trace(Σ) = Σ scaleᵢ², and with the merged-node-expanded scales this
        // already carries the expansion - own_size = 2·√(trace/3) ≈
        // 2·expansion·rms(scale), the same measure `parent_size` uses.
        // `parent_size` is packed in `covarianceB.w`, sign-encoding leaf-ness:
        // >0 internal, <0 leaf, |v| = parent size (`FRONTIER_ROOT_SIZE` ≈ ∞ for a
        // root), and 0 (unwritten) is treated as a root so a splat never vanishes.
        const distance = viewCenter.z.negate();
        const trace = covA.x.add(covA.w).add(covB.y);
        const ownSize = trace
          .max(0.0)
          .mul(1 / 3)
          .sqrt()
          .mul(2.0);
        const packedParent = covB.w;
        const isLeaf = packedParent.lessThan(0.0);
        const absParent = packedParent.abs();
        const parentSize = absParent.equal(0.0).select(float(FRONTIER_ROOT_SIZE), absParent);
        const limitDist = uniforms.pixelScaleLimit.mul(distance);
        const ownCut = isLeaf.select(float(0.0), ownSize);
        notBlob = asNode<'bool'>(
          parentSize.greaterThan(limitDist).and(ownCut.lessThanEqual(limitDist)),
        );
      } else {
        // Optional screen-radius cull, using the *unclamped* projected radius
        // (`majorAxis`/`minorAxis` cap at maxRadius, so every big splat would look
        // identically sized). Two uses:
        //  - Blob cull (`maxScreenRadiusPx` only): drop splats bigger than the
        //    upper bound - a coarse merged `.rad` node near the camera hides,
        //    leaving a hole, without touching fine detail.
        //  - Foveation band (`minScreenRadiusPx` too): keep only splats whose
        //    on-screen radius is in `(min, max]`.
        const maxScreen = settings.maxScreenRadiusPx ?? 0;
        const minScreen = settings.minScreenRadiusPx ?? 0;
        const projRadius = lambda1.sqrt().mul(settings.maxStdDev);
        let inBand: THREE.Node<'bool'> | null = null;
        // The bounds are uniforms, not constants: a foveated mesh moves them
        // with its LOD cut (see `uniforms.screenBandMin`). The build-time
        // numbers only decide *whether* each side of the band exists.
        if (maxScreen > 0)
          inBand = asNode<'bool'>(projRadius.lessThanEqual(uniforms.screenBandMax));
        if (minScreen > 0) {
          const above = projRadius.greaterThan(uniforms.screenBandMin);
          inBand = asNode<'bool'>(inBand ? inBand.and(above) : above);
        }
        notBlob = inBand;
      }

      if (settings.performanceProfile === 'smooth') {
        // PlayCanvas-compatible contribution rejection. The library's
        // default quality profile bypasses this branch entirely.
        // Screen-capped isotropic points (~1 px) fail opacity·major·minor ≥ 3
        // once the camera approaches - skip the cull while mix > 0 so point
        // mode does not vanish on zoom-in (hosts typically default to `smooth`).
        const majorRadius = majorAxis.length();
        const minorRadius = minorAxis.length();
        const opacity = stack.color.a;
        const contributionOk = opacity
          .greaterThanEqual(1 / 255)
          .and(majorRadius.max(minorRadius).mul(2).greaterThanEqual(2))
          .and(opacity.mul(majorRadius).mul(minorRadius).greaterThanEqual(3));
        const passes =
          stack.isotropicCovarianceMix === null
            ? contributionOk
            : asNode<'bool'>(contributionOk.or(stack.isotropicCovarianceMix.greaterThan(0)));
        If(notBlob ? passes.and(notBlob) : passes, writePosition);
      } else if (notBlob) {
        If(notBlob, writePosition);
      } else {
        writePosition();
      }
    });

    return clipPosition;
  })();

  if (mode === 'display') {
    material.fragmentNode = Fn(() => {
      const squaredDistance = quadPosition.dot(quadPosition);
      Discard(squaredDistance.greaterThan(1.0));
      let opacity: THREE.Node<'float'>;
      if (settings.lodAlpha && vAdjustedStdDev && vAlpha2 && vVisualOpacity) {
        // Spark's LOD falloff. `g = exp(-½·adjustedStdDev²·|q|²)` is the Gaussian
        // at this fragment. A leaf composites `g · alpha`. A merged node
        // (`alpha > 1`) uses a super-Gaussian plateau `1 − (1 − g)^a`,
        // `a = exp((remap² − 1)/e)`, so a single coarse splat fills the footprint
        // of the subtree it stands in for - no covariance inflation.
        // Visual opacity (fade / alpha modifiers) scales the completed falloff.
        const g = squaredDistance.mul(vAdjustedStdDev.mul(vAdjustedStdDev).mul(-0.5)).exp();
        const remap = vAlpha2.mul(4.0).sub(3.0).min(5.0);
        const aExp = remap
          .mul(remap)
          .sub(1.0)
          .mul(1 / Math.E)
          .exp();
        const merged = g.oneMinus().pow(aExp).oneMinus();
        opacity = asNode<'float'>(
          vAlpha2.greaterThan(1.0).select(merged, g.mul(vAlpha2)).mul(vVisualOpacity),
        );
      } else {
        // True Gaussian falloff. |quadPosition| = 1 is `maxStdDev` σ from center.
        opacity = asNode<'float'>(squaredDistance.mul(gaussianExponent).exp().mul(splatColor.a));
      }
      const alpha = opacity.mul(opacityCompensation);
      const rgb = (
        inputs.displayColorModifier?.(splatColor.rgb, screenUV, uniforms.viewport) ?? splatColor.rgb
      ).toVar();
      return vec4(rgb.mul(alpha), alpha); // premultiplied alpha
    })();

    // Premultiplied "over" compositing; splats are sorted back-to-front.
    material.transparent = true;
    material.depthTest = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    // Splat billboards are symmetric; avoid three.js's default two-pass
    // DoubleSide submission for transparent materials.
    material.forceSinglePass = true;
    // Splat colors are already authored for display; scene exposure should not
    // re-grade them, but the renderer still performs the final sRGB encoding.
    material.toneMapped = false;
  } else {
    if (!pick) {
      throw new Error("applySplatMaterialGraph in 'pick' mode requires pick uniforms.");
    }
    material.fragmentNode = Fn(() => {
      const squaredDistance = quadPosition.dot(quadPosition);
      Discard(squaredDistance.greaterThan(1.0));
      let gaussian: THREE.Node<'float'>;
      if (settings.lodAlpha && vAdjustedStdDev && vAlpha2 && vVisualOpacity) {
        // Same LOD classification as display (original alpha); modifiers still
        // scale the hit threshold through the visual-opacity multiplier.
        const g = squaredDistance.mul(vAdjustedStdDev.mul(vAdjustedStdDev).mul(-0.5)).exp();
        const remap = vAlpha2.mul(4.0).sub(3.0).min(5.0);
        const aExp = remap
          .mul(remap)
          .sub(1.0)
          .mul(1 / Math.E)
          .exp();
        const merged = g.oneMinus().pow(aExp).oneMinus();
        gaussian = asNode<'float'>(
          vAlpha2.greaterThan(1.0).select(merged, g.mul(vAlpha2)).mul(vVisualOpacity),
        );
      } else {
        gaussian = asNode<'float'>(squaredDistance.mul(gaussianExponent).exp().mul(splatColor.a));
      }
      const alpha = gaussian.mul(opacityCompensation);
      Discard(alpha.lessThan(pick.alphaThreshold));

      // 24-bit normalized linear view depth → RGB; alpha marks a hit.
      const normalized = viewDepthVarying!
        .sub(pick.near)
        .div(pick.far.sub(pick.near))
        .clamp(0.0, 1.0);
      const depth = normalized.mul(16777215.0);
      const r = depth.div(65536.0).floor();
      const g = depth.mod(65536.0).div(256.0).floor();
      const b = depth.mod(256.0).floor();
      return vec4(r.div(255.0), g.div(255.0), b.div(255.0), 1.0);
    })();

    material.transparent = false;
    material.depthTest = true;
    material.depthWrite = true;
    material.side = THREE.DoubleSide;
    material.blending = THREE.NoBlending;
    material.toneMapped = false;
  }
}

export { foldSplatModifierStack };
