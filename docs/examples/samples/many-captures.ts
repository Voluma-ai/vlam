// Example: site/examples/many-captures.md - three captures sorted and blended
// as one cloud, each movable at no cost.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatScene, createSplatRenderer, loadScene } from '@voluma/vlam';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0, 0.3, 2.1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const data = await loadScene('/goose.sog');

// One shared pool for every cloud, so the sort covers all of them at once.
// Capacity is in splats and must cover the sum of what you add - it is
// allocated up front, so size it for the scene you intend to build.
const flock = new SplatScene({ capacity: data.count * 3 });
scene.add(flock);

// Close enough that the clouds pass through each other - which is the point:
// overlapping is exactly where independently sorted meshes would show a seam.
const SPACING = 0.42;

// Each source is copied into the pool once, in its own local frame; the
// placement below is a matrix the shader applies live.
const ids = [-1, 0, 1].map((slot) =>
  flock.addSource(data, new THREE.Matrix4().makeTranslation(slot * SPACING, 0, 0)),
);

const start = performance.now();

renderer.setAnimationLoop(() => {
  const time = (performance.now() - start) / 1000;

  // Moving a source is a uniform write - no data is copied, nothing is
  // re-uploaded, and the shared sort keeps every cloud correctly interleaved
  // with the others while they move. Safe to do every frame.
  ids.forEach((id, i) => {
    const slot = i - 1;
    const bob = Math.sin(time * 1.2 + i) * 0.12;
    // A little drift in and out, so the three keep sliding through each other.
    const drift = Math.sin(time * 0.7 + i) * 0.1;
    flock.setSourceTransform(
      id,
      new THREE.Matrix4()
        .makeRotationY(time * 0.4 + i)
        .setPosition(slot * SPACING + drift, bob, slot * 0.12),
    );
  });

  controls.update();
  flock.update(camera, renderer); // one update for the whole scene
  renderer.render(scene, camera);
});
