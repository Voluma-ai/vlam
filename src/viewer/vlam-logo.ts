/**
 * Viewer-only VLAM! mark: the white left stroke of the V as a mesh
 * (`vlam-balk.glb`, fitted to the logo bitmap's outline) and the flame and
 * its effects as synthetic splats (`logo-splats.ts`):
 *
 *  - the **stroke**, a lit mesh: shaded in-shader from the flame and relit by
 *    the scene's factor map like any other surface, and the same mesh is the
 *    relighting / occluder proxy;
 *  - the **fire**: flame body, glow, embers and the light pool on the floor,
 *    one `SplatMesh`, emissive, so the host draws it on its own and night
 *    relighting leaves it alone.
 *
 * The flame is the light source: the stroke's lighting is a warm point light
 * at the flame centroid plus a hemispheric sky term scaled by `night`, which
 * the viewer lowers under the fog effect so the mark sits in the dark the way
 * the scene does. Everything animates through uniforms; each modifier is
 * built once per mesh.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  colorSpaceToWorking,
  float,
  fract,
  hash,
  int,
  max,
  mix,
  mx_noise_float,
  mx_noise_vec3,
  normalize,
  normalWorld,
  positionWorld,
  pow,
  screenUV,
  smoothstep,
  uniform,
  vec3,
  vec4,
  viewportSize,
} from 'three/tsl';
import {
  SplatMesh,
  type DisplayColorModifier,
  type SplatData,
  type SplatMeshOptions,
  type SplatModifier,
} from '../lib/core';
import { buildLogoSplats, type LogoBitmap, type LogoLayer, type LogoSplats } from './logo-splats';
import type { FogAccent } from './volumetric-fog';

/** The mark's base floats this far above the floor; the light pool sits on the floor. */
export const LOGO_FLOOR_BELOW = 0.3;

/**
 * Where the mark's base goes in known demo scenes, keyed by scene file name.
 * Tempel: the middle of the round peristyle courtyard (floor at y ≈ -0.36,
 * see the fog accent presets), the base a little above the floor.
 */
export const LOGO_PLACEMENTS: Readonly<Record<string, readonly [number, number, number]>> = {
  'Tempel.lcc2': [-0.42, -0.06, -23.3],
};

