/**
 * `@voluma/vlam/effects` - optional, tree-shakeable effects built on the M7
 * {@link SplatModifier} contract. Import only what you use; nothing here is
 * pulled into the core renderer bundle.
 *
 *  - {@link sdfEffects}: a declarative sphere/box/cylinder shape list evaluated
 *    in-shader from a bounded uniform array (a fixed unroll over `maxShapes`
 *    slots, gated by the live count) - add/move/remove shapes is data-only
 *    (no pipeline recompile), on WebGPU and the WebGL2 fallback alike (M7.4).
 *    The kinds mirror the CPU selection volumes (`createSelectionVolume` on
 *    `@voluma/vlam/selection`), so a host can highlight exactly what a
 *    selection would take.
 *  - {@link lightingPreset} / {@link revealPreset}: small reference presets,
 *    starting points rather than a framework (M7.5).
 *  - {@link createRelightingProxy}: builds a gray lit mesh group from collision
 *    tiles (or raw geometries) for PlayCanvas-style {@link SplatMesh.setRelighting}.
 *  - {@link createRelightingShadowFactorMaterial}: writes a shadow **multiplier**
 *    (1 = lit, &lt;1 = umbra) so coverage does not statically tint splats.
 *    Accepts one light or {@link RelightingLightContribution}[] with intensity
 *    weights. Optional `color` / `diffuse` / `direction` add a Lambert boost on
 *    top of that identity (RGB may exceed 1 on a HalfFloat lighting RT).
 *  - {@link renderRelightingFactorMap}: host-safe lighting pass. Isolates
 *    `autoClear`, shadow maps, and swaps a passthrough `contextNode` so the
 *    example works on an existing `WebGPURenderer`, not only `createSplatRenderer`.
 *  - {@link worldWarpPreset}: camera-centered sphere wrap (planet / bowl).
 *  - {@link depthOfFieldPreset}: stylized modifier-based depth-of-field (M13).
 *    For physically-modeled camera DoF prefer the core
 *    {@link SplatMesh.setDepthOfField} / `UnifiedSplatRenderer.setDepthOfField`
 *    path - this preset is the soft/approximate alternative built purely on
 *    the modifier hook.
 *
 * Every preset here reads positions from `ctx.localCenter` - mesh-local space,
 * which inside a `SplatScene` is the splat's **placed** position. So a shape or
 * a reveal spans every source as one scene instead of travelling with a moved
 * one; see `docs/guide/effects-and-modifiers.md` for what that looks like, and
 * `ctx.sourceCenter` for the opposite behaviour.
 *
 * See `docs/guide/effects-and-modifiers.md`.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  float,
  int,
  mat3,
  min,
  mix,
  modelViewMatrix,
  normalWorld,
  objectPosition,
  positionWorld,
  shadow,
  smoothstep,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
  wgslFn,
  reference,
  frameGroup,
  cos,
} from 'three/tsl';
import type { SplatContext, SplatModifier } from './splat-modifier';
import { warn } from './logging';
import type { CollisionMeshTile } from './formats/lcc/collision-mesh';
import type { TriangleMeshData } from './formats/lcc/parse-mesh-ply';

type Node<T extends string> = THREE.Node<T>;
function asNode<T extends string>(node: unknown): Node<T> {
  return node as Node<T>;
}

// --- SDF effects (M7.4) -----------------------------------------------------

/**
 * A signed-distance primitive kind. `cylinder` is capped and runs along the
 * shape-local Y axis (rotate it with {@link SdfShape.rotation}).
 */
export type SdfShapeKind = 'sphere' | 'box' | 'cylinder';

/**
 * What a shape does to the splats it covers:
 *  - `tint` - blend the splat color toward the shape color.
 *  - `desaturate` - blend the splat color toward its luminance.
 *  - `hide` - fade the splat out (soft cutaway).
 *  - `rim` - tint only a band around the shape's surface.
 */
export type SdfMode = 'tint' | 'desaturate' | 'hide' | 'rim';

/** One SDF shape in a {@link sdfEffects} list. All spaces are mesh-local. */
export interface SdfShape {
  kind: SdfShapeKind;
  /** Shape center, mesh-local. Default `[0, 0, 0]`. */
  center?: readonly [number, number, number];
  /**
   * Sphere/cylinder radius. Required for `kind: 'sphere'` and
   * `kind: 'cylinder'`; must be positive - {@link SdfEffect.setShapes} throws
   * otherwise.
   */
  radius?: number;
  /**
   * Cylinder full height along the shape-local Y axis. Required (and only
   * used) for `kind: 'cylinder'`; must be positive - {@link SdfEffect.setShapes}
   * throws otherwise.
   */
  height?: number;
  /**
   * Box half-extents. Required (and only used) for `kind: 'box'`; every
   * component must be positive - {@link SdfEffect.setShapes} throws otherwise.
   */
  halfExtents?: readonly [number, number, number];
  /** Orientation quaternion `[x, y, z, w]` (boxes and cylinders). Default identity. */
  rotation?: readonly [number, number, number, number];
  /** Effect color (tint/rim). Default white. */
  color?: readonly [number, number, number];
  /** Soft-edge width in world units; 0 is a hard edge. Default `0`. */
  falloff?: number;
  /** Invert the test - affect the outside of the shape instead. */
  invert?: boolean;
  /** Effect strength in `[0, 1]`. Default `1`. */
  strength?: number;
  mode: SdfMode;
}

/** A live SDF effect: one modifier plus a data-only way to update its shapes. */
export interface SdfEffect {
  /** Attach to `mesh.modifiers`. Built once; updating shapes never recompiles. */
  readonly modifier: SplatModifier;
  /**
   * Replaces the shape list. Purely a uniform-buffer write, so animating
   * shape poses/colors/thresholds every frame costs no pipeline recompile.
   * Shapes beyond {@link maxShapes} are dropped with a one-time warning.
   *
   * Throws (before writing anything) if a sphere or cylinder lacks a positive
   * `radius`, a cylinder lacks a positive `height`, or a box lacks positive
   * `halfExtents` - a zero-size shape is always a caller bug, never a useful
   * no-op.
   */
  setShapes(shapes: readonly SdfShape[]): void;
  /** The compiled-in shape capacity (see {@link sdfEffects} `maxShapes`). */
  readonly maxShapes: number;
  /**
   * The packed uniform state behind the modifier - `maxShapes × SHAPE_STRIDE`
   * vec4 slots plus the live shape count.
   * @internal Exposed for unit tests of the packing; not public API.
   */
  readonly _uniforms: {
    readonly slots: readonly THREE.Vector4[];
    readonly count: { value: number };
  };
}

/** vec4 slots per shape in the uniform array (see the packing below). */
const SHAPE_STRIDE = 5;
const MODE_INDEX: Record<SdfMode, number> = { tint: 0, desaturate: 1, hide: 2, rim: 3 };

