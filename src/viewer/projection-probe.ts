import * as THREE from 'three/webgpu';
import { createWebGPURenderer, SplatMesh } from '../lib/core';
import { loadSplatData } from '../lib/loaders';
import { UnifiedSplatMesh } from '../lib/unified';
import { computeProjection } from '../lib/projection/compute';
import { shEvaluationDiagnostics } from './sh-evaluation-diagnostics';

const output = document.querySelector<HTMLOutputElement>('[data-testid="result"]');
const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
if (!output || !canvas) throw new Error('Missing projection probe elements.');
const EXPLICIT_COMPUTE = computeProjection();
const AUTO_COMPUTE = computeProjection({ mode: 'auto' });
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
const unified = new UnifiedSplatMesh(renderer, 8, { projectionStrategy: EXPLICIT_COMPUTE });
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

const standalone = new SplatMesh(data, { projectionStrategy: EXPLICIT_COMPUTE, sortIntervalMs: 0 });
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
  const mesh = new UnifiedSplatMesh(renderer, 1, {
    performanceProfile,
    projectionStrategy: projectionStrategy === 'auto' ? AUTO_COMPUTE : EXPLICIT_COMPUTE,
  });
  try {
    mesh.addSource(sourceMesh);
    mesh.update(camera);
    // The unified vertex path draws nothing until its first GPU sort has
    // completed (`onSubmittedWorkDone`), so a single update + draw reads a
    // blank frame on a real adapter. Draw once to let the readback wait out
    // the queue, then update again so the completed order publishes; the
    // compute path is indirect and already visible on the first frame.
    await drawPixels(mesh);
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
    projectionStrategy: EXPLICIT_COMPUTE,
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
): Promise<{
  pixels: Uint8Array;
  projectionDispatches: number | null;
  visibleCount: number | null;
  bucketCount: number | null;
  activeCount: number;
  axisErrorA: number;
  axisErrorB: number;
  clipError: number;
}> => {
  const mesh = new SplatMesh(gooseData, {
    orientation: 'source',
    projectionStrategy: projectionStrategy === 'compute' ? EXPLICIT_COMPUTE : 'vertex',
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
  // The draw above acknowledges the first sort against `onSubmittedWorkDone`,
  // which on a real adapter has not resolved when the camera moves again, so
  // this second move lands under a held sort gate. Compute projection must
  // still re-project here (the draw reads cached clip centers); the two
  // stationary updates that follow must not.
  gooseCamera.position.copy(front);
  gooseCamera.lookAt(target);
  gooseCamera.updateMatrixWorld();
  mesh.update(gooseCamera, renderer);
  mesh.update(gooseCamera, renderer);
  mesh.update(gooseCamera, renderer);
  const pixels = await drawPixels(mesh, gooseCamera, 1280, 720);
  const pipeline = mesh as unknown as {
    projectedPipeline: {
      projectionDispatches: number;
      readVisibleCount?: () => Promise<number>;
      buffers?: { axes: THREE.StorageBufferAttribute; clipCenters: THREE.StorageBufferAttribute };
    } | null;
    projectedSorter: { lastBucketCount: number } | null;
    sorter: { lastBucketCount: number } | null;
    activeCount: number;
    pool: {
      backing: { centers: Float32Array; covarianceA: Float32Array; covarianceB: Float32Array };
    };
  };
  const projectionDispatches = pipeline.projectedPipeline?.projectionDispatches ?? null;
  const visibleCount = pipeline.projectedPipeline?.readVisibleCount
    ? await pipeline.projectedPipeline.readVisibleCount()
    : null;
  const bucketCount =
    pipeline.projectedSorter?.lastBucketCount ?? pipeline.sorter?.lastBucketCount ?? null;
  let axisErrorA = 0;
  let axisErrorB = 0;
  let clipError = 0;
  if (projectionStrategy === 'compute' && pipeline.projectedPipeline?.buffers) {
    const gpuAxes = new Float32Array(
      await renderer.getArrayBufferAsync(pipeline.projectedPipeline.buffers.axes),
    );
    const gpuClips = new Float32Array(
      await renderer.getArrayBufferAsync(pipeline.projectedPipeline.buffers.clipCenters),
    );
    const modelView = new THREE.Matrix4().multiplyMatrices(
      gooseCamera.matrixWorldInverse,
      mesh.matrixWorld,
    );
    const m = modelView.elements;
    const projection = gooseCamera.projectionMatrix.elements;
    const focal = [(projection[0] * 1280) / 2, (projection[5] * 720) / 2];
    const { centers, covarianceA, covarianceB } = pipeline.pool.backing;
    const count = pipeline.activeCount;
    const dot3 = (p: number[], q: number[]) => p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!;
    for (let i = 0; i < count; i += 37) {
      const base = i * 4;
      const center = [centers[base]!, centers[base + 1]!, centers[base + 2]!, 1];
      const view = [0, 0, 0, 0];
      for (let row = 0; row < 4; row++) {
        view[row] =
          m[row]! * center[0]! +
          m[row + 4]! * center[1]! +
          m[row + 8]! * center[2]! +
          m[row + 12]! * center[3]!;
      }
      const cov = [
        covarianceA[base]!,
        covarianceA[base + 1]!,
        covarianceA[base + 2]!,
        covarianceA[base + 3]!,
        covarianceB[base]!,
        covarianceB[base + 1]!,
      ];
      const invZ = 1 / view[2]!;
      const invZ2 = invZ * invZ;
      const j1 = [focal[0]! * invZ, 0, -focal[0]! * view[0]! * invZ2];
      const j2 = [0, focal[1]! * invZ, -focal[1]! * view[1]! * invZ2];
      const rotate = (j: number[], transposed: boolean) => {
        const out = [0, 0, 0];
        for (let row = 0; row < 3; row++) {
          out[row] = transposed
            ? m[row * 4]! * j[0]! + m[row * 4 + 1]! * j[1]! + m[row * 4 + 2]! * j[2]!
            : m[row]! * j[0]! + m[row + 4]! * j[1]! + m[row + 8]! * j[2]!;
        }
        return out;
      };
      const sigma = (u: number[]) => [
        cov[0]! * u[0]! + cov[1]! * u[1]! + cov[2]! * u[2]!,
        cov[1]! * u[0]! + cov[3]! * u[1]! + cov[4]! * u[2]!,
        cov[2]! * u[0]! + cov[4]! * u[1]! + cov[5]! * u[2]!,
      ];
      const project = (transposed: boolean) => {
        const u1 = rotate(j1, transposed);
        const u2 = rotate(j2, transposed);
        const a = dot3(u1, sigma(u1)) + 0.3;
        const d = dot3(u2, sigma(u2)) + 0.3;
        const b = dot3(u1, sigma(u2));
        const mid = (a + d) * 0.5;
        const radius = Math.hypot((a - d) * 0.5, b);
        const lambda1 = mid + radius;
        const lambda2 = Math.max(0, mid - radius);
        let vx = b + 1e-6;
        let vy = lambda1 - a;
        const len = Math.hypot(vx, vy) || 1;
        vx /= len;
        vy /= len;
        const major = Math.min(512, Math.sqrt(Math.max(0, lambda1)) * 3);
        const minor = Math.min(512, Math.sqrt(lambda2) * 3);
        return [vx * major, vy * major, vy * minor, -vx * minor];
      };
      const gpuAxis = [gpuAxes[base]!, gpuAxes[base + 1]!, gpuAxes[base + 2]!, gpuAxes[base + 3]!];
      const score = (predicted: number[]) =>
        Math.max(...predicted.map((value, index) => Math.abs(value - gpuAxis[index]!)));
      axisErrorA = Math.max(axisErrorA, score(project(true)));
      axisErrorB = Math.max(axisErrorB, score(project(false)));
      const clip = [0, 0, 0, 0];
      for (let row = 0; row < 4; row++) {
        clip[row] =
          projection[row]! * view[0]! +
          projection[row + 4]! * view[1]! +
          projection[row + 8]! * view[2]! +
          projection[row + 12]! * view[3]!;
      }
      clipError = Math.max(
        clipError,
        Math.abs(clip[0]! - gpuClips[base]!),
        Math.abs(clip[1]! - gpuClips[base + 1]!),
        Math.abs(clip[2]! - gpuClips[base + 2]!),
        Math.abs(clip[3]! - gpuClips[base + 3]!),
      );
    }
  }
  scene.remove(mesh);
  mesh.dispose();
  return {
    pixels,
    projectionDispatches,
    visibleCount,
    bucketCount,
    activeCount: pipeline.activeCount,
    axisErrorA,
    axisErrorB,
    clipError,
  };
};
const gooseVertex = await renderGoose('vertex');
const gooseVertexAgain = await renderGoose('vertex');
const gooseCompute = await renderGoose('compute');
let vertexRepeatChannels = 0;
let vertexRepeatMax = 0;
for (let i = 0; i < gooseVertex.pixels.length; i++) {
  const delta = Math.abs(gooseVertex.pixels[i]! - gooseVertexAgain.pixels[i]!);
  if (delta > 0) vertexRepeatChannels++;
  vertexRepeatMax = Math.max(vertexRepeatMax, delta);
}
let gooseDifferentChannels = 0;
let gooseMaxChannelDifference = 0;
let gooseOver2 = 0;
let gooseOver10 = 0;
let gooseOver50 = 0;
let gooseAbsSum = 0;
const gooseWorst: { x: number; y: number; vertex: number[]; compute: number[] }[] = [];
const width = 1280;
for (let i = 0; i < gooseVertex.pixels.length; i += 4) {
  let pixelMax = 0;
  for (let channel = 0; channel < 4; channel++) {
    const computeDifference = Math.abs(
      gooseVertex.pixels[i + channel]! - gooseCompute.pixels[i + channel]!,
    );
    if (computeDifference > 0) gooseDifferentChannels++;
    if (computeDifference > 2) gooseOver2++;
    if (computeDifference > 10) gooseOver10++;
    if (computeDifference > 50) gooseOver50++;
    gooseAbsSum += computeDifference;
    pixelMax = Math.max(pixelMax, computeDifference);
    gooseMaxChannelDifference = Math.max(gooseMaxChannelDifference, computeDifference);
  }
  if (pixelMax > 20) {
    const pixel = i / 4;
    gooseWorst.push({
      x: pixel % width,
      y: Math.floor(pixel / width),
      vertex: Array.from(gooseVertex.pixels.slice(i, i + 4)),
      compute: Array.from(gooseCompute.pixels.slice(i, i + 4)),
    });
  }
}
gooseWorst.sort(
  (a, b) =>
    Math.max(...a.vertex.map((value, index) => Math.abs(value - a.compute[index]!))) -
    Math.max(...b.vertex.map((value, index) => Math.abs(value - b.compute[index]!))),
);
const height = 720;
const shiftedMean = (dx: number, dy: number): number => {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    const sy = y + dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x++) {
      const sx = x + dx;
      if (sx < 0 || sx >= width) continue;
      const i = (y * width + x) * 4;
      const j = (sy * width + sx) * 4;
      for (let channel = 0; channel < 3; channel++) {
        sum += Math.abs(gooseVertex.pixels[i + channel]! - gooseCompute.pixels[j + channel]!);
        count++;
      }
    }
  }
  return sum / count;
};
const diffCanvas = document.createElement('canvas');
diffCanvas.id = 'goose-diff';
diffCanvas.width = width;
diffCanvas.height = 720;
const diffContext = diffCanvas.getContext('2d');
if (diffContext) {
  const image = diffContext.createImageData(width, 720);
  for (let i = 0; i < gooseVertex.pixels.length; i += 4) {
    const dr = Math.abs(gooseVertex.pixels[i]! - gooseCompute.pixels[i]!);
    const dg = Math.abs(gooseVertex.pixels[i + 1]! - gooseCompute.pixels[i + 1]!);
    const db = Math.abs(gooseVertex.pixels[i + 2]! - gooseCompute.pixels[i + 2]!);
    image.data[i] = Math.min(255, dr * 8);
    image.data[i + 1] = Math.min(255, dg * 8);
    image.data[i + 2] = Math.min(255, db * 8);
    image.data[i + 3] = 255;
  }
  diffContext.putImageData(image, 0, 0);
  document.body.append(diffCanvas);
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
    projectionStrategy: projectionStrategy === 'compute' ? EXPLICIT_COMPUTE : 'vertex',
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
    over2: gooseOver2,
    over10: gooseOver10,
    over50: gooseOver50,
    meanAbs: gooseAbsSum / gooseVertex.pixels.length,
    worst: gooseWorst.slice(-8),
    shift: {
      zero: shiftedMean(0, 0),
      left: shiftedMean(-1, 0),
      right: shiftedMean(1, 0),
      up: shiftedMean(0, -1),
      down: shiftedMean(0, 1),
    },
    // One move to the orbit pose and one return to the front pose. The two
    // following stationary updates must reuse the projected list.
    projectionDispatches: gooseCompute.projectionDispatches,
    vertexBuckets: gooseVertex.bucketCount,
    computeBuckets: gooseCompute.bucketCount,
    vertexVisible: gooseVertex.visibleCount,
    computeVisible: gooseCompute.visibleCount,
    activeCount: gooseCompute.activeCount,
    axisErrorA: gooseCompute.axisErrorA,
    axisErrorB: gooseCompute.axisErrorB,
    clipError: gooseCompute.clipError,
    vertexRepeatChannels,
    vertexRepeatMax,
  },
  shParity: {
    base: shBase.pixels,
    vertex: shVertex.pixels,
    computeCache: shComputeCache.pixels,
    cacheDispatches: shComputeCache.dispatches,
    projectorPackedColor: shComputeCache.packedColor,
  },
});
