/**
 * Viewer-only "volumetric fog" mode: a low ground fog lit by a flashlight the
 * camera carries and by accent spot lights (scene presets that may orbit or
 * sweep, else one static spot across the room).
 *
 * Three layers share the lights and the fog density:
 *  - the collision proxy is lit into a relighting factor map (night ambient
 *    plus accent fill, the flashlight shaped by a ringed beam profile);
 *  - a height-fog splat modifier hazes splats by the part of their view ray
 *    that runs through the fog layer;
 *  - a half-resolution pass ray-marches each pixel through every cone, over
 *    only the part of the ray inside the fog layer, and stops at the proxy's
 *    depth (splats do not write depth); a full-resolution pass adds it to the
 *    frame, with the glow around each accent lamp.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  acos,
  cameraPosition,
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  exp,
  float,
  getViewPosition,
  interleavedGradientNoise,
  max,
  min,
  mix,
  positionGeometry,
  screenCoordinate,
  screenUV,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { SplatModifier } from '../lib/core';
import type { CollisionMeshTile } from '../lib/formats/lcc/collision-mesh';
import type {
  RelightingAttachment,
  RelightingLightContribution,
  RelightingProxy,
  RelightingTarget,
} from '../lib/relighting';

type Node<T extends string> = THREE.Node<T>;

/**
 * Night level the factor map multiplies everything by before the lights add
 * fill: 30% under the original 0.06, so the lights carry more of the scene.
 */
const AMBIENT = 0.042;
/**
 * Fog fills the room up to a height above the floor that grows with density,
 * from {@link FOG_LAYER_MIN} (no fog) to {@link FOG_LAYER_MAX} at
 * {@link FOG_DENSITY_MAX}; the default density gives 2.1 m. Soft top.
 */
const FOG_LAYER_MIN = 0.25;
const FOG_LAYER_MAX = 5;
const FOG_EDGE = 0.3;
/** Top of the fog slider. */
export const FOG_DENSITY_MAX = 0.3;
/** Fog layer height (m) the fog slider starts at. */
const FOG_LAYER_DEFAULT = 2.1;
/** Start of the fog slider: the density whose layer is {@link FOG_LAYER_DEFAULT} deep. */
export const FOG_DENSITY_DEFAULT =
  ((FOG_LAYER_DEFAULT - FOG_LAYER_MIN) / (FOG_LAYER_MAX - FOG_LAYER_MIN)) * FOG_DENSITY_MAX;
/** Fog layer height (m above the floor) for a fog density. */
export const fogLayerHeight = (density: number): number =>
  FOG_LAYER_MIN +
  ((FOG_LAYER_MAX - FOG_LAYER_MIN) * Math.min(Math.max(density, 0), FOG_DENSITY_MAX)) /
    FOG_DENSITY_MAX;
const FOG_COLOR = new THREE.Color(0.55, 0.6, 0.7);
const STEPS = 40;
const MAX_DISTANCE = 40;
/** The scattered light is soft; it is marched at 1 / BEAM_DOWNSCALE resolution. */
const BEAM_DOWNSCALE = 2;

/** Flashlight focus range (half-angles, rad) and its start: a 15° beam. */
const WIDE = 0.6;
const NARROW = 0.06;
const START = THREE.MathUtils.degToRad(7.5);
/** Start of the rings slider: how strongly the reflector rings show. */
export const FLASH_RINGS_DEFAULT = 0.9;
/** Fill / beam gain are tuned at this half-angle. */
const REFERENCE = 0.38;
const FLASH_FILL = 32;
/**
 * Fill of the switched-off flashlight. Not 0: a zero fill changes the factor
 * material's compiled shape, and the weight update then refuses the whole
 * change, leaving the old fill (and its rings) lit.
 */
const FILL_OFF = 1e-6;

/** Flashlight reach (m) at the reference brightness. */
const FLASH_RANGE = 18;
const FLASH_GAIN = 0.6;
const solidAngle = (angle: number): number => 1 - Math.cos(angle);
/** Flashlight half-angle (rad) for a focus of 0 (wide) … 1 (narrow). */
export const flashlightHalfAngle = (focus: number): number => WIDE + (NARROW - WIDE) * focus;
const WIDE_BRIGHTNESS = solidAngle(REFERENCE) / solidAngle(WIDE);
/** Capped: conserving energy down to 0.06 rad would be ~40× and clip to white. */
const NARROW_BRIGHTNESS = 4.7;

