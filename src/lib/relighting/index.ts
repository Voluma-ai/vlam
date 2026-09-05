/**
 * `@voluma/vlam/relighting` — optional proxy-mesh screen-space relighting.
 *
 * This pre-v1 package composes a factor-map callback onto a standalone
 * `SplatMesh` or `UnifiedSplatMesh` display pass. It owns no caller
 * textures, proxy geometries, lights, scenes, or render targets.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  context,
  cos,
  float,
  frameGroup,
  min,
  mix,
  normalWorld,
  objectPosition,
  positionWorld,
  reference,
  shadow,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
  texture,
} from 'three/tsl';
import type { DisplayColorModifier } from '../core/splat-mesh-material';
import type { CollisionMeshTile } from '../formats/lcc/collision-mesh';
import type { TriangleMeshData } from '../formats/lcc/parse-mesh-ply';

type Node<T extends string> = THREE.Node<T>;
function asNode<T extends string>(node: unknown): Node<T> {
  return node as Node<T>;
}
const size = new THREE.Vector2();
const clearColor = new THREE.Color();

/**
 * Passthrough context: keeps a stable `.id` for the render-object cache, but
 * does not apply host tone-mapping / sRGB encode to the linear factor map.
 */
const RELIGHT_PASS_CONTEXT = context({
  getOutput: (node: THREE.Node) => node,
});

/**
 * Minimal renderer surface {@link renderRelightingFactorMap} needs. A real
 * `THREE.WebGPURenderer` satisfies this; tests can pass a stub.
 */
export type RelightingFactorRenderer = {
  autoClear: boolean;
  shadowMap: { enabled: boolean; autoUpdate?: boolean };
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2;
  getRenderTarget(): THREE.RenderTarget | null;
  getActiveCubeFace(): number;
  getActiveMipmapLevel(): number;
  getMRT(): THREE.MRTNode | null;
  setMRT(mrt: THREE.MRTNode | null): void;
  setRenderTarget(
    target: THREE.RenderTarget | null,
    activeCubeFace?: number,
    activeMipmapLevel?: number,
  ): void;
  getClearColor(target: THREE.Color): THREE.Color;
  getClearAlpha(): number;
  setClearColor(color: THREE.ColorRepresentation, alpha?: number): void;
  clear(): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  contextNode: unknown;
};

/**
 * Renders `scene` from `camera` into `target` as a shadow-factor map:
 * resizes to the drawing buffer, clears **white + A0**, forces `autoClear`
 * and shadow maps on, and swaps in a passthrough `contextNode` so a host
 * ACES/sRGB wrap cannot turn the linear multiplier into speckle.
 *
 * Call each frame **before** `splats.update` / the main splat draw. Restore
 * is guaranteed even if `render` throws.
 */
export function renderRelightingFactorMap(
  renderer: RelightingFactorRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.RenderTarget,
): void {
  renderer.getDrawingBufferSize(size);
  target.setSize(Math.max(1, size.x), Math.max(1, size.y));

  const previousTarget = renderer.getRenderTarget();
  const previousCubeFace = renderer.getActiveCubeFace();
  const previousMipmapLevel = renderer.getActiveMipmapLevel();
  const previousMrt = renderer.getMRT();
  const previousAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const previousShadowEnabled = renderer.shadowMap.enabled;
  const previousShadowAutoUpdate = renderer.shadowMap.autoUpdate;
  const previousContext = renderer.contextNode;
  renderer.getClearColor(clearColor);

  try {
    renderer.contextNode = RELIGHT_PASS_CONTEXT;
    renderer.autoClear = true;
    renderer.shadowMap.enabled = true;
    if (previousShadowAutoUpdate === false) renderer.shadowMap.autoUpdate = true;
    renderer.setMRT(null);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0xffffff, 0);
    renderer.clear();
    renderer.render(scene, camera);
  } finally {
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
    renderer.setMRT(previousMrt);
    renderer.setClearColor(clearColor, previousAlpha);
    renderer.autoClear = previousAutoClear;
    renderer.shadowMap.enabled = previousShadowEnabled;
    if (previousShadowAutoUpdate !== undefined) {
      renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
    }
    renderer.contextNode = previousContext;
  }
}

/** Defaults match PlayCanvas's 0.5-gray proxy convention. */
export const DEFAULT_RELIGHT_BLEND = 1;
export const DEFAULT_RELIGHT_BRIGHTNESS = 2;
export const DEFAULT_RELIGHT_BACKGROUND = 1;
export const DEFAULT_RELIGHT_SOFTNESS = 0;

/** Settings for a lit proxy RGBA factor map. */
export type RelightingSettings = {
  map: THREE.Texture;
  blend?: number;
  brightness?: number;
  background?: number;
  softness?: number;
};

