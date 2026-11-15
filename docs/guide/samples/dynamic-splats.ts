// Guide sample: docs/guide/dynamic-splats.md - several 4DGS clips in a
// captured scene, depth-sorted with it in one unified draw (WebGPU), sharing
// one staging budget. Experimental: `@voluma/vlam/dynamic`.
import * as THREE from 'three/webgpu';
import type { SplatMesh } from '@voluma/vlam';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '@voluma/vlam/unified';
import { SplatClipMesh, SplatClipStagingBudget, loadSplatClip } from '@voluma/vlam/dynamic';

export async function addDancers(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  capture: SplatMesh,
  clipUrls: readonly string[],
) {
  // Each clip decodes in its own worker, so they load in parallel.
  const clips = await Promise.all(clipUrls.map((url) => loadSplatClip(url)));
  // Their sections tend to end together: one upload budget per frame for all.
  const staging = new SplatClipStagingBudget(4 * 1024 * 1024);
  const view = capture.getUnifiedSourceView();
  const meshes = clips.map((clip, i) => {
    const mesh = new SplatClipMesh(clip, {
      renderer,
      staging,
      // A unified draw needs every source's draw settings to agree.
      srgbOutput: view.srgbOutput,
      minPixelSize: view.minPixelSize,
      minContribution: view.minContribution,
    });
    mesh.position.set(i * 0.8, 0, 0);
    scene.add(mesh); // the unified draw reads its world matrix
    return mesh;
  });

  // One mixer per clip; offset each action so the dancers are out of step.
  const mixers = meshes.map((mesh, i) => {
    const mixer = new THREE.AnimationMixer(mesh);
    const action = mixer.clipAction(mesh.animation);
    action.time = i * 0.3;
    action.play();
    return mixer;
  });

  let unified: UnifiedSplatMesh | null = null;
  if (supportsUnifiedSplatMesh(renderer)) {
    const capacity = meshes.reduce((sum, mesh) => sum + mesh.capacity, capture.capacity);
    unified = new UnifiedSplatMesh(renderer, capacity);
    unified.addSource(capture);
    // Default registration (no `cacheModifiers`): the clips re-gather every
    // frame and re-sort on their own sort-displacement revision.
    for (const mesh of meshes) unified.addSource(mesh);
    scene.add(unified);
  } else {
    // WebGL2: standalone draws, the clips over the capture.
    for (const mesh of meshes) mesh.renderOrder = 1;
  }

  // Per frame: advance the mixers, then update. The unified draw updates its
  // sources (the clips included) itself.
  return (camera: THREE.PerspectiveCamera, delta: number) => {
    for (const mixer of mixers) mixer.update(delta);
    if (unified) unified.update(camera);
    else for (const mesh of [capture, ...meshes]) mesh.update(camera, renderer);
  };
}
