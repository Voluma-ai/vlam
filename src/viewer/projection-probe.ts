import * as THREE from 'three/webgpu';
import { createWebGPURenderer, SplatMesh } from '../lib/core';
import { loadSplatData } from '../lib/loaders';
import { UnifiedSplatMesh } from '../lib/unified';

const output = document.querySelector<HTMLOutputElement>('[data-testid="result"]');
const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
if (!output || !canvas) throw new Error('Missing projection probe elements.');
addEventListener('error', (event) => {
  output.textContent = JSON.stringify({ error: String(event.error ?? event.message) });
});
addEventListener('unhandledrejection', (event) => {
  output.textContent = JSON.stringify({ error: String(event.reason) });
});

const renderer = await createWebGPURenderer({ canvas, antialias: false, requireWebGpu: true });
renderer.setSize(64, 64, false);
await renderer.init();
const positions = new Float32Array([
  0,
  0,
  0, // center
  2.2,
  0,
  -1, // center outside, footprint crosses the right edge
  100,
  0,
  0, // fully offscreen
  0,
  0,
  3, // behind the eye
  0,
  0,
  -20, // beyond far
]);
const colors = new Uint8Array(5 * 4).fill(255);
const covariances = new Float32Array(5 * 6);
for (let i = 0; i < 5; i++) {
  covariances[i * 6] = 0.16;
  covariances[i * 6 + 3] = 0.16;
  covariances[i * 6 + 5] = 0.16;
}
const data = { count: 5, positions, colors, covariances };
const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 10);
camera.position.z = 2;
camera.updateMatrixWorld();

type PipelineDebug = {
  projectedPipeline: {
    projectionDispatches: number;
    buffers: {
      visibleIndices: THREE.StorageBufferAttribute;
      visibleCount: THREE.StorageBufferAttribute;
      dispatchArgs: THREE.IndirectStorageBufferAttribute;
      drawArgs: THREE.IndirectStorageBufferAttribute;
    };
  };
  splatIndexAttribute?: THREE.StorageInstancedBufferAttribute;
  orderAttribute?: THREE.StorageInstancedBufferAttribute;
};

async function snapshot(owner: SplatMesh | UnifiedSplatMesh): Promise<object> {
  const debug = owner as unknown as PipelineDebug;
  const buffers = debug.projectedPipeline.buffers;
  const count = new Uint32Array(await renderer.getArrayBufferAsync(buffers.visibleCount))[0] ?? 0;
  const visible = new Uint32Array(await renderer.getArrayBufferAsync(buffers.visibleIndices));
  const dispatch = new Uint32Array(await renderer.getArrayBufferAsync(buffers.dispatchArgs));
  const draw = new Uint32Array(await renderer.getArrayBufferAsync(buffers.drawArgs));
  const orderAttribute = debug.splatIndexAttribute ?? debug.orderAttribute;
  if (!orderAttribute) throw new Error('Missing projection order buffer.');
  const order = new Float32Array(await renderer.getArrayBufferAsync(orderAttribute));
  return {
    effective:
      owner instanceof UnifiedSplatMesh
        ? owner.effectiveProjectionStrategy
        : owner.projectionStrategyStatus.effective,
    projectionDispatches: debug.projectedPipeline.projectionDispatches,
    instanceCount: (owner.geometry as THREE.InstancedBufferGeometry).instanceCount,
    count,
    visible: Array.from(visible.slice(0, count)).sort((a, b) => a - b),
    dispatch: Array.from(dispatch),
    draw: Array.from(draw),
    order: Array.from(order.slice(0, count)),
  };
}

async function drawPixels(
  owner: SplatMesh | UnifiedSplatMesh,
  drawCamera: THREE.Camera = camera,
  width = 64,
  height = 64,
): Promise<Uint8Array> {
  const scene = new THREE.Scene();
  scene.add(owner);
  const target = new THREE.RenderTarget(width, height, { type: THREE.UnsignedByteType });
  renderer.setRenderTarget(target);
  renderer.setClearColor(0, 0);
  renderer.clear();
  renderer.render(scene, drawCamera);
  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  renderer.setRenderTarget(null);
  scene.remove(owner);
  target.dispose();
  // The unsigned-byte render target fixes the runtime array type; three's
  // readback declaration intentionally returns the wider TypedArray union.
  return pixels as Uint8Array;
}

const vertex = new SplatMesh(data, { sortIntervalMs: 0 });
vertex.update(camera, renderer);
const vertexPixels = await drawPixels(vertex);
vertex.dispose();

const source = new SplatMesh(data);
const unified = new UnifiedSplatMesh(renderer, 8, { projectionStrategy: 'compute' });
unified.addSource(source);
unified.update(camera);
// A second preparation also verifies stable gathered-buffer reuse.
unified.update(camera);
const unifiedPixels = await drawPixels(unified);
const unifiedResult = {
  ...(await snapshot(unified)),
  pixel: Array.from(unifiedPixels.slice((32 * 64 + 32) * 4, (32 * 64 + 33) * 4)),
};
unified.dispose();
source.dispose();

