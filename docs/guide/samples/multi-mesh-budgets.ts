// Guide sample: docs/guide/multi-mesh-budgets.md - one main scene plus four
// `.rad` markers sharing a single splat budget, reweighted from the camera so
// the marker you fly up to gets the detail.
import * as THREE from 'three/webgpu';
import { CameraBudgetGovernor, StreamedSplatMesh, estimateSplatPoolBytes } from '@voluma/vlam';

const TOTAL_BUDGET = 4_000_000;
/** Per-marker ceiling: ~1.5x a marker's fair share, not the whole total. */
const MARKER_CEILING = 1_500_000;

const MARKERS = [
  { url: '/markers/a.rad', position: new THREE.Vector3(120, 0, 0) },
  { url: '/markers/b.rad', position: new THREE.Vector3(-120, 0, 0) },
  { url: '/markers/c.rad', position: new THREE.Vector3(0, 0, 120) },
  { url: '/markers/d.rad', position: new THREE.Vector3(0, 0, -120) },
];

export async function openMarkerScene(scene: THREE.Scene) {
  // Price the ceilings before committing to them: pools are allocated from the
  // ceiling and never shrink, so this is the memory floor of the whole setup -
  // the shared budget does not change it.
  const envelope =
    estimateSplatPoolBytes(TOTAL_BUDGET) + MARKERS.length * estimateSplatPoolBytes(MARKER_CEILING);
  console.log(`pool envelope ≈ ${Math.round(envelope / 1e6)} MB`);

  const main = await StreamedSplatMesh.load('/city/lod-meta.json');
  scene.add(main);

  const markers = await Promise.all(
    MARKERS.map(async ({ url, position }) => {
      const marker = await StreamedSplatMesh.load(url, {
        // Start at a fair share…
        budget: TOTAL_BUDGET / (MARKERS.length + 1),
        // …but reserve pool rows for the share a focused marker will receive.
        // Without this the mesh can only ever be shrunk below its start budget,
        // and the near marker stays coarse however close the camera gets.
        maxBudget: MARKER_CEILING,
      });
      marker.position.copy(position);
      scene.add(marker);
      return marker;
    }),
  );

  const governor = new CameraBudgetGovernor({ totalBudget: TOTAL_BUDGET });
  // The main scene holds a steady share; markers compete for the rest.
  governor.register(main, { fixedWeight: 4 });
  for (const marker of markers) governor.register(marker);

  return { main, markers, governor };
}

export function renderLoop(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  meshes: StreamedSplatMesh[],
  governor: CameraBudgetGovernor,
) {
  renderer.setAnimationLoop(() => {
    // Reweight first, so each mesh's update sees the budget it should be at.
    // Throttled internally (250 ms by default) - calling it every frame is fine.
    governor.update(camera);
    for (const mesh of meshes) mesh.update(camera, renderer);
    renderer.render(scene, camera);
  });
}

/** Spark's focus tiers, applied on selection. Takes effect on the next update. */
export function focusMarker(
  governor: CameraBudgetGovernor,
  markers: StreamedSplatMesh[],
  focused: StreamedSplatMesh,
) {
  for (const marker of markers) {
    governor.setPriority(marker, marker === focused ? 2 : 0.25);
    // For a `.rad` page-table marker, Spark's own knob is available too: it
    // sharpens the frontier cut rather than the budget that feeds it.
    marker.lodScale = marker === focused ? 1.5 : 1;
  }
}

/** What to read when checking that a near marker really did get more detail. */
export function reportShares(governor: CameraBudgetGovernor, markers: StreamedSplatMesh[]) {
  return markers.map((marker) => ({
    weight: governor.weightOf(marker),
    budget: marker.budget,
    ceiling: marker.maxBudget,
    // The number that decides how deep the `.rad` frontier descends.
    drawBudget: marker.drawBudget,
    drawn: marker.activeSplatCount,
  }));
}