// Shared defaults so a per-frame `setShapes` on sparse shape literals does not
// allocate a fresh array per omitted field.
const DEFAULT_CENTER: readonly [number, number, number] = [0, 0, 0];
const DEFAULT_COLOR: readonly [number, number, number] = [1, 1, 1];
const DEFAULT_ROTATION: readonly [number, number, number, number] = [0, 0, 0, 1];

/**
 * Builds a {@link SdfEffect} from a declarative shape list. Shapes live in a
 * bounded uniform array and are tested in-shader against each splat's local
 * center as a **fixed unroll over all `maxShapes` slots**, each slot gated by
 * `slot < count` so unused slots contribute nothing. (An in-shader loop is
 * not viable here - see the TSL varying constraint documented inside the
 * modifier.) Adding, moving or removing a shape - or changing the count - is
 * still a pure uniform write with no recompile. Works on WebGPU and the
 * WebGL2 fallback.
 *
 * `maxShapes` is the compiled capacity (default 32). Because every slot is
 * unrolled into the shader, raising it grows the shader's size and compile
 * time (and the uniform array; very large values can exceed WebGL2's uniform
 * limits), so keep it to what a scene needs.
 *
 * Shape positions are mesh-local. In a `SplatScene` that means scene
 * coordinates - a shape overlapping two sources covers both as one continuous
 * shape - so place them with `computeSplatBounds()`, which reports the sources
 * at their current placement.
 */
export function sdfEffects(
  initialShapes: readonly SdfShape[] = [],
  options: { maxShapes?: number } = {},
): SdfEffect {
  const maxShapes = Math.max(1, Math.floor(options.maxShapes ?? 32));

  // One flat uniform array of vec4; SHAPE_STRIDE slots per shape. Mutating
  // these Vector4s (and `count`) re-uploads as plain uniforms - never a
  // recompile. `count` bounds the in-shader loop.
  const slots: THREE.Vector4[] = [];
  for (let i = 0; i < maxShapes * SHAPE_STRIDE; i++) slots.push(new THREE.Vector4());
  const shapesUniform = uniformArray(slots, 'vec4');
  const count = uniform(0, 'int');

  let warnedOverflow = false;
  const setShapes = (shapes: readonly SdfShape[]): void => {
    const n = Math.min(shapes.length, maxShapes);
    if (shapes.length > maxShapes && !warnedOverflow) {
      warnedOverflow = true;
      warn(
        `sdfEffects: ${shapes.length} shapes exceeds maxShapes=${maxShapes}; ` +
          `extra shapes are ignored. Raise maxShapes if you need more.`,
      );
    }
    // Validate before touching any slot, so a bad list never leaves the
    // uniform array half-updated.
    for (let i = 0; i < n; i++) {
      const s = shapes[i] as SdfShape;
      if (s.kind === 'box') {
        const he = s.halfExtents;
        if (!he || !(he[0] > 0) || !(he[1] > 0) || !(he[2] > 0)) {
          throw new Error(
            `sdfEffects.setShapes: shape ${i} is a box and requires halfExtents ` +
              `with three positive components (got ${he ? `[${he.join(', ')}]` : 'undefined'}).`,
          );
        }
      } else if (!(typeof s.radius === 'number' && s.radius > 0)) {
        throw new Error(
          `sdfEffects.setShapes: shape ${i} is a ${s.kind} and requires a positive ` +
            `radius (got ${String(s.radius)}).`,
        );
      } else if (s.kind === 'cylinder' && !(typeof s.height === 'number' && s.height > 0)) {
        throw new Error(
          `sdfEffects.setShapes: shape ${i} is a cylinder and requires a positive ` +
            `height (got ${String(s.height)}).`,
        );
      }
    }
    for (let i = 0; i < n; i++) {
      const s = shapes[i] as SdfShape;
      const b = i * SHAPE_STRIDE;
      const c = s.center ?? DEFAULT_CENTER;
      const col = s.color ?? DEFAULT_COLOR;
      const rot = s.rotation ?? DEFAULT_ROTATION;
      const kindIndex = s.kind === 'box' ? 1 : s.kind === 'cylinder' ? 2 : 0;
      (slots[b + 0] as THREE.Vector4).set(c[0], c[1], c[2], kindIndex);
      if (s.kind === 'box') {
        const he = s.halfExtents as readonly [number, number, number];
        (slots[b + 1] as THREE.Vector4).set(he[0], he[1], he[2], s.falloff ?? 0);
      } else if (s.kind === 'cylinder') {
        (slots[b + 1] as THREE.Vector4).set(
          s.radius as number,
          (s.height as number) / 2,
          0,
          s.falloff ?? 0,
        );
      } else {
        (slots[b + 1] as THREE.Vector4).set(s.radius as number, 0, 0, s.falloff ?? 0);
      }
      (slots[b + 2] as THREE.Vector4).set(col[0], col[1], col[2], MODE_INDEX[s.mode]);
      (slots[b + 3] as THREE.Vector4).set(rot[0], rot[1], rot[2], rot[3]);
      (slots[b + 4] as THREE.Vector4).set(s.invert ? 1 : 0, s.strength ?? 1, 0, 0);
    }
    count.value = n;
  };
  setShapes(initialShapes);

  const modifier: SplatModifier = (ctx: SplatContext) => {
    // Unrolled over the fixed `maxShapes` slots as *pure expressions* (no
    // control flow): a splat's color is a chain of `select`/`mix` folds, one
    // per slot, each gated by `slot < count` so unused slots are transparent.
    // Control flow inside a modifier color is not viable - three.js evaluates
    // a color that reaches the fragment stage through a varying, and a varying
    // does not emit `Loop`/`If` statements - so the shape count drives a
    // uniform-gated unroll instead. Result: changing shapes or their count is
    // still a pure uniform write (no recompile); the cost is a shader whose
    // size grows with `maxShapes`.
    const p = ctx.localCenter;
    let rgb: Node<'vec3'> = asNode<'vec3'>(ctx.color.rgb);
    let alphaMul: Node<'float'> = float(1);

    for (let k = 0; k < maxShapes; k++) {
      const b = k * SHAPE_STRIDE;
      const el = (j: number): Node<'vec4'> => asNode<'vec4'>(shapesUniform.element(b + j));
      const s0 = el(0);
      const s1 = el(1);
      const s2 = el(2);
      const s3 = el(3);
      const s4 = el(4);

      const center = s0.xyz;
      const kind = s0.w; // 0 sphere · 1 box · 2 cylinder (stored as a float index)
      const size = s1.xyz;
      const falloff = s1.w.max(1e-4);
      const shapeColor = s2.xyz;
      const mode = s2.w;
      const invert = s4.x; // 0 · 1 flag
      const strength = s4.y;
      // Slots past the live count contribute nothing.
      const gate = int(k).lessThan(count).select(float(1), float(0));

      // Sample point in shape-local space: R⁻¹·(p − center). The sphere/box
      // and invert choices blend with `mix` on their 0/1 flags rather than a
      // `select`: three.js miscompiles a ConditionalNode whose branches carry
      // large sub-expressions (the box SDF) here, silently zeroing the result.
      const rel = p.sub(center);
      const pl = rotateByQuatConj(s3, rel);
      const dSphere = pl.length().sub(size.x);
      const dBox = sdBox(pl, size);
      const dCylinder = sdCappedCylinder(pl, size.x, size.y);
      // Kind index → 0/1 masks, folded with `mix` like the mode masks below.
      const boxMask = kind.greaterThan(0.5).and(kind.lessThan(1.5)).select(float(1), float(0));
      const cylinderMask = kind.greaterThan(1.5).select(float(1), float(0));
      const dRaw = mix(mix(dSphere, dBox, boxMask), dCylinder, cylinderMask);
      const d = mix(dRaw, dRaw.negate(), invert);

      // Inside coverage (1 within, fading out over `falloff`); rim coverage
      // peaks on the surface. Both scaled by strength and the live-slot gate.
      const insideCov = float(1)
        .sub(smoothstep(0, falloff, d))
        .mul(strength)
        .mul(gate);
      const rimCov = float(1)
        .sub(smoothstep(0, falloff, d.abs()))
        .mul(strength)
        .mul(gate);

      // Per-mode scalar masks (1 for the active mode, else 0). Applied by
      // folding the coverage with `mix`/multiply - NOT by a `select` that
      // reassigns `rgb`: three.js miscompiles a conditional whose branches
      // reuse the running value across an unrolled reassignment chain, so the
      // accumulation must stay pure arithmetic.
      const tintMask = mode.lessThan(0.5).select(float(1), float(0));
      const desatMask = mode.greaterThan(0.5).and(mode.lessThan(1.5)).select(float(1), float(0));
      const hideMask = mode.greaterThan(1.5).and(mode.lessThan(2.5)).select(float(1), float(0));
      const rimMask = mode.greaterThan(2.5).select(float(1), float(0));
      const luma = asNode<'float'>(rgb.dot(vec3(0.2126, 0.7152, 0.0722)));

      rgb = asNode<'vec3'>(mix(rgb, shapeColor, insideCov.mul(tintMask)));
      rgb = asNode<'vec3'>(mix(rgb, vec3(luma), insideCov.mul(desatMask)));
      rgb = asNode<'vec3'>(mix(rgb, shapeColor, rimCov.mul(rimMask)));
      alphaMul = asNode<'float'>(alphaMul.mul(float(1).sub(insideCov.mul(hideMask))));
    }

    return { color: vec4(rgb, ctx.color.a.mul(alphaMul)) };
  };

  return { modifier, setShapes, maxShapes, _uniforms: { slots, count } };
}

