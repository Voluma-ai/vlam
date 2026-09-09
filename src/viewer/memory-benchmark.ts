/**
 * Development-only scene-memory benchmark.
 *
 * It deliberately reports browser measurements and VLAM's explicit allocation
 * accounting side by side: neither is relabelled as total device memory.
 */
import * as THREE from 'three/webgpu';
import {
  createWebGPURenderer,
  SplatMesh,
  type SplatData,
  type SplatSortStrategy,
} from '../lib/core';
import { loadSplatData, loadSplatDataFile } from '../lib/loaders';
import { StreamedSplatMesh } from '../lib/streaming';
import { version as vlamVersion } from '../../package.json';
import {
  decodedSplatMemory,
  estimateMeshMemory,
  type DecodedSplatMemory,
} from './memory-accounting';

interface PerformanceMemory {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
}

interface UserAgentMemoryResult {
  readonly bytes: number;
}

interface MemoryPerformance extends Performance {
  readonly memory?: PerformanceMemory;
  measureUserAgentSpecificMemory?: () => Promise<UserAgentMemoryResult>;
}

interface HeapSample {
  readonly elapsedMs: number;
  readonly phase: string;
  readonly usedJsHeapBytes: number;
}

interface MemoryCheckpoint {
  readonly phase: string;
  readonly elapsedMs: number;
  readonly usedJsHeapBytes: number | null;
  readonly userAgentBytes: number | null;
  readonly activeSplats: number;
  readonly streamedCacheBytes: number;
}

const params = new URLSearchParams(globalThis.location.search);
const statusElement = document.querySelector<HTMLElement>('#status');
const resultElement = document.querySelector<HTMLElement>('#result');
const viewportElement = document.querySelector<HTMLElement>('#viewport');
const fileElement = document.querySelector<HTMLInputElement>('#local-file');
const runFileElement = document.querySelector<HTMLButtonElement>('#run-file');
const downloadElement = document.querySelector<HTMLButtonElement>('#download-json');
if (
  !statusElement ||
  !resultElement ||
  !viewportElement ||
  !fileElement ||
  !runFileElement ||
  !downloadElement
) {
  throw new Error('Memory benchmark markup is incomplete.');
}
const status = statusElement;
const result = resultElement;
const viewport = viewportElement;
const fileInput = fileElement;
const runFile = runFileElement;
const download = downloadElement;

const memoryPerformance = performance as MemoryPerformance;
let benchmarkStartedAt = performance.now();
const heapSamples: HeapSample[] = [];
let samplePhase = 'initializing';
let sampleTimer: number | undefined;
let latestReport: unknown = null;

