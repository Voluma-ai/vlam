// Example: site/examples/first-viewer.md - a complete viewer you can drag.
// Renderer + scene + camera + splats, plus OrbitControls for mouse input.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createSplatRenderer } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';

// 1. The renderer draws pixels into a <canvas>. `createSplatRenderer` picks
//    WebGPU when the browser has it and falls back to WebGL2 when it does not.
const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

// 2. The scene is the container: anything you add to it can be drawn.
const scene = new THREE.Scene();

// 3. The camera is where you are standing and which way you are facing.
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(1, 0.5, 1.4);

// 4. Mouse input. VLAM! never touches the pointer - this is plain three.js.
//    Drag to orbit, scroll to zoom, right-drag to pan.
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

// 5. The capture itself. `loadSplatData` downloads and decodes the file; the
//    `SplatMesh` is the three.js object that draws it.
const splats = new SplatMesh(await loadSplatData('/goose.sog'));
scene.add(splats);

// Keep filling the window when it is resized.
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// 6. One pass per frame, in this order: move the camera, tell the splats where
//    it is (they re-sort themselves back-to-front for it), then draw.
renderer.setAnimationLoop(() => {
  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