/** SDF of an axis-aligned box (shape-local) with half-extents `b`. */
function sdBox(p: Node<'vec3'>, b: Node<'vec3'>): Node<'float'> {
  const q = p.abs().sub(b);
  const outside = q.max(vec3(0, 0, 0)).length();
  const inside = q.x.max(q.y.max(q.z)).min(0);
  return asNode<'float'>(outside.add(inside));
}

/** SDF of a Y-axis capped cylinder (shape-local): radius `r`, half-height `h`. */
function sdCappedCylinder(p: Node<'vec3'>, r: Node<'float'>, h: Node<'float'>): Node<'float'> {
  const dr = p.xz.length().sub(r);
  const dy = p.y.abs().sub(h);
  const outside = vec2(dr.max(0), dy.max(0)).length();
  const inside = dr.max(dy).min(0);
  return asNode<'float'>(outside.add(inside));
}

/** Rotates `v` by the conjugate of quaternion `q` (xyzw): R⁻¹·v. */
function rotateByQuatConj(q: Node<'vec4'>, v: Node<'vec3'>): Node<'vec3'> {
  const u = q.xyz;
  const s = q.w;
  const t = u.cross(v).mul(2);
  return asNode<'vec3'>(v.sub(t.mul(s)).add(u.cross(t)));
}

// --- Reference presets (M7.5) ----------------------------------------------

/** A preset that exposes a live light direction uniform. */
export interface LightingPreset {
  readonly modifier: SplatModifier;
  /**
   * Mesh-local light direction; mutate `.value` to animate (no recompile).
   * Inside a `SplatScene` that frame is the scene's, so one direction lights
   * every source consistently however they are posed.
   */
  readonly direction: { value: THREE.Vector3 };
}

/**
 * Simple per-splat Lambertian shading using the splat's approximate normal
 * (`ctx.normal`, the least-variance covariance axis). A starting point for
 * relit product shots - not a lighting rig. Works on both backends.
 *
 * In a `SplatScene` the normal comes from the *placed* covariance, so a source
 * that rotates relights as it turns.
 */
export function lightingPreset(
  options: {
    direction?: readonly [number, number, number];
    ambient?: number;
    diffuse?: number;
  } = {},
): LightingPreset {
  const dir = new THREE.Vector3(...(options.direction ?? [0.3, 1, 0.6])).normalize();
  const direction = uniform(dir);
  const ambient = float(options.ambient ?? 0.35);
  const diffuse = float(options.diffuse ?? 0.75);

  const modifier: SplatModifier = (ctx: SplatContext) => {
    const ndl = ctx.normal.dot(direction.normalize()).max(0);
    const shade = ambient.add(ndl.mul(diffuse));
    return { color: vec4(ctx.color.rgb.mul(shade), ctx.color.a) };
  };
  return { modifier, direction: direction };
}

/** A live depth-of-field preset: focus plane and aperture are mutable uniforms. */
export interface DepthOfFieldPreset {
  readonly modifier: SplatModifier;
  /** World-unit distance to the focal plane; splats there stay sharp. Mutate
   * `.value` to rack focus (no recompile). Must stay positive. */
  readonly focusDistance: { value: number };
  /** Blur strength (aperture-like); 0 is no blur. Mutate `.value`. */
  readonly aperture: { value: number };
}

/**
 * Depth-of-field on the {@link SplatModifier} hook - **stylized / soft** path
 * (M13). Prefer {@link SplatMesh.setDepthOfField} / the core projected-2D
 * aperture model for camera DoF (isotropic screen-space CoC with √det opacity).
 *
 * A splat's circle of confusion grows with how far its view-space depth
 * sits from `focusDistance`; the modifier blurs it by enlarging it
 * (`scale = 1 + coc`) and, because the material scales the projected covariance
 * by `scale²`, divides opacity by `scale²` so the widened splat conserves its
 * integrated mass instead of over-brightening. Focus and aperture are live
 * uniforms, so racking focus every frame costs no recompile. Pure TSL - works
 * on WebGPU and the WebGL2 fallback.
 *
 * This is an *approximate* DoF: `scale` is a uniform 3D-covariance multiplier,
 * so the blur enlarges the splat's own (possibly anisotropic) footprint rather
 * than adding a truly isotropic screen-space disc. The physically exact aperture
 * model adds `coc²·I` to the *projected 2D* covariance with the same √(det)
 * opacity conservation the antialias filter uses - that path is
 * `SplatMesh.setDepthOfField` / `UnifiedSplatRenderer.setDepthOfField`
 * (see `docs/guide/effects-and-modifiers.md`, M13).
 *
 * Opacity conservation is exact only with `antialias` on: without it, the
 * fixed 0.3-px dilation dominates sub-pixel splats, so strong blur *dims*
 * distant splats (their footprint barely grows while alpha still falls by
 * 1/scale²) rather than blurring them.
 */
