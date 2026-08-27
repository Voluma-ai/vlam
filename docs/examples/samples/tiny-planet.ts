// Example: site/examples/tiny-planet.md - wrap a streamed street into a planet
// (or a bowl) without moving the camera.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { StreamedSplatMesh, createSplatRenderer } from '@voluma/vlam';
import { worldWarpPreset } from '@voluma/vlam/effects';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 10000);
camera.position.set(-9.09, 1.65, 8.85);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(-8.21, 1.67, 7.06);

const splats = await StreamedSplatMesh.load('/remote/jack/v/Dehaar/Dehaar.lcc2');
scene.add(splats);

// Nearby splats stay put so orbit still reads as moving through the scene.
// `0.22 × span` is what the viewer uses on a walkable street.
const span = splats.computeSplatBounds().getSize(new THREE.Vector3()).length();
const warp = worldWarpPreset({
  intensity: 0.55,
  radius: Math.max(1e-4, 0.22 * span),
});
splats.modifiers = [warp.modifier];

const intensity = document.querySelector<HTMLInputElement>('#intensity')!;
intensity.addEventListener('input', () => {
  warp.intensity.value = Number(intensity.value);
});

renderer.setAnimationLoop(() => {
  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
