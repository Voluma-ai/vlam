import { LinearSRGBColorSpace, NoToneMapping, Scene, REVISION } from 'three';
import { createSplatRenderer, detectSplatDeviceProfile, SplatMesh } from '../lib/core';
import { automaticSortIntervalMs } from '../lib/core/sort-scheduler';
import { loadSplatData } from '../lib/loaders';
import { version } from '../../package.json';
import type { ComparisonAdapter } from './comparison-adapter';
import type { ComparisonConfig } from './comparison-config';
import { ComparisonWebGpuTimer, type ComparisonQueryPool } from './comparison-gpu';

/** Construct only the plain full-file VLAM mesh and its renderer. */
export async function createComparisonVlam(
  config: ComparisonConfig,
  url: string,
): Promise<ComparisonAdapter> {
  // Decode before allocating a GPU device so a fetch/decode failure leaves no renderer alive.
  const data = await loadSplatData(url);
  const renderer = await createSplatRenderer({
    requireWebGpu: true,
    antialias: false,
    trackTimestamp: config.timestamps,
  });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.setSize(config.width, config.height, false);
  const matched = config.preset === 'matched';
  const mesh = new SplatMesh(data, {
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
  if (!backend.isWebGPUBackend)
    throw new Error('VLAM comparison requires an actual WebGPU backend.');
  const timer = new ComparisonWebGpuTimer(
    config.timestamps && backend.hasTimestamp,
    () => backend.timestampQueryPool,
    (kind) => renderer.resolveTimestampsAsync(kind),
  );
  const view = mesh.getUnifiedSourceView();
  const adapterInfo = backend.device?.adapterInfo;
  return {
    canvas: renderer.domElement,
    metadata: {
      engine: 'vlam',
      version,
      threeRevision: REVISION,
      backend: 'WebGPU',
      gpu: adapterInfo
        ? {
            vendor: adapterInfo.vendor,
            architecture: adapterInfo.architecture,
            device: adapterInfo.device,
            description: adapterInfo.description,
          }
        : null,
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
        sortStrategy: 'counting',
        sortIntervalMs: 'library adaptive default',
        resolvedSortIntervalMs: automaticSortIntervalMs(
          data.count,
          detectSplatDeviceProfile()?.isMobile === true,
        ),
        lod: false,
        outputColorSpace: renderer.outputColorSpace,
        msaa: renderer.samples,
      },
      differences: [
        'GPU counting sort; adaptive cadence',
        'Float32 centers/covariances with SOG SH palette',
        'Native VLAM clipping and alpha thresholds; matched preset does not promise identical pixels',
      ],
    },
    async settle(camera) {
      mesh.update(camera, renderer);
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
