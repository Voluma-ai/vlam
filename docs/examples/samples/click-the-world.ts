// Example: site/examples/click-the-world.md - click a point, mark it, fly to it.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createSplatRenderer, loadScene } from '@voluma/vlam';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(1, 0.5, 1.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const splats = new SplatMesh(await loadScene('/goose.sog'));
scene.add(splats);

// A small ball we drop on whatever was clicked.
const marker = new THREE.Mesh(
  new THREE.SphereGeometry(0.02),
  new THREE.MeshBasicNodeMaterial({ color: 0xff3366 }),
);
marker.visible = false;
scene.add(marker);

renderer.domElement.addEventListener('pointerdown', (event) => {
  // The pick takes normalized device coordinates: the canvas mapped to
  // -1…1 on both axes, with +Y up. This is the usual three.js conversion.
  const ndc = new THREE.Vector2(
    (event.clientX / innerWidth) * 2 - 1,
    -(event.clientY / innerHeight) * 2 + 1,
  );

  void splats.pick(ndc, camera, renderer, { alphaThreshold: 0.1 }).then((hit) => {
    // null means the ray went through empty space or only through smudges too
    // faint to count as surface. A miss is normal, never an error.
    if (!hit) return;

    marker.position.copy(hit.point);
    marker.visible = true;

    // Orbit around what you just clicked. OrbitControls eases into it because
    // damping is on.
    controls.target.copy(hit.point);
  });
});

renderer.setAnimationLoop(() => {
  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
