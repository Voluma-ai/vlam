// Example: site/examples/flashlight-fog.md - a ringed flashlight carried through
// a foggy hall at night: relit splats, fogged splats, and a lit beam in the air.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  Fn,
  Loop,
  acos,
  cameraPosition,
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  exp,
  float,
  getViewPosition,
  interleavedGradientNoise,
  lightShadowMatrix,
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
import { createWebGPURenderer, type SplatModifier } from '@voluma/vlam';
import { StreamedSplatMesh } from '@voluma/vlam/streaming';
import {
  attachRelighting,
  createRelightingBeamProfile,
  createRelightingProxy,
  createRelightingShadowFactorMaterial,
  renderRelightingFactorMap,
  updateRelightingShadowFactorWeights,
} from '@voluma/vlam/relighting';

const renderer = await createWebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 10000);
// Mid-hall, facing the colonnade.
camera.position.set(-6.0, 1.65, 3.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(-5.1, 1.67, 1.7);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const splats = await StreamedSplatMesh.load('/remote/voluma/cultural-heritage/Tempel/Tempel.lcc2');
scene.add(splats);
splats.updateWorldMatrix(true, false);

// --- Fog on the splats -------------------------------------------------------
// One density drives both the haze on the capture and the beam in the air.
const fogDensity = uniform(0.06);
const fogColor = vec3(0.55, 0.6, 0.7);
const fog: SplatModifier = (ctx) => {
  const depth = ctx.viewCenter.z.negate();
  const haze = float(1).sub(exp(depth.mul(fogDensity).negate()));
  return { color: vec4(mix(ctx.color.rgb, fogColor, haze), ctx.color.a) };
};
splats.modifiers = [fog];

// --- The flashlight ----------------------------------------------------------
// A plain SpotLight. The rings are a beam profile, not flashlight-specific API:
// any radial falloff works, and SpotLight.map takes a full 2D pattern.
const flashlight = new THREE.SpotLight(0xfff0d8, 1, 18, 0.38, 0.1, 1.2);
flashlight.castShadow = true;
flashlight.shadow.mapSize.set(1024, 1024);
flashlight.shadow.bias = -0.002;
flashlight.shadow.normalBias = 0.05;

const lobe = (t: number, center: number, width: number, gain: number) =>
  gain * Math.exp(-(((t - center) / width) ** 2));
const rings = createRelightingBeamProfile((t) =>
  Math.min(
    1,
    0.12 + lobe(t, 0, 0.2, 0.88) + lobe(t, 0.55, 0.16, 0.38) + lobe(t, 0.88, 0.045, 0.32),
  ),
);

// --- Relighting the capture --------------------------------------------------
// The proxy is the capture's collision mesh, as in the Relight example.
const proxy = createRelightingProxy({
  tiles: await splats.loadCollisionMeshes(),
  matrixWorld: splats.matrixWorld.clone(),
});
const relightScene = new THREE.Scene();
relightScene.add(proxy.group, flashlight, flashlight.target);

// intensity 0: no umbra of its own, only shadow-occluded fill inside the cone.
const contribution = {
  light: flashlight,
  intensity: 0,
  fill: 32,
  beamProfile: rings,
  beamProfileStrength: 1,
};
const factorMat = createRelightingShadowFactorMaterial([contribution], { combine: 'min' });
proxy.group.traverse((obj) => {
  if (!(obj instanceof THREE.Mesh)) return;
  obj.material = factorMat;
  obj.castShadow = true;
  obj.receiveShadow = true;
});

// The factor pass also keeps the proxy's depth: the beam pass below stops
// marching where the ray meets a wall or the floor.
const relightTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType });
relightTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
relightTarget.depthTexture = new THREE.DepthTexture(1, 1);

// Night: everything sits at `ambient`, and the flashlight fill lifts it back up.
const ambient = 0.05;
attachRelighting(splats, {
  map: relightTarget.texture,
  blend: 1,
  brightness: ambient,
  background: ambient,
  softness: 2,
});

