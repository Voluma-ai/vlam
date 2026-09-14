import type { PerspectiveCamera } from 'three';
import * as pc from 'playcanvas';
import type { ComparisonAdapter } from './comparison-adapter';
import { ComparisonPlayCanvasTimer } from './comparison-gpu';
import { comparisonAssetKind, type ComparisonConfig } from './comparison-config';

/** Whole-file SOG captures only; streamed LCC2/RAD are out of this adapter's scope. */
const FILE_SPLAT_BUDGET = 20_000_000;

const RENDERER_NAMES: Record<number, string> = {
  [pc.GSPLAT_RENDERER_AUTO]: 'auto',
  [pc.GSPLAT_RENDERER_RASTER_CPU_SORT]: 'raster-cpu-sort',
  [pc.GSPLAT_RENDERER_RASTER_GPU_SORT]: 'raster-gpu-sort',
  [pc.GSPLAT_RENDERER_COMPUTE]: 'compute',
};

/** `createGraphicsDevice` is declared as `Promise<any>`; name what we touch. */
type PlayCanvasDevice = pc.GraphicsDevice & {
  deviceType: string;
  supportsTimestampQuery: boolean;
};

function syncPlayCanvasCamera(entity: pc.Entity, camera: PerspectiveCamera): void {
  entity.setPosition(camera.position.x, camera.position.y, camera.position.z);
  entity.setRotation(
    camera.quaternion.x,
    camera.quaternion.y,
    camera.quaternion.z,
    camera.quaternion.w,
  );
  const pcCamera = entity.camera;
  if (!pcCamera) return;
  pcCamera.fov = camera.fov;
  pcCamera.aspectRatio = camera.aspect;
  pcCamera.horizontalFov = false;
  pcCamera.nearClip = camera.near;
  pcCamera.farClip = camera.far;
}

