/**
 * Small settled-render benchmark for device comparisons.
 *
 * Open `/render-benchmark.html?scene=/goose.sog` from the dev server. The
 * fixed canvas and plain SplatMesh keep this separate from viewer profiles,
 * streaming, controls, and UI effects. Loading and shader warm-up are not
 * included in the reported frame statistics.
 */
import * as THREE from 'three/webgpu';
import { createSplatRenderer, SplatMesh, type SplatPerformanceProfile } from '../lib/core';
import { loadSplatData } from '../lib/loaders';
import { version as vlamVersion } from '../../package.json';
import { BenchmarkGpuSampler, RenderBenchmarkSession } from './render-benchmark-session';

const params = new URLSearchParams(globalThis.location.search);
const sceneUrl = params.get('scene') ?? '/goose.sog';
const warmupSeconds = positiveParam('warmup', 5);
const sampleSeconds = positiveParam('seconds', 15);
const width = integerParam('width', 800);
const height = integerParam('height', 600);
const pixelRatio = positiveParam('pixelRatio', 1);
const forceWebGL = params.get('backend') === 'webgl';
const gpuTimestamps = params.get('gpuTimestamps') === '1';
const profile: SplatPerformanceProfile = params.get('profile') === 'smooth' ? 'smooth' : 'quality';
const maxStdDev = positiveParam('maxStdDev', 3);
const shBands = parseShBands(params.get('sh'));
const mode = params.get('mode') === 'orbit' ? 'orbit' : 'stationary';

const canvasElement = document.querySelector<HTMLCanvasElement>('#canvas');
const statusElement = document.querySelector<HTMLElement>('#status');
const downloadJsonElement = document.querySelector<HTMLButtonElement>('#download-json');
const downloadShotElement = document.querySelector<HTMLButtonElement>('#download-shot');
if (!canvasElement || !statusElement || !downloadJsonElement || !downloadShotElement) {
  throw new Error('Render benchmark markup is incomplete.');
}
const canvas = canvasElement;
const status = statusElement;
const downloadJson = downloadJsonElement;
const downloadShot = downloadShotElement;
let screenshotUrl: string | null = null;

