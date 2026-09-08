import * as THREE from 'three/webgpu';
import type { SplatMesh } from '../../core/splat-mesh';

/** Public frame preparation against a renderer boundary, without submitting GPU sorts. */
export function updateMesh(
  mesh: SplatMesh,
  copyTextureToTexture: THREE.WebGPURenderer['copyTextureToTexture'] = () => {},
): void {
  // Only the renderer boundary is mocked; uploads and mesh lifecycle run normally.
  const renderer = {
    backend: { isWebGPUBackend: true },
    getDrawingBufferSize: (size: THREE.Vector2) => size.set(640, 480),
    copyTextureToTexture,
  } as unknown as THREE.WebGPURenderer;
  mesh.update(new THREE.PerspectiveCamera(60, 640 / 480, 0.1, 1000), renderer, { sort: false });
}
