// Example: site/examples/play-4dgs-clip.md - play a 4D Gaussian splat clip
// (here Faltwerk `.csgs`) with the same transport as a glTF animation.
// Experimental: `@voluma/vlam/dynamic` may change in a minor release.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWebGPURenderer } from '@voluma/vlam';
import { SplatClipMesh, loadSplatClip } from '@voluma/vlam/dynamic';

const status = document.querySelector<HTMLElement>('#status')!;
const playButton = document.querySelector<HTMLButtonElement>('#play')!;
const scrub = document.querySelector<HTMLInputElement>('#scrub')!;
const speed = document.querySelector<HTMLSelectElement>('#speed')!;
const loop = document.querySelector<HTMLSelectElement>('#loop')!;

const renderer = await createWebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x1a1a1f);
document.body.appendChild(renderer.domElement);
// The mesh picks its playback path (GPU curves on WebGPU, worker frames on
// WebGL2) from the backend, so the renderer must be initialized first.
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 100);
camera.position.set(1.2, 0.8, 2.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);
controls.enableDamping = true;

// Any clip format VLAM reads; the format comes from the URL. The default is
// VLAM's goose walking in place, a Faltwerk `scene_*.json` next to its
// `.csgs` sections; `?clip=<url>` plays another.
const url = new URLSearchParams(location.search).get('clip') ?? '/goose-walk/scene_goose-walk.json';
const clip = await loadSplatClip(url, {
  onProgress: ({ message }) => (status.textContent = message),
});

// The clip says how many SH bands its frames carry; the pool follows.
const mesh = new SplatClipMesh(clip, { renderer });
mesh.addEventListener('error', ({ error }) => (status.textContent = String(error)));
scene.add(mesh);
status.textContent = `${clip.name} · ${clip.totalFrames} frames · ${mesh.playback} playback`;

// One track on `mesh.time`: play, pause, scrub, speed and loop modes come
// from the AnimationAction, exactly as for a glTF animation.
const mixer = new THREE.AnimationMixer(mesh);
const action = mixer.clipAction(mesh.animation);
action.play();

playButton.onclick = () => {
  action.paused = !action.paused;
  playButton.textContent = action.paused ? 'Play' : 'Pause';
};
scrub.max = String(clip.duration);
scrub.oninput = () => {
  action.paused = true;
  playButton.textContent = 'Play';
  action.time = Number(scrub.value); // seconds
};
speed.onchange = () => (action.timeScale = Number(speed.value)); // negative plays backwards
loop.onchange = () =>
  action.setLoop(loop.value === 'pingpong' ? THREE.LoopPingPong : THREE.LoopRepeat, Infinity);

const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
  timer.update();
  mixer.update(timer.getDelta());
  if (document.activeElement !== scrub) scrub.value = String(mesh.time);
  controls.update();
  // Shows the frame of `mesh.time` and uploads upcoming sections.
  mesh.update(camera, renderer);
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
