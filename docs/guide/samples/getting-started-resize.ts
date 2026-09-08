// Guide sample: docs/guide/getting-started.md - viewport resize.
import * as THREE from 'three/webgpu';

export function resizeRenderer(
  renderer: THREE.WebGPURenderer,
  camera: THREE.PerspectiveCamera,
): void {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
