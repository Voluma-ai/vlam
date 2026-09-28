// Example: site/examples/in-vr.md - room-scale Goose with controller locomotion.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  SplatMesh,
  createWebGPURenderer,
  recommendedXrFramebufferScale,
  xrSessionInit,
} from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';

const button = document.querySelector<HTMLButtonElement>('#enter-vr')!;
const status = document.querySelector<HTMLElement>('#status')!;
const webgpu = new URLSearchParams(location.search).get('backend') === 'webgpu';
const renderer = await createWebGPURenderer(
  webgpu ? { requireWebGpu: true } : { forceWebGL: true },
);
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
if (!webgpu) renderer.xr.setFramebufferScaleFactor(recommendedXrFramebufferScale());
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x182331);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 2.7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
const rig = new THREE.Group();
scene.add(rig);

// Four floor pieces leave the pedestal footprint empty. Only these meshes
// are teleportable, so a hit on the pedestal can never become a destination.
const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x536776, roughness: 0.9 });
const floor = [
  { x: 0, z: -1.75, w: 6, d: 2.5 },
  { x: 0, z: 1.75, w: 6, d: 2.5 },
  { x: -1.75, z: 0, w: 2.5, d: 1 },
  { x: 1.75, z: 0, w: 2.5, d: 1 },
].map(({ x, z, w, d }) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), floorMaterial);
  mesh.position.set(x, -0.02, z);
  scene.add(mesh);
  return mesh;
});
const pedestal = new THREE.Mesh(
  new THREE.CylinderGeometry(0.42, 0.5, 0.7, 24),
  new THREE.MeshStandardMaterial({ color: 0x8d7766, roughness: 0.8 }),
);
pedestal.position.y = 0.35;
scene.add(pedestal);
scene.add(new THREE.HemisphereLight(0xffffff, 0x384455, 2));

const splats = new SplatMesh(await loadSplatData('/goose.sog'));
splats.position.y = 1.1;
scene.add(splats);

const marker = new THREE.Mesh(
  new THREE.RingGeometry(0.15, 0.2, 32),
  new THREE.MeshBasicMaterial({ color: 0x59edbd, side: THREE.DoubleSide }),
);
marker.rotation.x = -Math.PI / 2;
marker.visible = false;
scene.add(marker);

type ControllerState = {
  group: THREE.Group;
  ray: THREE.Line;
  source: XRInputSource | null;
  aiming: boolean;
  turnLatched: boolean;
};
const rayGeometry = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(),
  new THREE.Vector3(0, 0, -3),
]);
const rayMaterial = new THREE.LineBasicMaterial({ color: 0x79d8ff });
const controllers: ControllerState[] = [0, 1].map((index) => {
  const group = renderer.xr.getController(index);
  const ray = new THREE.Line(rayGeometry, rayMaterial);
  group.add(ray);
  rig.add(group);
  const state: ControllerState = { group, ray, source: null, aiming: false, turnLatched: false };
  group.addEventListener('connected', (event) => {
    state.source = (event as unknown as { data: XRInputSource }).data;
    ray.visible = true;
  });
  group.addEventListener('disconnected', () => {
    state.source = null;
    state.aiming = false;
    state.turnLatched = false;
    ray.visible = false;
    marker.visible = false;
  });
  group.addEventListener('selectstart', () => {
    state.aiming = true;
  });
  group.addEventListener('selectend', () => {
    if (state.aiming) {
      const destination = teleportDestination(state);
      if (destination) teleportTo(destination);
    }
    state.aiming = false;
    marker.visible = false;
  });
  ray.visible = false;
  return state;
});

const caster = new THREE.Raycaster();
const origin = new THREE.Vector3();
const direction = new THREE.Vector3();
const rotation = new THREE.Quaternion();
function teleportDestination(controller: ControllerState): THREE.Vector3 | null {
  if (!controller.source) return null;
  controller.group.getWorldPosition(origin);
  controller.group.getWorldQuaternion(rotation);
  direction.set(0, 0, -1).applyQuaternion(rotation);
  caster.set(origin, direction);
  caster.far = 3;
  const hit = caster
    .intersectObjects(floor, false)
    .find((candidate) => (candidate.face?.normal.y ?? 0) > 0.9);
  return hit?.point.clone() ?? null;
}
function currentHead(): THREE.Camera {
  renderer.xr.updateCamera(camera);
  return renderer.xr.getCamera();
}
function teleportTo(destination: THREE.Vector3): void {
  const head = currentHead().getWorldPosition(new THREE.Vector3());
  rig.position.x += destination.x - head.x;
  rig.position.z += destination.z - head.z;
  rig.updateMatrixWorld(true);
}
function snapTurn(angle: number): void {
  const before = currentHead().getWorldPosition(new THREE.Vector3());
  rig.rotateY(angle);
  rig.updateMatrixWorld(true);
  const after = currentHead().getWorldPosition(new THREE.Vector3());
  rig.position.add(before.sub(after));
  rig.updateMatrixWorld(true);
}