export type VolumetricFogInputs = {
  renderer: THREE.WebGPURenderer;
  camera: THREE.PerspectiveCamera;
  /** Mesh-world matrix baked into source-local LCC collision tiles. */
  matrixWorld: THREE.Matrix4;
  tiles?: readonly CollisionMeshTile[];
  /** Already world-space proxy geometry (e.g. `?proxy=`); wins over `tiles`. */
  geometries?: readonly THREE.BufferGeometry[];
  /**
   * World-space geometry lit alongside either proxy (the demo's mark, say),
   * so lights, shadows and the beam march see it. Owned by the caller.
   */
  extraGeometries?: readonly THREE.BufferGeometry[];
  /**
   * Fixed spot lights besides the flashlight (see {@link FOG_ACCENT_PRESETS}).
   * Without any, one warm spot is placed across the room from the camera.
   */
  accents?: readonly FogAccent[];
};

/** A fixed spot light in world space; `color` defaults to a warm white. */
export type FogAccent = {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  color?: THREE.ColorRepresentation;
  /** Cone half-angle in radians; default 0.32 (about 18°). */
  angle?: number;
  /** Soft fraction of the cone edge, 0 (hard) … 1; default 0.35. */
  penumbra?: number;
  /** Multiplier on the lamp's fill and beam strength; default 1. */
  gain?: number;
  /**
   * Circles the light around `center` (x, z) at `radius`, keeping its height
   * and aiming at `target`: one lap every `period` seconds, starting at the
   * angle of `position` around `center`.
   */
  orbit?: { center: readonly [number, number]; radius: number; period: number };
  /**
   * Sweeps the aim: `target` moves back and forth along `axis` by up to
   * `amplitude` metres, one full sweep every `period` seconds.
   */
  scan?: { axis: readonly [number, number, number]; amplitude: number; period: number };
};

/**
 * Hand-placed accent lights for known demo scenes, keyed by scene file name.
 * Tempel, seen from the demo's start in the round peristyle courtyard: a warm
 * lamp slowly circling the courtyard behind both pillar rings, lighting across
 * the garden, and an orange and a blue spot behind the inner-ring pillars on
 * either side, crossing the courtyard floor while one tilts and one pans.
 */
export const FOG_ACCENT_PRESETS: Readonly<Record<string, readonly FogAccent[]>> = {
  'Tempel.lcc2': [
    // Courtyard rings fitted to the collision pillars around (-0.42, -23.3):
    // inner r 12.9, outer r 17.4, wall r 18.5. The lamp runs in the walkway
    // between the two pillar rings, starting on the far side of the start view.
    {
      position: [2.93, 1.44, -7.66],
      target: [-0.42, -0.36, -23.3],
      orbit: { center: [-0.42, -23.3], radius: 16, period: 120 },
    },
    // Orange tilts its aim up and down (about ±13°); blue pans left and right
    // (about ±27°).
    {
      position: [12.86, 1.44, -19.91],
      target: [-6, 1.2, -27],
      color: 0xff6a1a,
      scan: { axis: [0, 1, 0], amplitude: 4.5, period: 10 },
    },
    {
      position: [-7.2, 1.44, -11.63],
      target: [4, -0.36, -28],
      color: 0x3a6bff,
      scan: { axis: [0.825, 0, 0.565], amplitude: 10, period: 14 },
    },
  ],
};

