// Example: site/examples/depth-of-field.md - camera-style focus, driven by
// sliders and by clicking whatever you want sharp.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createWebGPURenderer } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';

const renderer = await createWebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0.9, 0.3, 1.7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const splats = new SplatMesh(await loadSplatData('/goose.sog'));
scene.add(splats);

const focusInput = document.querySelector<HTMLInputElement>('#focus')!;
const apertureInput = document.querySelector<HTMLInputElement>('#aperture')!;
const readout = document.querySelector<HTMLElement>('#readout')!;

/**
 * Both settings are live uniforms - this is a couple of numbers handed to a
 * shader that is already compiled. No rebuild, nothing re-uploaded, so calling
 * it on every slider frame (or every animation frame) is free.
 */
function apply(): void {
  const focusDistance = Number(focusInput.value);
  const aperture = Number(apertureInput.value);
  splats.setDepthOfField({ focusDistance, aperture });
  readout.textContent =
    aperture === 0
      ? 'aperture 0 - depth of field off, everything sharp'
      : `focus ${focusDistance.toFixed(2)} · aperture ${aperture.toFixed(2)}`;
}

focusInput.addEventListener('input', apply);
apertureInput.addEventListener('input', apply);
apply();

// Autofocus, the way a camera does it: pick the point under the cursor and
// focus on however far away it turned out to be.
renderer.domElement.addEventListener('pointerdown', (event) => {
  const ndc = new THREE.Vector2(
    (event.clientX / innerWidth) * 2 - 1,
    -(event.clientY / innerHeight) * 2 + 1,
  );
  void splats.pick(ndc, camera, renderer, { alphaThreshold: 0.1 }).then((hit) => {
    if (!hit) return;
    // `hit.distance` is camera → point, which is exactly what focusDistance
    // means, so the two fit together with no conversion.
    focusInput.value = String(hit.distance);
    apply();
  });
});

renderer.setAnimationLoop(() => {
  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