export function depthOfFieldPreset(
  options: { focusDistance?: number; aperture?: number; maxBlur?: number } = {},
): DepthOfFieldPreset {
  const focusDistance = uniform(Math.max(1e-4, options.focusDistance ?? 10));
  const aperture = uniform(Math.max(0, options.aperture ?? 0.5));
  // Cap the enlargement so a splat far behind the focus plane cannot balloon
  // to cover the screen (and its 1/scale² opacity cannot underflow to nothing).
  const maxBlur = float(Math.max(0, options.maxBlur ?? 6));

  const modifier: SplatModifier = (ctx: SplatContext) => {
    // View-space depth along the optical axis (camera looks down −z).
    const depth = ctx.viewCenter.z.negate().max(1e-4);
    // Clamped in-shader too: the constructor clamp cannot protect against a
    // later `focusDistance.value = 0`, which would divide by zero below and
    // NaN every splat's scale.
    const focus = focusDistance.max(1e-4);
    // Circle of confusion, normalized by the focus distance so it is scale-
    // invariant: 0 at the focal plane, growing with |depth − focus|.
    const coc = depth.sub(focus).abs().div(focus).mul(aperture).min(maxBlur);
    const blur = float(1).add(coc);
    // Conserve integrated opacity: the material scales area by blur², so peak
    // opacity must fall by 1/blur² or the blurred splat over-brightens. The
    // blur multiplies the running scale (and compensates only for its own
    // factor), so a preceding modifier's scale survives composition.
    const alpha = asNode<'float'>(ctx.color.a.div(blur.mul(blur)));
    return { scale: asNode<'float'>(ctx.scale.mul(blur)), color: vec4(ctx.color.rgb, alpha) };
  };
  return { modifier, focusDistance, aperture };
}

/** A preset that exposes a reveal `progress` uniform in `[0, 1]`. */
export interface RevealPreset {
  readonly modifier: SplatModifier;
  /** Reveal progress; 0 hides everything, 1 shows everything. */
  readonly progress: { value: number };
}

/**
 * Time-driven dissolve/reveal. A value-noise field over the splat's local
 * position is thresholded against `progress`: splats whose noise is below the
 * threshold are shown, with a soft alpha edge. The noise is a `wgslFn` chunk -
 * the M7 escape hatch - so this preset is **WebGPU-only** (see the fallback
 * notes); force WebGL2 and it will not compile.
 *
 * The field is anchored to the mesh, so in a `SplatScene` a moved source
 * reveals in step with whatever it now sits beside (and the pattern slides
 * across it as it travels) rather than carrying its own schedule around.
 */
export function revealPreset(options: { frequency?: number; edge?: number } = {}): RevealPreset {
  const progress = uniform(0);
  const frequency = options.frequency ?? 3;
  // The edge doubles as the threshold-range margin below, so it must stay in
  // [0, 0.5] for the remap to be well-formed.
  const edge = Math.min(Math.max(options.edge ?? 0.08, 0), 0.5);

  // Value noise as a single self-contained WGSL function: hash the 8 corners
  // of the lattice cell, then trilinearly interpolate with smoothstep weights
  // (g²(3 − 2g)). Every corner hash is a `fract` in [0, 1) and `mix` is a
  // convex combination, so the result is provably in [0, 1) - the reveal
  // threshold math below depends on that bound. The hashes are `let`-bound
  // locals so the chunk stays one function - three.js `wgslFn` binds call
  // inputs to the *first* function it finds, so a multi-function chunk would
  // need the entry first anyway; keeping it to one avoids that footgun.
  const vnoise = wgslFn(/* wgsl */ `
    fn vnoise( x: vec3<f32> ) -> f32 {
      let i = floor( x );
      let g = fract( x );
      let u = g * g * ( 3.0 - 2.0 * g );
      let k = vec3<f32>( 12.9898, 78.233, 37.719 );
      let s = 43758.5453;
      let h000 = fract( sin( dot( i + vec3<f32>( 0.0, 0.0, 0.0 ), k ) ) * s );
      let h100 = fract( sin( dot( i + vec3<f32>( 1.0, 0.0, 0.0 ), k ) ) * s );
      let h010 = fract( sin( dot( i + vec3<f32>( 0.0, 1.0, 0.0 ), k ) ) * s );
      let h110 = fract( sin( dot( i + vec3<f32>( 1.0, 1.0, 0.0 ), k ) ) * s );
      let h001 = fract( sin( dot( i + vec3<f32>( 0.0, 0.0, 1.0 ), k ) ) * s );
      let h101 = fract( sin( dot( i + vec3<f32>( 1.0, 0.0, 1.0 ), k ) ) * s );
      let h011 = fract( sin( dot( i + vec3<f32>( 0.0, 1.0, 1.0 ), k ) ) * s );
      let h111 = fract( sin( dot( i + vec3<f32>( 1.0, 1.0, 1.0 ), k ) ) * s );
      let x00 = mix( h000, h100, u.x );
      let x10 = mix( h010, h110, u.x );
      let x01 = mix( h001, h101, u.x );
      let x11 = mix( h011, h111, u.x );
      let y0 = mix( x00, x10, u.y );
      let y1 = mix( x01, x11, u.y );
      return mix( y0, y1, u.z );
    }
  `);

  const modifier: SplatModifier = (ctx: SplatContext) => {
    // Each splat gets a per-position threshold from the noise; it appears as
    // `progress` sweeps past that threshold, with a soft `edge`-wide band.
    // The noise is in [0, 1); remapping it to [edge, 1 − edge] keeps the whole
    // smoothstep band inside [0, 1], so progress 0 hides every splat fully and
    // progress 1 shows every splat fully - the documented contract.
    const noise = asNode<'float'>(vnoise({ x: ctx.localCenter.mul(frequency) }));
    const threshold = asNode<'float'>(noise.mul(1 - 2 * edge).add(edge));
    const alpha = smoothstep(threshold.sub(edge), threshold.add(edge), progress);
    const visible = progress.greaterThan(threshold.sub(edge));
    return { color: vec4(ctx.color.rgb, ctx.color.a.mul(alpha)), visible: asNode<'bool'>(visible) };
  };
  return { modifier, progress: progress };
}

