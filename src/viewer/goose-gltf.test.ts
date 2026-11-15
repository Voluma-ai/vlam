import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { SkinnedSplatMesh, loadSplatGltf } from '../lib/dynamic';
import { GoosePuppet, createGooseClips } from './goose-clips';
import { buildGooseGlb } from './goose-gltf';
import { createProceduralGoose } from './goose-procedural';
import { createGooseRig } from './goose-rig';

/** Largest distance between matching splat centers. */
function worstDistance(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i += 3) {
    worst = Math.max(
      worst,
      Math.hypot(a[i]! - b[i]!, a[i + 1]! - b[i + 1]!, a[i + 2]! - b[i + 2]!),
    );
  }
  return worst;
}

describe('goose-gltf', () => {
  it('plays the file the way the rig poses the goose', async () => {
    const { glb, clips } = buildGooseGlb();
    expect(clips).toEqual(['look', 'wag', 'flap', 'honk', 'idle']);
    const loaded = await loadSplatGltf(glb.buffer as ArrayBuffer);
    const mesh = loaded.meshes[0] as SkinnedSplatMesh;
    expect(mesh).toBeInstanceOf(SkinnedSplatMesh);
    const byName = (name: string) => THREE.AnimationClip.findByName(loaded.animations, name)!;
    expect(byName('wag').userData.vlam).toEqual({ loop: 'repeat', repetitions: 5 });
    expect(byName('honk').blendMode).toBe(THREE.AdditiveAnimationBlendMode);

    // The same goose, rigged live, posed by the same clips.
    const goose = createProceduralGoose({ ground: false });
    const rig = createGooseRig(goose);
    const source = Object.fromEntries(createGooseClips().map((clip) => [clip.name, clip]));
    const mixer = new THREE.AnimationMixer(loaded.scene);
    for (const [name, time] of [
      ['flap', 1.6],
      ['honk', 0.4],
      ['look', 3.1],
    ] as const) {
      const action = mixer.clipAction(byName(name));
      action.play();
      mixer.setTime(time);
      loaded.scene.updateMatrixWorld(true);
      const fromFile = mesh.posedSplatData().positions;

      const puppet = new GoosePuppet();
      const puppetMixer = new THREE.AnimationMixer(puppet);
      puppetMixer.clipAction(source[name]!).play();
      puppetMixer.setTime(time);
      rig.setPose(puppet);
      const live = rig.posedData().positions;
      // Keys every 1/30 s, interpolated per bone rather than per joint angle.
      expect(worstDistance(fromFile, live), name).toBeLessThan(4e-3);
      // And the pose is a real one, away from rest.
      expect(worstDistance(live, goose.data.positions), name).toBeGreaterThan(0.02);
      action.stop();
    }
    rig.mesh.dispose();
    mesh.dispose();
  }, 60_000);
});
