import { NoToneMapping, Scene, WebGLRenderer, REVISION } from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { ComparisonAdapter } from './comparison-adapter';
import type { ComparisonConfig } from './comparison-config';
import { ComparisonWebGlTimer, type DisjointTimerExtension } from './comparison-gpu';

/** Construct Spark independently so its workers and GPU allocations never coexist with VLAM. */
export async function createComparisonSpark(
  config: ComparisonConfig,
  url: string,
): Promise<ComparisonAdapter> {
  const renderer = new WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.setSize(config.width, config.height, false);
  renderer.toneMapping = NoToneMapping;
  const matched = config.preset === 'matched';
  const spark = new SparkRenderer({
    renderer,
    ...(matched
      ? {
          maxStdDev: 3,
          sortRadial: false,
          enableLod: false,
          minPixelRadius: 0,
          preBlurAmount: 0.3,
          blurAmount: 0,
          encodeLinear: false,
        }
      : {}),
  });
  const mesh = new SplatMesh({ url, ...(matched ? { lod: false, enableLod: false } : {}) });
  try {
    await mesh.initialized;
  } catch (error) {
    mesh.dispose();
    spark.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
  if (config.sh === 0) mesh.maxSh = 0;
  mesh.rotation.x = Math.PI;
  const scene = new Scene();
  scene.add(spark, mesh);
  const gl = renderer.getContext();
  if (!(gl instanceof WebGL2RenderingContext)) throw new Error('Spark comparison requires WebGL2.');
  const timer = new ComparisonWebGlTimer(
    gl,
    config.timestamps
      ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerExtension | null)
      : null,
  );
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    canvas: renderer.domElement,
    metadata: {
      engine: 'spark',
      version: '2.1.0',
      threeRevision: REVISION,
      backend: 'WebGL2',
      gpu: debug ? (gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string) : null,
      sourceSplats: mesh.splats?.getNumSplats(),
      shBands: Math.min(mesh.maxSh, mesh.splats?.getNumSh() ?? 0),
      settings: {
        maxStdDev: spark.maxStdDev,
        sortRadial: spark.sortRadial,
        minSortIntervalMs: spark.minSortIntervalMs,
        enableLod: spark.enableLod,
        meshEnableLod: mesh.enableLod ?? 'automatic (no tree requested)',
        minPixelRadius: spark.minPixelRadius,
        maxPixelRadius: spark.maxPixelRadius,
        minAlpha: spark.minAlpha,
        preBlurAmount: spark.preBlurAmount,
        blurAmount: spark.blurAmount,
        encodeLinear: spark.encodeLinear,
        clipXY: spark.clipXY,
        outputColorSpace: renderer.outputColorSpace,
        msaa: 0,
      },
      differences: [
        'Asynchronous worker sorting; main-thread and GPU samples exclude worker duration',
        'Spark packed splats and native clipping/alpha thresholds',
        'GPU queries cover synchronous render-call work, not deferred accumulator work outside that call',
      ],
    },
    async settle(camera) {
      const autoUpdate = spark.autoUpdate;
      spark.autoUpdate = false;
      try {
        // update() can return while an older worker sort is still running.
        // Drain it first, then explicitly generate and sort the final camera.
        const deadline = performance.now() + 30000;
        const waitForSort = async (includeQueued: boolean): Promise<void> => {
          while (spark.sorting || (includeQueued && spark.sortDirty)) {
            if (performance.now() > deadline)
              throw new Error('Spark initial/final sort timed out.');
            await new Promise((resolve) => setTimeout(resolve, 16));
          }
        };
        await waitForSort(false);
        scene.updateMatrixWorld(true);
        await spark.update({ scene, camera });
        await waitForSort(true);
        renderer.render(scene, camera);
      } finally {
        spark.autoUpdate = autoUpdate;
      }
    },
    frame(camera, frame, sampling) {
      timer.begin(frame, sampling);
      const start = performance.now();
      renderer.render(scene, camera);
      const cpuMs = performance.now() - start;
      timer.end();
      return { cpuMs, draws: renderer.info.render.calls, activeSplats: spark.activeSplats };
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
          'Every eighth measured synchronous render call, including Spark auto-update; excludes worker and deferred work',
      };
    },
    dispose() {
      timer.reset();
      mesh.dispose();
      spark.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