/** A live world-warp preset: signed intensity and radius are mutable uniforms. */
export interface WorldWarpPreset {
  readonly modifier: SplatModifier;
  /**
   * Signed warp amount in `[-1, 1]`. Positive wraps the street *down* so you
   * walk on top of the sphere (tiny planet); negative wraps it *up* so you
   * stand in the bowl (Inception fold). `0` is identity. Mutate `.value` to
   * animate (no recompile).
   */
  readonly intensity: { value: number };
  /**
   * Distance at which the wrap becomes strong. Nearby splats (`depth ≪
   * radius`) stay put so walk/fly controls still read as moving through the
   * unwarped near field. Must stay positive. Mutate `.value`.
   */
  readonly radius: { value: number };
}

/**
 * Camera-centered splat warp on the {@link SplatModifier} hook: one signed
 * `intensity` uniform, two opposite hinges of the same view-space wrap. The
 * camera is not moved - only splat centers (and their rigid orientation)
 * change, so WASD / orbit stay as they are.
 *
 * Both sides hinge view-space `(y, z)` around camera +X by
 * `(π/2) · atan(depth / radius)`:
 *
 *  - `intensity > 0` - planet: the far street wraps *down* under your feet so
 *    you walk on top of the sphere.
 *  - `intensity < 0` - fold: the far street wraps *up* over your head so you
 *    stand in the bowl.
 *  - `intensity = 0` is identity (`offset = 0`, rotation unchanged).
 *
 * The shader mixes each full-strength hinge toward the original position by
 * `|intensity|`. Orientation follows the orthonormalized Jacobian so
 * ellipsoids wrap with the surface rather than sliding. Pure TSL - WebGPU
 * and the WebGL2 fallback.
 *
 * Displaced splats keep their **pre-displacement** depth-sort order (the
 * modifier-stack contract). Extreme warps can composite in the wrong order;
 * this preset does not re-sort on warped centers.
 */
export function worldWarpPreset(
  options: { intensity?: number; radius?: number } = {},
): WorldWarpPreset {
  const intensity = uniform(Math.min(1, Math.max(-1, options.intensity ?? 0)));
  const radius = uniform(Math.max(1e-4, options.radius ?? 1));

  const modifier: SplatModifier = (ctx: SplatContext) => {
    const k = asNode<'float'>(intensity.clamp(-1, 1));
    const R = asNode<'float'>(radius.max(1e-4));
    const v = ctx.viewCenter;
    const planetW = k.max(0);
    const foldW = k.negate().max(0);

    const depth = v.z.negate().max(0);
    const alpha = depth
      .div(R)
      .atan()
      .mul(float(Math.PI * 0.5));
    const cA = alpha.cos();
    const sFold = alpha.sin();
    const sPlanet = sFold.negate();
    const foldV = vec3(v.x, v.y.mul(cA).sub(v.z.mul(sFold)), v.y.mul(sFold).add(v.z.mul(cA)));
    const planetV = vec3(v.x, v.y.mul(cA).sub(v.z.mul(sPlanet)), v.y.mul(sPlanet).add(v.z.mul(cA)));

    const warpedV = mix(mix(v, foldV, foldW), planetV, planetW);

    const halfPiR = float(Math.PI * 0.5).mul(R);
    const dFoldDz = v.z
      .lessThan(0)
      .select(halfPiR.negate().div(depth.mul(depth).add(R.mul(R))), float(0));
    const dPlanetDz = dFoldDz.negate();
    const foldC0 = vec3(1, 0, 0);
    const foldC1 = vec3(0, cA, sFold);
    const foldC2 = vec3(0, sFold.negate().sub(foldV.z.mul(dFoldDz)), cA.add(foldV.y.mul(dFoldDz)));
    const planetC0 = vec3(1, 0, 0);
    const planetC1 = vec3(0, cA, sPlanet);
    const planetC2 = vec3(
      0,
      sPlanet.negate().sub(planetV.z.mul(dPlanetDz)),
      cA.add(planetV.y.mul(dPlanetDz)),
    );

    const i0 = vec3(1, 0, 0);
    const i1 = vec3(0, 1, 0);
    const i2 = vec3(0, 0, 1);
    const j0 = mix(mix(i0, foldC0, foldW), planetC0, planetW);
    const j1 = mix(mix(i1, foldC1, foldW), planetC1, planetW);
    const j2 = mix(mix(i2, foldC2, foldW), planetC2, planetW);

    const r0 = j0.div(j0.length().max(1e-6));
    const r1u = j1.sub(r0.mul(r0.dot(j1)));
    const r1 = r1u.div(r1u.length().max(1e-6));
    const r2gs = j2.sub(r0.mul(r0.dot(j2))).sub(r1.mul(r1.dot(j2)));
    const r2 = r2gs.div(r2gs.length().max(1e-6));
    const qView = asNode<'mat3'>(mat3(r0, r1, r2));
    const viewR = asNode<'mat3'>(modelViewMatrix.toMat3());
    const viewRT = viewR.transpose();
    const warpR = asNode<'mat3'>(viewRT.mul(qView).mul(viewR));

    return {
      offset: asNode<'vec3'>(ctx.offset.add(viewRT.mul(warpedV.sub(v)))),
      rotation: asNode<'mat3'>(warpR.mul(ctx.rotation)),
    };
  };
  return { modifier, intensity, radius };
}

// --- Proxy-mesh relighting helper -------------------------------------------

export { renderRelightingFactorMap, type RelightingFactorRenderer } from './relighting-pass';

/** Handle returned by {@link createRelightingProxy}. */
export interface RelightingProxy {
  /** World-space group of lit proxy meshes (hide from the main splat scene). */
  readonly group: THREE.Group;
  /**
   * Configures a material for the relight coverage pass: gray albedo and
   * opaque alpha so uncovered RT pixels stay at clear-alpha 0.
   */
  configureMaterial(material: THREE.Material): void;
  /** Disposes geometries and the default material owned by this helper. */
  dispose(): void;
}

/** One independent shadow-casting light for {@link createRelightingShadowFactorMaterial}. */
export type RelightingLightContribution = {
  light: THREE.Light;
  /** Relative umbra weight. Default `1`. Values `<= 0` are skipped unless `fill` is set. */
  intensity?: number;
  /**
   * Additive Lambert fill on top of the umbra factor (RGB may exceed 1).
   * Gated by `shadow()`, facing, and for spot/point lights the Frostbite
   * `distance` window (and the spot cone). `0` / omitted = umbra only.
   */
  fill?: number;
};

/** Options for {@link createRelightingShadowFactorMaterial}. */
export type RelightingShadowFactorOptions = {
  umbra?: number;
  receiveUpMin?: number;
  color?: THREE.Color;
  diffuse?: number;
  direction?: THREE.Vector3;
  /**
   * How independent contributions combine into one multiplier.
   * - `average` (default): intensity-weighted mean of shadows (fill lights).
   * - `min`: union of umbras — each caster keeps its own silhouette. Contribution
   *   `intensity` scales umbra depth: `0` → none, `1` → default `umbra`,
   *   `>1` → darker than default (`umbra_i = clamp(1 - I*(1-umbra), 0, 1)`).
   */
  combine?: 'average' | 'min';
  midLight?: THREE.Light;
  midRadius?: number;
  outerLight?: THREE.Light;
  outerRadius?: number;
  farLight?: THREE.Light;
  nearRadius?: number;
};

