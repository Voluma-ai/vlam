// Guide sample: docs/guide/unified-rendering.md - unified pick with source
// identification, plus unified depth of field.
import * as THREE from 'three/webgpu';
import type { SplatMesh } from '@voluma/vlam';
import type { UnifiedSplatMesh } from '@voluma/vlam/unified';

export async function pickAcrossSources(
  unified: UnifiedSplatMesh,
  event: PointerEvent,
  camera: THREE.PerspectiveCamera,
  mainMesh: SplatMesh,
) {
  const ndc = new THREE.Vector2(
    (event.clientX / innerWidth) * 2 - 1,
    -(event.clientY / innerHeight) * 2 + 1,
  );
  // Every VISIBLE source runs its own depth pick; the hit nearest the camera
  // wins and names its source. Hidden sources never hit; null on a miss.
  const hit = await unified.pick(ndc, camera, { alphaThreshold: 0.1 });
  if (hit) {
    console.log(hit.source === mainMesh ? 'main scene' : 'other source', hit.point, hit.distance);
    // Rack the shared camera depth of field onto whatever was clicked -
    // a pure uniform write, applied at draw time across all sources.
    unified.setDepthOfField({ focusDistance: hit.distance, aperture: 0.02 });
  }
}
