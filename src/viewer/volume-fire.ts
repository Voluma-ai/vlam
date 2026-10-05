/**
 * Viewer-only volumetric fire for the VLAM! mark on WebGPU: a small Eulerian
 * fluid simulation on the GPU (semi-Lagrangian advection, curl-noise
 * turbulence, buoyancy, a two-step Jacobi pressure solve) feeding a
 * ray-marched emissive volume. The emitter is the mark's flame shape: seed
 * points sampled from the logo bitmap, denser toward the base, so a real
 * plume rises through the silhouette the splat flame draws on WebGL2.
 *
 * The simulation kernels follow the three.js `webgpu_volume_fire` example
 * (MIT, see THIRD_PARTY_NOTICES.md); the renderer is our own box ray march
 * so it composes with the splat draw without a render pipeline: the fire is
 * premultiplied emission over the frame, absorbed by its own smoke.
 */
import * as THREE from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  cameraPosition,
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  getViewPosition,
  screenUV,
  texture,
  float,
  fract,
  frameId,
  instanceIndex,
  interleavedGradientNoise,
  acesFilmicToneMapping,
  saturation,
  max,
  min,
  mix,
  mx_noise_float,
  positionGeometry,
  positionLocal,
  screenCoordinate,
  smoothstep,
  storage,
  storageTexture,
  texture3D,
  textureStore,
  uniform,
  uvec3,
  vec3,
  vec4,
} from 'three/tsl';
import { snoise, snoiseVec3 } from 'three/addons/tsl/math/curlNoise.js';
import type { VolumeLight } from './volumetric-fog';

type Node<T extends string> = THREE.Node<T>;

const GRID_X = 64;
const GRID_Y = 256;
const GRID_Z = 64;
const CELL_COUNT = GRID_X * GRID_Y * GRID_Z;
const TEXEL = new THREE.Vector3(1 / GRID_X, 1 / GRID_Y, 1 / GRID_Z);
/** Two Jacobi iterations, as the example ships; keep it even (ping-pong). */
const PRESSURE_ITERATIONS = 2;
const SIM_STEP = 1 / 60;
/**
 * Longest single step. A slow frame takes one longer step rather than
 * several: catching up with substeps doubles the work exactly on the devices
 * that can least afford it, and semi-Lagrangian advection is stable anyway.
 */
const MAX_STEP = 1 / 30;
/** Most samples per ray; short spans take fewer, about one voxel apart. */
const RAY_STEPS = 64;
/** Below this summed density and temperature a sample adds nothing visible. */
const EMPTY_SAMPLE = 1e-3;
/** The fire is soft; it is marched at 1 / RENDER_DOWNSCALE resolution. */
const RENDER_DOWNSCALE = 2;
/** Fog lights the smoke scatters at most (flashlight plus accents). */
const MAX_VOLUME_LIGHTS = 8;
/**
 * Smoke radiance per unit of fog beam light: matches a flashlit smoke wisp
 * to the fog around it, after the fire's ACES grade.
 */
const VOLUME_LIGHT_GAIN = 12;
/** The example's volume height, which its shading lengths are relative to. */
const EXAMPLE_VOLUME_HEIGHT = 12;
/** Box height in flame heights: tall enough that the plume fades out before the top. */
const HEADROOM = 2.7;
/** The box height the forces were tuned against (1.35 flame heights). */
const REFERENCE_HEADROOM = 1.35;

export interface VolumeFireInputs {
  readonly renderer: THREE.WebGPURenderer;
  /** Local xyz triples inside the flame, base-heavy (see `LogoSplats.flameSeeds`). */
  readonly seeds: Float32Array;
  /** Local-space bounds of the flame body. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /**
   * Sideways acceleration along local +x on the same scale as buoyancy (3),
   * acting on hot gas, so the plume rises at a slope that mirrors the mark's
   * white stroke. Default 2 (about 34° off vertical); 0 is a straight column.
   */
  readonly wind?: number;
  /**
   * Horizontal scale of the emitter about its centroid (x and z), so the
   * flame's base can be narrower than the drawn flame. Default 0.43.
   */
  readonly baseScale?: number;
  /**
   * Flame height relative to the original tuning: squeezes the emitter
   * toward its base and cools the gas faster by the same factor, so the
   * flame tips sit lower. Default 0.5.
   */
  readonly heightScale?: number;
  /**
   * Simulation speed relative to real time: below 1 the whole fire plays in
   * slow motion (rise, turbulence, flicker) with its shape unchanged. Default 1.2,
   * the example's.
   */
  readonly speed?: number;
}