function positiveParam(name: string, fallback: number): number {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function integerParam(name: string, fallback: number): number {
  return Math.max(1, Math.floor(positiveParam(name, fallback)));
}

function parseShBands(value: string | null): 0 | 1 | 2 | 3 | undefined {
  if (value === '0' || value === '1' || value === '2' || value === '3')
    return Number(value) as 0 | 1 | 2 | 3;
  return undefined;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as number;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function downloadJsonFile(result: unknown): void {
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'vlam-render-benchmark.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

function downloadScreenshot(): void {
  if (screenshotUrl === null) return;
  const link = document.createElement('a');
  link.href = screenshotUrl;
  link.download = 'vlam-render-benchmark.png';
  link.click();
}

async function run(): Promise<void> {
  const renderer = await createSplatRenderer({
    antialias: params.get('msaa') !== '0',
    forceWebGL,
    trackTimestamp: gpuTimestamps,
  });
  await renderer.init();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  canvas.replaceWith(renderer.domElement);
  const data = await loadSplatData(sceneUrl);
  const mesh = new SplatMesh(data, {
    antialias: false,
    maxStdDev,
    performanceProfile: profile,
    ...(shBands === undefined ? {} : { shBands }),
  });
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 10000);
  const bounds = mesh.computeSplatBounds();
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.5, 0.1);
  camera.position.set(center.x, center.y, center.z + radius * 2.5);
  camera.lookAt(center);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const session = new RenderBenchmarkSession(warmupSeconds * 1000, sampleSeconds * 1000);
  const frameTimes = session.frameTimes;
  const cpuRenderSubmitTimes: number[] = [];
  const drawSubmissions: number[] = [];
  const splatDrawSubmissions: number[] = [];
  // This backend capability exists on both WebGPU and the WebGL2 fallback,
  // but is not yet described by @types/three's Backend declaration.
  const hasTimestamp = (renderer.backend as unknown as { hasTimestamp: boolean }).hasTimestamp;
  const sampler = new BenchmarkGpuSampler(gpuTimestamps && hasTimestamp, (kind) =>
    renderer.resolveTimestampsAsync(kind),
  );
  let splatDrawCalls = 0;
  renderer.setRenderObjectFunction((...args) => {
    const before = renderer.info.render.drawCalls;
    renderer.renderObject(...args);
    if (args[0] === mesh) splatDrawCalls += renderer.info.render.drawCalls - before;
  });
  const restart = (): void => {
    if (document.visibilityState === 'visible') return;
    session.reset();
    sampler.reset();
    cpuRenderSubmitTimes.length = 0;
    drawSubmissions.length = 0;
    splatDrawSubmissions.length = 0;
    status.textContent = 'Paused. Warm-up and measurements restart when this page is visible.';
  };
  document.addEventListener('visibilitychange', restart);
  try {
    await new Promise<void>((resolve, reject) => {
      renderer.setAnimationLoop((timestamp) => {
        if (document.visibilityState !== 'visible') return;
        try {
          const tick = session.frame(timestamp);
          if (mode === 'orbit') {
            const orbit = tick.elapsedMs * 0.00012;
            camera.position.set(
              center.x + Math.sin(orbit) * radius * 2.5,
              center.y + Math.sin(orbit * 0.7) * radius * 0.2,
              center.z + Math.cos(orbit) * radius * 2.5,
            );
            camera.lookAt(center);
            camera.updateMatrixWorld();
          }
          mesh.update(camera, renderer);
          splatDrawCalls = 0;
          const submitStart = performance.now();
          renderer.render(scene, camera);
          const submitMs = performance.now() - submitStart;
          sampler.frame(
            tick.sampling,
            renderer.info.render.frameCalls,
            renderer.info.compute.frameCalls,
          );
          if (tick.sampling) {
            cpuRenderSubmitTimes.push(submitMs);
            drawSubmissions.push(renderer.info.render.drawCalls);
            splatDrawSubmissions.push(splatDrawCalls);
          }
          status.textContent = tick.sampling ? `Measuring ${mode} rendering…` : 'Warming up…';
          if (!tick.complete) return;
          // Read pixels in the render callback: WebGL's default framebuffer is
          // transient, and disposing the backend deliberately loses its context.
          screenshotUrl = renderer.domElement.toDataURL('image/png');
          document.removeEventListener('visibilitychange', restart);
          renderer.setAnimationLoop(null);
          resolve();
        } catch (error) {
          renderer.setAnimationLoop(null);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    await sampler.finish();
  } finally {
    document.removeEventListener('visibilitychange', restart);
    renderer.setAnimationLoop(null);
    renderer.setRenderObjectFunction(null);
    await sampler.finish();
    mesh.dispose();
    renderer.dispose();
  }
  const drawingBuffer = renderer.getDrawingBufferSize(new THREE.Vector2());
  const gpuSummary = (samples: readonly number[]) => ({
    status: !gpuTimestamps ? 'disabled' : samples.length === 0 ? 'unavailable' : 'available',
    sampleCount: samples.length,
    meanMs: samples.length === 0 ? null : mean(samples),
    medianMs: samples.length === 0 ? null : percentile(samples, 0.5),
    p95Ms: samples.length === 0 ? null : percentile(samples, 0.95),
  });
  const result = {
    environment: {
      versions: { vlam: vlamVersion, threeRevision: THREE.REVISION },
      label: params.get('label') ?? '',
      mode,
      browser: navigator.userAgent,
      platform: navigator.platform,
      backend:
        (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
          ? 'WebGPU'
          : 'WebGL2',
      drawingBuffer: { width: drawingBuffer.x, height: drawingBuffer.y },
      pixelRatio: renderer.getPixelRatio(),
      multisamplingSamples: renderer.samples,
      splatCount: data.count,
      shBands: mesh.shBands,
      scene: sceneUrl,
      warmupSeconds,
      sampleSeconds,
      quality: { profile, maxStdDev, splatAntialias: false, requestedShBands: shBands ?? 'source' },
    },
    frame: {
      sampleCount: frameTimes.length,
      measuredSeconds: frameTimes.reduce((sum, ms) => sum + ms, 0) / 1000,
      averageFps: mean(frameTimes) > 0 ? 1000 / mean(frameTimes) : 0,
      medianMs: percentile(frameTimes, 0.5),
      p95Ms: percentile(frameTimes, 0.95),
      p99Ms: percentile(frameTimes, 0.99),
      medianFps: percentile(frameTimes, 0.5) > 0 ? 1000 / percentile(frameTimes, 0.5) : 0,
      cpuRenderSubmitMedianMs: percentile(cpuRenderSubmitTimes, 0.5),
      cpuRenderSubmitP95Ms: percentile(cpuRenderSubmitTimes, 0.95),
      renderDrawCallsMedian: percentile(drawSubmissions, 0.5),
      renderDrawCallsP95: percentile(drawSubmissions, 0.95),
      renderDrawCallsMax: percentile(drawSubmissions, 1),
      renderDrawCallsMean: mean(drawSubmissions),
      splatDrawCallsMedian: percentile(splatDrawSubmissions, 0.5),
      splatDrawCallsMax: percentile(splatDrawSubmissions, 1),
      gpu: {
        render: gpuSummary(sampler.samples.render),
        compute: gpuSummary(sampler.samples.compute),
      },
    },
  };
  status.textContent = JSON.stringify(result, null, 2);
  downloadJson.disabled = false;
  downloadShot.disabled = false;
  downloadJson.onclick = () => downloadJsonFile(result);
  downloadShot.onclick = downloadScreenshot;
  const finalImage = document.createElement('img');
  finalImage.src = screenshotUrl!;
  finalImage.alt = 'Final benchmark frame';
  finalImage.style.cssText = 'display:block;max-width:100%;height:auto;margin-bottom:12px';
  renderer.domElement.replaceWith(finalImage);
}

void run().catch((error: unknown) => {
  status.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
