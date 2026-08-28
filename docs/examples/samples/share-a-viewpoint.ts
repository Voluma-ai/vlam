// Example: site/examples/share-a-viewpoint.md - camera pose in the URL, and
// an eased flight between saved viewpoints.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createSplatRenderer } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const splats = new SplatMesh(await loadSplatData('/goose.sog'));
scene.add(splats);

interface Viewpoint {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

const DEFAULT_VIEW: Viewpoint = {
  position: new THREE.Vector3(0.9, 0.3, 1.7),
  target: new THREE.Vector3(0, 0, 0),
};

/** Six numbers, three decimals each - short enough to paste into a chat. */
function encode(view: Viewpoint): string {
  return [...view.position.toArray(), ...view.target.toArray()].map((n) => n.toFixed(3)).join(',');
}

/**
 * Parse defensively: a URL is user input, and a hand-edited or truncated one
 * must fall back rather than leave the camera at NaN, which renders nothing
 * and looks like a broken scene.
 */
function decode(value: string | null): Viewpoint | null {
  if (!value) return null;
  const n = value.split(',').map(Number);
  if (n.length !== 6 || n.some((v) => !Number.isFinite(v))) return null;
  return {
    position: new THREE.Vector3(n[0], n[1], n[2]),
    target: new THREE.Vector3(n[3], n[4], n[5]),
  };
}

function applyViewpoint(view: Viewpoint): void {
  camera.position.copy(view.position);
  controls.target.copy(view.target);
  controls.update();
}

// Open the page with ?view=… and you land exactly where the link was made.
applyViewpoint(decode(new URLSearchParams(location.search).get('view')) ?? DEFAULT_VIEW);

const status = document.querySelector<HTMLElement>('#status')!;

document.querySelector<HTMLButtonElement>('#copy')!.addEventListener('click', () => {
  const url = new URL(location.href);
  url.searchParams.set('view', encode({ position: camera.position, target: controls.target }));
  // replaceState, not assignment: updating the address bar must not reload
  // the page and throw away the capture you already downloaded.
  history.replaceState(null, '', url);
  void navigator.clipboard.writeText(url.href).then(
    () => (status.textContent = 'Link copied - it opens on this exact view.'),
    () => (status.textContent = `Copy failed; the address bar holds the link.`),
  );
});

// --- A tour: eased flight between viewpoints -------------------------------

const TOUR: Viewpoint[] = [
  DEFAULT_VIEW,
  { position: new THREE.Vector3(-1.2, 0.5, 0.9), target: new THREE.Vector3(-0.1, 0.1, 0) },
  { position: new THREE.Vector3(0.2, 0.9, 1.1), target: new THREE.Vector3(0, 0.2, 0) },
];

let flight: { from: Viewpoint; to: Viewpoint; startedAt: number } | null = null;
let leg = 0;

/** Ease in and out, so the move starts and stops gently instead of snapping. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function flyTo(to: Viewpoint): void {
  flight = {
    from: { position: camera.position.clone(), target: controls.target.clone() },
    to,
    startedAt: performance.now(),
  };
}

document.querySelector<HTMLButtonElement>('#tour')!.addEventListener('click', () => {
  leg = (leg + 1) % TOUR.length;
  flyTo(TOUR[leg] as Viewpoint);
  status.textContent = `Flying to viewpoint ${leg + 1} of ${TOUR.length}…`;
});

const FLIGHT_MS = 1400;

renderer.setAnimationLoop(() => {
  if (flight) {
    const t = Math.min(1, (performance.now() - flight.startedAt) / FLIGHT_MS);
    const eased = easeInOut(t);
    // Interpolating position and target separately keeps the subject in frame
    // through the move - the camera swings around it rather than past it.
    camera.position.lerpVectors(flight.from.position, flight.to.position, eased);
    controls.target.lerpVectors(flight.from.target, flight.to.target, eased);
    if (t === 1) {
      flight = null;
      status.textContent = 'Arrived. Copy the link to share this view.';
    }
  }

  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