function numberParam(name: string, fallback: number): number {
  const parsed = Number(params.get(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shBandsParam(): 0 | 1 | 2 | 3 | undefined {
  const value = params.get('sh');
  return value === '0' || value === '1' || value === '2' || value === '3'
    ? (Number(value) as 0 | 1 | 2 | 3)
    : undefined;
}

function sortStrategyParam(): SplatSortStrategy {
  const value = params.get('sort');
  return value === 'worker' || value === 'radix' || value === 'exact' ? value : 'counting';
}

function sourceExtension(source: { url: string } | { file: File }): string | null {
  const name = 'url' in source ? new URL(source.url, location.href).pathname : source.file.name;
  const extension = name.match(/\.([^./]+)$/)?.[1];
  return extension?.toLowerCase() ?? null;
}

/** Small worker-free scene for lifecycle smoke tests under parallel CI load. */
function syntheticSplatData(count: number): SplatData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  const width = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (i % width) * 0.1;
    positions[i * 3 + 1] = Math.floor(i / width) * 0.1;
    colors.set([180, 205, 255, 255], i * 4);
    covariances.set([0.04, 0, 0, 0.04, 0, 0.04], i * 6);
  }
  return { count, positions, colors, covariances };
}

function currentUsedHeap(): number | null {
  return memoryPerformance.memory?.usedJSHeapSize ?? null;
}

function takeHeapSample(): void {
  const usedJsHeapBytes = currentUsedHeap();
  if (usedJsHeapBytes === null) return;
  heapSamples.push({
    elapsedMs: performance.now() - benchmarkStartedAt,
    phase: samplePhase,
    usedJsHeapBytes,
  });
}

function startHeapSampling(): void {
  takeHeapSample();
  sampleTimer = globalThis.setInterval(takeHeapSample, 100);
}

function stopHeapSampling(): void {
  if (sampleTimer !== undefined) globalThis.clearInterval(sampleTimer);
  sampleTimer = undefined;
  takeHeapSample();
}

async function userAgentBytes(): Promise<number | null> {
  if (params.get('uaMemory') === '0') return null;
  if (!memoryPerformance.measureUserAgentSpecificMemory) return null;
  try {
    return (await memoryPerformance.measureUserAgentSpecificMemory()).bytes;
  } catch {
    return null;
  }
}

async function settleGarbage(): Promise<boolean> {
  const exposedGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (exposedGc) {
    exposedGc();
    exposedGc();
  }
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  return exposedGc !== undefined;
}

function streamedCacheBytes(mesh: SplatMesh | null): number {
  return mesh instanceof StreamedSplatMesh ? mesh.fetchCounts.cacheBytes : 0;
}

async function checkpoint(phase: string, mesh: SplatMesh | null): Promise<MemoryCheckpoint> {
  samplePhase = phase;
  takeHeapSample();
  const measured = await userAgentBytes();
  return {
    phase,
    elapsedMs: performance.now() - benchmarkStartedAt,
    usedJsHeapBytes: currentUsedHeap(),
    userAgentBytes: measured,
    activeSplats: mesh?.activeSplatCount ?? 0,
    streamedCacheBytes: streamedCacheBytes(mesh),
  };
}

function frameCamera(mesh: SplatMesh, camera: THREE.PerspectiveCamera): void {
  const bounds = mesh.computeSplatBounds();
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.5, 0.1);
  camera.position.set(center.x, center.y, center.z + radius * 2.5);
  camera.lookAt(center);
  camera.updateMatrixWorld();
}

