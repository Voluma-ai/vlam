// Guide sample: docs/guide/dynamic-splats.md - a rigged splat from a
// `KHR_gaussian_splatting` glTF, its clips played the way their hints ask.
// Experimental: `@voluma/vlam/dynamic`.
import * as THREE from 'three/webgpu';
import { loadSplatGltf, type SplatGltfClipHints } from '@voluma/vlam/dynamic';

export async function addRiggedSplat(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  url: string,
) {
  // Skinned primitives come back as SkinnedSplatMeshes bound to the file's skeleton.
  const model = await loadSplatGltf(url);
  scene.add(model.scene);

  const mixer = new THREE.AnimationMixer(model.scene);
  /** Starts a clip by name, looped, repeated or played once as its hints say. */
  const play = (name: string): THREE.AnimationAction | null => {
    const clip = THREE.AnimationClip.findByName(model.animations, name);
    if (!clip) return null;
    const action = mixer.clipAction(clip);
    const hints = (clip.userData as { vlam?: SplatGltfClipHints }).vlam ?? {};
    if (hints.loop === 'once') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, hints.repetitions ?? Infinity);
    }
    // Additive clips are already additive: they layer on top of the others.
    return action.reset().play();
  };
  play('idle');

  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    mixer.update(timer.getDelta());
    // Each update reads the bones into the skin.
    for (const mesh of model.meshes) mesh.update(camera, renderer);
    renderer.render(scene, camera);
  });
  return { model, mixer, play };
}
