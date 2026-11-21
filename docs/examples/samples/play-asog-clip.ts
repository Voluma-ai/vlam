// Example: site/examples/play-asog-clip.md - play an Animated SOG (`.asog`)
// clip and its soundtrack. `?src=<url>` plays another `.asog` file.
// Experimental: `@voluma/vlam/dynamic` may change in a minor release.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWebGPURenderer } from '@voluma/vlam';
import { SplatClipMesh, loadAsogClip } from '@voluma/vlam/dynamic';

const renderer = await createWebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
await renderer.init(); // the mesh picks its playback path from the backend

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0, 0, 3);
const controls = new OrbitControls(camera, renderer.domElement);

// One file, decoded in a worker.
const src = new URLSearchParams(location.search).get('src');
const clip = await loadAsogClip(src ?? '/asog-sample/synthetic-ball.asog');
const mesh = new SplatClipMesh(clip, { renderer });
mesh.rotation.x = Math.PI; // .asog is y down: stand it up
scene.add(mesh);
controls.target.copy(clip.bounds.getCenter(new THREE.Vector3()).applyEuler(mesh.rotation));

// Played like a glTF animation: one track on `mesh.time` (seconds).
const mixer = new THREE.AnimationMixer(mesh);
const action = mixer.clipAction(mesh.animation);
action.play();
const speed = document.querySelector<HTMLSelectElement>('#speed')!;
speed.onchange = () => (action.timeScale = Number(speed.value)); // negative plays in reverse

// The soundtrack, if the file has one, through three.js audio. It plays only
// once the button is pressed (browsers also need that gesture to allow sound);
// the button stays hidden for a clip without sound.
const listener = new THREE.AudioListener();
camera.add(listener);
const sound = new THREE.Audio(listener);
const button = document.querySelector<HTMLButtonElement>('#sound')!;
let soundOn = false;
if (clip.audio) {
  const bytes = clip.audio.bytes.slice().buffer; // decodeAudioData takes the buffer
  sound.setBuffer(await listener.context.decodeAudioData(bytes));
  button.onclick = () => {
    soundOn = !soundOn;
    if (soundOn) void listener.context.resume();
    else if (sound.isPlaying) sound.stop();
    button.textContent = soundOn ? 'Mute' : 'Play sound';
  };
  button.hidden = false; // shown only for a clip with sound
}

// Keep the sound at `mesh.time`, at the clip's rate. `heard` is where the
// sound is, integrated at the rate it plays at; when it drifts more than
// 60 ms from the clip (each loop, a scrub, a hitch) the sound restarts there.
// Paused, reversed or extreme rates (beyond 0.25x to 4x) are silent.
let heard = 0;
let lastNow = 0;
let lastTime = NaN;
function syncSound(): void {
  if (!soundOn || !sound.buffer || listener.context.state !== 'running') return;
  const now = listener.context.currentTime;
  const rate = action.getEffectiveTimeScale() * mixer.timeScale;
  const held = mesh.time === lastTime;
  lastTime = mesh.time;
  if (held || !(rate >= 0.25 && rate <= 4) || mesh.time >= sound.buffer.duration) {
    if (sound.isPlaying) sound.stop(); // a shorter sound waits for the loop
    return;
  }
  if (sound.isPlaying) {
    heard += (now - lastNow) * sound.playbackRate;
    lastNow = now;
    if (sound.playbackRate !== rate) sound.setPlaybackRate(rate);
    if (Math.abs(heard - mesh.time) < 0.06) return;
    sound.stop();
  } else if (sound.buffer.duration - mesh.time < 0.06) {
    return; // the sound ran out just ahead of the clip: wait for the loop
  }
  sound.setPlaybackRate(rate);
  sound.offset = mesh.time;
  sound.play();
  heard = mesh.time;
  lastNow = now;
}

const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
  timer.update();
  mixer.update(timer.getDelta());
  syncSound();
  controls.update();
  mesh.update(camera, renderer); // shows the frame of `mesh.time`
  renderer.render(scene, camera);
});
