// Guide sample: docs/guide/picking-and-queries.md - GPU pick under the cursor.
import * as THREE from 'three/webgpu';
import type { SplatMesh } from '@voluma/vlam';

export async function onPointerDown(
  event: PointerEvent,
  splats: SplatMesh,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGPURenderer,
) {
  const ndc = new THREE.Vector2(
    (event.clientX / innerWidth) * 2 - 1,
    -(event.clientY / innerHeight) * 2 + 1,
  );
  // Async one-pixel GPU depth pass; follows what is actually drawn
  // (modifiers, streamed LOD included). Null on a miss - never a throw.
  const hit = await splats.pick(ndc, camera, renderer, { alphaThreshold: 0.1 });
  if (hit) {
    // hit.point is world space; hit.distance is camera → point.
    console.log('picked', hit.point, hit.distance);
  }
}