const standalone = new SplatMesh(data, { projectionStrategy: 'compute', sortIntervalMs: 0 });
standalone.update(camera, renderer);
const standalonePixels = await drawPixels(standalone);
let differentChannels = 0;
let maxChannelDifference = 0;
for (let i = 0; i < vertexPixels.length; i++) {
  const difference = Math.abs(vertexPixels[i]! - standalonePixels[i]!);
  if (difference > 0) differentChannels++;
  maxChannelDifference = Math.max(maxChannelDifference, difference);
}
const standaloneResult = {
  ...(await snapshot(standalone)),
  pixel: Array.from(standalonePixels.slice((32 * 64 + 32) * 4, (32 * 64 + 33) * 4)),
  vertexParity: { differentChannels, maxChannelDifference },
};
const backCamera = camera.clone();
backCamera.lookAt(0, 0, 3);
backCamera.updateMatrixWorld();
const backPick = await standalone.pick(new THREE.Vector2(), backCamera, renderer);
const frontPick = await standalone.pick(new THREE.Vector2(), camera, renderer);
// Picking must leave the main view's cached projection and indirect draw intact.
const afterPickPixels = await drawPixels(standalone);
const picking = {
  frontZ: frontPick?.point.z ?? null,
  backZ: backPick?.point.z ?? null,
  displayChangedChannels: afterPickPixels.reduce(
    (count, channel, index) => count + Number(channel !== standalonePixels[index]),
    0,
  ),
};
standalone.dispose();

let renderOnlyPicking: { released: boolean; backZ: number | null } | null = null;
if (new URLSearchParams(location.search).get('renderOnly') === '1') {
  const renderOnly = new SplatMesh(data, {
    projectionStrategy: 'compute',
    storageMode: 'render-only',
  });
  renderOnly.update(camera, renderer);
  await drawPixels(renderOnly);
  const renderOnlyPick = await renderOnly.pick(new THREE.Vector2(), backCamera, renderer);
  renderOnlyPicking = {
    released: renderOnly.cpuStorageReleased,
    backZ: renderOnlyPick?.point.z ?? null,
  };
  renderOnly.dispose();
}

const gooseData = await loadSplatData('/goose.sog');
renderer.setSize(1280, 720, false);
const gooseCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.01, 10_000);
gooseCamera.position.set(-0.0004366189241409302, 0.00006721913814544678, 1.5563988874388157);
gooseCamera.lookAt(-0.0004366189241409302, 0.00006721913814544678, 0.00020229816436767578);
gooseCamera.updateMatrixWorld();
const renderGoose = async (projectionStrategy: 'vertex' | 'compute'): Promise<Uint8Array> => {
  const mesh = new SplatMesh(gooseData, {
    orientation: 'source',
    projectionStrategy,
    sortIntervalMs: 0,
    sortStrategy: 'counting',
    performanceProfile: 'quality',
    maxStdDev: 3,
    minSplatSizePx: 0,
    antialias: false,
    srgbOutput: true,
  });
  mesh.rotation.x = Math.PI;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const target = new THREE.Vector3(
    -0.0004366189241409302,
    0.00006721913814544678,
    0.00020229816436767578,
  );
  const front = new THREE.Vector3(
    -0.0004366189241409302,
    0.00006721913814544678,
    1.5563988874388157,
  );
  gooseCamera.position
    .copy(target)
    .add(front.clone().sub(target).applyAxisAngle(THREE.Object3D.DEFAULT_UP, 1.44));
  gooseCamera.lookAt(target);
  gooseCamera.updateMatrixWorld();
  mesh.update(gooseCamera, renderer);
  renderer.render(scene, gooseCamera);
  gooseCamera.position.copy(front);
  gooseCamera.lookAt(target);
  gooseCamera.updateMatrixWorld();
  mesh.update(gooseCamera, renderer);
  mesh.update(gooseCamera, renderer);
  mesh.update(gooseCamera, renderer);
  const pixels = await drawPixels(mesh, gooseCamera, 1280, 720);
  scene.remove(mesh);
  mesh.dispose();
  return pixels;
};
const gooseVertex = await renderGoose('vertex');
const gooseCompute = await renderGoose('compute');
let gooseDifferentChannels = 0;
let gooseMaxChannelDifference = 0;
for (let i = 0; i < gooseVertex.length; i++) {
  const difference = Math.abs(gooseVertex[i]! - gooseCompute[i]!);
  if (difference > 0) gooseDifferentChannels++;
  gooseMaxChannelDifference = Math.max(gooseMaxChannelDifference, difference);
}
renderer.dispose();
output.textContent = JSON.stringify({
  standalone: standaloneResult,
  unified: unifiedResult,
  picking,
  renderOnlyPicking,
  gooseParity: {
    differentChannels: gooseDifferentChannels,
    maxChannelDifference: gooseMaxChannelDifference,
  },
});
