/**
 * Where the demo effects that stand something in the scene (the `4dgs`
 * dancers, the `rigged` goose) put it: a known spot in scenes the demo ships
 * with, else the middle of the scene's floor. Kept apart from those effects so
 * each lazy chunk imports only this.
 */
import * as THREE from 'three/webgpu';
import type { SplatMesh } from '../lib/core';

/**
 * The stage's center (feet height) in known scenes, keyed by scene file name.
 * Tempel: under the VLAM! mark's placement point, a little above the
 * courtyard floor (y ≈ -0.36) so legs clear the planted bed in the middle.
 */
const STAGE_PLACEMENTS: Readonly<Record<string, readonly [number, number, number]>> = {
  'Tempel.lcc2': [-0.42, 0, -23.3],
};

/** The stage's center for `sceneTitle`, in world space. */
export function sceneStageCenter(sceneTitle: string, splats: SplatMesh): THREE.Vector3 {
  const preset = STAGE_PLACEMENTS[sceneTitle];
  if (preset) return new THREE.Vector3(...preset);
  const bounds = splats.computeSplatBounds().clone().applyMatrix4(splats.matrixWorld);
  const middle = bounds.getCenter(new THREE.Vector3());
  return new THREE.Vector3(middle.x, bounds.min.y, middle.z);
}