export type VolumetricFogMode = {
  /** Height-fog modifier for the splat effect slot. */
  readonly modifier: SplatModifier;
  /** The flashlight's visible model (world space); add it to the drawn scene. */
  readonly model: THREE.Object3D;
  /** Attaches the night factor map to the displayed mesh. */
  attach(target: RelightingTarget): void;
  /** Per frame, before the splat draw: moves the lights and lights the proxy. */
  renderLighting(): void;
  /** Per frame, after the main render: adds the light scattered by the fog. */
  renderBeams(): void;
  /**
   * The proxy depth {@link renderLighting} leaves behind at drawing-buffer
   * size, for other passes that stop at the scene (the mark's fire).
   */
  readonly proxyDepth: THREE.DepthTexture;
  setFogDensity(density: number): void;
  setRings(strength: number): void;
  /** 0 = wide and dim, 1 = narrow and bright. */
  setFocus(focus: number): void;
  readonly startFocus: number;
  readonly fogDensity: number;
  /** Switches the flashlight on or off (it starts off). Returns whether it is now on. */
  toggleLit(): boolean;
  /** Puts the lit flashlight down where it is, or picks it back up. Returns `carried`. */
  toggleCarried(): boolean;
  readonly lit: boolean;
  readonly carried: boolean;
  /**
   * Aims the flashlight at the mouse cursor (normalised device
   * coordinates, -1…1, y up); `null` points it where the camera looks.
   */
  setAim(ndc: { readonly x: number; readonly y: number } | null): void;
  /**
   * The fog's spot lights as of the last {@link renderLighting} (world
   * space), for other volumes that should scatter them too (the mark's smoke).
   */
  volumeLights(): readonly VolumeLight[];
  dispose(): void;
};

/** A spot light shaded like the fog's beams: cone, range window, soft falloff. */
export type VolumeLight = {
  readonly position: THREE.Vector3;
  readonly direction: THREE.Vector3;
  readonly cosOuter: number;
  readonly cosInner: number;
  /** The fog's beam gain for this light. */
  readonly gain: number;
  readonly range: number;
  readonly color: THREE.Color;
};

type BeamLight = {
  light: THREE.SpotLight;
  pos: THREE.UniformNode<'vec3', THREE.Vector3>;
  dir: THREE.UniformNode<'vec3', THREE.Vector3>;
  outer: THREE.UniformNode<'float', number>;
  inner: THREE.UniformNode<'float', number>;
  gain: THREE.UniformNode<'float', number>;
  rings: THREE.UniformNode<'float', number>;
  /** `light.distance`, live so focusing can throw the flashlight further. */
  range: THREE.UniformNode<'float', number>;
  /** Glow around the source itself; 0 for the carried flashlight. */
  halo: number;
};