/** A live attachment update; omit `map` to retain the current caller-owned texture. */
export type RelightingUpdate = Partial<RelightingSettings>;

/** Resolved, live numeric relighting settings. */
export type RelightingUniforms = {
  blend: number;
  brightness: number;
  background: number;
  softness: number;
};

/** Clamps the numeric relighting settings without taking ownership of the map. */
export function clampRelightingSettings(
  partial: Partial<Pick<RelightingSettings, 'blend' | 'brightness' | 'background' | 'softness'>>,
  previous: RelightingUniforms = {
    blend: DEFAULT_RELIGHT_BLEND,
    brightness: DEFAULT_RELIGHT_BRIGHTNESS,
    background: DEFAULT_RELIGHT_BACKGROUND,
    softness: DEFAULT_RELIGHT_SOFTNESS,
  },
): RelightingUniforms {
  const blend = partial.blend ?? previous.blend;
  const brightness = partial.brightness ?? previous.brightness;
  const background = partial.background ?? previous.background;
  const softness = partial.softness ?? previous.softness;
  return {
    blend: Number.isFinite(blend) ? Math.min(1, Math.max(0, blend)) : previous.blend,
    brightness: Number.isFinite(brightness) ? Math.max(0, brightness) : previous.brightness,
    background: Number.isFinite(background) ? Math.max(0, background) : previous.background,
    softness: Number.isFinite(softness) ? Math.min(8, Math.max(0, softness)) : previous.softness,
  };
}

/** A target with the generic display-only callback contract. */
export type RelightingTarget = {
  displayColorModifier: DisplayColorModifier | null;
};

/** Controller returned by {@link attachRelighting}. */
export type RelightingAttachment = {
  update(settings: RelightingUpdate): void;
  dispose(): void;
};

/**
 * Adds a relighting factor map after any existing display-color callback.
 * Texture identity and callbacks rebuild the display material; numeric setting
 * changes mutate extension-owned uniforms only. Disposal restores the previous
 * callback only while this attachment remains installed.
 */
export function attachRelighting(
  target: RelightingTarget,
  initial: RelightingSettings,
): RelightingAttachment {
  const previous = target.displayColorModifier;
  const blend = uniform(0);
  const brightness = uniform(DEFAULT_RELIGHT_BRIGHTNESS);
  const background = uniform(DEFAULT_RELIGHT_BACKGROUND);
  const softness = uniform(DEFAULT_RELIGHT_SOFTNESS);
  let map: THREE.Texture | null = null;
  let installed: DisplayColorModifier | null = null;

  const apply = (settings: RelightingUpdate): void => {
    const nextMap = settings.map ?? map;
    if (nextMap === null) throw new Error('attachRelighting requires a factor-map texture.');
    const resolved = clampRelightingSettings(settings, {
      blend: blend.value,
      brightness: brightness.value,
      background: background.value,
      softness: softness.value,
    });
    blend.value = resolved.blend;
    brightness.value = resolved.brightness;
    background.value = resolved.background;
    softness.value = resolved.softness;
    if (nextMap === map && installed !== null) return;
    map = nextMap;
    installed = (rgb, uv, viewport) => {
      const base = previous?.(rgb, uv, viewport) ?? rgb;
      const sample = texture(map!, uv);
      const factor = mix(vec3(background), sample.rgb.mul(brightness), sample.a);
      const ox = softness.div(viewport.x.max(1));
      const oy = softness.div(viewport.y.max(1));
      const a = texture(map!, uv.add(vec2(ox, 0)));
      const b = texture(map!, uv.add(vec2(ox.negate(), 0)));
      const c = texture(map!, uv.add(vec2(0, oy)));
      const d = texture(map!, uv.add(vec2(0, oy.negate())));
      const weight = sample.a.add(a.a).add(b.a).add(c.a).add(d.a).max(1e-4);
      const softRgb = sample.rgb
        .mul(sample.a)
        .add(a.rgb.mul(a.a))
        .add(b.rgb.mul(b.a))
        .add(c.rgb.mul(c.a))
        .add(d.rgb.mul(d.a))
        .div(weight);
      const softFactor = mix(vec3(background), softRgb.mul(brightness), weight.mul(0.2));
      return softness
        .greaterThan(0)
        .select(mix(base, base.mul(softFactor), blend), mix(base, base.mul(factor), blend));
    };
    target.displayColorModifier = installed;
  };
  apply(initial);
  return {
    update: apply,
    dispose: () => {
      if (target.displayColorModifier === installed) target.displayColorModifier = previous;
    },
  };
}

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
