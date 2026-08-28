// Guide sample: docs/guide/multi-mesh-budgets.md - one main scene plus four
// additional `.rad` meshes sharing a single splat budget, reweighted from the
// camera so the mesh you fly up to gets the detail.
import * as THREE from 'three/webgpu';
import { estimateSplatPoolBytes } from '@voluma/vlam';
import { CameraBudgetGovernor, StreamedSplatMesh } from '@voluma/vlam/streaming';

const TOTAL_BUDGET = 4_000_000;
/** Per-mesh ceiling: ~1.5x an additional mesh's fair share, not the whole total. */
const EXTRA_CEILING = 1_500_000;

const EXTRAS = [
  { url: '/additional/a.rad', position: new THREE.Vector3(120, 0, 0) },
  { url: '/additional/b.rad', position: new THREE.Vector3(-120, 0, 0) },
  { url: '/additional/c.rad', position: new THREE.Vector3(0, 0, 120) },
  { url: '/additional/d.rad', position: new THREE.Vector3(0, 0, -120) },
];

export async function openMultiMeshScene(scene: THREE.Scene) {
  // Price the ceilings before committing to them: pools are allocated from the
  // ceiling and never shrink, so this is the memory floor of the whole setup -
  // the shared budget does not change it.
  const envelope =
    estimateSplatPoolBytes(TOTAL_BUDGET) + EXTRAS.length * estimateSplatPoolBytes(EXTRA_CEILING);
  console.log(`pool envelope ≈ ${Math.round(envelope / 1e6)} MB`);

  const main = await StreamedSplatMesh.load('/city/lod-meta.json');
  scene.add(main);

  const extras = await Promise.all(
    EXTRAS.map(async ({ url, position }) => {
      const extra = await StreamedSplatMesh.load(url, {
        // Start at a fair share…
        budget: TOTAL_BUDGET / (EXTRAS.length + 1),
        // …but reserve pool rows for the share a focused mesh will receive.
        // Without this the mesh can only ever be shrunk below its start budget,
        // and the near mesh stays coarse however close the camera gets.
        maxBudget: EXTRA_CEILING,
      });
      extra.position.copy(position);
      scene.add(extra);
      return extra;
    }),
  );

  const governor = new CameraBudgetGovernor({ totalBudget: TOTAL_BUDGET });
  // The main scene holds a steady share; additional meshes compete for the rest.
  governor.register(main, { fixedWeight: 4 });
  for (const extra of extras) governor.register(extra);

  return { main, extras, governor };
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
export function focusMesh(
  governor: CameraBudgetGovernor,
  meshes: StreamedSplatMesh[],
  focused: StreamedSplatMesh,
) {
  for (const mesh of meshes) {
    governor.setPriority(mesh, mesh === focused ? 2 : 0.25);
    // For a `.rad` page-table mesh, Spark's own knob is available too: it
    // sharpens the frontier cut rather than the budget that feeds it.
    mesh.lodScale = mesh === focused ? 1.5 : 1;
  }
}

/** What to read when checking that a near additional mesh really did get more detail. */
export function reportShares(governor: CameraBudgetGovernor, meshes: StreamedSplatMesh[]) {
  return meshes.map((mesh) => ({
    weight: governor.weightOf(mesh),
    budget: mesh.budget,
    ceiling: mesh.maxBudget,
    // The number that decides how deep the `.rad` frontier descends.
    drawBudget: mesh.drawBudget,
    drawn: mesh.activeSplatCount,
  }));
}
