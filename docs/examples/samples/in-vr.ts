// Example: site/examples/in-vr.md - the same capture, viewed in a headset.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  SplatMesh,
  createSplatRenderer,
  recommendedXrFramebufferScale,
  resolveSplatBudget,
  resolveXrSplatBudget,
  xrSessionInit,
} from '@voluma/vlam';
import { loadScene } from '@voluma/vlam/loaders';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
// Headsets render two eyes at high refresh, so they get a smaller framebuffer
// than a monitor would. 1 on anything that is not a headset.
renderer.xr.setFramebufferScaleFactor(recommendedXrFramebufferScale());
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0, 1.6, 1.5); // roughly standing eye height
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.4, 0);
controls.enableDamping = true;

const splats = new SplatMesh(await loadScene('/goose.sog'));
splats.position.y = 1.3; // lift it to eye level for a standing viewer
scene.add(splats);

// Two eyes, ~90 Hz, no room for a dropped frame: a headset must not be handed
// the page's splat budget. This clamps it to what a headset can hold. A static
// mesh like this one is already whole, so the number is only reported here -
// on a StreamedSplatMesh you would apply it with `setBudget` when the session
// starts, and put the page budget back when it ends.
const pageBudget = resolveSplatBudget();
const headsetBudget = resolveXrSplatBudget(pageBudget);

const button = document.querySelector<HTMLButtonElement>('#enter-vr')!;
const status = document.querySelector<HTMLElement>('#status')!;

// `navigator.xr` is absent on browsers without WebXR - feature-detect rather
// than assume, or the page throws for everyone else.
if (!navigator.xr) {
  button.disabled = true;
  status.textContent = 'This browser has no WebXR support.';
} else {
  const supported = await navigator.xr.isSessionSupported('immersive-vr');
  button.disabled = !supported;
  status.textContent = supported
    ? `Ready · page budget ${pageBudget.toLocaleString()} → headset ${headsetBudget.toLocaleString()}`
    : 'No VR headset available to this browser.';
}

button.addEventListener('click', () => {
  void (async () => {
    // `xrSessionInit` adds what the renderer's backend needs - notably the
    // 'webgpu' required feature - on top of whatever you ask for yourself.
    const session = await navigator.xr!.requestSession(
      'immersive-vr',
      xrSessionInit(renderer, { optionalFeatures: ['local-floor', 'bounded-floor'] }),
    );
    await renderer.xr.setSession(session);
    status.textContent = 'In VR - take the headset off to return.';
    session.addEventListener('end', () => {
      status.textContent = 'Session ended.';
    });
  })();
});

// setAnimationLoop is already the right loop for XR: three.js drives it from
// the headset's frame callback once a session is running.
renderer.setAnimationLoop(() => {
  if (!renderer.xr.isPresenting) controls.update();
  splats.update(renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, renderer);
  renderer.render(scene, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);
});