/** Construct PlayCanvas independently so its GPU allocations never coexist with VLAM. */
export async function createComparisonPlayCanvas(
  config: ComparisonConfig,
  url: string,
): Promise<ComparisonAdapter> {
  const kind = comparisonAssetKind(url);
  if (kind !== 'file') {
    throw new Error('PlayCanvas comparison currently supports whole-file SOG captures only.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = config.width;
  canvas.height = config.height;
  // `pc.Application`'s constructor is synchronous and therefore cannot create a
  // WebGPU device: it silently yields WebGL2, where the unified GSplat renderer
  // falls back to CPU sorting. Awaiting `createGraphicsDevice` is the only way
  // to reach the same backend SuperSplat runs on.
  const device = (await pc.createGraphicsDevice(canvas, {
    deviceTypes: [pc.DEVICETYPE_WEBGPU],
    antialias: config.msaa,
    powerPreference: 'high-performance',
  })) as PlayCanvasDevice;
  if (device.deviceType !== pc.DEVICETYPE_WEBGPU) {
    device.destroy();
    throw new Error(
      `PlayCanvas comparison requires a WebGPU device; got "${String(device.deviceType)}".`,
    );
  }
  device.maxPixelRatio = 1;
  const appOptions = new pc.AppOptions();
  appOptions.graphicsDevice = device;
  appOptions.componentSystems = [pc.CameraComponentSystem, pc.GSplatComponentSystem];
  appOptions.resourceHandlers = [pc.GSplatHandler, pc.TextureHandler];
  const app = new pc.AppBase(canvas);
  app.init(appOptions);
  app.setCanvasFillMode(pc.FILLMODE_NONE);
  app.setCanvasResolution(pc.RESOLUTION_FIXED, config.width, config.height);
  app.autoRender = false;
  const gsplat = app.scene.gsplat;
  gsplat.splatBudget = FILE_SPLAT_BUDGET;
  gsplat.renderer = pc.GSPLAT_RENDERER_RASTER_GPU_SORT;
  if (config.sortMetric === 'radial') gsplat.radialSorting = true;
  if (config.sortMetric === 'depth') gsplat.radialSorting = false;
  if (config.minPixelSize !== undefined) gsplat.minPixelSize = config.minPixelSize;
  if (config.minContribution !== undefined) gsplat.minContribution = config.minContribution;
  const cameraEntity = new pc.Entity('camera');
  cameraEntity.addComponent('camera', {
    fov: 45,
    nearClip: 0.01,
    farClip: 10_000,
    clearColor: new pc.Color(0, 0, 0, 1),
    aspectRatioMode: pc.ASPECT_MANUAL,
    aspectRatio: config.width / config.height,
  });
  app.root.addChild(cameraEntity);
  app.start();
  const asset = new pc.Asset('comparison-splat', 'gsplat', { url });
  app.assets.add(asset);
  try {
    await new Promise<void>((resolve, reject) => {
      asset.ready(() => resolve());
      asset.on('error', (error: unknown) =>
        reject(error instanceof Error ? error : new Error(String(error))),
      );
      app.assets.load(asset);
    });
  } catch (error) {
    app.destroy();
    throw error;
  }
  const splat = new pc.Entity('splat');
  splat.addComponent('gsplat', { asset });
  splat.setLocalEulerAngles(180, 0, 0);
  app.root.addChild(splat);
  const resource = asset.resource as { numSplats?: number; splatCount?: number } | null;
  const sourceSplats = resource?.numSplats ?? resource?.splatCount ?? 0;
  const profiler = device.gpuProfiler;
  const timestamps = Boolean(device.supportsTimestampQuery);
  if (timestamps) profiler.enabled = true;
  const timer = new ComparisonPlayCanvasTimer(timestamps, profiler);
  /** The GSplat renderer only resolves once a frame has been submitted. */
  let resolvedRenderer = -1;
  return {
    canvas,
    metadata: {
      engine: 'playcanvas',
      version: '2.22.1',
      backend: 'WebGPU',
      sourceSplats,
      settings: {
        deviceType: device.deviceType,
        splatBudget: gsplat.splatBudget,
        renderer: gsplat.renderer,
        rendererName: RENDERER_NAMES[gsplat.renderer] ?? 'unknown',
        minPixelSize: gsplat.minPixelSize,
        minContribution: gsplat.minContribution,
        alphaClipForward: gsplat.alphaClipForward,
        radialSorting: gsplat.radialSorting,
        msaa: config.msaa ? 'enabled' : 0,
      },
      differences: [
        'PlayCanvas 2.22.1 unified GSplat renderer (hybrid GPU-sort on WebGPU)',
        'Default contribution culls stay on unless minPixelSize/minContribution are set',
        `splatBudget raised to ${FILE_SPLAT_BUDGET} so a whole-file SOG is not LOD-capped at 1M`,
        'GPU timings come from PlayCanvas GpuProfiler pass timestamps, not three.js query pools',
      ],
    },
    diagnostics() {
      return {
        deviceType: device.deviceType,
        requestedRenderer: RENDERER_NAMES[gsplat.renderer] ?? gsplat.renderer,
        resolvedRenderer: RENDERER_NAMES[resolvedRenderer] ?? resolvedRenderer,
        supportsTimestampQuery: timestamps,
        sampledFrames: timer.samples.length,
        gpuTiming: timer.accounting,
        gpuPasses: timer.passMedians(),
      };
    },
    async settle(camera) {
      syncPlayCanvasCamera(cameraEntity, camera);
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        app.render();
        const count = splat.gsplat?.enabled ? sourceSplats : 0;
        if (count > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      app.render();
      resolvedRenderer = gsplat.currentRenderer;
    },
    frame(camera, frame, sampling) {
      syncPlayCanvasCamera(cameraEntity, camera);
      const start = performance.now();
      app.render();
      const cpuMs = performance.now() - start;
      timer.frame(device.renderVersion, frame, sampling);
      resolvedRenderer = gsplat.currentRenderer;
      return {
        cpuMs,
        draws: 1,
        activeSplats: sourceSplats,
      };
    },
    reset() {
      timer.reset();
    },
    finish() {
      return timer.finish(() => app.render());
    },
    gpu() {
      return {
        render: timer.samples.slice(),
        compute: [],
        supported: timestamps,
        rejected: timer.accounting.rejected,
        accounting: timer.accounting,
        coverage: timestamps
          ? 'PlayCanvas GpuProfiler results identified by device renderVersion; every timed submission is resolved or rejected before reporting'
          : 'Device lacks timestamp-query; CPU and rAF medians only',
      };
    },
    dispose() {
      timer.dispose();
      splat.destroy();
      cameraEntity.destroy();
      app.destroy();
    },
  };
}