export interface VolumeFire {
  /**
   * The ray-marched box; pose it like the mark (same position and rotation).
   * It lives in the fire's own scene: {@link render} draws it, so do not add
   * it to the main scene.
   */
  readonly mesh: THREE.Mesh;
  /** Live sideways push (see `VolumeFireInputs.wind`). */
  readonly wind: { value: number };
  /** Steps the simulation by `deltaSeconds` (at most one step per call). */
  update(deltaSeconds: number, elapsed: number): void;
  /**
   * Per frame, after the main render: marches the fire at half resolution
   * and composites it over the current target. The march stops at `depth`,
   * this frame's scene depth (the collision proxy, see `proxy-depth.ts`),
   * which the splat draw cannot provide since splats write no depth.
   */
  render(camera: THREE.Camera, depth: THREE.DepthTexture | null): void;
  /**
   * World-space spot lights the smoke scatters, shaded like the fog's beams
   * (see `VolumetricFogMode.volumeLights`). They stand in for the example's
   * key light, which a night scene does not have; `null` brings it back.
   */
  setVolumeLights(lights: readonly VolumeLight[] | null): void;
  dispose(): void;
}

function createStorage3D(name: string): THREE.Storage3DTexture {
  const texture = new THREE.Storage3DTexture(GRID_X, GRID_Y, GRID_Z);
  texture.name = name;
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.HalfFloatType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  return texture;
}

/** `instanceIndex` (1D) → voxel coordinate. */
const voxelCoord = (id: Node<'uint'>) => {
  const x = id.mod(GRID_X);
  const y = id.div(GRID_X).mod(GRID_Y);
  const z = id.div(GRID_X * GRID_Y);
  return uvec3(x, y, z);
};
/** Voxel coordinate → normalized uvw at the cell center. */
const coordToUvw = (coord: Node<'uvec3'>) =>
  vec3(coord)
    .add(0.5)
    .div(vec3(GRID_X, GRID_Y, GRID_Z));

