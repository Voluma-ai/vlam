// Guide sample: docs/guide/loading-scenes.md - several whole-file scenes
// under one splat budget.
import * as THREE from 'three/webgpu';
import { SplatMesh } from '@voluma/vlam';
import { loadSplatData, SplatSceneBudget } from '@voluma/vlam/loaders';
import { UnifiedSplatMesh } from '@voluma/vlam/unified';

export async function loadBudgetedScene(renderer: THREE.WebGPURenderer, scene: THREE.Scene) {
  // The device's default, at most 2²⁴. Pass `{ total }` to tighten it.
  const sceneBudget = new SplatSceneBudget();
  const urls = ['/castle.sog', '/garden.sog', '/statue.ply'];
  // Optional: split the budget by each file's header count before loading.
  // Without it, each file takes whatever is still free when it arrives.
  await sceneBudget.plan(urls);

  const meshes = await Promise.all(
    urls.map(async (url) => new SplatMesh(await loadSplatData(url, { sceneBudget }))),
  );

  // The budget never exceeds what one unified draw can address.
  const unified = new UnifiedSplatMesh(renderer, sceneBudget.total);
  for (const mesh of meshes) unified.addSource(mesh);
  scene.add(unified);
  return { unified, meshes };
}
