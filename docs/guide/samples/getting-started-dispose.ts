// Guide sample: docs/guide/getting-started.md - teardown.
import * as THREE from 'three/webgpu';
import type { SplatMesh } from '@voluma/vlam';

export function teardown(scene: THREE.Scene, renderer: THREE.WebGPURenderer, splats: SplatMesh) {
  renderer.setAnimationLoop(null);
  scene.remove(splats);
  splats.dispose(); // frees pool textures, sorter buffers, pick resources
  renderer.dispose();
}
