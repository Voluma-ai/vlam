// Example: site/examples/open-local-file.md - pick or drop a capture from disk.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createWebGPURenderer } from '@voluma/vlam';
import { SplatLoadError, isAbortError, loadSplatDataFile } from '@voluma/vlam/loaders';

// Optional VLAM! convenience: still a three.js WebGPURenderer, configured with
// raised WebGPU limits and available device features for more demanding scenes.
const renderer = await createWebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(1, 0.5, 1.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const status = document.querySelector<HTMLElement>('#status')!;
const picker = document.querySelector<HTMLInputElement>('#file')!;

// Only one capture on screen at a time, and only one load in flight: opening a
// second file cancels the first, so a slow 2 GB read cannot land after it.
let current: SplatMesh | null = null;
let inFlight: AbortController | null = null;

async function open(file: File): Promise<void> {
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  try {
    // The file is decoded in a Web Worker, on the device. Nothing is uploaded.
    const data = await loadSplatDataFile(file, {
      signal: controller.signal,
      onProgress: (loaded, total) => {
        // total is 0 when the size is unknown - show a spinner, not a percentage.
        status.textContent =
          total > 0 ? `Reading ${Math.round((loaded / total) * 100)}%` : 'Reading…';
      },
    });

    // Swap only after the new one is ready, so the old capture stays on screen
    // while the new one decodes.
    if (current) {
      scene.remove(current);
      current.dispose();
    }
    current = new SplatMesh(data);
    scene.add(current);
    status.textContent = `${file.name} - ${data.count.toLocaleString()} splats`;
  } catch (error) {
    if (isAbortError(error)) return; // superseded by a newer file; not a failure
    if (error instanceof SplatLoadError) {
      // `phase` says where it broke: 'decode' is almost always a file that is
      // not the format its extension claims.
      status.textContent =
        error.phase === 'decode'
          ? `${file.name} could not be read - is it really a splat file?`
          : `Could not open ${file.name} (${error.phase}).`;
      return;
    }
    throw error; // something unrelated to loading - do not swallow it
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

picker.addEventListener('change', () => {
  const file = picker.files?.[0];
  if (file) void open(file);
});

// Drag and drop. `preventDefault` on dragover is what makes the page a drop
// target at all; without it the browser just navigates to the file.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (file) void open(file);
});

renderer.setAnimationLoop(() => {
  controls.update();
  current?.update(camera, renderer);
  renderer.render(scene, camera);
});
