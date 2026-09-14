import * as THREE from 'three/webgpu';
import { createWebGPURenderer, SplatMesh } from '../lib/core';
import { loadSplatData } from '../lib/loaders';
import { UnifiedSplatMesh } from '../lib/unified';
import { shEvaluationDiagnostics } from './sh-evaluation-diagnostics';

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
const backend = renderer.backend as unknown as {
  isWebGPUBackend?: boolean;
  device?: {
    adapterInfo?: {
      vendor?: string;
      architecture?: string;
      device?: string;
      description?: string;
      driver?: string;
      isFallbackAdapter?: boolean;
    };
  };
};
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

// The unified draw owns a separate material/projector. Keep a rendered
// regression here so its shared contribution policy cannot silently diverge
// from a standalone source again.
const cullData = {
  count: 1,
  positions: new Float32Array([0, 0, 0]),
  colors: new Uint8Array([255, 255, 255, 255]),
  // At this 64 px view the ±3σ diameter is below the balanced 2 px floor.
  covariances: new Float32Array([0.0001, 0, 0, 0.0001, 0, 0.0001]),
};
const hasVisiblePixels = (pixels: Uint8Array): boolean =>
  pixels.some((channel, index) => index % 4 !== 3 && channel > 1);
const renderCulledStandalone = async (
  performanceProfile: 'balanced' | 'quality',
): Promise<boolean> => {
  const mesh = new SplatMesh(cullData, { performanceProfile, projectionStrategy: 'vertex' });
  try {
    mesh.update(camera, renderer);
    return hasVisiblePixels(await drawPixels(mesh));
  } finally {
    mesh.dispose();
  }
};
const renderCulledUnified = async (
  performanceProfile: 'balanced' | 'quality',
  projectionStrategy: 'auto' | 'compute' = 'auto',
): Promise<boolean> => {
  const sourceMesh = new SplatMesh(cullData, {
    performanceProfile,
    projectionStrategy: 'vertex',
  });
  const mesh = new UnifiedSplatMesh(renderer, 1, { performanceProfile, projectionStrategy });
  try {
    mesh.addSource(sourceMesh);
    mesh.update(camera);
    return hasVisiblePixels(await drawPixels(mesh));
  } finally {
    mesh.dispose();
    sourceMesh.dispose();
  }
};
const unifiedContributionCulling = {
  standaloneBalancedVisible: await renderCulledStandalone('balanced'),
  unifiedBalancedVisible: await renderCulledUnified('balanced'),
  standaloneQualityVisible: await renderCulledStandalone('quality'),
  unifiedQualityVisible: await renderCulledUnified('quality'),
  unifiedComputeBalancedVisible: await renderCulledUnified('balanced', 'compute'),
  unifiedComputeQualityVisible: await renderCulledUnified('quality', 'compute'),
};

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
const renderGoose = async (
  projectionStrategy: 'vertex' | 'compute',
): Promise<{ pixels: Uint8Array; projectionDispatches: number | null }> => {
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
  if (projectionStrategy === 'compute' && mesh.projectionStrategyStatus.effective !== 'compute') {
    throw new Error(`Compute projection fell back: ${mesh.projectionStrategyStatus.reason}`);
  }
  renderer.render(scene, gooseCamera);
  gooseCamera.position.copy(front);
  gooseCamera.lookAt(target);
  gooseCamera.updateMatrixWorld();
  mesh.update(gooseCamera, renderer);
  mesh.update(gooseCamera, renderer);
  mesh.update(gooseCamera, renderer);
  const pixels = await drawPixels(mesh, gooseCamera, 1280, 720);
  const pipeline = mesh as unknown as {
    projectedPipeline: { projectionDispatches: number } | null;
  };
  const projectionDispatches = pipeline.projectedPipeline?.projectionDispatches ?? null;
  scene.remove(mesh);
  mesh.dispose();
  return { pixels, projectionDispatches };
};
const gooseVertex = await renderGoose('vertex');
const gooseCompute = await renderGoose('compute');
let gooseDifferentChannels = 0;
let gooseMaxChannelDifference = 0;
for (let i = 0; i < gooseVertex.pixels.length; i++) {
  const computeDifference = Math.abs(gooseVertex.pixels[i]! - gooseCompute.pixels[i]!);
  if (computeDifference > 0) gooseDifferentChannels++;
  gooseMaxChannelDifference = Math.max(gooseMaxChannelDifference, computeDifference);
}

