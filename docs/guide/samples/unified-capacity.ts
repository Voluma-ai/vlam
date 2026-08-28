// Guide sample: docs/guide/unified-rendering.md - capacity planning against
// the device's storage-buffer bind limit.
import * as THREE from 'three/webgpu';
import { deviceMaxStorageBufferBindingSize, recommendedWebGpuRequiredLimits } from '@voluma/vlam';
import { UnifiedSplatRenderer, estimateLargestStorageBufferBytes } from '@voluma/vlam/unified';

export async function createRendererAndUnified(capacity: number) {
  // Ask for the adapter's advertised limits up front: unified work buffers
  // need 16 B/splat of storage, so capacities above ~8M splats exceed
  // WebGPU's default 128 MiB maxStorageBufferBindingSize. `createSplatRenderer()`
  // does this for you - the adapter is requested by hand here only because the
  // pre-flight check below wants the handle.
  const adapter = await navigator.gpu?.requestAdapter();
  const renderer = new THREE.WebGPURenderer({
    ...(adapter ? { requiredLimits: recommendedWebGpuRequiredLimits(adapter) } : {}),
  });
  await renderer.init();

  // Optional pre-flight: how much storage would this capacity bind, and what
  // does the device allow? (The constructor performs this check itself and
  // throws a clear error instead of cascading GPUValidationErrors.)
  const needed = estimateLargestStorageBufferBytes(capacity);
  const allowed = deviceMaxStorageBufferBindingSize(renderer);
  console.log(`need ${needed} B of ${allowed} B allowed`);

  const unified = new UnifiedSplatRenderer(renderer, capacity, { srgbOutput: false });
  return { renderer, unified };
}
