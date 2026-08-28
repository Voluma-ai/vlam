// Example: site/examples/annotations.md - HTML labels pinned to points on the
// capture, tracking the camera and hiding when the capture covers them.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createSplatRenderer } from '@voluma/vlam';
import { loadScene } from '@voluma/vlam/loaders';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0.9, 0.3, 1.7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const splats = new SplatMesh(await loadScene('/goose.sog'));
scene.add(splats);

const layer = document.querySelector<HTMLElement>('#labels')!;

interface Annotation {
  /** Where it is pinned, in world space. */
  point: THREE.Vector3;
  element: HTMLElement;
  /** Last occlusion verdict; updated by the round-robin check below. */
  hidden: boolean;
}

const annotations: Annotation[] = [];

function addAnnotation(point: THREE.Vector3, text: string): void {
  const element = document.createElement('div');
  element.className = 'label';
  element.textContent = text;
  layer.appendChild(element);
  annotations.push({ point: point.clone(), element, hidden: false });
}

// Click the capture to pin a label to whatever is under the cursor.
renderer.domElement.addEventListener('pointerdown', (event) => {
  const ndc = new THREE.Vector2(
    (event.clientX / innerWidth) * 2 - 1,
    -(event.clientY / innerHeight) * 2 + 1,
  );
  void splats.pick(ndc, camera, renderer, { alphaThreshold: 0.1 }).then((hit) => {
    if (hit) addAnnotation(hit.point, `Point ${annotations.length + 1}`);
  });
});

const projected = new THREE.Vector3();

/**
 * Screen position for a world point. `project` gives normalized device
 * coordinates; z > 1 means the point is behind the camera, where the x/y it
 * returns are mirrored nonsense.
 */
function toScreen(point: THREE.Vector3): { x: number; y: number; behind: boolean } {
  projected.copy(point).project(camera);
  return {
    x: (projected.x * 0.5 + 0.5) * innerWidth,
    y: (-projected.y * 0.5 + 0.5) * innerHeight,
    behind: projected.z > 1,
  };
}

// Occlusion, one label per frame. A pick costs a GPU round-trip, so testing
// every label every frame would be wasteful - and labels do not need to
// respond faster than the eye notices. With ten labels at 60fps each is
// rechecked six times a second, which reads as instant.
let nextToCheck = 0;
let checkInFlight = false;

function checkOneForOcclusion(): void {
  if (checkInFlight || annotations.length === 0) return;
  const annotation = annotations[nextToCheck % annotations.length];
  nextToCheck++;
  if (!annotation) return;

  const screen = toScreen(annotation.point);
  if (screen.behind) return;

  const ndc = new THREE.Vector2((screen.x / innerWidth) * 2 - 1, -(screen.y / innerHeight) * 2 + 1);
  checkInFlight = true;
  void splats
    .pick(ndc, camera, renderer, { alphaThreshold: 0.1 })
    .then((hit) => {
      // Something solid in front of the pinned point means the capture is
      // covering it. The tolerance keeps the label's own surface from
      // occluding itself.
      const distance = camera.position.distanceTo(annotation.point);
      annotation.hidden = hit !== null && hit.distance < distance - 0.02;
    })
    .finally(() => {
      checkInFlight = false;
    });
}

function positionLabels(): void {
  for (const annotation of annotations) {
    const screen = toScreen(annotation.point);
    const visible = !screen.behind && !annotation.hidden;
    annotation.element.style.opacity = visible ? '1' : '0';
    // Keep transform updates even while hidden, so a label fading back in is
    // already in the right place.
    annotation.element.style.transform = `translate(-50%, -50%) translate(${screen.x}px, ${screen.y}px)`;
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);

  // After the render: the camera matrices used for projection are then the
  // same ones the frame was drawn with, so labels cannot lag by a frame.
  positionLabels();
  checkOneForOcclusion();
});
