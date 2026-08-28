// Guide sample: docs/guide/unified-rendering.md - one depth-correct draw
// over a static mesh and a streamed mesh (WebGPU only).
import * as THREE from 'three/webgpu';
import { SplatMesh } from '@voluma/vlam';
import { loadScene } from '@voluma/vlam/loaders';
import { StreamedSplatMesh } from '@voluma/vlam/streaming';
import { UnifiedSplatRenderer, supportsUnifiedSplatRenderer } from '@voluma/vlam/unified';

export async function setupUnified(renderer: THREE.WebGPURenderer, scene: THREE.Scene) {
  const main = await StreamedSplatMesh.load('/city/lod-meta.json');
  const statue = new SplatMesh(await loadScene('/statue.sog'));
  statue.position.set(4, 0, -2); // pose the SOURCE meshes, not the unified mesh

  // Check after renderer init: answers false on WebGL2 (and before the
  // backend exists). Fall back to standalone draws there.
  if (!supportsUnifiedSplatRenderer(renderer)) {
    scene.add(main, statue);
    return null;
  }

  const unified = new UnifiedSplatRenderer(renderer, main.capacity + statue.capacity);
  unified.addSource(main);
  unified.addSource(statue, { priority: 1, opacity: 0.8 });
  scene.add(unified); // add the unified mesh INSTEAD of the sources

  // Runtime control per source:
  unified.setSourceOpacity(statue, 0.5);
  unified.setSourceVisible(statue, false);
  unified.setSourceVisible(statue, true);

  // removeSource restores the source's standalone visibility and picking.
  //   unified.removeSource(statue); scene.add(statue);
  // dispose() does the same for every remaining source.

  // Each frame: unified.update(camera) before renderer.render(scene, camera).
  return unified;
}
