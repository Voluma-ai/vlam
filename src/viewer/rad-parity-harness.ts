import * as THREE from 'three/webgpu';
import { createWebGPURenderer } from '../lib/core';
import { StreamedSplatMesh } from '../lib/streaming';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '../lib/unified';

const params = new URLSearchParams(globalThis.location.search);
const parsePositiveInt = (raw: string | null, fallback: number): number => {
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid positive integer: ${raw}`);
  return value;
};
const parseVector = (raw: string | null): [number, number, number] | undefined => {
  if (raw === null) return undefined;
  const values = raw.split(',').map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value)))
    throw new Error(`Invalid camera vector: ${raw}`);
  return values as [number, number, number];
};
const SIZE = parsePositiveInt(params.get('size'), 512);
const BUDGETS =
  (params.get('budgets') ?? params.get('budget'))
    ? (params.get('budgets') ?? params.get('budget'))!
        .split(',')
        .map((value) => parsePositiveInt(value, 1))
    : [25_000, 50_000, 100_000, 150_000, 250_000, 1_500_000, 3_100_000];
const SETTLE_MS = parsePositiveInt(params.get('settleMs'), 8_000);
const status = document.querySelector<HTMLDivElement>('#status');
const shots = document.querySelector<HTMLDivElement>('#shots');

function print(message: string): void {
  if (status) status.textContent = message;
}

function addShot(label: string, dataUrl: string): void {
  if (!shots) return;
  const wrap = document.createElement('figure');
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = label;
  img.width = SIZE;
  img.height = SIZE;
  const cap = document.createElement('figcaption');
  cap.textContent = label;
  wrap.append(img, cap);
  shots.append(wrap);
}

async function capture(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): Promise<string> {
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}

async function imageMae(left: string, right: string): Promise<number> {
  const decode = async (dataUrl: string): Promise<ImageBitmap> =>
    createImageBitmap(await (await fetch(dataUrl)).blob());
  const images = await Promise.all([decode(left), decode(right)]);
  const [firstImage, secondImage] = images;
  if (!firstImage || !secondImage) throw new Error('RAD parity harness decoded no images.');
  const canvas = document.createElement('canvas');
  canvas.width = firstImage.width;
  canvas.height = firstImage.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('RAD parity harness could not create a 2D canvas.');
  const pixels = images.map((image) => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    image.close();
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  });
  const [leftPixels, rightPixels] = pixels;
  if (!leftPixels || !rightPixels) throw new Error('RAD parity harness decoded no pixels.');
  const channel = (pixels: Uint8ClampedArray, index: number): number => pixels[index] ?? 0;
  let sum = 0;
  for (let i = 0; i < leftPixels.length; i += 4) {
    sum += Math.abs(channel(leftPixels, i) - channel(rightPixels, i));
    sum += Math.abs(channel(leftPixels, i + 1) - channel(rightPixels, i + 1));
    sum += Math.abs(channel(leftPixels, i + 2) - channel(rightPixels, i + 2));
  }
  return sum / (canvas.width * canvas.height * 3);
}

async function run(): Promise<void> {
  const url = params.get('url') ?? params.get('rad');
  if (!url) {
    const skipped = {
      skipped: true,
      reason: 'missing-url',
      expected: '23-06-2024-lod.rad',
      hint: 'Open /rad-parity-harness.html?url=<absolute-or-local-rad-url>',
    };
    Object.assign(window, { __radParityHarness: skipped });
    print(JSON.stringify(skipped, null, 2));
    return;
  }

  // The local benchmark asset middleware intentionally serves GET (including
  // byte ranges) but not HEAD, so probe with the same request shape the RAD
  // loader uses instead of turning a valid cached scene into a false 404.
  const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } }).catch(() => null);
  if (!probe?.ok) {
    const skipped = { skipped: true, reason: 'unavailable', url, status: probe?.status ?? 0 };
    Object.assign(window, { __radParityHarness: skipped });
    print(JSON.stringify(skipped, null, 2));
    return;
  }

  const renderer = await createWebGPURenderer({ antialias: false, requireWebGpu: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x111111, 1);
  document.body.prepend(renderer.domElement);
  await renderer.init();
  if (!supportsUnifiedSplatMesh(renderer)) {
    throw new Error('RAD parity harness requires a WebGPU backend.');
  }

  const cameraPosition = parseVector(params.get('cameraPosition')) ?? [0, 2, 8];
  const cameraTarget = parseVector(params.get('cameraTarget')) ?? [0, 0, 0];
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100_000);
  camera.position.fromArray(cameraPosition);
  camera.lookAt(new THREE.Vector3().fromArray(cameraTarget));
  camera.updateMatrixWorld();

  const samples: Array<Record<string, unknown>> = [];
  const intermediate: Array<Record<string, unknown>> = [];
  for (const budget of BUDGETS) {
    print(`Loading ${url} at ${budget}…`);
    const mesh = await StreamedSplatMesh.load(url, {
      budget,
      maxBudget: budget,
      sortStrategy: 'counting',
      orientation: 'source',
      srgbOutput: true,
    });
    const directScene = new THREE.Scene();
    directScene.add(mesh);
    const started = performance.now();
    while (performance.now() - started < SETTLE_MS) {
      mesh.update(camera, renderer);
      const frontier = mesh.frontierState;
      if (mesh.activeSplatCount > 0) {
        intermediate.push({
          budget,
          generation: frontier.planGeneration,
          converged: frontier.frontierConverged,
          pending: frontier.pendingFrontierSplats,
          stale: frontier.staleResidentSplats,
          activeSplats: mesh.activeSplatCount,
          camera: frontier.lastPlanCamera,
        });
      }
      if (
        !mesh.isStreaming &&
        mesh.activeSplatCount > 0 &&
        frontier.frontierConverged &&
        frontier.pendingFrontierSplats === 0 &&
        frontier.staleResidentSplats === 0
      )
        break;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    mesh.update(camera, renderer);
    const directShot = await capture(renderer, directScene, camera);
    addShot(`direct ${budget}`, directShot);

    const unified = new UnifiedSplatMesh(renderer, Math.max(budget, mesh.activeSplatCount), {
      sortStrategy: 'counting',
      srgbOutput: true,
    });
    unified.addSource(mesh);
    const unifiedScene = new THREE.Scene();
    unifiedScene.add(unified);
    unified.update(camera);
    const unifiedShot = await capture(renderer, unifiedScene, camera);
    addShot(`unified ${budget}`, unifiedShot);

    samples.push({
      budget,
      activeSplats: mesh.activeSplatCount,
      streaming: mesh.isStreaming,
      contentSplats: mesh.contentSplatCount,
      sortStrategy: 'counting',
      frontier: mesh.frontierState,
      firstFrontierCamera: mesh.frontierState.firstFrontierCamera,
      lastPlanCamera: mesh.frontierState.lastPlanCamera,
      directShotBytes: directShot.length,
      unifiedShotBytes: unifiedShot.length,
      directUnifiedMae: await imageMae(directShot, unifiedShot),
    });
    unified.dispose();
    mesh.dispose();
  }

  const result = {
    skipped: false,
    url,
    budgets: BUDGETS,
    settleMs: SETTLE_MS,
    cameraPosition,
    cameraTarget,
    samples,
    intermediate,
  };
  Object.assign(window, { __radParityHarness: result });
  print(JSON.stringify(result, null, 2));
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  print(message);
  console.error(error);
});