/**
 * Cap on independent shadow lights (cascades of the first directional do not
 * count). Extra contributions are ignored. The compiled graph unrolls only
 * the live contribution count, not a padded 32-wide loop.
 */
export const MAX_RELIGHTING_SHADOW_LIGHTS = 32;

const contributionIntensity = (contribution: RelightingLightContribution): number => {
  const value = contribution.intensity;
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, value as number);
};

const contributionFill = (contribution: RelightingLightContribution): number => {
  const value = contribution.fill;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value as number);
};

/** Light pose/color must track every frame. `uniform(vec)` keeps object identity, so in-place `copy()` does not re-upload. */
const liveRef = <T extends string>(name: string, type: string, object: object): Node<T> => {
  const ref = reference(name, type, object);
  // three.js implements ReferenceNode.setGroup(), but its public declaration omits it.
  (ref as unknown as { setGroup(group: typeof frameGroup): unknown }).setGroup(frameGroup);
  return asNode<T>(ref);
};

/**
 * Fade punctual (spot / point) umbras to lit as fragments approach `light.distance`.
 * Directional lights return 1. Uses the Frostbite cutoff window so weight is 0 at
 * cutoff (no hard shadow-map cliff). `light.decay` steepens the falloff (&gt;1).
 */
const punctualUmbraWeight = (light: THREE.Light): Node<'float'> => {
  const punctual = light as THREE.SpotLight & THREE.PointLight;
  const isPunctual = punctual.isSpotLight === true || punctual.isPointLight === true;
  if (!isPunctual) return float(1);
  const cutoff = Number(punctual.distance);
  if (!(cutoff > 0)) return float(1);
  const decay = Math.max(Number(punctual.decay) || 1, 0.01);
  const lightDistance = asNode<'float'>(positionWorld.distance(objectPosition(punctual)));
  const range = liveRef<'float'>('distance', 'float', punctual).max(1e-4);
  // pow2(saturate(1 - pow4(d/cutoff))) → 1 near light, 0 at cutoff
  const window = asNode<'float'>(lightDistance.div(range).pow4().oneMinus().clamp().pow2());
  return asNode<'float'>(window.pow(float(decay)));
};

/**
 * Ranged Lambert toward a punctual light, occluded by its shadow map.
 * Spot cone uses `light.angle` / `penumbra` and `light.target`.
 * Does **not** use `receiveUpMin`: that slope gate keeps umbra off noisy
 * vertical foliage, but it also erased fill on tree stems, so splats only
 * lit after the host fell back to un-occluded Lambert.
 */
const punctualFillTerm = (light: THREE.Light, fill: number, vis: Node<'float'>): Node<'vec3'> => {
  const punctual = light as THREE.SpotLight & THREE.PointLight;
  const isSpot = punctual.isSpotLight === true;
  const isPoint = punctual.isPointLight === true;
  if (!isSpot && !isPoint) return vec3(0, 0, 0);

  const lightPos = asNode<'vec3'>(objectPosition(punctual));
  const toLightVec = asNode<'vec3'>(lightPos.sub(positionWorld));
  const dist = asNode<'float'>(toLightVec.length().max(1e-4));
  const toLight = asNode<'vec3'>(toLightVec.div(dist));
  const ndl = asNode<'float'>(normalWorld.dot(toLight).max(0));
  const window = punctualUmbraWeight(light);
  let mask = asNode<'float'>(window.mul(ndl).mul(vis));

  if (isSpot) {
    const spot = light as THREE.SpotLight;
    const shine = asNode<'vec3'>(objectPosition(spot.target).sub(lightPos).normalize());
    const outer = liveRef<'float'>('angle', 'float', spot).max(1e-3);
    const penumbra = liveRef<'float'>('penumbra', 'float', spot).clamp(0, 0.95);
    const inner = asNode<'float'>(outer.mul(float(1).sub(penumbra)).max(1e-3));
    const cone = asNode<'float'>(smoothstep(cos(outer), cos(inner), toLight.negate().dot(shine)));
    mask = asNode<'float'>(mask.mul(cone));
  }

  const chroma = liveRef<'vec3'>('color', 'color', light);
  return asNode<'vec3'>(chroma.mul(float(fill)).mul(mask));
};

const directionalFillTerm = (
  light: THREE.Light,
  fill: number,
  vis: Node<'float'>,
): Node<'vec3'> => {
  const dirLight = light as THREE.DirectionalLight;
  if (dirLight.isDirectionalLight !== true) return vec3(0, 0, 0);
  const shine = asNode<'vec3'>(
    objectPosition(dirLight.target).sub(objectPosition(dirLight)).normalize(),
  );
  const ndl = asNode<'float'>(normalWorld.dot(shine.negate()).max(0));
  const chroma = liveRef<'vec3'>('color', 'color', light);
  return asNode<'vec3'>(chroma.mul(float(fill)).mul(ndl).mul(vis));
};

const normalizeRelightingLights = (
  lights: THREE.Light | RelightingLightContribution[],
): RelightingLightContribution[] => {
  const list = Array.isArray(lights) ? lights : [{ light: lights, intensity: 1 }];
  const weighted: RelightingLightContribution[] = [];
  for (const contribution of list) {
    if (weighted.length >= MAX_RELIGHTING_SHADOW_LIGHTS) break;
    if (contributionIntensity(contribution) <= 0 && contributionFill(contribution) <= 0) continue;
    weighted.push(contribution);
  }
  return weighted;
};

const cascadedShadow = (
  light: THREE.Light,
  options: RelightingShadowFactorOptions,
  dist: Node<'float'>,
): Node<'float'> => {
  const nearRadius = Number.isFinite(options.nearRadius)
    ? Math.max(1, options.nearRadius as number)
    : options.midLight
      ? 20
      : 100;
  const midRadius = Number.isFinite(options.midRadius)
    ? Math.max(nearRadius, options.midRadius as number)
    : 50;
  const outerRadius = Number.isFinite(options.outerRadius)
    ? Math.max(midRadius, options.outerRadius as number)
    : 160;
  const blendAt = (inner: Node<'float'>, outer: Node<'float'>, radius: number): Node<'float'> =>
    asNode<'float'>(mix(inner, outer, smoothstep(float(radius * 0.7), float(radius * 0.95), dist)));
  let shadowed = asNode<'float'>(shadow(light));
  if (options.midLight) {
    shadowed = blendAt(shadowed, asNode<'float'>(shadow(options.midLight)), nearRadius);
    if (options.outerLight) {
      shadowed = blendAt(shadowed, asNode<'float'>(shadow(options.outerLight)), midRadius);
      if (options.farLight) {
        shadowed = blendAt(shadowed, asNode<'float'>(shadow(options.farLight)), outerRadius);
      }
    } else if (options.farLight) {
      shadowed = blendAt(shadowed, asNode<'float'>(shadow(options.farLight)), midRadius);
    }
  } else if (options.farLight) {
    shadowed = blendAt(shadowed, asNode<'float'>(shadow(options.farLight)), nearRadius);
  }
  return shadowed;
};

