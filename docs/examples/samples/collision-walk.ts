// Example: site/examples/collision-walk.md - first-person walking against the
// collision meshes shipped beside a streamed De Haar capture.
import * as THREE from 'three/webgpu';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { createWebGPURenderer } from '@voluma/vlam';
import { StreamedSplatMesh, isAbortError } from '@voluma/vlam/streaming';
import { createCollisionWorld, type CollisionWorld } from './collision-world';

const EYE_HEIGHT = 1.7;
const COLLISION_RADIUS = 0.3;
const WALK_SPEED = 4;
const RUN_MULTIPLIER = 2;
const GRAVITY = 18;
const JUMP_SPEED = 5;
const GROUND_SNAP = 0.5;
const MAX_GROUND_DROP = 50;
const MAX_FALL_SPEED = 40;

const renderer = await createWebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1f);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 10000);
camera.position.set(-9.09, 1.65, 8.85);
camera.lookAt(-8.21, 1.67, 7.06);

const controls = new PointerLockControls(camera, renderer.domElement);
const enter = document.querySelector<HTMLButtonElement>('#enter')!;
const status = document.querySelector<HTMLElement>('#status')!;
const instructions = document.querySelector<HTMLElement>('#instructions')!;

const movementKeys = new Set<string>();
const movementCodes = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);
const runCodes = new Set(['ShiftLeft', 'ShiftRight']);
let jumpRequested = false;

const clearInput = (): void => {
  movementKeys.clear();
  jumpRequested = false;
};

window.addEventListener('keydown', (event) => {
  if (!controls.isLocked) return;
  if (movementCodes.has(event.code) || runCodes.has(event.code)) movementKeys.add(event.code);
  if (event.code === 'Space' && !event.repeat) jumpRequested = true;
  if (movementCodes.has(event.code) || runCodes.has(event.code) || event.code === 'Space') {
    event.preventDefault();
  }
});
window.addEventListener('keyup', (event) => movementKeys.delete(event.code));
window.addEventListener('blur', clearInput);
document.addEventListener('visibilitychange', clearInput);

const lock = (): void => controls.lock();
enter.addEventListener('click', lock);
renderer.domElement.addEventListener('click', lock);
controls.addEventListener('lock', () => {
  enter.hidden = true;
  instructions.textContent = 'WASD move · Shift run · Space jump · Esc release';
});
controls.addEventListener('unlock', () => {
  clearInput();
  enter.hidden = false;
  enter.textContent = 'Continue walking';
  instructions.textContent = 'Click to capture the mouse';
});

const splats = await StreamedSplatMesh.load('/remote/jack/v/Dehaar/Dehaar.lcc2');
scene.add(splats);
splats.updateWorldMatrix(true, false);

let collisionWorld: CollisionWorld | null = null;
let collisionFailure: string | null = null;
let grounded = false;
let verticalVelocity = 0;
let walkStarted = false;
let disposed = false;
const collisionAbort = new AbortController();

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const movement = new THREE.Vector3();
const previousPosition = new THREE.Vector3();

const attachCollision = async (): Promise<void> => {
  try {
    const tiles = await splats.loadCollisionMeshes({ signal: collisionAbort.signal });
    if (disposed) return;
    if (tiles.length === 0) {
      collisionFailure = 'This capture has no collision geometry.';
      return;
    }
    collisionWorld = createCollisionWorld(tiles, splats.matrixWorld, {
      buildOrderOrigin: camera.position,
    });
  } catch (error: unknown) {
    if (isAbortError(error)) return;
    collisionFailure = 'Collision geometry could not be loaded.';
    console.warn(collisionFailure, error);
  }
};
void attachCollision();

const startWalking = (world: CollisionWorld): void => {
  world.depenetrate(camera.position, COLLISION_RADIUS);
  const ground = world.groundDistance(camera.position, MAX_GROUND_DROP);
  if (ground !== null) camera.position.y += EYE_HEIGHT - ground;
  grounded = ground !== null;
  verticalVelocity = 0;
  walkStarted = true;
};

const updateWalking = (elapsed: number): void => {
  const world = collisionWorld;
  if (!world?.ready) return;
  if (!walkStarted) startWalking(world);

  previousPosition.copy(camera.position);
  movement.set(0, 0, 0);
  if (controls.isLocked) {
    forward.set(0, 0, -1).transformDirection(camera.matrixWorld).setY(0);
    if (forward.lengthSq() < 1e-8) {
      forward.set(0, 1, 0).transformDirection(camera.matrixWorld).setY(0);
    }
    forward.normalize();
    right.set(1, 0, 0).transformDirection(camera.matrixWorld).setY(0).normalize();

    if (movementKeys.has('KeyW')) movement.add(forward);
    if (movementKeys.has('KeyS')) movement.sub(forward);
    if (movementKeys.has('KeyA')) movement.sub(right);
    if (movementKeys.has('KeyD')) movement.add(right);
    if (jumpRequested && grounded) {
      verticalVelocity = JUMP_SPEED;
      grounded = false;
    }
  }
  jumpRequested = false;

  if (movement.lengthSq() > 0) {
    const running = movementKeys.has('ShiftLeft') || movementKeys.has('ShiftRight');
    const speed = WALK_SPEED * (running ? RUN_MULTIPLIER : 1);
    movement.normalize().multiplyScalar(speed * elapsed);
    world.moveSphere(camera.position, movement, COLLISION_RADIUS);
  }

  const ground = world.groundDistance(camera.position, MAX_GROUND_DROP);
  if (ground === null) {
    // Collision covers only the reconstructed walkable area. Hover over gaps
    // instead of falling forever outside the available mesh.
    verticalVelocity = 0;
    grounded = false;
  } else if (verticalVelocity <= 0 && ground <= EYE_HEIGHT + GROUND_SNAP) {
    const correction = EYE_HEIGHT - ground;
    if (Math.abs(correction) > 1e-3) camera.position.y += correction;
    verticalVelocity = 0;
    grounded = true;
  } else {
    grounded = false;
    verticalVelocity = Math.max(verticalVelocity - GRAVITY * elapsed, -MAX_FALL_SPEED);
    const fall = verticalVelocity * elapsed;
    if (fall < 0 && ground + fall < EYE_HEIGHT) {
      camera.position.y += EYE_HEIGHT - ground;
      verticalVelocity = 0;
      grounded = true;
    } else {
      camera.position.y += fall;
      world.depenetrate(camera.position, COLLISION_RADIUS);
    }
  }

  if (camera.position.distanceToSquared(previousPosition) > 1e-8) {
    camera.updateMatrixWorld();
  }
};

let lastStatus = '';
const updateStatus = (): void => {
  const next = collisionFailure
    ? collisionFailure
    : collisionWorld
      ? collisionWorld.ready
        ? `Collision ready · ${collisionWorld.builtCount}/${collisionWorld.tileCount} tiles indexed`
        : `Building collision · 0/${collisionWorld.tileCount} tiles indexed`
      : 'Loading collision geometry…';
  if (next === lastStatus) return;
  status.textContent = next;
  lastStatus = next;
};

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let lastTime = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const elapsed = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  updateWalking(elapsed);
  updateStatus();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});

window.addEventListener('pagehide', () => {
  disposed = true;
  collisionAbort.abort();
  renderer.setAnimationLoop(null);
  controls.dispose();
  collisionWorld?.dispose();
  splats.dispose();
  renderer.dispose();
});
