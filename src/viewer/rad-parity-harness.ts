import * as THREE from 'three/webgpu';
import { createWebGPURenderer } from '../lib/core';
import { StreamedSplatMesh } from '../lib/streaming';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '../lib/unified';

const SIZE = 512;
const BUDGETS = [25_000, 50_000, 100_000, 150_000, 250_000, 1_500_000, 3_100_000] as const;
const SETTLE_MS = 8_000;
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

async function run(): Promise<void> {
  const params = new URLSearchParams(globalThis.location.search);
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

  const probe = await fetch(url, { method: 'HEAD' }).catch(() => null);
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

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  camera.position.set(0, 2, 8);
  camera.lookAt(0, 0, 0);
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
      if (!mesh.isStreaming && mesh.activeSplatCount > 0 && frontier.frontierConverged) break;
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
    });
    unified.dispose();
    mesh.dispose();
  }

  const result = { skipped: false, url, samples, intermediate };
  Object.assign(window, { __radParityHarness: result });
  print(JSON.stringify(result, null, 2));
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  print(message);
  console.error(error);
});
