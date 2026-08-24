// Example: site/examples/fast-on-phones.md - let the device decide the
// settings, then keep the frame rate honest with an adaptive pixel ratio.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  SplatMesh,
  createSplatRenderer,
  detectSplatDeviceProfile,
  loadScene,
  recommendedMaxPixelRatio,
  resolveSplatBudget,
  resolveSplatPerformanceProfile,
  suggestAdaptivePixelRatio,
} from '@voluma/vlam';

const renderer = await createSplatRenderer();
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

const splats = new SplatMesh(await loadScene('/goose.sog'), {
  // 'smooth' culls faint splats harder than 'quality'. Resolved from the
  // device unless you pass one - mobile gets 'smooth', desktop 'quality'.
  performanceProfile: resolveSplatPerformanceProfile(),
});
scene.add(splats);

const hud = document.querySelector<HTMLElement>('#hud')!;
let emaMs: number | undefined;
let last = performance.now();
let sinceHud = 0;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const frameMs = now - last;
  last = now;

  // Measure, then let the library decide whether to spend or save. It
  // hysteresis-damps the decision, so the ratio does not oscillate on a
  // frame that happened to be slow.
  const next = suggestAdaptivePixelRatio({
    frameMs,
    emaMs,
    current: pixelRatio,
    max: maxRatio,
    min: 1,
  });
  emaMs = next.emaMs;
  if (next.pixelRatio !== pixelRatio) {
    pixelRatio = next.pixelRatio;
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
