// Example: site/examples/surface-queries.md - drop objects onto the capture
// and measure between them, using the CPU spatial queries.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createWebGPURenderer } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';

const renderer = await createWebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0.8, 0.4, 1.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const splats = new SplatMesh(await loadSplatData('/goose.sog'));
scene.add(splats);

const readout = document.querySelector<HTMLElement>('#readout')!;
const markers: THREE.Vector3[] = [];

function addMarker(at: THREE.Vector3): void {
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.015),
    new THREE.MeshBasicNodeMaterial({ color: 0xff3366 }),
  );
  dot.position.copy(at);
  scene.add(dot);
  markers.push(at.clone());
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  const ndc = new THREE.Vector2(
    (event.clientX / innerWidth) * 2 - 1,
    -(event.clientY / innerHeight) * 2 + 1,
  );

  void splats.pick(ndc, camera, renderer, { alphaThreshold: 0.1 }).then((hit) => {
    if (!hit) return;

    // Start a little above the clicked point and ask what is underneath it.
    // `queryHeight` is a synchronous CPU query over the resident splat
    // centers - no GPU round-trip, so it is safe to call while dragging.
    const above = hit.point.clone().setY(hit.point.y + 0.05);
    const ground = splats.queryHeight(above, 0.3);

    // Null means nothing was sampled below: out of range, or a streamed
    // region whose chunks are not resident yet. Fall back to the pick.
    addMarker(ground ? ground.point : hit.point);

    // `queryNearest` answers a different question: the closest splat center
    // to a point, within a radius. Good for snapping and contact tests.
    const near = splats.queryNearest(hit.point, 0.05);

    const parts = [`${markers.length} marker(s)`];
    if (near) parts.push(`nearest splat ${near.distance.toFixed(3)} away`);
    if (markers.length >= 2) {
      const [a, b] = markers.slice(-2) as [THREE.Vector3, THREE.Vector3];
      parts.push(`last two ${a.distanceTo(b).toFixed(3)} apart`);
    }
    readout.textContent = parts.join(' · ');
  });
});

renderer.setAnimationLoop(() => {
  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