// --- The beam in the fog -----------------------------------------------------
// A full-screen additive pass ray-marches each pixel's view ray through the
// cone, adding in-scattered light attenuated by the same fog. It samples the
// same ring profile, so the rings show in the air too.
const lightPos = uniform(new THREE.Vector3());
const lightDir = uniform(new THREE.Vector3(0, 0, -1));
const ringStrength = uniform(1);
const beamGain = uniform(0.6);
// Shares the light's colour, so tinting the flashlight tints the beam.
const beamColor = uniform(flashlight.color);
const coneOuter = uniform(flashlight.angle);
const coneInner = uniform(flashlight.angle * (1 - flashlight.penumbra));
const beamRange = uniform(flashlight.distance);
const STEPS = 48;
const MAX_DISTANCE = 40;
// The march also compares each step against the flashlight's shadow map, so a
// column shadows the air behind it, not only the wall. three creates that map
// on the first shadow draw, so the lookup starts on a placeholder set up the
// same way (a comparison sampler) and is pointed at the real map each frame.
const shadowPlaceholder = new THREE.DepthTexture(1, 1);
shadowPlaceholder.compareFunction = THREE.LessEqualCompare;
const shadowDepth = texture(shadowPlaceholder);

const beam = Fn(() => {
  const depth = texture(relightTarget.depthTexture!, screenUV).x;
  const viewHit = getViewPosition(screenUV, depth, cameraProjectionMatrixInverse);
  const rayDir = cameraWorldMatrix.mul(vec4(viewHit.normalize(), 0)).xyz.normalize();
  const hit = depth.lessThan(1).select(viewHit.length(), float(MAX_DISTANCE));
  const stepLength = hit.min(MAX_DISTANCE).div(STEPS);
  const jitter = interleavedGradientNoise(screenCoordinate);
  const scattered = float(0).toVar();

  Loop(STEPS, ({ i }) => {
    const s = float(i).add(jitter).mul(stepLength);
    const point = cameraPosition.add(rayDir.mul(s));
    const toSample = point.sub(lightPos);
    const d = toSample.length().max(1e-3);
    const cosAngle = toSample.div(d).dot(lightDir).clamp(-1, 1);
    const cone = smoothstep(coneOuter.cos(), coneInner.cos(), cosAngle);
    const t = acos(cosAngle).div(coneOuter).clamp(0, 1);
    const ring = mix(float(1), texture(rings, vec2(t, 0.5)).level(float(0)).r, ringStrength);
    // Same range window as the relight fill, plus a soft inverse-square.
    const range = d.div(beamRange).pow4().oneMinus().clamp().pow2();
    const falloff = range.div(d.mul(d).mul(0.08).add(1));
    const transmittance = exp(s.mul(fogDensity).negate());
    // Project the step through the shadow camera the way three's shadow
    // filters do (y flipped for WebGPU); outside the camera the step is lit.
    // No depth bias: that guards surfaces against acne, and in the air it
    // would leave a slab of lit fog just behind every occluder.
    const clip = lightShadowMatrix(flashlight).mul(vec4(point, 1));
    const coord = clip.xyz.div(clip.w);
    const inFrustum = coord.x
      .greaterThanEqual(0)
      .and(coord.x.lessThanEqual(1))
      .and(coord.y.greaterThanEqual(0))
      .and(coord.y.lessThanEqual(1))
      .and(coord.z.lessThanEqual(1));
    const unshadowed = inFrustum.select(
      shadowDepth.sample(vec2(coord.x, coord.y.oneMinus())).compare(coord.z).x,
      float(1),
    );
    scattered.addAssign(
      cone
        .mul(ring)
        .mul(falloff)
        .mul(unshadowed)
        .mul(transmittance)
        .mul(fogDensity)
        .mul(stepLength),
    );
  });

  return vec4(beamColor.mul(scattered).mul(beamGain), 1);
});

const beamMaterial = new THREE.MeshBasicNodeMaterial({
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
beamMaterial.vertexNode = vec4(positionGeometry.xy, 0, 1);
beamMaterial.colorNode = beam();
const beamQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), beamMaterial);
beamQuad.frustumCulled = false;
const beamScene = new THREE.Scene();
beamScene.add(beamQuad);

// --- Controls ----------------------------------------------------------------
const panel = document.createElement('div');
panel.style.cssText =
  'position:fixed;top:12px;left:12px;padding:8px 12px;border-radius:8px;' +
  'background:#000a;color:#eee;display:grid;grid-template-columns:auto 140px;gap:6px 10px';
