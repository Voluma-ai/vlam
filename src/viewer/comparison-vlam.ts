import {
  LinearSRGBColorSpace,
  NoToneMapping,
  Scene,
  REVISION,
  type PerspectiveCamera,
} from 'three';
import { createSplatRenderer, detectSplatDeviceProfile, SplatMesh } from '../lib/core';
import { automaticSortIntervalMs } from '../lib/core/sort-scheduler';
import { loadSplatData } from '../lib/loaders';
import { version } from '../../package.json';
import type { ComparisonAdapter } from './comparison-adapter';
import type { ComparisonConfig } from './comparison-config';
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

/** Construct only the plain full-file VLAM mesh and its renderer. */
export async function createComparisonVlam(
  config: ComparisonConfig,
  url: string,
): Promise<ComparisonAdapter> {
  const useWebGl = config.backend === 'webgl';
  // Decode before allocating a GPU device so a fetch/decode failure leaves no renderer alive.
  const data = await loadSplatData(url);
  const renderer = await createSplatRenderer({
    ...(useWebGl ? { forceWebGL: true } : { requireWebGpu: true }),
    antialias: false,
    // WebGPU timestamps only; WebGL uses EXT_disjoint_timer_query_webgl2 below.
    trackTimestamp: config.timestamps && !useWebGl,
  });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.setSize(config.width, config.height, false);
  const matched = config.preset === 'matched';
  const mesh = new SplatMesh(data, {
    shEvaluation: config.shEvaluation,
    orientation: 'source',
    ...(matched
      ? ({
          performanceProfile: 'quality',
          shBands: 3,
          maxStdDev: 3,
          sortMetric: 'depth',
          minSplatSizePx: 0,
          antialias: false,
          srgbOutput: true,
        } as const)
      : {}),
    ...(config.sh === 0 ? { shBands: 0 } : {}),
  });
  mesh.rotation.x = Math.PI;
  if (matched) renderer.outputColorSpace = LinearSRGBColorSpace;
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
    };
    timestampQueryPool: Partial<Record<'render' | 'compute', ComparisonQueryPool | null>>;
  };
  if (useWebGl) {
    if (backend.isWebGPUBackend === true)
      throw new Error('VLAM WebGL comparison received a WebGPU backend.');
  } else if (!backend.isWebGPUBackend) {
    throw new Error('VLAM comparison requires an actual WebGPU backend.');
  }

  const view = mesh.getUnifiedSourceView();
  const isMobile = detectSplatDeviceProfile()?.isMobile === true;
  const sortStrategy = useWebGl ? 'worker' : 'counting';
  const baseMetadata = {
    engine: 'vlam' as const,
    version,
    threeRevision: REVISION,
    backend: useWebGl ? ('WebGL2' as const) : ('WebGPU' as const),
    sourceSplats: data.count,
    shBands: mesh.shBands,
    activeSplats: mesh.activeSplatCount,
    settings: {
      performanceProfile: mesh.performanceProfile,
      maxStdDev: view.maxStdDev,
      minSplatSizePx: view.minSplatSizePx,
      antialias: view.antialias,
      srgbOutput: view.srgbOutput,
      sortMetric: 'depth',
      sortStrategy,
      sortIntervalMs: 'library adaptive default',
      resolvedSortIntervalMs: automaticSortIntervalMs(data.count, isMobile),
      lod: false,
      outputColorSpace: renderer.outputColorSpace,
      msaa: renderer.samples,
      shEvaluation: config.shEvaluation,
      requestedBackend: config.backend,
    },
    differences: useWebGl
      ? [
          'WebGL2 fallback with asynchronous CPU worker sorting; GPU samples exclude worker duration',
          'Float32 centers/covariances with SOG SH palette (same draw path as WebGPU)',
          'Native VLAM clipping and alpha thresholds; matched preset does not promise identical pixels',
        ]
      : [
          'GPU counting sort; adaptive cadence',
          'Float32 centers/covariances with SOG SH palette',
          'Native VLAM clipping and alpha thresholds; matched preset does not promise identical pixels',
        ],
  };

  /** Wait until the WebGL worker has applied the settle camera's order. */
  const settleWorkerSort = async (camera: PerspectiveCamera): Promise<void> => {
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
  const adapterInfo = backend.device?.adapterInfo;
  return {
    canvas: renderer.domElement,
    diagnostics: () => shEvaluationDiagnostics(mesh),
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
    },
    async settle(camera) {
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
      mesh.dispose();
      renderer.dispose();
    },
  };
}