/** Decodes a bitmap URL into RGBA pixels through a 2D canvas. */
export async function loadLogoBitmap(url: string): Promise<LogoBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Logo bitmap ${url}: HTTP ${response.status}`);
  const image = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Logo bitmap: 2D canvas unavailable.');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height);
  image.close();
  return { width: pixels.width, height: pixels.height, data: pixels.data };
}

export interface VlamLogoOptions {
  /** World height of the mark, metres (default 8). */
  readonly height?: number;
  /**
   * The mesh of the white stroke (`vlam-balk.glb`, in the mark's local frame
   * at 8 m): drawn as a real lit surface and used verbatim as the relighting /
   * occluder proxy.
   */
  readonly strokeGeometry: THREE.BufferGeometry;
  /** Show only the white stroke (`'stroke'`) or the whole mark (`'full'`). */
  readonly parts?: 'stroke' | 'full';
  /** Freeze the animation (the mark still lights itself). */
  readonly animate?: boolean;
  /** Floor below the mark's base, metres; the light pool sits there. */
  readonly floorBelow?: number;
  /**
   * Draw the splat flame body (default). A host that simulates its own fire
   * in the flame's shape passes `false` and keeps only glow, embers and pool.
   */
  readonly flameBody?: boolean;
  /**
   * Mesh settings the mark's meshes must share with the scene mesh to join
   * it in a `UnifiedSplatMesh` (cutoff, footprint floor, filter profile,
   * contribution culls); `antialias` is stamped on the data.
   */
  readonly mesh?: SplatMeshOptions & { antialias?: boolean };
}

/** A spot light aimed at the mark, in world space. */
export interface LogoSpotlight {
  readonly position: THREE.Vector3;
  readonly target: THREE.Vector3;
  /** Lambert gain on the stroke's own shading; default 1.4. */
  readonly intensity?: number;
  /** Cone half-angle in degrees; default 18. */
  readonly angleDeg?: number;
  /** Soft fraction of the cone edge, 0 (hard) … 1; default 0.35. */
  readonly penumbra?: number;
  /** Fill gain of the matching fog accent, relative to the fog's default. */
  readonly fogGain?: number;
}

/** The mounted mark. */
export interface VlamLogo {
  /**
   * The white stroke, a lit mesh. Add it to the scene; it is posed with the
   * mark and occludes the splats behind it through the depth test. Also the
   * pose reference (matrixWorld) of the mark.
   */
  readonly stroke: THREE.Mesh;
  /**
   * Relighting target of the stroke: `attachRelighting` installs its
   * factor-map callback here, as on a splat mesh.
   */
  readonly strokeDisplay: { displayColorModifier: DisplayColorModifier | null };
  /** The emissive layers; `null` for a stroke-only mark. */
  readonly fire: SplatMesh | null;
  /** The splat meshes (the fire), for the scene. */
  readonly meshes: readonly SplatMesh[];
  readonly splats: LogoSplats;
  /** World position of the flame centroid: where its light comes from. */
  readonly flameWorld: THREE.Vector3;
  /** World position of the stroke's center. */
  readonly strokeCenterWorld: THREE.Vector3;
  /** World position of the mark's base. */
  readonly position: THREE.Vector3;
  /** Objects {@link place} poses with the mark (a simulated fire, say). */
  readonly followers: THREE.Object3D[];
  /** Local-space bounds of the flame body (for a host's own fire). */
  readonly flameMin: readonly [number, number, number];
  readonly flameMax: readonly [number, number, number];
  /** Places the base and turns the mark's front toward a world point. */
  place(base: THREE.Vector3, faceToward: THREE.Vector3): void;
  /** Per frame: advances the animation uniforms. */
  tick(elapsed: number): void;
  /** Per frame on the standalone path: {@link tick} plus each mesh's sort/upload. */
  update(camera: THREE.PerspectiveCamera, renderer: THREE.WebGPURenderer, elapsed: number): void;
  /** 1 under daylight; lower it to the scene's night level under fog/relight. */
  setNight(level: number): void;
  /**
   * A white spot light on the stroke (world space), or `null` for none. The
   * stroke shades itself, so this is how a scene light reaches it; the same
   * light is reported by {@link fogAccents} so its beam shows in the fog.
   */
  setSpotlight(spot: LogoSpotlight | null): void;
  /** The flame as a volumetric-fog accent light (none for a stroke-only mark). */
  fogAccents(): readonly FogAccent[];
  /**
   * A fresh solid prism of the stroke's shape in world space, for a
   * relighting proxy (so scene lights and the flashlight land on the stroke
   * through the factor map) or a depth occluder. The caller owns it.
   */
  strokeProxyGeometry(): THREE.BufferGeometry;
  dispose(): void;
}

/**
 * The mark height (metres) `vlam-balk.glb` is modelled for. The mesh is the
 * V's left stroke baked into the mark's local frame at this height (fitted to
 * the bitmap's stroke outline), and scales uniformly with `height`.
 */
const STROKE_MESH_HEIGHT = 8;

/** The warm flame tint on the stroke. */
const FLAME_WARM = vec3(1.0, 0.58, 0.26);

/** Where the stroke's lights are, in whatever frame `p`, `n` and `eye` share. */
interface StrokeLights {
  readonly flame: THREE.UniformNode<'vec3', THREE.Vector3>;
  readonly spot: THREE.UniformNode<'vec3', THREE.Vector3>;
  readonly spotDir: THREE.UniformNode<'vec3', THREE.Vector3>;
  readonly spotIntensity: THREE.UniformNode<'float', number>;
  readonly spotCosOuter: THREE.UniformNode<'float', number>;
  readonly spotCosInner: THREE.UniformNode<'float', number>;
  readonly night: THREE.UniformNode<'float', number>;
  readonly flicker: THREE.UniformNode<'float', number>;
  /** 1 with a flame, 0 for a stroke-only mark. */
  readonly flameLight: THREE.Node<'float'>;
}

/**
 * The stroke's shading, shared by the splat modifier (mesh-local frame) and
 * the mesh material (world frame): a warm point light at the flame + sky
 * hemisphere + a tight highlight + an optional white spot. Returns display
 * (sRGB) color.
 */
function shadeStroke(
  lights: StrokeLights,
  p: THREE.Node<'vec3'>,
  n: THREE.Node<'vec3'>,
  eye: THREE.Node<'vec3'>,
  albedo: THREE.Node<'vec3'>,
): THREE.Node<'vec3'> {
  const toLight = lights.flame.sub(p);
  const distance = toLight.length();
  const l = toLight.div(distance.max(1e-4));
  const attenuation = float(1).div(distance.mul(distance).mul(0.35).add(1));
  // Lambert plus a fill the flame throws on everything near it, so the
  // stroke's side facing away still catches the fire at night.
  const diffuse = max(n.dot(l), 0)
    .mul(2.4)
    .add(0.5)
    .mul(attenuation)
    .mul(lights.flicker)
    .mul(lights.flameLight);
  const v = normalize(eye.sub(p));
  const h = normalize(l.add(v));
  const specular = pow(max(n.dot(h), 0), 20)
    .mul(attenuation)
    .mul(lights.flicker)
    .mul(lights.flameLight)
    .mul(0.8);
  // Hemispheric daylight: facing discs stay white, undersides fall to half.
  const sky = n.y.mul(0.25).add(0.78).mul(lights.night).add(0.04);
  // White spot: Lambert inside a soft cone, mild distance falloff.
  const toSpot = lights.spot.sub(p);
  const spotDistance = toSpot.length();
  const ls = toSpot.div(spotDistance.max(1e-4));
  const cone = smoothstep(
    lights.spotCosOuter,
    lights.spotCosInner,
    ls.negate().dot(lights.spotDir),
  );
  const spot = max(n.dot(ls), 0)
    .mul(cone)
    .mul(lights.spotIntensity)
    .div(spotDistance.mul(spotDistance).mul(0.004).add(1));
  return albedo.mul(sky.add(FLAME_WARM.mul(diffuse)).add(spot)).add(FLAME_WARM.mul(specular));
}

/** Copies the splats `[start, end)` into their own `SplatData`. */
function sliceSplatData(
  data: SplatData,
  start: number,
  end: number,
  antialias?: boolean,
): SplatData {
  return {
    count: end - start,
    positions: data.positions.slice(start * 3, end * 3),
    covariances: data.covariances.slice(start * 6, end * 6),
    colors: data.colors.slice(start * 4, end * 4),
    ...(antialias === undefined ? {} : { antialias }),
  };
}

/** Creates the mark from its bitmap; the caller adds {@link VlamLogo.meshes} to the scene. */
export function createVlamLogo(bitmap: LogoBitmap, options: VlamLogoOptions): VlamLogo {
  const height = options.height ?? 8;
  const strokeOnly = options.parts === 'stroke';
  const floorBelow = options.floorBelow ?? LOGO_FLOOR_BELOW;
  const animate = options.animate ?? true;
  const { antialias, ...meshOptions } = options.mesh ?? {};
  const flameBody = options.flameBody ?? true;
  const splats = buildLogoSplats(bitmap, {
    height,
    floorY: -floorBelow,
    parts: strokeOnly
      ? { stroke: true, flame: false, glow: false, embers: false, pool: false }
      : { stroke: true, flame: flameBody, glow: true, embers: true, pool: true },
  });
  const { layers, data } = splats;
  const fireStart = layers.stroke.end;
  const strokeGeometry = options.strokeGeometry
    .clone()
    .scale(height / STROKE_MESH_HEIGHT, height / STROKE_MESH_HEIGHT, height / STROKE_MESH_HEIGHT);
  const fire = strokeOnly
    ? null
    : new SplatMesh(sliceSplatData(data, fireStart, data.count, antialias), meshOptions);
  const meshes = fire ? [fire] : [];

  // Shared live inputs. Each modifier is built once and never replaced.
  const time = uniform(0);
  const night = uniform(1);
  /** Smooth CPU-side flicker the whole light stack shares. */
  const flicker = uniform(1);
  /** The flame's light on the stroke; 0 when the mark has no flame. */
  const flameLight = float(strokeOnly ? 0 : 1);
  const makeLights = (flame: THREE.Vector3): StrokeLights => ({
    flame: uniform(flame),
    // An optional spot light on the stroke.
    spot: uniform(new THREE.Vector3()),
    spotDir: uniform(new THREE.Vector3(0, -1, 0)),
    spotIntensity: uniform(0),
    spotCosOuter: uniform(Math.cos(THREE.MathUtils.degToRad(18))),
    spotCosInner: uniform(Math.cos(THREE.MathUtils.degToRad(12))),
    night,
    flicker,
    flameLight,
  });
  // The stroke shades in world space; `syncFlameWorld` keeps the lights in step.
  const lights = makeLights(new THREE.Vector3());
  let spotWorld: LogoSpotlight | null = null;
  const idle = float(animate ? 1 : 0);

  const material = new THREE.MeshBasicNodeMaterial();
  material.toneMapped = false;
  let modifier: DisplayColorModifier | null = null;
  const buildStrokeColor = (): void => {
    // Same color path as the splats: lit in display space, then into the
    // working space (unless the scene emits sRGB as-is), then relit.
    const lit = shadeStroke(lights, positionWorld, normalWorld, cameraPosition, vec3(0.97));
    const working = options.mesh?.srgbOutput
      ? lit
      : (colorSpaceToWorking(vec4(lit, 1), THREE.SRGBColorSpace) as unknown as THREE.Node<'vec4'>)
          .rgb;
    const rgb = modifier ? modifier(working, screenUV, viewportSize) : working;
    material.colorNode = vec4(rgb, 1);
    material.needsUpdate = true;
  };
  buildStrokeColor();
  const strokeDisplay: VlamLogo['strokeDisplay'] = {
    get displayColorModifier() {
      return modifier;
    },
    set displayColorModifier(next) {
      modifier = next;
      buildStrokeColor();
    },
  };
  const stroke = new THREE.Mesh(strokeGeometry, material);
  stroke.frustumCulled = false;
  stroke.raycast = () => undefined;

  // Fire: layers are blended with float masks rather than `select`: a TSL
  // conditional in this graph drops the splats of one branch (seen on the
  // native WebGPU path), while `mix` by a 0/1 mask renders every layer.
  if (fire) {
    const flameBase = float(splats.flameBase);
    const flameTop = float(splats.flameTop);
    const emberRise = float(height * 0.45);
    const rebase = (layer: LogoLayer): LogoLayer => ({
      start: layer.start - fireStart,
      end: layer.end - fireStart,
    });
    const fireModifier: SplatModifier = (ctx) => {
      const index = ctx.index;
      const mask = (layer: LogoLayer) =>
        index
          .greaterThanEqual(int(layer.start))
          .and(index.lessThan(int(layer.end)))
          .toFloat();
      const mFlame = mask(rebase(layers.flame));
      const mGlow = mask(rebase(layers.glow));
      const mEmber = mask(rebase(layers.embers));
      const mPool = mask(rebase(layers.pool));
      const mFlameGlow = mFlame.add(mGlow);
      const p = ctx.localCenter;

      // Flame: the noise field scrolls upward; the base stays attached, the top wanders.
      const lift = smoothstep(flameBase, flameTop, p.y);
      const scroll = vec3(0, time.mul(-1.5), 0);
      const turbulence = mx_noise_vec3(p.mul(2.6).add(scroll));
      const flameOffset = turbulence.mul(vec3(1, 0.6, 1)).mul(lift.mul(0.26).add(0.025));
      const flameBreath = mx_noise_float(p.mul(4).add(vec3(0, time.mul(-2.2), 0)));
      // Brighten toward a hot core as the field breathes; never below the bitmap.
      const flameRgb = ctx.color.rgb
        .mul(flameBreath.mul(0.25).add(1.05).mul(flicker.mul(0.25).add(0.75)))
        .add(vec3(0.08, 0.04, 0).mul(lift));
      const flameScale = flameBreath.mul(0.22).mul(lift);

      // Glow: breathes with the flicker, wobbles slowly.
      const seed = hash(index.toFloat());
      const seed2 = hash(index.toFloat().add(31.7));
      const glowScale = mx_noise_float(vec3(time.mul(0.9), seed.mul(7), 0))
        .mul(0.35)
        .add(1)
        .mul(flicker.mul(0.4).add(0.6))
        .sub(1);

      // Embers: each has its own phase; it rises, sways, fades out, then restarts.
      const cycle = fract(time.mul(seed2.mul(0.5).add(0.22)).add(seed));
      const sway = mx_noise_vec3(p.mul(3).add(vec3(seed.mul(13), time.mul(0.6), 0))).mul(
        cycle.mul(0.18),
      );
      const emberOffset = vec3(sway.x, cycle.mul(emberRise).add(sway.y.mul(0.3)), sway.z);
      const emberFade = float(1).sub(cycle).mul(float(1).sub(cycle));
      const emberRgb = mix(ctx.color.rgb, vec3(1, 0.4, 0.1), cycle);

      // Pool: flickers with the flame.
      const poolAlpha = flicker.mul(0.5).add(0.5);

      const offset = flameOffset.mul(mFlameGlow).add(emberOffset.mul(mEmber)).mul(idle);
      const scale = flameScale.mul(mFlame).add(glowScale.mul(mGlow)).mul(idle).add(1);
      const rgb = flameRgb.mul(mFlameGlow).add(emberRgb.mul(mEmber)).add(ctx.color.rgb.mul(mPool));
      const alphaGain = float(1)
        .add(emberFade.sub(1).mul(mEmber).mul(idle))
        .add(poolAlpha.sub(1).mul(mPool));
      return { offset, scale, color: vec4(rgb, ctx.color.a.mul(alphaGain)) };
    };
    fire.modifiers = [fireModifier];
  }

  // Flame-only bounds from the seeds (the flame layer itself may be absent).
  const flameMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const flameMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < splats.flameSeeds.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = splats.flameSeeds[i + axis] as number;
      if (value < (flameMin[axis] as number)) flameMin[axis] = value;
      if (value > (flameMax[axis] as number)) flameMax[axis] = value;
    }
  }
  const followers: THREE.Object3D[] = [];
  const flameWorld = new THREE.Vector3();
  const strokeCenterWorld = new THREE.Vector3();
  const strokeCenterLocal = new THREE.Vector3();
  {
    const { points } = splats.strokeOutline;
    const count = points.length / 2;
    for (let i = 0; i < count; i++) {
      strokeCenterLocal.x += (points[i * 2] as number) / count;
      strokeCenterLocal.y += (points[i * 2 + 1] as number) / count;
    }
  }
  const syncFlameWorld = (): void => {
    stroke.updateMatrixWorld();
    flameWorld.set(...splats.flameCenter).applyMatrix4(stroke.matrixWorld);
    strokeCenterWorld.copy(strokeCenterLocal).applyMatrix4(stroke.matrixWorld);
    lights.flame.value.copy(flameWorld);
    if (spotWorld) {
      lights.spot.value.copy(spotWorld.position);
      lights.spotDir.value.copy(spotWorld.target).sub(spotWorld.position).normalize();
    }
  };
  syncFlameWorld();

  return {
    stroke,
    strokeDisplay,
    fire,
    meshes,
    splats,
    flameWorld,
    strokeCenterWorld,
    position: stroke.position,
    followers,
    flameMin,
    flameMax,
    place(base, faceToward) {
      // Local +z is the front of the mark; turn it toward the point about y.
      const yaw = Math.atan2(faceToward.x - base.x, faceToward.z - base.z);
      for (const object of [stroke, ...meshes, ...followers]) {
        object.position.copy(base);
        object.rotation.set(0, yaw, 0);
        object.updateMatrixWorld();
      }
      syncFlameWorld();
    },
    tick(elapsed) {
      time.value = elapsed;
      // Three incommensurate sines read as a live flame, not a strobe.
      flicker.value =
        0.86 +
        0.14 *
          (0.5 * Math.sin(elapsed * 13.1) +
            0.3 * Math.sin(elapsed * 7.3 + 1) +
            0.2 * Math.sin(elapsed * 29.7));
    },
    update(camera, renderer, elapsed) {
      this.tick(elapsed);
      for (const mesh of meshes) mesh.update(camera, renderer);
    },
    setNight(level) {
      night.value = Math.max(0, Math.min(1, level));
    },
    setSpotlight(spot) {
      spotWorld = spot;
      const outer = THREE.MathUtils.degToRad(spot?.angleDeg ?? 18);
      lights.spotIntensity.value = spot ? (spot.intensity ?? 1.4) : 0;
      lights.spotCosOuter.value = Math.cos(outer);
      lights.spotCosInner.value = Math.cos(outer * (1 - (spot?.penumbra ?? 0.35)));
      syncFlameWorld();
    },
    fogAccents() {
      const accents: FogAccent[] = [];
      if (spotWorld) {
        accents.push({
          position: spotWorld.position.toArray(),
          target: spotWorld.target.toArray(),
          color: 0xffffff,
          angle: THREE.MathUtils.degToRad(spotWorld.angleDeg ?? 18),
          penumbra: spotWorld.penumbra ?? 0.35,
          gain: spotWorld.fogGain ?? 1,
        });
      }
      if (!strokeOnly) {
        const floor = stroke.position.y - floorBelow;
        accents.push({
          position: [flameWorld.x, flameWorld.y + height * 0.05, flameWorld.z],
          target: [flameWorld.x, floor, flameWorld.z],
          color: 0xff7a1e,
        });
      }
      return accents;
    },
    strokeProxyGeometry() {
      stroke.updateMatrixWorld();
      // The proxy is the mesh itself: no inset, so the factor map ends
      // exactly at the silhouette.
      return strokeGeometry.clone().applyMatrix4(stroke.matrixWorld);
    },
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      strokeGeometry.dispose();
      material.dispose();
    },
  };
}
