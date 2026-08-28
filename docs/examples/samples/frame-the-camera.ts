// Example: site/examples/frame-the-camera.md - put the camera where the
// capture actually is, instead of guessing coordinates.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createSplatRenderer } from '@voluma/vlam';
import { loadScene } from '@voluma/vlam/loaders';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const splats = new SplatMesh(await loadScene('/goose.sog'));
scene.add(splats);

/**
 * The capture's bounds in world space.
 *
 * `computeSplatBounds` measures the splats themselves, in the mesh's local
 * space - so the mesh's own matrix, which carries the upright correction as
 * well as anything you set, still has to be applied. Do NOT use
 * `Box3.setFromObject`: the geometry is a single instanced unit quad, so it
 * would report a ~2-unit box at the origin no matter what the capture holds.
 */
function worldBounds(mesh: SplatMesh): THREE.Box3 {
  mesh.updateMatrixWorld(true);
  return mesh.computeSplatBounds().applyMatrix4(mesh.matrixWorld);
}

/**
 * Moves the camera back far enough for `box` to fill the view, keeping the
 * direction you are already looking from.
 */
function frame(box: THREE.Box3, margin = 1.25): void {
  const sphere = box.getBoundingSphere(new THREE.Sphere());

  // How far back a sphere of this radius has to sit to fit the vertical field
  // of view - and the horizontal one, which is the tighter of the two on a
  // portrait window.
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const distance = (sphere.radius * margin) / Math.sin(Math.min(vFov, hFov) / 2);

  const direction = camera.position.clone().sub(controls.target);
  // First run: no meaningful direction yet, so pick a pleasant three-quarter view.
  if (direction.lengthSq() < 1e-8) direction.set(0.6, 0.35, 1);
  direction.normalize();

  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(direction, distance);

  // Clip planes scaled to the capture, so a large scan does not z-fight and a
  // tiny one is not clipped away at the near plane.
  camera.near = Math.max(distance / 1000, sphere.radius / 1000);
  camera.far = distance + sphere.radius * 4;
  camera.updateProjectionMatrix();
  controls.update();
}

const box = worldBounds(splats);
frame(box);

// Report what was found, so the numbers stop being a mystery.
const size = box.getSize(new THREE.Vector3());
document.querySelector<HTMLElement>('#readout')!.textContent =
  `bounds ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} · ` +
  `center ${box
    .getCenter(new THREE.Vector3())
    .toArray()
    .map((v) => v.toFixed(2))
    .join(', ')}`;

document.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => frame(box));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