/**
 * Node material for a **shadow-factor** lighting RT used with
 * {@link SplatMesh.setRelighting}.
 *
 * Fragment output is `vec4(vec3(mix(umbra, 1, shadow)) + boost, 1)`:
 *  - covered + lit → RGB ≈ 1 (identity modulate when brightness/background are 1)
 *  - covered + umbra → RGB ≈ `umbra` (soft darken; never pure black)
 *  - uncovered stays clear-alpha 0 from the RT clear
 *  - with `diffuse` &gt; 0, facing surfaces add `color * NdotL * diffuse`
 *    (RGB may exceed 1; use a HalfFloat lighting RT)
 *
 * Pass one {@link THREE.Light} (demo / single-sun) or an array of
 * {@link RelightingLightContribution} so independent lights share one
 * multiplier. Default combine is intensity-weighted average
 * (`illum = sum(I_i * shadow_i) / sum(I_i)`); pass `combine: 'min'` for a
 * union of umbras so each caster keeps its silhouette. Spot / point lights
 * with `distance &gt; 0` fade their umbra to lit via a Frostbite cutoff window
 * (steepened by `decay`) so the shadow map far plane is not a hard cliff.
 * Contribution `fill` adds occluded Lambert (range + cone for punctual lights)
 * on top of that identity so accent lights can light splats without wrapping
 * through collision. Cascades (`midLight` / `outerLight` / `farLight`) still
 * attach to the **first** directional only. At most
 * {@link MAX_RELIGHTING_SHADOW_LIGHTS} independent lights are used; extras
 * are ignored. Graph size follows the live contribution count (not a padded
 * loop of that width).
 *
 * By default, only **upward** proxy faces receive (`receiveUpMin`). Vertical
 * and noisy foliage triangles still **cast**, but they do not self-shadow —
 * that PCF acne reads as per-frame sparkle in trees. Pass `receiveUpMin: 0`
 * to receive on every face. Contribution `fill` does **not** use that slope
 * gate (stems would otherwise stay unlit in the factor map).
 *
 * Clear the lighting RT to **RGB 1, A 0** (not black). Softness / bilinear
 * samples at coverage edges otherwise pull in black and draw a dark outline
 * of every collision triangle.
 *
 * Prefer this over a lit MeshStandard / ShadowMaterial pass when the host wants
 * cast umbras without a static dark stamp on the whole collision footprint.
 * Assign to proxy meshes with `castShadow` and `receiveShadow` both true; the
 * umbra shape follows those triangles (splat foliage cannot cast).
 *
 * @param lights - Shadow-casting light, or intensity-weighted contributions.
 *   The first entry is the innermost cascade when `midLight` / `outerLight` /
 *   `farLight` are set.
 * @param options.umbra - Multiplier in full shadow, in `[0, 1]`. Default `0.45`.
 * @param options.receiveUpMin - World-up `normal.y` below which the face does
 *   not receive. Default `0.25`. `0` disables the slope gate.
 * @param options.color - Light tint for the optional Lambert boost. Mutate
 *   in place; the material holds this object. Default white.
 * @param options.diffuse - Lambert boost on top of identity. Default `0`
 *   (shadow multiplier only). Facing, unshadowed coverage becomes
 *   `1 + color * NdotL * diffuse`.
 * @param options.direction - World-space direction **toward** the light.
 *   Mutate in place each frame as the sun moves. Default `(0, 1, 0)`.
 * @param options.midLight - Optional mid cascade (demo: ~50 m). Blend from
 *   the first light over `nearRadius`.
 * @param options.midRadius - World metres where the mid cascade yields to
 *   `outerLight` (or `farLight`). Default `50`.
 * @param options.outerLight - Optional outer cascade (demo: ~160 m) between
 *   mid and scene-sized far. Blend from mid over `midRadius`, then to
 *   `farLight` over `outerRadius`.
 * @param options.outerRadius - World metres where the outer cascade yields to
 *   `farLight`. Default `160`. Ignored without `outerLight` and `farLight`.
 * @param options.farLight - Optional scene-sized cascade. Out-of-frustum
 *   `shadow()` is 1 (lit), so inner maps can stay tight without clipping
 *   distant umbras. Blend by camera distance.
 * @param options.nearRadius - World metres where the inner cascade yields to
 *   `midLight` (or to `farLight` if there is no mid). Default `20` with
 *   `midLight`, else `100`.
 */