export async function createVolumetricFogMode(
  inputs: VolumetricFogInputs,
): Promise<VolumetricFogMode> {
  const {
    attachRelighting,
    createRelightingBeamProfile,
    createRelightingProxy,
    createRelightingShadowFactorMaterial,
    renderRelightingFactorMap,
    updateRelightingShadowFactorWeights,
  } = await import('../lib/relighting');
  const { renderer, camera } = inputs;

  const extra = inputs.extraGeometries ?? [];
  // The proxy bakes `matrixWorld` into every geometry it is handed, so world
  // geometry riding along with source-local tiles is pre-multiplied by the
  // inverse and comes out in world space again.
  const inverseWorld = inputs.matrixWorld.clone().invert();
  const proxy: RelightingProxy =
    inputs.geometries && inputs.geometries.length > 0
      ? createRelightingProxy({ geometries: [...inputs.geometries, ...extra], albedo: 1 })
      : createRelightingProxy({
          tiles: inputs.tiles ?? [],
          geometries: extra.map((geometry) => geometry.clone().applyMatrix4(inverseWorld)),
          matrixWorld: inputs.matrixWorld.clone(),
          albedo: 1,
        });
  const lightScene = new THREE.Scene();
  lightScene.add(proxy.group);

  // Floor lookup on the proxy: near-horizontal triangles bucketed per metre.
  // A splat height query snags on columns and floaters beside the camera.
  const FLOOR_CELL = 1;
  const floorCells = new Map<string, number[]>();
  const cellKey = (x: number, z: number): string =>
    `${Math.floor(x / FLOOR_CELL)},${Math.floor(z / FLOOR_CELL)}`;
  {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const normal = new THREE.Vector3();
    proxy.group.updateMatrixWorld(true);
    proxy.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const position = (obj.geometry as THREE.BufferGeometry).getAttribute('position');
      const index = (obj.geometry as THREE.BufferGeometry).getIndex();
      const count = index ? index.count : position.count;
      for (let t = 0; t + 2 < count; t += 3) {
        const i0 = index ? index.getX(t) : t;
        const i1 = index ? index.getX(t + 1) : t + 1;
        const i2 = index ? index.getX(t + 2) : t + 2;
        a.fromBufferAttribute(position, i0).applyMatrix4(obj.matrixWorld);
        b.fromBufferAttribute(position, i1).applyMatrix4(obj.matrixWorld);
        c.fromBufferAttribute(position, i2).applyMatrix4(obj.matrixWorld);
        normal.subVectors(b, a).cross(c.clone().sub(a)).normalize();
        if (Math.abs(normal.y) < 0.8) continue;
        const key = cellKey((a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3);
        const heights = floorCells.get(key);
        const y = (a.y + b.y + c.y) / 3;
        if (heights) heights.push(y);
        else floorCells.set(key, [y]);
      }
    });
  }
  /** Highest proxy floor at least half a metre below the camera, or `null`. */
  const probeFloor = (): number | null => {
    const eye = camera.position;
    let best = -Infinity;
    for (const y of floorCells.get(cellKey(eye.x, eye.z)) ?? []) {
      if (y <= eye.y - 0.5 && y > best) best = y;
    }
    return Number.isFinite(best) ? best : null;
  };

  // --- Lights ----------------------------------------------------------------
  const lobe = (t: number, center: number, width: number, gain: number): number =>
    gain * Math.exp(-(((t - center) / width) ** 2));
  const rings = createRelightingBeamProfile((t) =>
    Math.min(
      1,
      0.12 + lobe(t, 0, 0.2, 0.88) + lobe(t, 0.55, 0.16, 0.38) + lobe(t, 0.88, 0.045, 0.32),
    ),
  );

  // Dark body and a thicker, shorter head along +Y, the lens end at the origin
  // with a glowing bulb half out of it. Unlit materials: the scene has no lights.
  const model = new THREE.Group();
  const darkMaterial = new THREE.MeshBasicMaterial({ color: 0x1b1b1e });
  const glowMaterial = new THREE.MeshBasicMaterial({ color: 0xfff0d8, toneMapped: false });
  const bodyGeometry = new THREE.CylinderGeometry(0.022, 0.022, 0.2, 20);
  const headGeometry = new THREE.CylinderGeometry(0.036, 0.036, 0.07, 24);
  const bulbGeometry = new THREE.SphereGeometry(0.028, 20, 12);
  const body = new THREE.Mesh(bodyGeometry, darkMaterial);
  body.position.y = -0.17;
  const head = new THREE.Mesh(headGeometry, darkMaterial);
  head.position.y = -0.035;
  model.add(body, head, new THREE.Mesh(bulbGeometry, glowMaterial));
  model.visible = false;
  const modelAxis = new THREE.Vector3(0, 1, 0);
  const modelDirection = new THREE.Vector3();

  const flashlight = new THREE.SpotLight(0xfff0d8, 1, FLASH_RANGE, START, 0.1, 1.2);
  // Preset accents, or one warm spot anchored across the room (see below).
  const accentPoses: readonly (FogAccent | null)[] = inputs.accents?.length
    ? inputs.accents
    : [null];
  const accents = accentPoses.map(
    (pose) =>
      new THREE.SpotLight(
        pose?.color ?? 0xffc890,
        1,
        34,
        pose?.angle ?? 0.32,
        pose?.penumbra ?? 0.35,
        1.2,
      ),
  );
  const accentGain = (index: number): number => accentPoses[index]?.gain ?? 1;
  for (const light of [flashlight, ...accents]) {
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.bias = -0.002;
    // Coarse collision triangles cast hard shards; push and blur them.
    light.shadow.normalBias = 0.15;
    light.shadow.radius = 4;
    lightScene.add(light, light.target);
  }

  const flashContribution: RelightingLightContribution = {
    light: flashlight,
    intensity: 0,
    fill: FLASH_FILL,
    beamProfile: rings,
    beamProfileStrength: FLASH_RINGS_DEFAULT,
  };
  const accentContributions: RelightingLightContribution[] = accents.map((light, i) => ({
    light,
    intensity: 0,
    fill: 55 * accentGain(i),
  }));
  const contributions = () => [flashContribution, ...accentContributions];
  const factorMaterial = createRelightingShadowFactorMaterial(contributions(), {
    combine: 'min',
  });
  factorMaterial.side = THREE.FrontSide;
  proxy.group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.material = factorMaterial;
    obj.castShadow = true;
    obj.receiveShadow = true;
  });

  // The factor pass keeps the proxy depth for the beam march.
  const factorTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType });
  factorTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
  factorTarget.depthTexture = new THREE.DepthTexture(1, 1);

  // --- Height fog ------------------------------------------------------------
  const fogDensity = uniform(FOG_DENSITY_DEFAULT);
  let fogLayer = fogLayerHeight(FOG_DENSITY_DEFAULT);
  const fogTop = uniform(fogLayer);
  const fogColor = vec3(FOG_COLOR.r, FOG_COLOR.g, FOG_COLOR.b);

  /** Fog density at world height `y`: full in the layer, gone just above it. */
  const densityAt = (y: Node<'float'>): Node<'float'> =>
    fogDensity.mul(float(1).sub(smoothstep(fogTop.sub(FOG_EDGE), fogTop.add(FOG_EDGE), y)));

  // The camera's world position as a uniform rather than TSL's `cameraPosition`:
  // a unified draw folds this modifier into a compute gather, which has no
  // camera to resolve the node against.
  const eyeWorld = uniform(new THREE.Vector3());
  const modifier: SplatModifier = (ctx) => {
    const toSplat = ctx.worldCenter.sub(eyeWorld);
    const distance = toSplat.length();
    // Share of the camera→splat segment that lies inside the layer.
    const low = min(eyeWorld.y, ctx.worldCenter.y);
    const high = max(eyeWorld.y, ctx.worldCenter.y);
    const inside = fogTop.sub(low).div(high.sub(low).max(1e-3)).clamp(0, 1);
    const haze = float(1).sub(exp(fogDensity.mul(distance).mul(inside).negate()));
    return { color: vec4(mix(ctx.color.rgb, fogColor, haze), ctx.color.a) };
  };

  // --- Light scattered by the fog --------------------------------------------
  const beamLight = (
    light: THREE.SpotLight,
    gain: number,
    ringStrength: number,
    halo: number,
  ): BeamLight => ({
    light,
    pos: uniform(new THREE.Vector3()),
    dir: uniform(new THREE.Vector3(0, 0, -1)),
    outer: uniform(light.angle),
    inner: uniform(light.angle * (1 - light.penumbra)),
    gain: uniform(gain),
    rings: uniform(ringStrength),
    range: uniform(light.distance),
    halo,
  });
  const beams = [
    beamLight(flashlight, FLASH_GAIN, FLASH_RINGS_DEFAULT, 0),
    ...accents.map((light, i) => beamLight(light, 8 * accentGain(i), 0, 1.2)),
  ];

  /** Proxy depth along the view ray, or {@link MAX_DISTANCE} where it shows sky. */
  const viewRay = () => {
    const depth = texture(factorTarget.depthTexture!, screenUV).x;
    const viewHit = getViewPosition(screenUV, depth, cameraProjectionMatrixInverse);
    const rayDir = cameraWorldMatrix.mul(vec4(viewHit.normalize(), 0)).xyz.normalize();
    const hit = depth.lessThan(1).select(viewHit.length(), float(MAX_DISTANCE));
    return { rayDir, hit };
  };

  const beamNode = Fn(() => {
    const { rayDir, hit } = viewRay();
    const scattered = vec3(0, 0, 0).toVar();

    // Density is zero above the layer's soft top, so march only the stretch of
    // the ray below it: all steps land in fog, and rays that never enter the
    // layer (sky and walls above the fog from head height) skip the march.
    const end = hit.min(MAX_DISTANCE);
    const ceiling = fogTop.add(FOG_EDGE);
    const above = ceiling.sub(cameraPosition.y);
    const dirY = rayDir.y;
    // Where the ray crosses the ceiling; only read when dirY points at it.
    const safeDirY = dirY.lessThan(0).select(dirY.min(-1e-5), dirY.max(1e-5));
    const crossing = above.div(safeDirY);
    const start = above
      .greaterThan(0)
      .select(float(0), dirY.lessThan(0).select(crossing, end))
      .min(end);
    const stop = dirY.greaterThan(0).select(crossing.min(end), end);
    const segment = stop.sub(start);

    If(segment.greaterThan(1e-3), () => {
      const stepLength = segment.div(STEPS);
      const jitter = interleavedGradientNoise(screenCoordinate);
      const opticalDepth = float(0).toVar();
      Loop(STEPS, ({ i }) => {
        const s = start.add(float(i).add(jitter).mul(stepLength));
        const point = cameraPosition.add(rayDir.mul(s));
        const density = densityAt(point.y);
        opticalDepth.addAssign(density.mul(stepLength));
        const weight = density.mul(stepLength).mul(exp(opticalDepth.negate()));
        for (const beam of beams) {
          const toPoint = point.sub(beam.pos);
          const d = toPoint.length().max(1e-3);
          const cosAngle = toPoint.div(d).dot(beam.dir).clamp(-1, 1);
          const cone = smoothstep(beam.outer.cos(), beam.inner.cos(), cosAngle);
          const t = acos(cosAngle).div(beam.outer).clamp(0, 1);
          const ring = mix(float(1), texture(rings, vec2(t, 0.5)).level(float(0)).r, beam.rings);
          const range = d.div(beam.range).pow4().oneMinus().clamp().pow2();
          const falloff = range.div(d.mul(d).mul(0.08).add(1));
          const color = vec3(beam.light.color.r, beam.light.color.g, beam.light.color.b);
          scattered.addAssign(color.mul(cone.mul(ring).mul(falloff).mul(weight).mul(beam.gain)));
        }
      });
    });

    return vec4(scattered, 1);
  });

  // Marched at reduced resolution, then upsampled bilinearly by the composite.
  const beamTarget = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  beamTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;

  const compositeNode = Fn(() => {
    const { rayDir, hit } = viewRay();
    const color = texture(beamTarget.texture, screenUV).rgb.toVar();
    // A lamp you can see: glow around a source in front of the proxy surface,
    // so a pillar between you and the light hides it. Full resolution: the
    // core is only a few pixels wide.
    for (const beam of beams) {
      if (beam.halo <= 0) continue;
      const toLight = beam.pos.sub(cameraPosition);
      const along = toLight.dot(rayDir);
      const miss = toLight.sub(rayDir.mul(along)).length();
      const inFront = along.greaterThan(0).and(along.lessThan(hit)).select(float(1), float(0));
      const glow = exp(miss.div(0.09).pow2().negate()).add(exp(miss.div(0.35).negate()).mul(0.25));
      const lamp = vec3(beam.light.color.r, beam.light.color.g, beam.light.color.b);
      color.addAssign(lamp.mul(glow.mul(inFront).mul(beam.halo)));
    }
    return vec4(color, 1);
  });

  const fullScreenPass = (colorNode: Node<'vec4'>, blending: THREE.Blending) => {
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: blending !== THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
      blending,
    });
    material.vertexNode = vec4(positionGeometry.xy, 0, 1);
    material.colorNode = colorNode;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    return { scene, material, quad };
  };
  const beamPass = fullScreenPass(beamNode(), THREE.NoBlending);
  const compositePass = fullScreenPass(compositeNode(), THREE.AdditiveBlending);
  const bufferSize = new THREE.Vector2();

  // --- Placement -------------------------------------------------------------
  const forward = new THREE.Vector3();
  const aimPoint = new THREE.Vector3();
  let aim: { x: number; y: number } | null = null;
  const right = new THREE.Vector3();
  let floorY = probeFloor() ?? camera.position.y - 1.6;
  let lit = false;
  let ringStrength = FLASH_RINGS_DEFAULT;
  let carried = true;
  let focusNow = 0;
  let framesToProbe = 0;

  // Without presets, the one accent stands across the room from the camera:
  // far ahead, a little to the side, raking back across the middle to the
  // floor. It is anchored on the first frame with a floor under the camera, so
  // turning the mode on from an overview outside the capture does not leave it
  // hanging in empty space.
  const placeAccent = (
    light: THREE.SpotLight,
    position: THREE.Vector3Like,
    target: THREE.Vector3Like,
  ): void => {
    light.position.copy(position);
    light.target.position.copy(target);
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();
  };
  let accentAnchored = false;
  const anchorAccent = (floor: number): void => {
    camera.updateMatrixWorld();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    right.crossVectors(forward, THREE.Object3D.DEFAULT_UP).normalize();
    placeAccent(
      accents[0]!,
      camera.position
        .clone()
        .addScaledVector(forward, 11)
        .addScaledVector(right, -0.75)
        .setY(floor + 2.6),
      camera.position.clone().addScaledVector(forward, 4).addScaledVector(right, 2).setY(floor),
    );
    accentAnchored = true;
  };
  /** Orbiting presets: their light, path and start angle. */
  // The clock starts once the camera stands on a floor, so the lamp does not
  // travel while the scene is still loading behind the initial-view screen.
  let startedAt: number | null = null;
  const orbiting = (inputs.accents ?? []).flatMap((pose, i) =>
    pose.orbit
      ? [
          {
            light: accents[i]!,
            ...pose.orbit,
            height: pose.position[1],
            startAngle: Math.atan2(
              pose.position[2] - pose.orbit.center[1],
              pose.position[0] - pose.orbit.center[0],
            ),
          },
        ]
      : [],
  );
  /** Scanning presets: their light, rest aim and sweep. */
  const scanning = (inputs.accents ?? []).flatMap((pose, i) =>
    pose.scan
      ? [
          {
            light: accents[i]!,
            rest: new THREE.Vector3(...pose.target),
            axis: new THREE.Vector3(...pose.scan.axis).normalize(),
            amplitude: pose.scan.amplitude,
            period: pose.scan.period,
          },
        ]
      : [],
  );
  if (inputs.accents?.length) {
    inputs.accents.forEach((pose, i) =>
      placeAccent(
        accents[i]!,
        new THREE.Vector3(...pose.position),
        new THREE.Vector3(...pose.target),
      ),
    );
    accentAnchored = true;
  } else {
    // Parked out of reach until anchored.
    placeAccent(accents[0]!, { x: 0, y: -1e4, z: 0 }, { x: 0, y: -1e4 - 1, z: 0 });
    const initialFloor = probeFloor();
    if (initialFloor !== null) anchorAccent(initialFloor);
  }

  const syncBeam = (beam: BeamLight): void => {
    beam.pos.value.copy(beam.light.position);
    beam.dir.value.copy(beam.light.target.position).sub(beam.light.position).normalize();
  };

  /** The rings go with the beam: nothing shows while the flashlight is off. */
  const applyRings = (): void => {
    const strength = lit ? ringStrength : 0;
    beams[0]!.rings.value = strength;
    flashContribution.beamProfileStrength = strength;
    flashlight.visible = lit;
    model.visible = lit;
    updateRelightingShadowFactorWeights(factorMaterial, contributions());
  };

  const applyFocus = (focus: number): void => {
    focusNow = focus;
    const angle = flashlightHalfAngle(focus);
    const brightness = WIDE_BRIGHTNESS * (NARROW_BRIGHTNESS / WIDE_BRIGHTNESS) ** focus;
    flashlight.angle = angle;
    beams[0]!.outer.value = angle;
    beams[0]!.inner.value = angle * (1 - flashlight.penumbra);
    beams[0]!.gain.value = lit ? FLASH_GAIN * brightness : 0;
    // A concentrated beam carries further: the distance at which it falls to
    // the same illuminance grows with sqrt(intensity) (inverse-square law).
    flashlight.distance = FLASH_RANGE * Math.sqrt(brightness);
    beams[0]!.range.value = flashlight.distance;
    flashContribution.fill = lit ? FLASH_FILL * brightness : FILL_OFF;
    applyRings();
  };
  const startFocus = (WIDE - START) / (WIDE - NARROW);
  applyFocus(startFocus);

  let attachment: RelightingAttachment | null = null;

  return {
    modifier,
    model,
    startFocus,
    get fogDensity() {
      return fogDensity.value;
    },
    proxyDepth: factorTarget.depthTexture,
    attach(target) {
      attachment?.dispose();
      attachment = attachRelighting(target, {
        map: factorTarget.texture,
        blend: 1,
        brightness: AMBIENT,
        background: AMBIENT,
        softness: 2,
      });
    },
    renderLighting() {
      camera.getWorldPosition(eyeWorld.value);
      const now = performance.now() / 1000;
      if (startedAt === null && probeFloor() !== null) startedAt = now;
      const seconds = startedAt === null ? 0 : now - startedAt;
      for (const { light, center, radius, period, height, startAngle } of orbiting) {
        const angle = startAngle + (2 * Math.PI * seconds) / period;
        light.position.set(
          center[0] + radius * Math.cos(angle),
          height,
          center[1] + radius * Math.sin(angle),
        );
        light.updateMatrixWorld();
      }
      for (const { light, rest, axis, amplitude, period } of scanning) {
        const offset = amplitude * Math.sin((2 * Math.PI * seconds) / period);
        light.target.position.copy(rest).addScaledVector(axis, offset);
        light.target.updateMatrixWorld();
      }
      if (framesToProbe-- <= 0) {
        // The floor under the camera moves with it (stairs, ramps); re-probe
        // a few times a second and ease toward it.
        framesToProbe = 20;
        const probed = probeFloor();
        if (probed !== null) {
          floorY += (probed - floorY) * 0.5;
          if (!accentAnchored) anchorAccent(probed);
        }
      }
      fogTop.value = floorY + fogLayer;
      if (carried) {
        // Held just below and right of the eye, pointing where the camera looks.
        camera.updateMatrixWorld();
        camera.getWorldDirection(forward);
        flashlight.position.set(0.18, -0.15, -0.45).applyMatrix4(camera.matrixWorld);
        if (aim === null) {
          flashlight.target.position.copy(camera.position).addScaledVector(forward, 10);
        } else {
          // The point 10 m down the cursor's ray, so the beam crosses it.
          aimPoint.set(aim.x, aim.y, 0.5).unproject(camera).sub(camera.position).normalize();
          flashlight.target.position.copy(camera.position).addScaledVector(aimPoint, 10);
        }
        flashlight.updateMatrixWorld();
        flashlight.target.updateMatrixWorld();
        model.position.copy(flashlight.position);
        modelDirection.copy(flashlight.target.position).sub(flashlight.position).normalize();
        model.quaternion.setFromUnitVectors(modelAxis, modelDirection);
      }
      for (const beam of beams) syncBeam(beam);
      renderRelightingFactorMap(renderer, lightScene, camera, factorTarget);
    },
    renderBeams() {
      renderer.getDrawingBufferSize(bufferSize);
      beamTarget.setSize(
        Math.max(1, Math.ceil(bufferSize.x / BEAM_DOWNSCALE)),
        Math.max(1, Math.ceil(bufferSize.y / BEAM_DOWNSCALE)),
      );
      const previousTarget = renderer.getRenderTarget();
      const autoClear = renderer.autoClear;
      try {
        // Every texel is written (no blending), so the target needs no clear.
        renderer.autoClear = false;
        renderer.setRenderTarget(beamTarget);
        renderer.render(beamPass.scene, camera);
        renderer.setRenderTarget(previousTarget);
        renderer.render(compositePass.scene, camera);
      } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = autoClear;
      }
    },
    setFogDensity(density) {
      fogDensity.value = Math.max(0, density);
      // Thicker fog also rises higher.
      fogLayer = fogLayerHeight(density);
    },
    setRings(strength) {
      ringStrength = strength;
      applyRings();
    },
    setFocus: applyFocus,
    volumeLights() {
      return beams.map((beam) => ({
        position: beam.pos.value,
        direction: beam.dir.value,
        cosOuter: Math.cos(beam.outer.value),
        cosInner: Math.cos(beam.inner.value),
        gain: beam.gain.value,
        range: beam.range.value,
        color: beam.light.color,
      }));
    },
    setAim(ndc) {
      aim = ndc === null ? null : { x: ndc.x, y: ndc.y };
    },
    get carried() {
      return carried;
    },
    get lit() {
      return lit;
    },
    toggleCarried() {
      carried = !carried;
      return carried;
    },
    toggleLit() {
      lit = !lit;
      carried = true;
      applyFocus(focusNow);
      return lit;
    },
    dispose() {
      attachment?.dispose();
      attachment = null;
      factorMaterial.dispose();
      for (const pass of [beamPass, compositePass]) {
        pass.material.dispose();
        pass.quad.geometry.dispose();
      }
      beamTarget.dispose();
      proxy.dispose();
      factorTarget.dispose();
      rings.dispose();
      flashlight.dispose();
      for (const geometry of [bodyGeometry, headGeometry, bulbGeometry]) geometry.dispose();
      darkMaterial.dispose();
      glowMaterial.dispose();
      for (const light of accents) light.dispose();
    },
  };
}
