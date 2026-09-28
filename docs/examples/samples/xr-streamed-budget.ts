// Budget transitions for a streamed scene, separate from the fixed-size Goose example.
import type * as THREE from 'three/webgpu';
import { resolveXrSplatBudget } from '@voluma/vlam';
import type { StreamedSplatMesh } from '@voluma/vlam/streaming';

/** Returns a cleanup function to call before disposing the mesh. */
export function useXrBudget(renderer: THREE.WebGPURenderer, splats: StreamedSplatMesh): () => void {
  let pageBudget: number | undefined;
  const start = () => {
    if (pageBudget !== undefined) return;
    pageBudget = splats.budget;
    splats.setBudget(resolveXrSplatBudget(pageBudget));
  };
  const end = () => {
    if (pageBudget === undefined) return;
    splats.setBudget(pageBudget);
    pageBudget = undefined;
  };
  renderer.xr.addEventListener('sessionstart', start);
  renderer.xr.addEventListener('sessionend', end);
  if (renderer.xr.isPresenting) start();
  return () => {
    renderer.xr.removeEventListener('sessionstart', start);
    renderer.xr.removeEventListener('sessionend', end);
    end();
  };
}
