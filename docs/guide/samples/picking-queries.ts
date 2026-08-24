// Guide sample: docs/guide/picking-and-queries.md - synchronous CPU queries
// over the resident splat centers (no GPU round-trip).
import * as THREE from 'three/webgpu';
import type { SplatMesh } from '@voluma/vlam';

export function probe(splats: SplatMesh, cameraPosition: THREE.Vector3) {
  // Nearest resident splat center within 0.5 world units - measurements,
  // proximity tests, contact points.
  const nearest = splats.queryNearest(cameraPosition, 0.5);
  if (nearest) console.log('surface at', nearest.point, 'distance', nearest.distance);

  // Floor probe: the highest splat at most 3 units below the point (world −Y).
  // Both queries take and return WORLD-space values, so they respect the
  // mesh's transform - including a moved/scaled mesh and the built-in y-up
  // orientation correction.
  const floor = splats.queryHeight(cameraPosition, 3);
  if (floor) {
    console.log(`ground ${floor.drop} below`, floor.point);
  } else {
    // Null means "no floor sampled here": out of range, or (on a streamed
    // mesh) a region whose chunks are not resident at the current LOD.
  }
}
