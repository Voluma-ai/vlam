// Guide sample: docs/guide/getting-started.md - the complete minimal app.
import * as THREE from 'three/webgpu';
import { SplatMesh, createSplatRenderer } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(1, 0.5, 1.4);
camera.lookAt(0, 0, 0);

const splats = new SplatMesh(await loadSplatData('/scene.sog'));
scene.add(splats);

renderer.setAnimationLoop(() => {
  splats.update(camera, renderer); // uniforms + GPU depth sort
  renderer.render(scene, camera);
});