// Goose has no SH, so use a small view-dependent fixture to exercise the
// cache-plus-projection color path and its refresh after camera movement.
const shPalette = new Float32Array(192 * 4);
// The camera looks along -Z. A negative Z coefficient therefore adds red at
// both poses; a smaller X term keeps the two results visibly view-dependent
// rather than accidentally clamping either pose to black.
shPalette[4] = -0.5;
shPalette[8] = 0.3;
const shData = {
  count: 1,
  positions: new Float32Array([0, 0, 0]),
  colors: new Uint8Array([80, 100, 120, 255]),
  covariances: new Float32Array([0.04, 0, 0, 0.04, 0, 0.04]),
  sh: {
    bands: 1,
    labels: new Uint32Array(1),
    palette: shPalette,
    paletteWidth: 192,
    paletteHeight: 1,
  },
};
const shCamera = new THREE.PerspectiveCamera(90, 1, 0.1, 10);
const renderSh = async (
  projectionStrategy: 'vertex' | 'compute',
  shEvaluation: 'vertex' | 'compute',
  shBands: 0 | 1 = 1,
): Promise<{ pixels: number[][]; dispatches: number; packedColor: boolean | null }> => {
  const mesh = new SplatMesh(shData, {
    projectionStrategy,
    shEvaluation,
    shBands,
    sortIntervalMs: 0,
    srgbOutput: true,
  });
  const pixels: number[][] = [];
  try {
    for (const x of [0, 1]) {
      shCamera.position.set(x, 0, 2);
      shCamera.lookAt(0, 0, 0);
      shCamera.updateMatrixWorld();
      mesh.update(shCamera, renderer);
      const deadline = performance.now() + 30_000;
      while (
        shEvaluationDiagnostics(mesh).reason === 'loading-compute-module' ||
        mesh.projectionStrategyStatus.reason === 'loading-sh-cache-module'
      ) {
        if (performance.now() > deadline)
          throw new Error('SH projection probe initialization timed out.');
        await new Promise((resolve) => setTimeout(resolve, 16));
        mesh.update(shCamera, renderer);
      }
      if (
        projectionStrategy === 'compute' &&
        mesh.projectionStrategyStatus.effective !== 'compute'
      ) {
        throw new Error(`SH projection probe fell back: ${mesh.projectionStrategyStatus.reason}`);
      }
      if (shEvaluation === 'compute' && shEvaluationDiagnostics(mesh).resolved !== 'compute') {
        throw new Error(`SH cache probe fell back: ${shEvaluationDiagnostics(mesh).reason}`);
      }
      const image = await drawPixels(mesh, shCamera);
      pixels.push(Array.from(image.slice((32 * 64 + 32) * 4, (32 * 64 + 33) * 4)));
    }
    const pipeline = mesh as unknown as { projectedPipeline: { packedColor: boolean } | null };
    return {
      pixels,
      dispatches: shEvaluationDiagnostics(mesh).dispatches,
      packedColor: pipeline.projectedPipeline?.packedColor ?? null,
    };
  } finally {
    mesh.dispose();
  }
};
const shBase = await renderSh('vertex', 'vertex', 0);
const shVertex = await renderSh('vertex', 'vertex');
const shComputeCache = await renderSh('compute', 'compute');
const drawingBuffer = renderer.getDrawingBufferSize(new THREE.Vector2());
const adapter = backend.device?.adapterInfo;
const adapterText = [adapter?.vendor, adapter?.architecture, adapter?.device, adapter?.description]
  .filter((value): value is string => typeof value === 'string')
  .join(' ')
  .toLowerCase();
renderer.dispose();
output.textContent = JSON.stringify({
  hardware: {
    browser: navigator.userAgent,
    backend: backend.isWebGPUBackend === true ? 'webgpu' : 'other',
    adapter: {
      vendor: adapter?.vendor ?? null,
      architecture: adapter?.architecture ?? null,
      device: adapter?.device ?? null,
      description: adapter?.description ?? null,
      driver: adapter?.driver ?? null,
      isFallback: adapter?.isFallbackAdapter ?? null,
    },
    isSoftware:
      adapter?.isFallbackAdapter === true ||
      /swiftshader|llvmpipe|software|fallback/.test(adapterText),
    viewport: { width: drawingBuffer.x, height: drawingBuffer.y },
  },
  standalone: standaloneResult,
  unified: unifiedResult,
  unifiedContributionCulling,
  picking,
  renderOnlyPicking,
  gooseParity: {
    differentChannels: gooseDifferentChannels,
    maxChannelDifference: gooseMaxChannelDifference,
    // One move to the orbit pose and one return to the front pose. The two
    // following stationary updates must reuse the projected list.
    projectionDispatches: gooseCompute.projectionDispatches,
  },
  shParity: {
    base: shBase.pixels,
    vertex: shVertex.pixels,
    computeCache: shComputeCache.pixels,
    cacheDispatches: shComputeCache.dispatches,
    projectorPackedColor: shComputeCache.packedColor,
  },
});