export function createRelightingShadowFactorMaterial(
  lights: THREE.Light | RelightingLightContribution[],
  options: RelightingShadowFactorOptions = {},
): THREE.MeshStandardNodeMaterial {
  const umbra = Number.isFinite(options.umbra)
    ? Math.min(1, Math.max(0, options.umbra as number))
    : 0.45;
  const receiveUpMin = Number.isFinite(options.receiveUpMin)
    ? Math.min(0.95, Math.max(0, options.receiveUpMin as number))
    : 0.25;
  const diffuse = Number.isFinite(options.diffuse) ? Math.max(0, options.diffuse as number) : 0;
  const material = new THREE.MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide;
  material.color = new THREE.Color(1, 1, 1);
  material.roughness = 1;
  material.metalness = 0;
  material.transparent = false;
  material.depthWrite = true;
  // polygonOffset reduces self-shadow acne that reads as mesh wireframe.
  material.polygonOffset = true;
  material.polygonOffsetFactor = 2;
  material.polygonOffsetUnits = 2;
  // Bypass MeshStandard lighting. Shadow attenuation is the base multiplier;
  // optional Lambert is added on top of identity so unshadowed coverage stays
  // ≈ 1 when `diffuse` is 0.
  const dist = positionWorld.distance(cameraPosition);
  const contributions = normalizeRelightingLights(lights);
  const receive =
    receiveUpMin > 0
      ? asNode<'float'>(smoothstep(float(receiveUpMin), float(receiveUpMin + 0.3), normalWorld.y))
      : float(1);

  const shadowTermAt = (index: number, light: THREE.Light): Node<'float'> => {
    const raw = index === 0 ? cascadedShadow(light, options, dist) : asNode<'float'>(shadow(light));
    // Mix toward lit (1) as punctual range fades so umbras soften instead of
    // clipping at the shadow-map far plane.
    return asNode<'float'>(mix(float(1), raw, punctualUmbraWeight(light)));
  };
  // A ShadowNode owns its shadow render resources. Reuse one node per
  // contribution so adding fill does not render the same shadow map twice.
  const shadowTerms = contributions.map((contribution, index) =>
    shadowTermAt(index, contribution.light),
  );

  let factor: Node<'float'>;
  let shadowed: Node<'float'> = float(1);

  if (options.combine === 'min' && contributions.length > 0) {
    // Union of umbras with per-light depth from contribution intensity:
    // umbra_i = clamp(1 - I * (1 - umbra), 0, 1)
    // so I=0 → no shadow, I=1 → default umbra, I>1 → darker than default.
    let factorCombined: Node<'float'> = float(1);
    for (let i = 0; i < contributions.length; i++) {
      const contribution = contributions[i]!;
      const intensity = contributionIntensity(contribution);
      if (intensity <= 0) continue;
      const umbra_i = Math.min(1, Math.max(0, 1 - intensity * (1 - umbra)));
      const term = shadowTerms[i]!;
      const factor_i = asNode<'float'>(mix(float(umbra_i), float(1), term));
      factorCombined = asNode<'float'>(min(factorCombined, factor_i));
    }
    shadowed = factorCombined;
    factor = asNode<'float'>(mix(float(1), factorCombined, receive));
  } else {
    const shadowIndices = contributions
      .map((contribution, index) => ({ index, intensity: contributionIntensity(contribution) }))
      .filter(({ intensity }) => intensity > 0);
    if (shadowIndices.length === 1) {
      shadowed = shadowTerms[shadowIndices[0]!.index]!;
    } else if (shadowIndices.length > 1) {
      let illum: Node<'float'> = float(0);
      let denom = 0;
      for (const { index, intensity } of shadowIndices) {
        denom += intensity;
        const term = shadowTerms[index]!;
        illum = asNode<'float'>(illum.add(float(intensity).mul(term)));
      }
      shadowed = asNode<'float'>(illum.div(float(denom)));
    }
    if (shadowIndices.length > 0) {
      const attenuation = mix(float(1), shadowed, receive);
      factor = mix(float(umbra), float(1), attenuation);
    } else {
      factor = float(1);
    }
  }

  let boost: Node<'vec3'> = vec3(0, 0, 0);
  if (diffuse > 0) {
    const lightColor = uniform(options.color ?? new THREE.Color(1, 1, 1));
    const lightDir = uniform(options.direction ?? new THREE.Vector3(0, 1, 0));
    const ndl = asNode<'float'>(normalWorld.dot(lightDir.normalize()).max(0));
    boost = asNode<'vec3'>(lightColor.mul(ndl).mul(float(diffuse)).mul(receive).mul(shadowed));
  }
  for (let i = 0; i < contributions.length; i++) {
    const contribution = contributions[i]!;
    const fill = contributionFill(contribution);
    if (fill <= 0) continue;
    const light = contribution.light;
    const vis = shadowTerms[i]!;
    const punctual = punctualFillTerm(light, fill, vis);
    const directional = directionalFillTerm(light, fill, vis);
    boost = asNode<'vec3'>(boost.add(punctual).add(directional));
  }
  material.outputNode = vec4(vec3(factor).add(boost), float(1));
  return material;
}

function triangleMeshToGeometry(data: TriangleMeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions.slice(), 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices.slice(), 1));
  // Normals are computed after any world bake in {@link createRelightingProxy}.
  return geometry;
}

/**
 * Builds a PlayCanvas-style relighting **proxy** from collision tiles or raw
 * geometries. The host places {@link RelightingProxy.group} on a dedicated
 * layer / scene with lights (never the main splat scene), renders that into
 * an RGBA RT matching the main camera, then calls
 * {@link SplatMesh.setRelighting} with the RT texture.
 *
 * Collision meshes are a convenient stand-in when their silhouette is good
 * enough; a denser reconstructed mesh is often better. This helper does not
 * own lights or the render target.
 *
 * When `matrixWorld` is set (e.g. streamed mesh world matrix with the LCC
 * Z-up→Y-up correction), it is **baked into the geometry** the same way the
 * demo collision BVH path does - so the proxy aligns with splats without
 * depending on a live Object3D transform.
 *
 * Coarse collision proxies leave hard coverage silhouettes; hosts should pass
 * `RelightingSettings.softness` (and often a half-res lighting RT) so those
 * edges do not look like a static shadow.
 *
 * For cast umbras **without** a static dark footprint, render the proxy with
 * {@link createRelightingShadowFactorMaterial} so RT RGB is a multiplier
 * (unshadowed ≈ 1), not a lit-gray appearance.
 */
export function createRelightingProxy(
  options: {
    /** LCC collision tiles (source-local). Prefer with `matrixWorld`. */
    tiles?: readonly CollisionMeshTile[];
    /** Extra or alternative geometries already in the desired frame. */
    geometries?: readonly THREE.BufferGeometry[];
    /**
     * Source-local → world (e.g. streamed mesh `matrixWorld`). Baked into
     * tile / cloned geometries; leave unset when geometries are already world.
     */
    matrixWorld?: THREE.Matrix4;
    /** Gray albedo in `[0, 1]`. Default `0.5` (PlayCanvas brightness 2). */
    albedo?: number;
  } = {},
): RelightingProxy {
  const albedo = options.albedo ?? 0.5;
  const group = new THREE.Group();
  const worldMatrix = options.matrixWorld ?? null;

  const ownedGeometries: THREE.BufferGeometry[] = [];
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(albedo, albedo, albedo),
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  const bakeWorld = (geometry: THREE.BufferGeometry): void => {
    if (!worldMatrix) return;
    geometry.applyMatrix4(worldMatrix);
  };

  const addGeometry = (geometry: THREE.BufferGeometry, owns: boolean): void => {
    let geo = geometry;
    let owned = owns;
    if (worldMatrix && !owns) {
      // Caller still owns the original; bake a private copy.
      geo = geometry.clone();
      owned = true;
    }
    bakeWorld(geo);
    geo.computeVertexNormals();
    if (owned) ownedGeometries.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Proxy is lighting-only; never participate in picking / raycasts.
    mesh.raycast = () => undefined;
    group.add(mesh);
  };

  for (const tile of options.tiles ?? []) {
    addGeometry(triangleMeshToGeometry(tile.data), true);
  }
  for (const geometry of options.geometries ?? []) {
    addGeometry(geometry, false);
  }

  const configureMaterial = (mat: THREE.Material): void => {
    mat.side = THREE.DoubleSide;
    mat.transparent = false;
    mat.opacity = 1;
    if ('color' in mat && mat.color instanceof THREE.Color) {
      mat.color.setRGB(albedo, albedo, albedo);
    }
    if ('roughness' in mat && typeof mat.roughness === 'number') {
      (mat as THREE.MeshStandardMaterial).roughness = 1;
    }
    if ('metalness' in mat && typeof mat.metalness === 'number') {
      (mat as THREE.MeshStandardMaterial).metalness = 0;
    }
  };

  return {
    group,
    configureMaterial,
    dispose: () => {
      material.dispose();
      for (const geometry of ownedGeometries) geometry.dispose();
      group.clear();
    },
  };
}
