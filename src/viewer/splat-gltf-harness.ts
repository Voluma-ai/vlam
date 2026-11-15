/**
 * Splat glTF harness: loads a `KHR_gaussian_splatting` glTF through
 * `loadSplatGltf` (`@voluma/vlam/dynamic`) and plays its clips under an
 * `AnimationMixer`, honouring the clips' `extras.vlam` hints.
 *
 * Query parameters:
 *  - `url=<glb>`: the file (default `/benchmark-assets/procedural-goose.glb`,
 *    written by `node scripts/export-goose-glb.mjs`)
 *  - `clip=<name>|none`: the clip to play (default the first one); `none`
 *    shows the bind pose
 *  - `time=<s>`: hold the clip at this time instead of playing
 *  - `backend=webgpu|webgl2`
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWebGPURenderer } from '../lib/core';
import { SkinnedSplatMesh, loadSplatGltf, type SplatGltfClipHints } from '../lib/dynamic';

const query = new URLSearchParams(location.search);
const url = query.get('url') ?? '/benchmark-assets/procedural-goose.glb';
const held = query.has('time') ? Number(query.get('time')) || 0 : null;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const status = document.getElementById('status')!;
const clipSelect = document.getElementById('clip') as HTMLSelectElement;
const playButton = document.getElementById('play') as HTMLButtonElement;
const scrub = document.getElementById('scrub') as HTMLInputElement;

async function main(): Promise<void> {
  const renderer = await createWebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL: query.get('backend') === 'webgl2',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.setClearColor(0x2b2b2b, 1);
  await renderer.init();

  const started = performance.now();
  const loaded = await loadSplatGltf(url);
  const loadMs = performance.now() - started;
  const scene = new THREE.Scene();
  scene.add(loaded.scene);

  // Frame the splats from the side.
  const box = new THREE.Box3();
  let splats = 0;
  for (const mesh of loaded.meshes) {
    if (!(mesh instanceof SkinnedSplatMesh)) continue;
    const data = mesh.posedSplatData();
    splats += data.count;
    for (let i = 0; i < data.count; i++) {
      box.expandByPoint(new THREE.Vector3().fromArray(data.positions, i * 3));
    }
  }
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, size / 100, size * 50);
  camera.position.set(center.x + size * 0.15, center.y + size * 0.15, center.z + size * 1.3);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.update();

  const mixer = new THREE.AnimationMixer(loaded.scene);
  let action: THREE.AnimationAction | null = null;
  let paused = held !== null;
  const choose = (name: string): void => {
    action?.stop();
    action = null;
    const clip = THREE.AnimationClip.findByName(loaded.animations, name);
    if (!clip) return;
    action = mixer.clipAction(clip);
    const hints = (clip.userData as { vlam?: SplatGltfClipHints }).vlam ?? {};
    if (hints.loop === 'once') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, hints.repetitions ?? Infinity);
    }
    action.play();
    action.time = held ?? 0;
    mixer.update(0);
    scrub.max = String(clip.duration * (hints.repetitions ?? 1));
  };
  for (const name of ['none', ...loaded.animations.map((clip) => clip.name)]) {
    clipSelect.add(new Option(name, name));
  }
  const first = query.get('clip') ?? loaded.animations[0]?.name ?? 'none';
  clipSelect.value = first;
  choose(first);
  clipSelect.addEventListener('change', () => choose(clipSelect.value));
  playButton.textContent = paused ? 'Play' : 'Pause';
  playButton.addEventListener('click', () => {
    paused = !paused;
    playButton.textContent = paused ? 'Play' : 'Pause';
    if (!paused && action && !action.isRunning()) action.reset().play();
  });
  scrub.addEventListener('input', () => {
    if (!action) return;
    paused = true;
    playButton.textContent = 'Play';
    if (!action.isRunning()) action.reset().play();
    action.time = Number(scrub.value);
    mixer.update(0);
  });

  const describe = (): string =>
    `${url}\n${splats.toLocaleString()} splats · ${loaded.animations.length} clips · ` +
    `loaded in ${(loadMs / 1000).toFixed(1)} s`;
  status.textContent = describe();

  const timer = new THREE.Timer();
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });
  (window as unknown as { __splatGltf: unknown }).__splatGltf = { loaded, mixer, camera, controls };
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    if (!paused) {
      mixer.update(timer.getDelta());
      if (action) scrub.value = String(action.time);
    }
    controls.update();
    for (const mesh of loaded.meshes) mesh.update(camera, renderer);
    renderer.render(scene, camera);
  });
}

main().catch((error: unknown) => {
  status.textContent = `Failed: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
});
