// Example: site/examples/splats-and-objects.md - put an ordinary three.js cube
// on the goose's head, as a hat.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createSplatRenderer } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0.6, 0.5, 1.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.1, 0);

// Lights affect ordinary geometry only. The capture already has its real
// lighting baked in, so nothing here changes how the goose looks.
scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(2, 4, 3);
scene.add(sun);

const splats = new SplatMesh(await loadSplatData('/goose.sog'));

// A SplatMesh arrives with a rotation of its own: the correction that stands
// the capture upright. Replacing its orientation outright (rotation.set,
// quaternion.copy) would throw that away and leave the goose upside down.
// Transforming a Group around it sidesteps the question entirely.
const goose = new THREE.Group();
goose.add(splats);
scene.add(goose);

// The hat. It is a child of the same group, so its position is expressed in
// the capture's own frame - and if you ever move or scale the group, it goes
// along instead of being left behind.
const hat = new THREE.Mesh(
  new THREE.BoxGeometry(0.17, 0.09, 0.17),
  new THREE.MeshStandardNodeMaterial({ color: 0x4488ff, roughness: 0.4 }),
);
// Measured off the capture: the top of the head is at y ≈ 0.5, around x ≈ -0.21.
// Finding these by eye, once, is the normal way to place something on a capture.
hat.position.set(-0.21, 0.53, 0);
hat.rotation.set(0, 0.5, -0.12); // worn at a jaunty angle
goose.add(hat);

renderer.setAnimationLoop(() => {
  controls.update();
  hat.rotation.y += 0.01; // only the hat spins; the goose stays put
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
