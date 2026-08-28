// Guide sample: docs/guide/streaming-and-lod.md - open a streamed scene.
import * as THREE from 'three/webgpu';
import { StreamedSplatMesh } from '@voluma/vlam/streaming';

export async function openStreamed(scene: THREE.Scene, signal: AbortSignal) {
  const splats = await StreamedSplatMesh.load('/capture/lod-meta.json', {
    signal, // aborting rejects with AbortError and disposes the partial mesh
    baseUrl: document.baseURI, // relative manifest URLs resolve against this
    budget: 2_000_000, // active-splat cap; defaults to a per-device value
    lodBaseDistance: 10, // world units inside which the finest LOD is used
  });
  scene.add(splats);
  // Per frame, exactly like a static mesh:
  //   splats.update(camera, renderer); renderer.render(scene, camera);
  return splats;
}