document.body.appendChild(panel);
const slider = (
  label: string,
  min: number,
  max: number,
  value: number,
  onInput: (v: number) => void,
) => {
  const input = Object.assign(document.createElement('input'), {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String((max - min) / 100),
    value: String(value),
  });
  input.addEventListener('input', () => onInput(Number(input.value)));
  panel.append(Object.assign(document.createElement('label'), { textContent: label }), input);
};
slider('Fog', 0, 0.2, fogDensity.value, (v) => (fogDensity.value = v));
slider('Rings', 0, 1, 1, (v) => {
  ringStrength.value = v;
  contribution.beamProfileStrength = v;
  // Live: retunes uniforms, no new material.
  updateRelightingShadowFactorWeights(factorMat, [contribution]);
});

// Focus, like twisting a zoom flashlight's head: a narrow, bright beam or a
// wide, dim one. At the wide end brightness follows 1 / solid angle of the cone
// (same total light); towards the narrow end it is capped, since conserving
// energy in a 0.06 rad cone would be ~40x and clip everything to white.
// Brightness is interpolated in log space between the two ends.
const WIDE = 0.6;
const NARROW = 0.06;
const REFERENCE = flashlight.angle; // fill 32 and beam gain 0.6 are tuned here
const solidAngle = (angle: number) => 1 - Math.cos(angle);
const WIDE_BRIGHTNESS = solidAngle(REFERENCE) / solidAngle(WIDE);
const NARROW_BRIGHTNESS = 4.7;
const baseFill = contribution.fill;
const baseGain = beamGain.value;
const baseRange = flashlight.distance;
const focusBeam = (focus: number) => {
  const angle = WIDE + (NARROW - WIDE) * focus;
  const brightness = WIDE_BRIGHTNESS * (NARROW_BRIGHTNESS / WIDE_BRIGHTNESS) ** focus;
  // `angle` is read live by the relight material and the shadow camera.
  flashlight.angle = angle;
  coneOuter.value = angle;
  coneInner.value = angle * (1 - flashlight.penumbra);
  contribution.fill = baseFill * brightness;
  updateRelightingShadowFactorWeights(factorMat, [contribution]);
  beamGain.value = baseGain * brightness;
  // A concentrated beam carries further: the distance at which it falls to the
  // same illuminance grows with sqrt(intensity) (inverse-square law).
  flashlight.distance = baseRange * Math.sqrt(brightness);
  beamRange.value = flashlight.distance;
};
// Start on a 20° beam (10° half-angle; SpotLight.angle is measured from the axis).
const START = THREE.MathUtils.degToRad(10);
const startFocus = (WIDE - START) / (WIDE - NARROW);
focusBeam(startFocus);
slider('Beam', 0, 1, startFocus, focusBeam);

// Put the flashlight down to walk around its beam and see the cone in the fog.
let carried = true;
const drop = Object.assign(document.createElement('button'), { textContent: 'Put down (F)' });
drop.style.gridColumn = 'span 2';
const toggleCarried = () => {
  carried = !carried;
  drop.textContent = carried ? 'Put down (F)' : 'Pick up (F)';
};
drop.addEventListener('click', toggleCarried);
window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyF') toggleCarried();
});
panel.append(drop);

// --- Frame loop --------------------------------------------------------------
const forward = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  controls.update();

  if (carried) {
    // Held just below and right of the eye, pointing where the camera looks.
    camera.updateMatrixWorld();
    camera.getWorldDirection(forward);
    flashlight.position.set(0.18, -0.15, 0).applyMatrix4(camera.matrixWorld);
    flashlight.target.position.copy(camera.position).addScaledVector(forward, 10);
    flashlight.updateMatrixWorld();
    flashlight.target.updateMatrixWorld();
  }
  lightPos.value.copy(flashlight.position);
  lightDir.value.copy(flashlight.target.position).sub(flashlight.position).normalize();

  renderRelightingFactorMap(renderer, relightScene, camera, relightTarget);
  const shadowMap = flashlight.shadow.map?.depthTexture;
  if (shadowMap && shadowDepth.value !== shadowMap) shadowDepth.value = shadowMap;
  splats.update(camera, renderer);
  renderer.render(scene, camera);

  renderer.autoClear = false;
  renderer.render(beamScene, camera);
  renderer.autoClear = true;
});
