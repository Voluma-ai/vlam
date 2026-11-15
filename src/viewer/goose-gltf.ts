/**
 * The procedural goose as a skinned `KHR_gaussian_splatting` glTF: its
 * splats in the folded rest pose, its skeleton, and its clips sampled into
 * bone animations, so any glTF player (an `AnimationMixer`, a Voluma model
 * marker's clip slider) can play it and `loadSplatGltf` turns it back into a
 * rigged splat.
 *
 * Clips: `look`, `wag` (one wag, hinted to repeat five times), `flap`,
 * `honk` (written absolute, hinted additive) and `idle`, the whole
 * {@link GooseChoreography} schedule baked into one 9-second loop for players
 * that play one clip at a time.
 *
 * Lighting is baked into the colors: the rig's in-shader relighting and
 * grazing sheen (`goose-rig.ts`) are not in the file.
 */
import * as THREE from 'three/webgpu';
import {
  GOOSE_CHOREOGRAPHY_PERIOD,
  GOOSE_WAGS,
  GooseChoreography,
  GoosePuppet,
  createGooseClips,
} from './goose-clips';
import { createProceduralGoose, gooseBoneMatrices } from './goose-procedural';
import {
  writeSplatGlb,
  type SplatGlbAnimation,
  type SplatGlbClipHints,
} from '../tools/splat-gltf/write-splat-glb';

/** Keyframes per second the clips are sampled at, as they were authored. */
const FPS = 30;
/** Fewest keys a clip gets (the one-wag clip is a third of a second). */
const MIN_KEYS = 20;

const HINTS: Record<string, SplatGlbClipHints> = {
  look: { loop: 'repeat' },
  wag: { loop: 'repeat', repetitions: GOOSE_WAGS },
  flap: { loop: 'once' },
  honk: { loop: 'once', additive: true },
  idle: { loop: 'repeat' },
};

/** Key times over `duration` seconds, both ends included. */
function keyTimes(duration: number): number[] {
  const steps = Math.max(MIN_KEYS - 1, Math.round(duration * FPS));
  return Array.from({ length: steps + 1 }, (_, i) => (i / steps) * duration);
}

/** Samples one clip on its own, from the rest pose, into bone poses. */
function sampleClip(clip: THREE.AnimationClip): SplatGlbAnimation {
  const puppet = new GoosePuppet();
  const mixer = new THREE.AnimationMixer(puppet);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const times = keyTimes(clip.duration);
  const poses = times.map((t) => {
    action.time = t;
    mixer.update(0);
    // An additive clip lands on the rest pose: absolute values, as written.
    return gooseBoneMatrices(puppet);
  });
  mixer.uncacheRoot(puppet);
  return { name: clip.name, times, poses, hints: HINTS[clip.name] };
}

/** The whole schedule of {@link GooseChoreography}, sampled into one loop. */
function sampleIdle(): SplatGlbAnimation {
  const puppet = new GoosePuppet();
  const choreography = new GooseChoreography(puppet);
  const times = keyTimes(GOOSE_CHOREOGRAPHY_PERIOD);
  const poses = times.map((t) => {
    // The last key closes the loop on the first.
    choreography.seek(t >= GOOSE_CHOREOGRAPHY_PERIOD ? 0 : t);
    return gooseBoneMatrices(puppet);
  });
  return { name: 'idle', times, poses, hints: HINTS.idle };
}

/** The goose (without its ground patch) as `.glb` bytes. */
export function buildGooseGlb(options: { seed?: number } = {}): {
  glb: Uint8Array;
  splats: number;
  bones: number;
  clips: string[];
} {
  const goose = createProceduralGoose({ ground: false, seed: options.seed });
  const { data, rig } = goose;
  const weights = new Float32Array(data.count * 2);
  for (let i = 0; i < data.count; i++) {
    weights[i * 2] = rig.splatWeights[i]!;
    weights[i * 2 + 1] = 1 - rig.splatWeights[i]!;
  }
  const animations = [...createGooseClips().map(sampleClip), sampleIdle()];
  const glb = writeSplatGlb({
    data,
    name: 'goose',
    skin: { bonesPerSplat: 2, indices: rig.splatBones, weights },
    skeleton: { names: rig.bones, parents: rig.parents, world: rig.boneMatrices },
    animations,
    generator: 'VLAM! procedural goose',
  });
  return {
    glb,
    splats: data.count,
    bones: rig.bones.length,
    clips: animations.map((animation) => animation.name),
  };
}