async function renderUntilSettled(
  mesh: SplatMesh,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGPURenderer,
): Promise<{ frames: number; timedOut: boolean }> {
  const timeoutAt = performance.now() + numberParam('settleSeconds', 30) * 1000;
  let frames = 0;
  do {
    mesh.update(camera, renderer);
    renderer.render(scene, camera);
    frames++;
    if (!(mesh instanceof StreamedSplatMesh) || (!mesh.isStreaming && frames >= 2)) {
      return { frames, timedOut: false };
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  } while (performance.now() < timeoutAt);
  return { frames, timedOut: true };
}

function downloadJson(report: unknown): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'vlam-memory-benchmark.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function runBenchmark(source: { url: string } | { file: File }): Promise<void> {
  if (sampleTimer !== undefined) throw new Error('A memory benchmark is already running.');
  status.textContent = 'Initializing renderer…';
  result.textContent = '';
  download.disabled = true;
  heapSamples.length = 0;
  benchmarkStartedAt = performance.now();
  startHeapSampling();

  const checkpoints: MemoryCheckpoint[] = [];
  const forceWebGL = params.get('backend') === 'webgl';
  const floatTextures = params.get('poolFloat') === 'float16' ? 'float16' : 'float32';
  const storageMode = params.get('storage') === 'render-only' ? 'render-only' : 'editable';
  const requestedSort = sortStrategyParam();
  const requestedShBands = shBandsParam();
  const kind = params.get('kind') === 'streamed' && 'url' in source ? 'streamed' : 'static';
  const synthetic = 'url' in source && source.url === 'synthetic';
  let renderer: THREE.WebGPURenderer | null = null;
  const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.01, 10000);
  const scene = new THREE.Scene();
  let mesh: SplatMesh | null = null;
  const retainedDecoded: { data: SplatData | null } = { data: null };
  let decodedBytes: DecodedSplatMemory | null = null;
  let paletteBytes = 0;
  let packedShBands: 0 | 1 | 2 | 3;
  let sourceFormat: string | null = sourceExtension(source);
  let sourceProgress = { loaded: 0, total: 0 };
  let garbageCollectionExposed: boolean;

  try {
    renderer = await createWebGPURenderer({ forceWebGL });
    await renderer.init();
    renderer.setPixelRatio(1);
    renderer.setSize(800, 600, false);
    viewport.replaceChildren(renderer.domElement);
    const backend =
      (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
        ? 'WebGPU'
        : 'WebGL2';
    checkpoints.push(await checkpoint('before-load', null));
    samplePhase = 'loading';
    status.textContent = `Loading ${kind} scene…`;
    const loadStartedAt = performance.now();
    const onProgress = (loaded: number, total: number): void => {
      sourceProgress = { loaded, total };
      takeHeapSample();
    };
    if (kind === 'streamed' && 'url' in source) {
      mesh = await StreamedSplatMesh.load(source.url, {
        budget: Math.floor(numberParam('budget', 1_000_000)),
        maxBudget: Math.floor(numberParam('maxBudget', numberParam('budget', 1_000_000))),
        poolFloatTextures: floatTextures,
        sortStrategy: requestedSort,
        storageMode,
        ...(requestedShBands === undefined ? {} : { shBands: requestedShBands }),
      });
      packedShBands =
        mesh.shBands === 1 || mesh.shBands === 2 || mesh.shBands === 3 ? mesh.shBands : 0;
    } else {
      retainedDecoded.data = synthetic
        ? syntheticSplatData(Math.min(10_000_000, Math.floor(numberParam('syntheticSplats', 64))))
        : 'file' in source
          ? await loadSplatDataFile(source.file, { onProgress })
          : await loadSplatData(source.url, { onProgress });
      const decoded = retainedDecoded.data;
      decodedBytes = decodedSplatMemory(decoded);
      sourceFormat = synthetic ? 'synthetic' : (decoded.format ?? sourceFormat);
      checkpoints.push(await checkpoint('after-decode', null));
      mesh = new SplatMesh(decoded, {
        poolFloatTextures: floatTextures,
        sortStrategy: requestedSort,
        storageMode,
        ...(requestedShBands === undefined ? {} : { shBands: requestedShBands }),
      });
      packedShBands = mesh.shBands > 0 ? (decoded.shPacked?.bands ?? 0) : 0;
      paletteBytes = mesh.shBands > 0 ? (decoded.sh?.palette.byteLength ?? 0) : 0;
    }
    const loadMs = performance.now() - loadStartedAt;
    checkpoints.push(await checkpoint('after-mesh-construction', mesh));
    scene.add(mesh);
    frameCamera(mesh, camera);
    samplePhase = 'first-render';
    status.textContent = 'Uploading and settling scene…';
    const settle = await renderUntilSettled(mesh, scene, camera, renderer);
    checkpoints.push(await checkpoint('after-first-settle', mesh));

    // Static caller-owned SplatData is released here. The earlier checkpoint
    // records the retained-input case; the next one isolates the mesh itself.
    retainedDecoded.data = null;
    garbageCollectionExposed = await settleGarbage();
    checkpoints.push(await checkpoint('settled-without-caller-data', mesh));
    stopHeapSampling();

    // Exercise GPU-only behavior after the comparable settled-memory samples.
    // Picking lazily creates its own render target/material, so running it any
    // earlier would contaminate the R1/R2 memory comparison.
    const gpuPickAfterRelease =
      storageMode === 'render-only'
        ? (await mesh.pick(new THREE.Vector2(0, 0), camera, renderer)) !== null
        : null;

    const effectiveSort: SplatSortStrategy = backend === 'WebGL2' ? 'worker' : requestedSort;
    const memory = estimateMeshMemory(mesh.capacity, {
      floatTextures,
      packedShBands,
      sortStrategy: effectiveSort,
      storageMode,
      paletteBytes,
    });
    const activeSplats = mesh.activeSplatCount;
    const capacity = mesh.capacity;
    const shBands = mesh.shBands;
    const releasedCpuBytes = mesh.releasedCpuBytes;
    const cpuStorageReleased = mesh.cpuStorageReleased;
    const finalCacheBytes = streamedCacheBytes(mesh);
    const streamDiagnostics =
      mesh instanceof StreamedSplatMesh
        ? {
            isStreaming: mesh.isStreaming,
            failedChunkCount: mesh.failedChunkCount,
            fetchCounts: { ...mesh.fetchCounts },
          }
        : null;

    scene.remove(mesh);
    mesh.dispose();
    mesh = null;
    renderer.dispose();
    renderer = null;
    garbageCollectionExposed = (await settleGarbage()) || garbageCollectionExposed;
    checkpoints.push(await checkpoint('after-dispose', null));

    const usedHeap = heapSamples.map((sample) => sample.usedJsHeapBytes);
    const report = {
      schemaVersion: 1,
      environment: {
        versions: { vlam: vlamVersion, threeRevision: THREE.REVISION },
        browser: navigator.userAgent,
        platform: navigator.platform,
        crossOriginIsolated,
        backend,
      },
      configuration: {
        kind,
        source: 'url' in source ? source.url : source.file.name,
        sourceFormat,
        sourceBytes: 'file' in source ? source.file.size : sourceProgress.total || null,
        floatTextures,
        storageMode,
        requestedSort,
        requestedShBands: requestedShBands ?? 'source',
        budget: kind === 'streamed' ? Math.floor(numberParam('budget', 1_000_000)) : null,
        maxBudget:
          kind === 'streamed'
            ? Math.floor(numberParam('maxBudget', numberParam('budget', 1_000_000)))
            : null,
      },
      scene: {
        loadMs,
        sourceProgress,
        activeSplats,
        capacity,
        shBands,
        releasedCpuBytes,
        cpuStorageReleased,
        gpuPickAfterRelease,
        settleFrames: settle.frames,
        settleTimedOut: settle.timedOut,
        streamDiagnostics,
      },
      measured: {
        checkpoints,
        sampledMainThreadJsHeap: {
          available: usedHeap.length > 0,
          intervalMs: 100,
          samples: heapSamples,
          peakBytes: usedHeap.length > 0 ? Math.max(...usedHeap) : null,
        },
        userAgentMemoryAvailable: checkpoints.some((value) => value.userAgentBytes !== null),
        garbageCollectionExposed,
      },
      accounted: {
        decodedSource: decodedBytes,
        mesh: memory,
        streamedCacheBytes: finalCacheBytes,
      },
      limitations: [
        'usedJsHeapBytes is a main-isolate browser metric, not total process memory.',
        'userAgentBytes is reported only when the browser exposes and permits its memory API.',
        'GPU bytes count explicit VLAM allocations; driver padding and renderer-owned resources are excluded.',
        'Repeat runs and compare medians; a single garbage-collected browser measurement is not a regression gate.',
      ],
    };
    latestReport = report;
    Object.assign(globalThis, { __vlamMemoryBenchmark: report });
    result.textContent = JSON.stringify(report, null, 2);
    status.textContent = 'Complete. Repeat the run in a fresh tab and compare medians.';
    download.disabled = false;
    download.onclick = () => downloadJson(latestReport);
  } catch (error) {
    stopHeapSampling();
    mesh?.dispose();
    renderer?.dispose();
    status.textContent = `Failed: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  }
}

runFile.onclick = () => {
  const file = fileInput.files?.[0];
  if (!file) {
    status.textContent = 'Choose a static scene file first.';
    return;
  }
  void runBenchmark({ file });
};

const initialScene = params.get('scene');
if (initialScene) void runBenchmark({ url: initialScene });