let desktopState: {
  parent: THREE.Object3D | null;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  up: THREE.Vector3;
  projection: THREE.Matrix4;
  projectionInverse: THREE.Matrix4;
  fov: number;
  aspect: number;
  near: number;
  far: number;
  zoom: number;
} | null = null;
let activeSession: XRSession | null = null;
let placementPending = false;
let entering = false;
let entryTask: Promise<void> | null = null;
let disposed = false;
renderer.xr.addEventListener('sessionstart', () => {
  rig.position.set(0, 0, 0);
  rig.quaternion.identity();
  rig.add(camera);
  controls.enabled = false;
  placementPending = true;
});
function restoreDesktop(): void {
  const saved = desktopState;
  if (!saved) return;
  camera.removeFromParent();
  saved.parent?.add(camera);
  camera.position.copy(saved.position);
  camera.quaternion.copy(saved.quaternion);
  camera.up.copy(saved.up);
  camera.fov = saved.fov;
  camera.aspect = saved.aspect;
  camera.near = saved.near;
  camera.far = saved.far;
  camera.zoom = saved.zoom;
  camera.projectionMatrix.copy(saved.projection);
  camera.projectionMatrixInverse.copy(saved.projectionInverse);
  camera.updateMatrixWorld(true);
  desktopState = null;
  rig.position.set(0, 0, 0);
  rig.quaternion.identity();
  marker.visible = false;
  for (const controller of controllers) {
    controller.aiming = false;
    controller.turnLatched = false;
    controller.source = null;
    controller.ray.visible = false;
  }
  controls.enabled = true;
  controls.update();
  resize();
  activeSession = null;
  placementPending = false;
  if (!disposed) {
    button.disabled = false;
    status.textContent = 'Session ended. You can enter again.';
  }
}
renderer.xr.addEventListener('sessionend', restoreDesktop);

if (!navigator.xr) {
  button.disabled = true;
  status.textContent = 'This browser has no WebXR support.';
} else {
  try {
    const supported = await navigator.xr.isSessionSupported('immersive-vr');
    button.disabled = !supported;
    status.textContent = supported
      ? 'Ready. Hold a trigger to aim; release to teleport.'
      : 'No VR headset is available to this browser.';
  } catch {
    button.disabled = true;
    status.textContent = 'Could not check VR support in this browser.';
  }
}
button.addEventListener('click', () => {
  if (entering || activeSession || !navigator.xr || disposed) return;
  entering = true;
  button.disabled = true;
  status.textContent = 'Opening VR…';
  entryTask = (async () => {
    try {
      const session = await navigator.xr!.requestSession(
        'immersive-vr',
        xrSessionInit(renderer, { requiredFeatures: ['local-floor'] }),
      );
      if (disposed) {
        await session.end();
        return;
      }
      activeSession = session;
      desktopState = {
        parent: camera.parent,
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone(),
        up: camera.up.clone(),
        projection: camera.projectionMatrix.clone(),
        projectionInverse: camera.projectionMatrixInverse.clone(),
        fov: camera.fov,
        aspect: camera.aspect,
        near: camera.near,
        far: camera.far,
        zoom: camera.zoom,
      };
      try {
        await renderer.xr.setSession(session);
      } catch (error) {
        await session.end().catch(() => {});
        restoreDesktop();
        throw error;
      }
      if (!disposed && activeSession === session && renderer.xr.isPresenting) {
        status.textContent =
          'In VR. Hold a trigger to aim, release to teleport; right stick turns.';
      }
    } catch (error) {
      if (!disposed) {
        activeSession = null;
        status.textContent =
          error instanceof Error
            ? 'Could not enter VR: ' + error.message
            : 'The VR session was denied or could not start.';
        button.disabled = false;
      }
    } finally {
      entering = false;
    }
  })();
});

function resize(): void {
  if (renderer.xr.isPresenting) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);
renderer.setAnimationLoop(() => {
  // Three restores the saved desktop loop while ending an XR session.
  if (disposed) return;
  if (renderer.xr.isPresenting) {
    const head = currentHead();
    if (placementPending) {
      const headLocal = head.getWorldPosition(new THREE.Vector3());
      rig.position.set(-headLocal.x, 0, -headLocal.z + 2.7);
      rig.updateMatrixWorld(true);
      placementPending = false;
    }
    marker.visible = false;
    for (const controller of controllers) {
      if (controller.aiming) {
        const destination = teleportDestination(controller);
        if (destination) {
          marker.position.copy(destination);
          marker.position.y = 0.02;
          marker.visible = true;
        }
      }
      const gamepad = controller.source?.gamepad;
      if (controller.source?.handedness !== 'right' || gamepad?.mapping !== 'xr-standard') {
        controller.turnLatched = false;
        continue;
      }
      const axis = gamepad.axes[2];
      if (axis === undefined || Math.abs(axis) < 0.25) {
        controller.turnLatched = false;
      } else if (Math.abs(axis) > 0.7 && !controller.turnLatched) {
        snapTurn((-Math.sign(axis) * Math.PI) / 6);
        controller.turnLatched = true;
      }
    }
  } else {
    controls.update();
  }
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  button.disabled = true;
  removeEventListener('resize', resize);
  // A pending request/setSession must finish before releasing its renderer.
  // The entry task handles rejection and closes a session granted after disposal.
  await entryTask;
  await activeSession?.end().catch(() => {}); // It may already have ended.
  renderer.xr.removeEventListener('sessionend', restoreDesktop);
  restoreDesktop();
  // End first: XRManager restores its saved animation loop on sessionend.
  await renderer.setAnimationLoop(null);
  controls.dispose();
  splats.dispose();
  for (const mesh of floor) mesh.geometry.dispose();
  floorMaterial.dispose();
  pedestal.geometry.dispose();
  (pedestal.material as THREE.Material).dispose();
  marker.geometry.dispose();
  (marker.material as THREE.Material).dispose();
  rayGeometry.dispose();
  rayMaterial.dispose();
  // r186 disposal is async; older Three typings still declare void.
  await Promise.resolve(renderer.dispose());
  renderer.domElement.remove();
}
addEventListener(
  'pagehide',
  () => {
    void dispose().catch((error: unknown) =>
      console.error('Could not close the VR example:', error),
    );
  },
  { once: true },
);
