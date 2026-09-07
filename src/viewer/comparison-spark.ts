import { Group, NoToneMapping, Scene, WebGLRenderer, REVISION, type Object3D } from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { ComparisonAdapter } from './comparison-adapter';
import type { ComparisonConfig } from './comparison-config';
import { ComparisonWebGlTimer, type DisjointTimerExtension } from './comparison-gpu';

function isLcc2Url(url: string): boolean {
  return /\.lcc2(?:$|\?)/i.test(url);
}

/** Same LCC2→Three basis StreamedSplatMesh applies; Spark has no LCC2 loader. */
function applyLcc2ToThree(target: Object3D): void {
  target.matrix.set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
  target.matrix.decompose(target.position, target.quaternion, target.scale);
  target.matrixWorldNeedsUpdate = true;
}

/** Construct Spark independently so its workers and GPU allocations never coexist with VLAM. */
export async function createComparisonSpark(
  config: ComparisonConfig,
  url: string,
): Promise<ComparisonAdapter> {
  const renderer = new WebGLRenderer({ antialias: config.msaa });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.setSize(config.width, config.height, false);
  renderer.toneMapping = NoToneMapping;
  const controlled = config.preset === 'controlled';
  const reference = config.preset === 'reference' || config.preset === 'matched';
  const aligned = controlled || reference;
  const maxStdDev = config.maxStdDev ?? (controlled ? Math.sqrt(8) : reference ? 3 : undefined);
  const sortRadial = config.sortMetric
    ? config.sortMetric === 'radial'
    : controlled
      ? true
      : reference
        ? false
        : undefined;
  const spark = new SparkRenderer({
    renderer,
    ...(aligned
      ? {
          enableLod: false,
          minPixelRadius: 0,
          preBlurAmount: 0.3,
          blurAmount: 0,
          encodeLinear: false,
        }
      : {}),
    ...(maxStdDev === undefined ? {} : { maxStdDev }),
    ...(sortRadial === undefined ? {} : { sortRadial }),
  });
  const streamed = isLcc2Url(url);
  const root = new Group();
  const meshes: SplatMesh[] = [];
  const meshOptions = aligned ? { lod: false, enableLod: false } : {};
  try {
    if (streamed) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Spark LCC2 manifest failed: HTTP ${response.status}.`);
      const manifest: unknown = await response.json();
      const files =
        typeof manifest === 'object' &&
        manifest !== null &&
        'root' in manifest &&
        typeof manifest.root === 'object' &&
        manifest.root !== null &&
        'splatFiles' in manifest.root
          ? manifest.root.splatFiles
          : undefined;
      if (!Array.isArray(files) || files.some((name) => typeof name !== 'string'))
        throw new Error('LCC2 manifest is missing splatFiles.');
      applyLcc2ToThree(root);
      const base = new URL('.', new URL(url, location.href));
      for (const file of files as string[]) {
        const mesh = new SplatMesh({ url: new URL(file, base).href, ...meshOptions });
        root.add(mesh);
        meshes.push(mesh);
      }
    } else {
      const mesh = new SplatMesh({ url, ...meshOptions });
      mesh.rotation.x = Math.PI;
      root.add(mesh);
      meshes.push(mesh);
    }
    await Promise.all(meshes.map((mesh) => mesh.initialized));
  } catch (error) {
    for (const mesh of meshes) mesh.dispose();
    spark.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
  if (config.sh !== undefined) for (const mesh of meshes) mesh.maxSh = config.sh;
  const scene = new Scene();
  scene.add(spark, root);
  const gl = renderer.getContext();
  if (!(gl instanceof WebGL2RenderingContext)) {
    for (const mesh of meshes) mesh.dispose();
    spark.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    throw new Error('Spark comparison requires WebGL2.');
  }
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
      sourceSplats: meshes.reduce((sum, mesh) => sum + (mesh.splats?.getNumSplats() ?? 0), 0),
      shBands: meshes.length
        ? Math.min(...meshes.map((mesh) => Math.min(mesh.maxSh, mesh.splats?.getNumSh() ?? 0)))
        : 0,
      settings: {
        maxStdDev: spark.maxStdDev,
        sortRadial: spark.sortRadial,
        minSortIntervalMs: spark.minSortIntervalMs,
        enableLod: spark.enableLod,
        meshEnableLod: streamed
          ? 'per-tile SOG (Spark has no LCC2 octree cut)'
          : (meshes[0]?.enableLod ?? 'automatic (no tree requested)'),
        minPixelRadius: spark.minPixelRadius,
        maxPixelRadius: spark.maxPixelRadius,
        minAlpha: spark.minAlpha,
        preBlurAmount: spark.preBlurAmount,
        blurAmount: spark.blurAmount,
        encodeLinear: spark.encodeLinear,
        clipXY: spark.clipXY,
        outputColorSpace: renderer.outputColorSpace,
        msaa: renderer.getContextAttributes()?.antialias === true ? 'enabled' : 0,
      },
      differences: [
        ...(streamed
          ? [
              'Spark has no LCC2 reader; every listed SOG tile is fully decoded (all LOD levels plus env)',
            ]
          : []),
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
        const deadline = performance.now() + (streamed ? 120000 : 30000);
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
      for (const mesh of meshes) mesh.dispose();
      spark.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
