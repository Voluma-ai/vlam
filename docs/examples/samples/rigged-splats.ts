// Example: site/examples/rigged-splats.md - a rigged splat character from a
// `KHR_gaussian_splatting` glTF, its skeleton and clips under an
// AnimationMixer: three loops cross-faded, a jump and a laugh played once in
// their place, and a wave added on top of whatever else plays.
// Experimental: `@voluma/vlam/dynamic` may change in a minor release.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createWebGPURenderer } from '@voluma/vlam';
import { SkinnedSplatMesh, loadSplatGltf } from '@voluma/vlam/dynamic';

const status = document.querySelector<HTMLElement>('#status')!;
const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;
const speed = document.querySelector<HTMLSelectElement>('#speed')!;

const renderer = await createWebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x1a1a1f);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 100);
camera.position.set(3.6, 1.4, 1.9);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.95, 0);
controls.enableDamping = true;

// 1. The character: Santa Claus, 1.9 m tall, its splats skinned to a
// 19-bone skeleton. The file stores them compressed
// (EXT_meshopt_compression), so the loader gets a meshopt decoder. A skinned
// splat primitive comes back as a SkinnedSplatMesh bound to the file's
// skeleton, in glTF axes (y up), so nothing needs turning. The file is 20 MB;
// its host sends CORS headers only to the VLAM docs site and its dev origin.
const model = await loadSplatGltf('https://storage.voluma.ai/shared/avatars/santa.glb', {
  loader: new GLTFLoader().setMeshoptDecoder(MeshoptDecoder),
});
scene.add(model.scene);
const santa = model.meshes.find((mesh) => mesh instanceof SkinnedSplatMesh)!;
status.textContent =
  `${santa.activeSplatCount.toLocaleString()} splats · ${santa.skeleton!.bones.length} bones · ` +
  `${model.animations.length} clips`;

// 2. The clips are the file's own animations: keyframe tracks on the bones,
// for a mixer rooted at the glTF's scene.
const mixer = new THREE.AnimationMixer(model.scene);
const clip = (name: string) => THREE.AnimationClip.findByName(model.animations, name)!;

// Three loops; one plays at a time.
const loops = {
  idle: mixer.clipAction(clip('idle')),
  walk: mixer.clipAction(clip('walk')),
  run: mixer.clipAction(clip('run')),
};
type Loop = keyof typeof loops;

// The jump and the laugh move the whole body and play once, in place of the
// loop. Clamped, they hold their last frame while the loop fades back in.
const once = (name: string) => {
  const action = mixer.clipAction(clip(name)).setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  return action;
};
const shots = { jump: once('jump'), laugh: once('laugh') };
type Shot = keyof typeof shots;

// The wave keys only the right arm, the spine, the neck and the head. The
// loops key those bones too, and a mixer averages actions that share a bone,
// so the wave is made additive: what it adds to its own first frame (the
// resting pose) goes on top of whichever loop plays, whose legs carry on.
const wave = mixer
  .clipAction(THREE.AnimationUtils.makeClipAdditive(clip('wave')))
  .setLoop(THREE.LoopOnce, 1);

// 3. Cross-fades blend two actions bone by bone, as for any skinned mesh.
let current: Loop = 'idle';
/** The jump or laugh that plays in place of the loop, if one does. */
let shot: THREE.AnimationAction | null = null;
loops.idle.play();
const fade = (from: THREE.AnimationAction, to: THREE.AnimationAction, seconds: number) => {
  to.reset().play();
  from.crossFadeTo(to, seconds, false);
};
const showCurrent = () => {
  for (const name of Object.keys(loops) as Loop[]) button(name).disabled = name === current;
};
for (const name of Object.keys(loops) as Loop[]) {
  button(name).onclick = () => {
    // During a jump or laugh the new loop only becomes the one to return to.
    if (!shot) fade(loops[current], loops[name], 0.4);
    current = name;
    showCurrent();
  };
}
showCurrent();

const showShots = () => {
  for (const name of Object.keys(shots) as Shot[]) button(name).disabled = shot !== null;
};
for (const name of Object.keys(shots) as Shot[]) {
  button(name).onclick = () => {
    shot = shots[name];
    showShots();
    fade(loops[current], shot, 0.15);
  };
}
mixer.addEventListener('finished', (event) => {
  if (event.action !== shot) return; // the wave finishes too
  fade(shot, loops[current], 0.25);
  shot = null;
  showShots();
});
button('wave').onclick = () => wave.reset().play();
speed.onchange = () => (mixer.timeScale = Number(speed.value));

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  mixer.update(timer.getDelta());
  controls.update();
  // Refreshes the bone texture from the skeleton, then sorts and draws.
  for (const mesh of model.meshes) mesh.update(camera, renderer);
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
