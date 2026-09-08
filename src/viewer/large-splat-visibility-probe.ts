/** GPU regression for visible offscreen-centered splats and cropped SH updates. */
import * as THREE from 'three/webgpu';
import { createWebGPURenderer, SplatMesh } from '../lib/core';
import { ShComputeCache } from '../lib/core/sh-compute-cache';

const requested = new URLSearchParams(location.search).get('backend') ?? 'webgpu';
const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
const output = document.querySelector<HTMLOutputElement>('[data-testid="result"]');
if (!canvas || !output) throw new Error('Missing probe elements.');
const renderer = await createWebGPURenderer({
  canvas,
  antialias: false,
  forceWebGL: requested === 'webgl2',
  requireWebGpu: requested === 'webgpu',
});
renderer.setSize(64, 64, false);
renderer.setClearColor(0, 0);
await renderer.init();
const palette = new Float32Array(192 * 4);
// Nonzero view-dependent red makes a missed SH refresh visible in readback.
palette[4] = 1;
const mesh = new SplatMesh(
  {
    count: 1,
    positions: new Float32Array([3, 0, 0]),
    colors: new Uint8Array([180, 128, 128, 255]),
    covariances: new Float32Array([4, 0, 0, 4, 0, 4]),
    sh: {
      bands: 1,
      labels: new Uint32Array(1),
      palette,
      paletteWidth: 192,
      paletteHeight: 1,
    },
  },
  { shEvaluation: requested === 'webgpu' ? 'compute' : 'vertex', sortMetric: 'depth' },
);
// Test-only inspection avoids asynchronous module loading; the ordinary mesh
// update still owns cache creation, dispatch, and invalidation.
const host = mesh as unknown as {
  ShCacheCtor: typeof ShComputeCache;
  shCache: ShComputeCache | null;
};
host.ShCacheCtor = ShComputeCache;
const scene = new THREE.Scene();
scene.add(mesh);
const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 10);
camera.position.z = 2;
const target = new THREE.RenderTarget(64, 64, { type: THREE.UnsignedByteType });

async function drawPixel(): Promise<number[]> {
  camera.updateMatrixWorld();
  mesh.update(camera, renderer);
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  return Array.from(await renderer.readRenderTargetPixelsAsync(target, 50, 32, 1, 1));
}

try {
  await drawPixel();
  const initialDispatches = host.shCache?.snapshot().dispatches ?? 0;
  camera.position.x = -2;
  let footprint = await drawPixel();
  if (requested === 'webgpu') {
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((host.shCache?.snapshot().dispatches ?? 0) > initialDispatches) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
      footprint = await drawPixel();
    }
  }
  const cache = host.shCache;
  let cachedColor: { cropped: number[]; full: number[]; dispatches: number } | null = null;
  if (cache) {
    const dispatches = cache.snapshot().dispatches;
    // Identical camera and pixels: forcing an unculled refresh must not change
    // this visible splat's color. Previously red changed from 31 to 47.
    cache.invalidate();
    cachedColor = { cropped: footprint, full: await drawPixel(), dispatches };
  }
  camera.position.x = 100;
  const offscreen = await drawPixel();
  camera.position.set(0, 0, -2);
  const behind = await drawPixel();
  camera.position.set(0, 0, 20);
  const beyondFar = await drawPixel();
  output.textContent = JSON.stringify({ footprint, cachedColor, offscreen, behind, beyondFar });
} finally {
  renderer.setRenderTarget(null);
  target.dispose();
  mesh.dispose();
  renderer.dispose();
}
