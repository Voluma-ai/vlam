import {
  LinearSRGBColorSpace,
  NoToneMapping,
  RenderTarget,
  Scene,
  REVISION,
  UnsignedByteType,
  type PerspectiveCamera,
} from 'three';
import { createWebGPURenderer, detectSplatDeviceProfile, SplatMesh } from '../lib/core';
import { automaticSortIntervalMs } from '../lib/core/sort-scheduler';
import { loadSplatData } from '../lib/loaders';
import { StreamedSplatMesh } from '../lib/streaming';
import { version } from '../../package.json';
import type { ComparisonAdapter } from './comparison-adapter';
import { comparisonAssetKind, type ComparisonConfig } from './comparison-config';
import { shEvaluationDiagnostics } from './sh-evaluation-diagnostics';
import {
  ComparisonWebGlTimer,
  ComparisonWebGpuTimer,
  type ComparisonQueryPool,
  type DisjointTimerExtension,
} from './comparison-gpu';

/** Narrow access to the WebGL worker sorter's completion counters for settle. */
interface WorkerSortSnapshot {
  submittedCount: number;
  completedCount: number;
}

/** Construct the VLAM mesh (streamed `.lcc2` / `.rad`, or a full-file SOG) and its renderer. */
export async function createComparisonVlam(
  config: ComparisonConfig,
  url: string,
): Promise<ComparisonAdapter> {
  const useWebGl = config.backend === 'webgl';
  const kind = comparisonAssetKind(url);
  const streamed = kind !== 'file';
  const controlled = config.preset === 'controlled';
  const reference = config.preset === 'reference' || config.preset === 'matched';
  const proposed = config.preset === 'proposed';
  const aligned = controlled || reference;
  const resolvedMaxStdDev =
    config.maxStdDev ?? (controlled || proposed ? Math.sqrt(8) : reference ? 3 : undefined);
  const resolvedSortMetric = config.sortMetric ?? (controlled || proposed ? 'radial' : undefined);
  const meshOptions = {
    shEvaluation: config.shEvaluation,
    projectionStrategy: config.projectionStrategy,
    orientation: 'source' as const,
    ...(aligned
      ? ({
          performanceProfile: 'quality' as const,
          shBands: 3 as const,
          minSplatSizePx: 0,
          antialias: false,
          srgbOutput: true,
        } as const)
      : {}),
    ...(resolvedMaxStdDev === undefined ? {} : { maxStdDev: resolvedMaxStdDev }),
    ...(resolvedSortMetric === undefined ? {} : { sortMetric: resolvedSortMetric }),
    ...(config.sortStrategy === undefined ? {} : { sortStrategy: config.sortStrategy }),
    ...(config.sortIntervalMs === undefined ? {} : { sortIntervalMs: config.sortIntervalMs }),
    ...(config.sh === undefined ? {} : { shBands: config.sh }),
  };
  // Decode / open the manifest before allocating a GPU device so a fetch failure
  // leaves no renderer alive.
  const mesh = streamed
    ? await StreamedSplatMesh.load(url, {
        ...meshOptions,
        ...(kind === 'lcc2' ? { lodBaseDistance: 10 } : {}),
      })
    : new SplatMesh(await loadSplatData(url), meshOptions);
  // Goose and hotel are Y-down captures; LCC2 already stands up via formatTransform.
  if (kind !== 'lcc2') mesh.rotation.x = Math.PI;
  const sourceSplats =
    mesh instanceof StreamedSplatMesh
      ? (mesh.contentSplatCount ?? mesh.maxBudget)
      : mesh.activeSplatCount;
  let renderer;
  try {
    renderer = await createWebGPURenderer({
      ...(useWebGl ? { forceWebGL: true } : { requireWebGpu: true }),
      antialias: config.msaa,
      // WebGPU timestamps only; WebGL uses EXT_disjoint_timer_query_webgl2 below.
      trackTimestamp: config.timestamps && !useWebGl,
    });
    await renderer.init();
  } catch (error) {
    mesh.dispose();
    throw error;
  }
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.setSize(config.width, config.height, false);
  if (aligned) renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  const scene = new Scene();
  scene.add(mesh);
  // This r185 backend surface is absent from @types/three. No library API depends on it.
  const backend = renderer.backend as unknown as {
    isWebGPUBackend?: boolean;
    isWebGLBackend?: boolean;
    hasTimestamp: boolean;
    device?: {
      adapterInfo?: {
        vendor?: string;
        architecture?: string;
        device?: string;
        description?: string;
      };
      limits?: {
        maxStorageBufferBindingSize?: number;
        maxBufferSize?: number;
        maxComputeWorkgroupsPerDimension?: number;
        maxStorageBuffersPerShaderStage?: number;
      };
      addEventListener?: (
        type: string,
        listener: (event: { error?: { message?: string }; preventDefault?: () => void }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        listener: (event: { error?: { message?: string }; preventDefault?: () => void }) => void,
      ) => void;
      lost?: Promise<{ reason?: string; message?: string }>;
    };
    timestampQueryPool: Partial<Record<'render' | 'compute', ComparisonQueryPool | null>>;
  };
  const deviceErrors: string[] = [];
  let deviceLost: { reason?: string; message?: string } | null = null;
  const onUncapturedError = (event: {
    error?: { message?: string };
    preventDefault?: () => void;
  }): void => {
    event.preventDefault?.();
    deviceErrors.push(event.error?.message ?? 'Unknown WebGPU validation error.');
  };
  backend.device?.addEventListener?.('uncapturederror', onUncapturedError);
  void backend.device?.lost?.then((info) => {
    deviceLost = info;
  });
  if (useWebGl) {
    if (backend.isWebGPUBackend === true)
      throw new Error('VLAM WebGL comparison received a WebGPU backend.');
  } else if (!backend.isWebGPUBackend) {
    throw new Error('VLAM comparison requires an actual WebGPU backend.');
  }

  const view = mesh.getUnifiedSourceView();
  const isMobile = detectSplatDeviceProfile()?.isMobile === true;
  const sortStrategy = useWebGl ? 'worker' : (config.sortStrategy ?? 'counting');
  const baseMetadata = {
    engine: 'vlam' as const,
    version,
    threeRevision: REVISION,
    backend: useWebGl ? ('WebGL2' as const) : ('WebGPU' as const),
    sourceSplats,
    shBands: mesh.shBands,
    activeSplats: mesh.activeSplatCount,
    settings: {
      performanceProfile: mesh.performanceProfile,
      maxStdDev: view.maxStdDev,
      minSplatSizePx: view.minSplatSizePx,
      antialias: view.antialias,
      srgbOutput: view.srgbOutput,
      sortMetric: resolvedSortMetric ?? 'depth',
      sortStrategy,
      sortIntervalMs: config.sortIntervalMs ?? 'library adaptive default',
      resolvedSortIntervalMs: automaticSortIntervalMs(sourceSplats, isMobile),
      lod: streamed,
      radStrategy: mesh instanceof StreamedSplatMesh ? mesh.radStrategy : null,
      outputColorSpace: renderer.outputColorSpace,
      msaa: renderer.samples,
      shEvaluation: config.shEvaluation,
      projectionStrategy: config.projectionStrategy,
      projectionMemory: mesh.projectionMemoryBytes,
      requestedBackend: config.backend,
    },
    differences: [
      ...(kind === 'lcc2'
        ? ['Streamed LCC2 octree cut with a device splat budget; not a fully decoded mesh']
        : []),
      ...(kind === 'rad'
        ? [
            'Streamed Spark `.rad` with a device splat budget (prefix or page-table); not a fully decoded mesh',
          ]
        : []),
      ...(useWebGl
        ? [
            'WebGL2 fallback with asynchronous CPU worker sorting; GPU samples exclude worker duration',
            'Float32 centers/covariances with SOG SH palette (same draw path as WebGPU)',
            'Native VLAM clipping and alpha thresholds; matched preset does not promise identical pixels',
          ]
        : [
            'GPU counting sort; adaptive cadence',
            'Float32 centers/covariances with SOG SH palette',
            'Native VLAM clipping and alpha thresholds; matched preset does not promise identical pixels',
          ]),
    ],
  };

  const awaitCoverage = async (camera: PerspectiveCamera): Promise<void> => {
    if (!(mesh instanceof StreamedSplatMesh)) return;
    const deadline = performance.now() + 120000;
    const timedOut = (label: string): Error => {
      throw new Error(`VLAM ${label} timed out.`);
    };
    while (mesh.initialRevealState.status === 'pending') {
      if (performance.now() > deadline) timedOut('LCC2 coverage hold');
      mesh.update(camera, renderer);
      renderer.render(scene, camera);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    if (kind !== 'rad') return;
    // Page-table `.rad` does not arm the LCC coverage hold. Wait until the
    // frontier has something to draw and reports a complete first cut.
    while (mesh.activeSplatCount === 0 || !mesh.frontierState.frontierConverged) {
      if (performance.now() > deadline) timedOut('RAD frontier settle');
      mesh.update(camera, renderer);
      renderer.render(scene, camera);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  };

  /** Wait until the WebGL worker has applied the settle camera's order. */
  const settleWorkerSort = async (camera: PerspectiveCamera): Promise<void> => {
    await awaitCoverage(camera);
    const host = mesh as unknown as {
      sorter?: { kind?: string; snapshot?: () => WorkerSortSnapshot };
    };
    const deadline = performance.now() + 30000;
    mesh.update(camera, renderer);
    // A second identical update signals the settled pose to the adaptive scheduler.
    mesh.update(camera, renderer);
    const sorter = host.sorter;
    if (sorter?.kind !== 'worker' || !sorter.snapshot) {
      renderer.render(scene, camera);
      return;
    }
    const target = sorter.snapshot().submittedCount;
    while (sorter.snapshot().completedCount < target) {
      if (performance.now() > deadline) throw new Error('VLAM WebGL worker sort timed out.');
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    renderer.render(scene, camera);
  };

  if (useWebGl) {
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext))
      throw new Error('VLAM WebGL comparison requires WebGL2.');
    const timer = new ComparisonWebGlTimer(
      gl,
      config.timestamps
        ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerExtension | null)
        : null,
    );
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      canvas: renderer.domElement,
      diagnostics: () => shEvaluationDiagnostics(mesh),
      metadata: {
        ...baseMetadata,
        gpu: debug ? (gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string) : null,
      },
      async settle(camera) {
        await settleWorkerSort(camera);
      },
      frame(camera, frame, sampling) {
        timer.begin(frame, sampling);
        const start = performance.now();
        mesh.update(camera, renderer);
        renderer.render(scene, camera);
        const cpuMs = performance.now() - start;
        timer.end();
        return {
          cpuMs,
          draws: renderer.info.render.drawCalls,
          activeSplats: mesh.activeSplatCount,
        };
      },
      reset() {
        timer.reset();
      },
      finish() {
        return timer.finish();
      },
      gpu() {
        return {
          render: timer.samples,
          compute: [],
          supported: timer.extension !== null,
          rejected: timer.rejected,
          coverage:
            'Every eighth measured synchronous update+render call; excludes CPU worker sort duration',
        };
      },
      dispose() {
        timer.reset();
        mesh.dispose();
        renderer.dispose();
      },
    };
  }

  const timer = new ComparisonWebGpuTimer(
    config.timestamps && backend.hasTimestamp,
    () => backend.timestampQueryPool,
    (kind) => renderer.resolveTimestampsAsync(kind),
  );
  const captureTarget = new RenderTarget(config.width, config.height, {
    type: UnsignedByteType,
    depthBuffer: true,
  });
  captureTarget.texture.colorSpace = renderer.outputColorSpace;
  const adapterInfo = backend.device?.adapterInfo;
  let gpuVisibleCount: number | null = null;
  return {
    canvas: renderer.domElement,
    diagnostics: () => ({
      ...shEvaluationDiagnostics(mesh),
      projection: {
        requested: mesh.projectionStrategy,
        ...mesh.projectionStrategyStatus,
        visibleCount: gpuVisibleCount,
        visibleRatio:
          gpuVisibleCount === null || mesh.activeSplatCount === 0
            ? null
            : gpuVisibleCount / mesh.activeSplatCount,
        memory: mesh.projectionMemoryBytes,
        dispatches: mesh.projectionDispatchCounts,
      },
      deviceErrors: [...deviceErrors],
      deviceLost,
    }),
    metadata: {
      ...baseMetadata,
      gpu: adapterInfo
        ? {
            vendor: adapterInfo.vendor,
            architecture: adapterInfo.architecture,
            device: adapterInfo.device,
            description: adapterInfo.description,
          }
        : null,
      limits: backend.device?.limits
        ? {
            maxStorageBufferBindingSize: backend.device.limits.maxStorageBufferBindingSize ?? null,
            maxBufferSize: backend.device.limits.maxBufferSize ?? null,
            maxComputeWorkgroupsPerDimension:
              backend.device.limits.maxComputeWorkgroupsPerDimension ?? null,
            maxStorageBuffersPerShaderStage:
              backend.device.limits.maxStorageBuffersPerShaderStage ?? null,
          }
        : null,
    },
    async settle(camera) {
      await awaitCoverage(camera);
      mesh.update(camera, renderer);
      // Lazy module loading must finish before timed warm-up starts. A fallback
      // remains explicit in diagnostics instead of masquerading as compute SH.
      const deadline = performance.now() + 30000;
      while (shEvaluationDiagnostics(mesh).reason === 'loading-compute-module') {
        if (performance.now() > deadline) throw new Error('SH compute initialization timed out.');
        await new Promise((resolve) => setTimeout(resolve, 16));
        mesh.update(camera, renderer);
      }
      // A second identical update signals the settled pose to the adaptive
      // scheduler, bypassing its moving-camera cadence outside timed sampling.
      mesh.update(camera, renderer);
      renderer.render(scene, camera);
      timer.frame(-1, false);
      await timer.finish();
      // Initial sort completion only; never wait for the GPU in the measured loop.
      await renderer.getArrayBufferAsync(view.sourceIndex);
      gpuVisibleCount = await mesh.readGpuVisibleSplatCount();
    },
    async capture(camera) {
      const previousTarget = renderer.getRenderTarget();
      try {
        mesh.update(camera, renderer);
        renderer.setRenderTarget(captureTarget);
        renderer.clear();
        renderer.render(scene, camera);
      } finally {
        renderer.setRenderTarget(previousTarget);
      }
      const source = await renderer.readRenderTargetPixelsAsync(
        captureTarget,
        0,
        0,
        config.width,
        config.height,
      );
      gpuVisibleCount = await mesh.readGpuVisibleSplatCount();
      const rowBytes = config.width * 4;
      const sourceStride =
        config.height > 1 ? (source.byteLength - rowBytes) / (config.height - 1) : rowBytes;
      if (!Number.isInteger(sourceStride) || sourceStride < rowBytes) {
        throw new Error('Unexpected WebGPU screenshot row layout.');
      }
      const pixels = new Uint8ClampedArray(rowBytes * config.height);
      const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      for (let row = 0; row < config.height; row++) {
        pixels.set(
          bytes.subarray(row * sourceStride, row * sourceStride + rowBytes),
          row * rowBytes,
        );
      }
      const canvas = document.createElement('canvas');
      canvas.width = config.width;
      canvas.height = config.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not create WebGPU screenshot canvas.');
      context.putImageData(new ImageData(pixels, config.width, config.height), 0, 0);
      return canvas.toDataURL('image/png');
    },
    frame(camera, frame, sampling) {
      const start = performance.now();
      mesh.update(camera, renderer);
      renderer.render(scene, camera);
      const cpuMs = performance.now() - start;
      timer.frame(frame, sampling);
      return { cpuMs, draws: renderer.info.render.drawCalls, activeSplats: mesh.activeSplatCount };
    },
    reset() {
      timer.reset();
    },
    finish() {
      return timer.finish();
    },
    gpu() {
      return {
        ...timer.samples,
        supported: timer.enabled,
        coverage:
          'All timestamped render/compute passes, grouped by submitted frame; no CPU or queue wait time',
      };
    },
    dispose() {
      backend.device?.removeEventListener?.('uncapturederror', onUncapturedError);
      captureTarget.dispose();
      mesh.dispose();
      renderer.dispose();
    },
  };
}