export function createVolumeFire(inputs: VolumeFireInputs): VolumeFire {
  const { renderer } = inputs;
  // The box: the flame body plus headroom above for the plume and a margin
  // around, in the mark's local frame. Fire uvw space maps onto it.
  const flameWidth = inputs.max[0] - inputs.min[0];
  const flameHeight = inputs.max[1] - inputs.min[1];
  // Wider to the right, where the wind carries the plume; tall so the plume
  // dissipates on its own instead of hitting a ceiling.
  const size = new THREE.Vector3(flameWidth * 2.4, flameHeight * HEADROOM, flameWidth * 1.6);
  // Forces, noise and edge falloffs keep the scale of the original
  // 1.35-flame-height box, so the taller box does not change the flame.
  const reference = flameHeight * REFERENCE_HEADROOM;
  const yRatio = reference / size.y;
  /** Per-axis factor turning uvw distances into reference lengths. */
  const edgeScale = vec3(size.x / reference, size.y / reference, size.z / reference);
  const boxMin = new THREE.Vector3(
    inputs.min[0] - flameWidth * 0.5,
    inputs.min[1] - flameHeight * 0.05,
    -size.z / 2,
  );
  const uBoxMin = uniform(boxMin.clone());
  const uBoxSize = uniform(size.clone());

  // --- simulation state ----------------------------------------------------
  const velA = createStorage3D('fire velocity A');
  const velB = createStorage3D('fire velocity B');
  const dyeA = createStorage3D('fire dye A');
  const dyeB = createStorage3D('fire dye B');
  const divergence = createStorage3D('fire divergence');
  const pressA = createStorage3D('fire pressure A');
  const pressB = createStorage3D('fire pressure B');
  const curl = createStorage3D('fire curl noise');
  curl.wrapS = curl.wrapT = curl.wrapR = THREE.RepeatWrapping;
  const dyeRead = texture3D(dyeA);
  const dyeWrite = storageTexture(dyeB).toWriteOnly();
  const curlRead = texture3D(curl);

  const uDt = uniform(SIM_STEP);
  const uTime = uniform(0);
  const uBuoyancy = uniform(3.0);
  const uWeight = uniform(0.15);
  // The example scales turbulence by 1 / sqrt(simulation speed).
  const uTurbulence = uniform(3.2 / Math.sqrt(inputs.speed ?? 1.2));
  const uTurbulenceDecay = uniform(0.1);
  const uTurbFrequency = uniform(10.0);
  const uVelDamping = uniform(0.25);
  const uWind = uniform(inputs.wind ?? 2);
  const heightScale = inputs.heightScale ?? 0.5;
  // The example's 1.3 s fire and 3.5 s smoke lifespans.
  const uCooling = uniform(1 / (1.3 * heightScale));
  const uDissipation = uniform(1 / 3.5);
  const uEmitDensity = uniform(7.0);
  const uEmitTemperature = uniform(5.5);
  const uFlicker = uniform(1);

  const seedCount = inputs.seeds.length / 3;
  const scaledSeeds = new Float32Array(inputs.seeds);
  const baseScale = inputs.baseScale ?? 0.43;
  let centerX = 0;
  let centerZ = 0;
  let bottom = Infinity;
  for (let i = 0; i < seedCount; i++) {
    centerX += scaledSeeds[i * 3] as number;
    bottom = Math.min(bottom, scaledSeeds[i * 3 + 1] as number);
    centerZ += scaledSeeds[i * 3 + 2] as number;
  }
  centerX /= Math.max(seedCount, 1);
  centerZ /= Math.max(seedCount, 1);
  for (let i = 0; i < seedCount; i++) {
    scaledSeeds[i * 3] = centerX + ((scaledSeeds[i * 3] as number) - centerX) * baseScale;
    scaledSeeds[i * 3 + 1] = bottom + ((scaledSeeds[i * 3 + 1] as number) - bottom) * heightScale;
    scaledSeeds[i * 3 + 2] = centerZ + ((scaledSeeds[i * 3 + 2] as number) - centerZ) * baseScale;
  }
  const seedAttribute = new THREE.StorageBufferAttribute(scaledSeeds, 3);
  const seeds = storage(seedAttribute, 'vec3', seedCount).toReadOnly();

  // 0) Curl noise, once.
  const aspect = edgeScale;
  const curlPass = Fn(() => {
    const coord = voxelCoord(instanceIndex);
    const uvw = coordToUvw(coord);
    const freq = uTurbFrequency;
    const e = float(0.1).div(freq);
    const dx = vec3(e, 0, 0);
    const dy = vec3(0, e, 0);
    const dz = vec3(0, 0, e);
    const p = uvw.mul(aspect);
    const px0 = snoiseVec3(p.sub(dx).mul(freq));
    const px1 = snoiseVec3(p.add(dx).mul(freq));
    const py0 = snoiseVec3(p.sub(dy).mul(freq));
    const py1 = snoiseVec3(p.add(dy).mul(freq));
    const pz0 = snoiseVec3(p.sub(dz).mul(freq));
    const pz1 = snoiseVec3(p.add(dz).mul(freq));
    const x = py1.z.sub(py0.z).sub(pz1.y).add(pz0.y);
    const y = pz1.x.sub(pz0.x).sub(px1.z).add(px0.z);
    const z = px1.y.sub(px0.y).sub(py1.x).add(py0.x);
    // 1 / (2e) with e = 0.1 / freq folded into the 5.0 as the example does.
    textureStore(curl, coord, vec4(vec3(x, y, z).mul(5.0), 0)).toWriteOnly();
  })().compute(CELL_COUNT);

  // 1) Advect velocity, add buoyancy and turbulence: velA → velB.
  const advectVelocity = Fn(() => {
    const coord = voxelCoord(instanceIndex);
    const uvw = coordToUvw(coord);
    const vel = texture3D(velA, uvw, float(0)).xyz;
    const prev = uvw.sub(vel.div(uBoxSize).mul(uDt));
    const next = texture3D(velA, prev, float(0)).xyz.toVar();
    const dye = dyeRead.sample(uvw).level(float(0));
    const density = dye.r;
    const temperature = dye.g;
    const age = dye.b;
    const buoyancy = temperature.mul(uBuoyancy).sub(density.mul(uWeight)).mul(reference);
    // Wind: a sideways push on hot gas, so the plume rises at a slope from
    // its base; cooled smoke drifts on with whatever it had.
    const wind = uWind.mul(temperature.min(1)).mul(reference);
    next.addAssign(vec3(wind, buoyancy, 0).mul(uDt));
    const thermalPos = uvw.add(
      vec3(0, age.negate().mul(0.6 * yRatio), age.mul(0.13)).div(uTurbFrequency),
    );
    const decay = age.mul(uTurbulenceDecay.negate()).exp();
    const thermal = curlRead
      .sample(thermalPos)
      .level(float(0))
      .xyz.mul(uTurbulence)
      .mul(temperature)
      .mul(decay);
    const ambientPos = uvw
      .mul(0.5)
      .add(vec3(0, uTime.mul(0.25 * yRatio), uTime.mul(0.06)).div(uTurbFrequency));
    const ambient = curlRead
      .sample(ambientPos)
      .level(float(0))
      .xyz.mul(uTurbulence.mul(0.2))
      .mul(density);
    next.addAssign(thermal.add(ambient).mul(reference).mul(uDt));
    next.mulAssign(max(float(1).sub(uVelDamping.mul(uDt)), 0));
    const edge = min(uvw, vec3(1).sub(uvw)).mul(edgeScale);
    next.mulAssign(smoothstep(0.0, 0.08, min(edge.x, min(edge.y, edge.z))));
    textureStore(velB, coord, vec4(next, 0)).toWriteOnly();
  })().compute(CELL_COUNT);

  // 2) Divergence of velB → divergence.
  const divergencePass = Fn(() => {
    const coord = voxelCoord(instanceIndex);
    const uvw = coordToUvw(coord);
    const vR = texture3D(velB, uvw.add(vec3(TEXEL.x, 0, 0)), 0).x;
    const vL = texture3D(velB, uvw.sub(vec3(TEXEL.x, 0, 0)), 0).x;
    const vU = texture3D(velB, uvw.add(vec3(0, TEXEL.y, 0)), 0).y;
    const vD = texture3D(velB, uvw.sub(vec3(0, TEXEL.y, 0)), 0).y;
    const vF = texture3D(velB, uvw.add(vec3(0, 0, TEXEL.z)), 0).z;
    const vB = texture3D(velB, uvw.sub(vec3(0, 0, TEXEL.z)), 0).z;
    const div = vR.sub(vL).add(vU.sub(vD)).add(vF.sub(vB)).mul(0.5);
    textureStore(divergence, coord, vec4(div, 0, 0, 0)).toWriteOnly();
  })().compute(CELL_COUNT);

  // 3) Jacobi pressure solve, ping-pong.
  const jacobi = (read: THREE.Storage3DTexture, write: THREE.Storage3DTexture) =>
    Fn(() => {
      const coord = voxelCoord(instanceIndex);
      const uvw = coordToUvw(coord);
      const pR = texture3D(read, uvw.add(vec3(TEXEL.x, 0, 0)), 0).x;
      const pL = texture3D(read, uvw.sub(vec3(TEXEL.x, 0, 0)), 0).x;
      const pU = texture3D(read, uvw.add(vec3(0, TEXEL.y, 0)), 0).x;
      const pD = texture3D(read, uvw.sub(vec3(0, TEXEL.y, 0)), 0).x;
      const pF = texture3D(read, uvw.add(vec3(0, 0, TEXEL.z)), 0).x;
      const pB = texture3D(read, uvw.sub(vec3(0, 0, TEXEL.z)), 0).x;
      const div = texture3D(divergence, uvw, float(0)).x;
      const pressure = pR.add(pL).add(pU).add(pD).add(pF).add(pB).sub(div).div(6);
      textureStore(write, coord, vec4(pressure, 0, 0, 0)).toWriteOnly();
    })().compute(CELL_COUNT);
  const jacobiAB = jacobi(pressA, pressB);
  const jacobiBA = jacobi(pressB, pressA);

  // 4) Project: velB − ∇p → velA.
  const projectPass = Fn(() => {
    const coord = voxelCoord(instanceIndex);
    const uvw = coordToUvw(coord);
    const pR = texture3D(pressA, uvw.add(vec3(TEXEL.x, 0, 0)), 0).x;
    const pL = texture3D(pressA, uvw.sub(vec3(TEXEL.x, 0, 0)), 0).x;
    const pU = texture3D(pressA, uvw.add(vec3(0, TEXEL.y, 0)), 0).x;
    const pD = texture3D(pressA, uvw.sub(vec3(0, TEXEL.y, 0)), 0).x;
    const pF = texture3D(pressA, uvw.add(vec3(0, 0, TEXEL.z)), 0).x;
    const pB = texture3D(pressA, uvw.sub(vec3(0, 0, TEXEL.z)), 0).x;
    const gradient = vec3(pR.sub(pL), pU.sub(pD), pF.sub(pB)).mul(0.5);
    const vel = texture3D(velB, uvw, float(0)).xyz.sub(gradient);
    textureStore(velA, coord, vec4(vel, 0)).toWriteOnly();
  })().compute(CELL_COUNT);

  // 5) Advect density / temperature / age: dyeRead → dyeWrite.
  const advectDye = Fn(() => {
    const coord = voxelCoord(instanceIndex);
    const uvw = coordToUvw(coord);
    const vel = texture3D(velA, uvw, float(0)).xyz;
    const prev = uvw.sub(vel.div(uBoxSize).mul(uDt));
    const dye = dyeRead.sample(prev).level(float(0));
    const density = dye.r.mul(max(float(1).sub(uDissipation.mul(uDt)), 0)).toVar();
    const temperature = dye.g.mul(max(float(1).sub(uCooling.mul(uDt)), 0)).toVar();
    const dims = vec3(GRID_X, GRID_Y, GRID_Z);
    const nearest = prev.mul(dims).floor().add(0.5).div(dims);
    const age = dyeRead.sample(nearest).level(float(0)).b.add(uDt).toVar();
    temperature.assign(temperature.clamp(0, 12));
    If(density.lessThanEqual(0.01), () => {
      age.assign(0);
    });
    textureStore(dyeWrite, coord, vec4(density, temperature, age, 1)).toWriteOnly();
  })().compute(CELL_COUNT);

  // 6) Emit from the flame seeds into dyeWrite.
  const emitPass = Fn(() => {
    const seed = seeds.element(instanceIndex);
    const uvw = seed.sub(uBoxMin).div(uBoxSize);
    const inside = uvw.x
      .greaterThanEqual(0)
      .and(uvw.x.lessThanEqual(1))
      .and(uvw.y.greaterThanEqual(0))
      .and(uvw.y.lessThanEqual(1))
      .and(uvw.z.greaterThanEqual(0))
      .and(uvw.z.lessThanEqual(1));
    If(inside, () => {
      const coord = uvec3(uvw.mul(vec3(GRID_X, GRID_Y, GRID_Z)));
      const flicker = mx_noise_float(
        seed.mul(9.0).add(vec3(0, uTime.negate().mul(2.5), uTime.mul(0.7))),
      )
        .mul(0.5)
        .add(0.5);
      const rate = flicker.mul(0.85).add(0.15).mul(uFlicker).mul(uDt.mul(0.5));
      const densityVal = uEmitDensity.mul(rate);
      const tempVal = uEmitTemperature.mul(rate);
      const current = dyeRead.sample(uvw).level(float(0));
      const newDensity = current.r.add(densityVal);
      const newTemp = current.g.add(tempVal).clamp(0, 12);
      const newAge = mix(current.b, float(0), densityVal.div(max(newDensity, 0.001)));
      textureStore(dyeWrite, coord, vec4(newDensity, newTemp, newAge, 1)).toWriteOnly();
    });
  })().compute(seedCount);

  // --- occluder depth: supplied per frame (see `render`) --------------------
  const placeholderDepth = new THREE.DepthTexture(1, 1);
  const uOccluded = uniform(0);

  // --- rendering: ray march the box in the mark's local frame -------------
  // The shading follows the example's VolumeNodeMaterial setup: additive
  // emission plus key-lit, self-shadowed smoke that the fire's own capsule
  // light also tints, tone mapped ACES at exposure 2. The example's lengths
  // are in its own units: its 12-unit volume height maps onto `reference`.
  const exampleScale = EXAMPLE_VOLUME_HEIGHT / reference;
  const uInverseModel = uniform(new THREE.Matrix4());
  const startColor = uniform(new THREE.Color(0xff0000));
  const midColor = uniform(new THREE.Color(0xff0000));
  const endColor = uniform(new THREE.Color(0xff0000));
  const uFireIntensity = uniform(40.0);
  const uFireGlowSpread = uniform(5.0);
  const uShadowAbsorption = uniform(2.0);
  const uShadowAmbient = uniform(0.5);
  const uPowderStrength = uniform(0.59);
  const uMultiScattering = uniform(1.0);
  const uPointLightVolumeIntensity = uniform(2.0);
  const uLightNearIntensity = uniform(10.0);
  const uLightFarIntensity = uniform(15.0);
  const uLightFarDistance = uniform(10.0);
  const uSaturation = uniform(1.1);
  const uExposure = uniform(2.0);
  /** Example units; animated in `update` like the example's CPU noise. */
  const uFlameHeight = uniform(3.5);
  const uSway = uniform(new THREE.Vector3());
  const uColorNoise = uniform(0);
  /** The emitter's base, where the example's teapot (and its point light) sits. */
  const emitterBase = new THREE.Vector3(centerX, bottom, centerZ);
  const uEmitterBase = uniform(emitterBase.clone());
  // The example's key light, relative to its emitter: up, left and in front.
  const uKeyLight = uniform(
    emitterBase.clone().add(new THREE.Vector3(-4.5, 15, 9).divideScalar(exampleScale)),
  );
  // One expression (no assigns), so it also builds outside an Fn.
  /** 1 while no fog lights are set: the example's key light lights the smoke. */
  const uKeyGain = uniform(1);
  const volumeLights = Array.from({ length: MAX_VOLUME_LIGHTS }, () => ({
    position: uniform(new THREE.Vector3()),
    direction: uniform(new THREE.Vector3(0, -1, 0)),
    cosOuter: uniform(1),
    cosInner: uniform(1),
    gain: uniform(0),
    range: uniform(1),
    color: uniform(new THREE.Vector3()),
  }));
  const fireRamp = (t: Node<'float'>) =>
    mix(
      mix(mix(vec3(0), endColor, smoothstep(0.05, 0.35, t)), midColor, smoothstep(0.35, 0.65, t)),
      startColor,
      smoothstep(0.65, 1.0, t),
    );
  /** Box-edge fade of a uvw position, in reference lengths. */
  const boxFade = (uvw: Node<'vec3'>, width: number) => {
    const edge = min(uvw, vec3(1).sub(uvw)).mul(edgeScale);
    return smoothstep(0.0, width, min(edge.x, min(edge.y, edge.z)));
  };
  // The fire's point light as the volume sees it (example `pointLightColor`
  // with `isVolume`): a soft capsule up the flame, constant colour.
  const fireLightScale = Math.pow(5.5 / 8.34, 4) * (7 / 11.02);
  const fireLightColor = fireRamp(
    float((5.5 / 8.34) * 0.5 + 0.2)
      .add(uColorNoise)
      .clamp(0, 1),
  );

  const voxelStep = Math.min(size.x / GRID_X, size.y / GRID_Y, size.z / GRID_Z);
  // Scene depth under the pixel, swapped in each frame.
  const occluderDepth = texture(placeholderDepth, screenUV);

  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = THREE.BackSide;
  // Each pixel sees exactly one back face of the box, over a cleared target.
  material.blending = THREE.NoBlending;
  material.toneMapped = false;
  material.fragmentNode = Fn(() => {
    // Ray in local space from the camera through this back-face fragment.
    const eye = uInverseModel.mul(vec4(cameraPosition, 1)).xyz;
    const dir = positionLocal.sub(eye).normalize();
    // Slab test against the box.
    const invDir = vec3(1).div(dir);
    const t0 = uBoxMin.sub(eye).mul(invDir);
    const t1 = uBoxMin.add(uBoxSize).sub(eye).mul(invDir);
    const tMin = min(t0, t1);
    const tMax = max(t0, t1);
    const near = max(max(tMin.x, tMin.y), tMin.z).max(0);
    const boxFar = min(min(tMax.x, tMax.y), tMax.z);
    // Stop at the occluder: its depth under this pixel, brought into the
    // mark's local frame and measured along the ray.
    const depth = occluderDepth.x;
    const viewHit = getViewPosition(screenUV, depth, cameraProjectionMatrixInverse);
    const worldHit = cameraWorldMatrix.mul(vec4(viewHit, 1)).xyz;
    const localHit = uInverseModel.mul(vec4(worldHit, 1)).xyz;
    const hitT = localHit.sub(eye).dot(dir);
    const hasHit = depth.lessThan(0.9999).toFloat().mul(uOccluded);
    const far = mix(boxFar, min(boxFar, hitT), hasHit);
    const span = far.sub(near).max(0);
    // About one voxel per step, spread wider when the span needs more than
    // RAY_STEPS of them: a ray that only clips the box takes a few samples.
    const stepSize = span.div(RAY_STEPS).max(voxelStep);
    const stepExample = stepSize.mul(exampleScale);
    const dither = fract(interleavedGradientNoise(screenCoordinate).add(float(frameId).mul(0.618)));
    const travelled = near.add(dither.mul(stepSize)).toVar();
    const light = vec3(0).toVar();
    const transmittance = vec3(1).toVar();
    Loop(RAY_STEPS, () => {
      If(travelled.greaterThanEqual(far), () => {
        Break();
      });
      const p = eye.add(dir.mul(travelled));
      const uvw = p.sub(uBoxMin).div(uBoxSize);
      // Most of the box is empty air: one dye fetch decides whether the
      // shading is needed at all.
      const coarse = dyeRead.sample(uvw).level(float(0));
      If(coarse.r.add(coarse.g).greaterThan(EMPTY_SAMPLE), () => {
        // Example `getVolumeSample`: velocity domain warp, detail noise, edge fade.
        const warp = texture3D(velA, uvw, float(0)).xyz.div(uBoxSize).mul(0.15);
        const warped = uvw.add(warp).clamp(0, 1);
        const sample = dyeRead.sample(warped).level(float(0));
        const age = sample.b;
        const pExample = p.mul(exampleScale);
        const detail = snoise(pExample.mul(5.5).add(vec3(0, age.mul(0.8).negate(), 0)));
        // A long fade under the top so whatever smoke reaches it thins out.
        const density = sample.r
          .mul(detail.mul(0.35).add(0.85))
          .mul(boxFade(warped, 0.06))
          .mul(smoothstep(0.0, 0.4, min(warped.y, float(1).sub(warped.y)).mul(edgeScale.y)));
        const temperature = sample.g;

        // Smoke scattering: two self-shadow taps toward the key light.
        const toKey = uKeyLight.sub(p);
        const lightDir = toKey.normalize();
        const shadowSum = float(0).toVar();
        for (let i = 0; i < 2; i++) {
          const tap = p.add(lightDir.mul(((i + 0.5) * 0.35) / exampleScale));
          const tapUvw = tap.sub(uBoxMin).div(uBoxSize);
          shadowSum.addAssign(
            dyeRead
              .sample(tapUvw)
              .level(float(0))
              .r.mul(boxFade(tapUvw.clamp(0, 1), 0.06)),
          );
        }
        const tau = shadowSum.mul(0.35).mul(uShadowAbsorption);
        const beer = tau.negate().exp();
        const multiScatter = tau.mul(0.25).negate().exp().mul(0.5);
        const base = mix(beer, beer.add(multiScatter), uMultiScattering);
        const powder = float(1).sub(tau.mul(2).negate().exp());
        const lightTransmittance = mix(base, base.mul(powder), uPowderStrength)
          .add(uShadowAmbient)
          .clamp(0, 1);
        // Isotropic phase (asymmetry 0) times 4π is 1.
        const scattering = density.mul(lightTransmittance);

        // Light reaching the smoke: the key spot (1000, decay 2) and the
        // fire's capsule light.
        const keyDistance = toKey.length().mul(exampleScale);
        const keyRadiance = float(1000).div(keyDistance.mul(keyDistance));
        const fromBase = pExample.sub(uEmitterBase.mul(exampleScale));
        const along = fromBase.y.div(uFlameHeight).clamp(0, 1);
        const segment = fromBase.sub(uSway).sub(vec3(0, uFlameHeight.mul(along), 0));
        const segmentDistance = segment.length();
        const softAttenuation = float(1).div(segmentDistance.mul(segmentDistance).add(1.44));
        const distanceScale = mix(
          uLightNearIntensity,
          uLightFarIntensity,
          smoothstep(0, 1, segmentDistance.div(uLightFarDistance).clamp(0, 1)),
        );
        const fireRadiance = saturation(fireLightColor, uSaturation)
          .mul(fireLightScale)
          .mul(uFireIntensity)
          .mul(uPointLightVolumeIntensity)
          .mul(uFlicker)
          .mul(softAttenuation)
          .mul(distanceScale);
        // The fog's beams, shaded as the fog shades them (local frame, metres).
        const beamRadiance = vec3(0).toVar();
        for (const beam of volumeLights) {
          const toPoint = p.sub(beam.position);
          const d = toPoint.length().max(1e-3);
          const cone = smoothstep(beam.cosOuter, beam.cosInner, toPoint.div(d).dot(beam.direction));
          const window = d.div(beam.range).pow4().oneMinus().clamp().pow2();
          const falloff = window.div(d.mul(d).mul(0.08).add(1));
          beamRadiance.addAssign(beam.color.mul(cone.mul(falloff).mul(beam.gain)));
        }
        const scatteringDensity = fireRadiance
          .add(keyRadiance.mul(uKeyGain))
          .add(beamRadiance.mul(VOLUME_LIGHT_GAIN))
          .mul(scattering);

        // Fire emission, with the example's key-light distance attenuation.
        const fire = fireRamp(temperature.clamp(0, 1))
          .mul(temperature.pow(float(6).sub(uFireGlowSpread)))
          .mul(uFireIntensity)
          .mul(density.add(0.15))
          .mul(float(400).div(keyDistance.mul(keyDistance)));

        const stepLight = scatteringDensity.add(fire).mul(0.01);
        light.addAssign(stepLight.mul(transmittance).mul(stepExample));
        transmittance.mulAssign(scatteringDensity.mul(0.01).negate().mul(stepExample).exp());
      });
      travelled.addAssign(stepSize);
    });
    return vec4(light, 1);
  })();

  // Marched into a full-resolution target, then added over the frame: the
  // example composites the volume additively (`max(scene, v) + v`, which is
  // about 2v over a night scene, at its 0.5 weight) before ACES.
  const fireTarget = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  fireTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
  const compositeMaterial = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  compositeMaterial.blending = THREE.AdditiveBlending;
  compositeMaterial.toneMapped = false;
  compositeMaterial.vertexNode = vec4(positionGeometry.xy, 0, 1);
  compositeMaterial.fragmentNode = Fn(() => {
    const marched = texture(fireTarget.texture, screenUV).rgb;
    const graded = acesFilmicToneMapping(
      saturation(marched, uSaturation),
      uExposure,
    ) as Node<'vec3'>;
    return vec4(graded, 1);
  })();
  const compositeGeometry = new THREE.PlaneGeometry(2, 2);
  const compositeQuad = new THREE.Mesh(compositeGeometry, compositeMaterial);
  compositeQuad.frustumCulled = false;
  const compositeScene = new THREE.Scene();
  compositeScene.add(compositeQuad);

  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
  geometry.translate(boxMin.x + size.x / 2, boxMin.y + size.y / 2, boxMin.z + size.z / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const fireScene = new THREE.Scene();
  fireScene.add(mesh);

  const simulation = [
    advectVelocity,
    divergencePass,
    ...Array.from({ length: PRESSURE_ITERATIONS }, (_, i) => (i % 2 === 0 ? jacobiAB : jacobiBA)),
    projectPass,
    advectDye,
    emitPass,
  ];
  let curlReady = false;
  const speed = inputs.speed ?? 1.2;
  let accumulator = 0;
  let simulationTime = 0;
  const drawingSize = new THREE.Vector2();
  const clearColor = new THREE.Color();
  const inverseModel = new THREE.Matrix4();
  return {
    mesh,
    wind: uWind,
    update(deltaSeconds, elapsed) {
      if (!curlReady) {
        renderer.compute(curlPass);
        curlReady = true;
      }
      // Fixed 1/60 s steps on fast displays; one longer step on slow frames.
      accumulator = Math.min(accumulator + Math.min(deltaSeconds, 1 / 20) * speed, MAX_STEP);
      if (accumulator < SIM_STEP) return;
      const step = accumulator;
      accumulator = 0;
      simulationTime += step;
      uDt.value = step;
      uTime.value = simulationTime % 1000;
      const flickerTime = elapsed * speed;
      uFlicker.value =
        0.85 + 0.12 * Math.sin(flickerTime * 0.8 * 6.28) + 0.06 * Math.sin(flickerTime * 15 * 6.28);
      // The example's CPU noise on the capsule light, as incommensurate sines.
      uFlameHeight.value = 3.5 + 0.8 * Math.sin(simulationTime * 2.5 * 2.1);
      uSway.value.set(
        0.4 * Math.sin(simulationTime * 3.5 * 1.7),
        0,
        0.4 * Math.sin(simulationTime * 3.5 * 1.3 + 1),
      );
      uColorNoise.value = 0.08 * Math.sin(simulationTime * 5 * 1.9);
      // One compute pass and submit for the whole step.
      renderer.compute(simulation);
      // Ping-pong the dye textures.
      const previous = dyeRead.value;
      dyeRead.value = dyeWrite.value;
      dyeWrite.value = previous;
    },
    render(camera, depth) {
      mesh.updateMatrixWorld();
      uInverseModel.value.copy(mesh.matrixWorld).invert();
      renderer.getDrawingBufferSize(drawingSize);
      const width = Math.max(1, Math.ceil(drawingSize.x / RENDER_DOWNSCALE));
      const height = Math.max(1, Math.ceil(drawingSize.y / RENDER_DOWNSCALE));
      if (fireTarget.width !== width || fireTarget.height !== height) {
        fireTarget.setSize(width, height);
      }
      const previousTarget = renderer.getRenderTarget();
      const previousAutoClear = renderer.autoClear;
      const previousAlpha = renderer.getClearAlpha();
      renderer.getClearColor(clearColor);
      try {
        if (depth) occluderDepth.value = depth;
        uOccluded.value = depth ? 1 : 0;
        renderer.autoClear = false;
        renderer.setRenderTarget(fireTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(fireScene, camera);
        renderer.setRenderTarget(previousTarget);
        renderer.render(compositeScene, camera);
      } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.setClearColor(clearColor, previousAlpha);
        renderer.autoClear = previousAutoClear;
      }
    },
    setVolumeLights(lights) {
      uKeyGain.value = lights ? 0 : 1;
      mesh.updateMatrixWorld();
      inverseModel.copy(mesh.matrixWorld).invert();
      volumeLights.forEach((slot, i) => {
        const light = lights?.[i];
        slot.gain.value = light?.gain ?? 0;
        if (!light) return;
        slot.position.value.copy(light.position).applyMatrix4(inverseModel);
        slot.direction.value.copy(light.direction).transformDirection(inverseModel);
        slot.cosOuter.value = light.cosOuter;
        slot.cosInner.value = light.cosInner;
        slot.range.value = light.range;
        slot.color.value.set(light.color.r, light.color.g, light.color.b);
      });
    },
    dispose() {
      placeholderDepth.dispose();
      fireTarget.dispose();
      compositeMaterial.dispose();
      compositeGeometry.dispose();
      geometry.dispose();
      material.dispose();
      for (const texture of [velA, velB, dyeA, dyeB, divergence, pressA, pressB, curl]) {
        texture.dispose();
      }
    },
  };
}
