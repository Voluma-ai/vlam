// Example: site/examples/big-scenes.md - a streamed capture with LOD.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { StreamedSplatMesh, createSplatRenderer, resolveSplatBudget } from '@voluma/vlam';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 500);
camera.position.set(0, 2, 8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// How many splats may be active at once. Left out, the library picks a number
// from what it can see of the device - the safe default. Name one only when
// you have measured your own scene on your own target hardware.
const budget = resolveSplatBudget();

// The manifest is a small JSON index; the splat data itself arrives in chunks,
// on demand, while you look around.
const splats = await StreamedSplatMesh.load('/capture/lod-meta.json', {
  budget,
  lodBaseDistance: 10, // inside this many world units, the finest detail is used
});
scene.add(splats);

// A quality control, if you want to expose one. Raising the budget shows more
// detail and costs more memory and frame time; lowering it does the reverse.
// Nothing reloads - the mesh just re-picks which chunks are worth keeping.
const quality = document.querySelector<HTMLInputElement>('#quality')!;
quality.addEventListener('input', () => {
  splats.setBudget(Math.round(budget * Number(quality.value)));
});

// `update` is where the streaming decisions happen: what is close enough to
// deserve detail, what has fallen behind the camera, what to fetch next. It
// needs the real camera pose for the frame, so update the controls first.
renderer.setAnimationLoop(() => {
  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
