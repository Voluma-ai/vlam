// Example: site/examples/big-scenes.md - a streamed capture with LOD.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWebGPURenderer, resolveSplatBudget } from '@voluma/vlam';
import { StreamedSplatMesh } from '@voluma/vlam/streaming';

const renderer = await createWebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 10000);
camera.position.set(-9.09, 1.65, 8.85);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(-8.21, 1.67, 7.06);

// Hold LMB still for 300 ms to walk forward. A drag in that window stays an
// orbit. Once walking, the same press looks around, like the viewer.
const HOLD_MS = 300;
const SLOP_PX = 2;
const WALK_SPEED = 4;
const LOOK = 0.0025;
const PITCH = Math.PI / 3;
type Hold = { id: number; t0: number; x: number; y: number; walking: boolean };
let hold: Hold | null = null;
const canvas = renderer.domElement;
const forward = new THREE.Vector3();
const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');

const look = (dx: number, dy: number): void => {
  if (dx === 0 && dy === 0) return;
  const dist = Math.max(camera.position.distanceTo(controls.target), 0.01);
  lookEuler.setFromQuaternion(camera.quaternion, 'YXZ');
  lookEuler.y -= dx * LOOK;
  lookEuler.x = Math.min(PITCH, Math.max(-PITCH, lookEuler.x - dy * LOOK));
  lookEuler.z = 0;
  camera.up.set(0, 1, 0);
  camera.quaternion.setFromEuler(lookEuler);
  camera.getWorldDirection(forward);
  controls.target.copy(camera.position).addScaledVector(forward, dist);
};

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  hold = {
    id: event.pointerId,
    t0: performance.now(),
    x: event.clientX,
    y: event.clientY,
    walking: false,
  };
});
canvas.addEventListener(
  'pointermove',
  (event) => {
    if (!hold || event.pointerId !== hold.id) return;
    if (hold.walking || performance.now() - hold.t0 > HOLD_MS) {
      hold.walking = true;
      controls.enableRotate = false;
      look(event.clientX - hold.x, event.clientY - hold.y);
      hold.x = event.clientX;
      hold.y = event.clientY;
      return;
    }
    if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > SLOP_PX) hold = null;
  },
  true,
);
const endHold = (event: PointerEvent): void => {
  if (hold?.id !== event.pointerId) return;
  hold = null;
  controls.enableRotate = true;
};
canvas.addEventListener('pointerup', endHold);
canvas.addEventListener('pointercancel', endHold);

let lastT = performance.now();

// How many splats may be active at once. Left out, the library picks a number
// from what it can see of the device - the safe default. Name one only when
// you have measured your own scene on your own target hardware.
const budget = resolveSplatBudget();

// The `.lcc2` is a small index; splat data arrives in chunks while you look
// around. `/remote/…` is the docs/demo proxy onto assets.voluma.ai.
const splats = await StreamedSplatMesh.load('/remote/jack/v/Dehaar/Dehaar.lcc2', {
  budget,
  lodBaseDistance: 10, // inside this many world units, the finest detail is used
});
scene.add(splats);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

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
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  if (hold && (hold.walking || now - hold.t0 > HOLD_MS)) {
    hold.walking = true;
    controls.enableRotate = false;
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() > 1e-8) {
      forward.normalize();
      camera.position.addScaledVector(forward, WALK_SPEED * dt);
      controls.target.addScaledVector(forward, WALK_SPEED * dt);
    }
  } else {
    controls.update();
  }
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
