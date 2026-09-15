// Example: site/examples/fast-on-phones.md - let the device decide the
// settings, then keep the frame rate honest with an adaptive pixel ratio.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  SplatMesh,
  createWebGPURenderer,
  detectSplatDeviceProfile,
  recommendedMaxPixelRatio,
  resolveSplatBudget,
  resolveSplatPerformanceProfile,
  suggestAdaptivePixelRatio,
  ADAPTIVE_PIXEL_RATIO_WARMUP_FRAMES,
} from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';

const renderer = await createWebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

// What the library can tell about this device. Every number below comes from
// it - none of them is a guess you have to make yourself.
const profile = detectSplatDeviceProfile();

// The quality ceiling. A phone's screen may report devicePixelRatio 3, which
// means nine times the fragments of ratio 1 - the single biggest cost on
// mobile, because splat rendering is fill-bound there rather than
// memory-bound. Cap it before you do anything else.
const maxRatio = recommendedMaxPixelRatio(profile);
let pixelRatio = Math.min(devicePixelRatio, maxRatio);
renderer.setPixelRatio(pixelRatio);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0.8, 0.3, 1.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const splats = new SplatMesh(await loadSplatData('/goose.sog'), {
  // 'smooth' culls faint splats harder than 'quality'. Resolved from the
  // device unless you pass one - mobile gets 'smooth', desktop 'quality'.
  performanceProfile: resolveSplatPerformanceProfile(),
});
scene.add(splats);

const hud = document.querySelector<HTMLElement>('#hud')!;
let emaMs: number | undefined;
let warmupRemaining = ADAPTIVE_PIXEL_RATIO_WARMUP_FRAMES;
let last = performance.now();
let sinceHud = 0;
let pressureMs = 0;
let healthyRecoveryMs = 0;
let probationRemainingMs = 0;
let cooldownRemainingMs = 0;
let failedProbeDelayMs = 30_000;

const recoveryDwellMs = 2_000;
const pressureDwellMs = 250;
const probationMs = 5_000;
const ordinaryCooldownMs = 10_000;
const maxFailedProbeDelayMs = 5 * 60_000;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const frameMs = now - last;
  last = now;

  if (document.visibilityState !== 'visible') return;
  const activeGap = Math.max(0, frameMs);
  const activeTimerMs = activeGap > 250 ? 0 : Math.min(activeGap, 100);
  if (activeGap > 250) healthyRecoveryMs = 0;

  const probationWasActive = probationRemainingMs > 0;
  probationRemainingMs = Math.max(0, probationRemainingMs - activeTimerMs);
  cooldownRemainingMs = Math.max(0, cooldownRemainingMs - activeTimerMs);

  // Measure, then let the library decide whether to spend or save. It
  // supplies the raw per-frame suggestion. Warmup skips one-time pipeline
  // compiles; the host applies the dwell, probation, and retry policy below.
  const next = suggestAdaptivePixelRatio({
    frameMs,
    emaMs,
    warmupRemaining,
    current: pixelRatio,
    max: maxRatio,
    min: 1,
  });
  emaMs = next.emaMs;
  warmupRemaining = next.warmupRemaining;
  pressureMs =
    next.pixelRatio < pixelRatio && activeGap <= 250
      ? Math.min(pressureDwellMs, pressureMs + activeTimerMs)
      : 0;
  if (next.pixelRatio < pixelRatio && pressureMs >= pressureDwellMs) {
    const failedProbe = probationWasActive;
    pixelRatio = next.pixelRatio;
    pressureMs = 0;
    healthyRecoveryMs = 0;
    probationRemainingMs = 0;
    cooldownRemainingMs = failedProbe ? failedProbeDelayMs : ordinaryCooldownMs;
    if (failedProbe) {
      failedProbeDelayMs = Math.min(failedProbeDelayMs * 2, maxFailedProbeDelayMs);
    }
    renderer.setPixelRatio(pixelRatio);
  } else if (probationRemainingMs > 0) {
    healthyRecoveryMs = 0;
  } else if (probationWasActive) {
    // A probe that completed without pressure earns the initial retry delay.
    failedProbeDelayMs = 30_000;
    healthyRecoveryMs = 0;
  } else if (emaMs === undefined || cooldownRemainingMs > 0) {
    healthyRecoveryMs = 0;
  } else if (emaMs > 22) {
    healthyRecoveryMs = 0;
  } else if (emaMs < 18 * 0.95) {
    healthyRecoveryMs = Math.min(recoveryDwellMs, healthyRecoveryMs + activeTimerMs);
  } else {
    // Isolated neutral jitter decays the dwell instead of resetting it.
    healthyRecoveryMs = Math.max(0, healthyRecoveryMs - activeTimerMs);
  }
  if (
    next.pixelRatio > pixelRatio &&
    healthyRecoveryMs >= recoveryDwellMs &&
    cooldownRemainingMs === 0
  ) {
    pixelRatio = next.pixelRatio;
    healthyRecoveryMs = 0;
    probationRemainingMs = probationMs;
    renderer.setPixelRatio(pixelRatio); // cheap: it resizes the drawing buffer
  }

  sinceHud += frameMs;
  if (sinceHud > 250) {
    sinceHud = 0;
    hud.textContent =
      `${(1000 / (emaMs ?? frameMs)).toFixed(0)} fps · pixel ratio ${pixelRatio} ` +
      `(screen ${devicePixelRatio}, ceiling ${maxRatio}) · ` +
      `${profile?.isMobile ? 'mobile' : 'desktop'} · budget ${resolveSplatBudget().toLocaleString()}`;
  }

  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
