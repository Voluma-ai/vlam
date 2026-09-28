import * as THREE from 'three';
import { installRadSelectionSnapshot, copyResidentRadSelection } from './rad-selection-snapshot';
import { SparkRenderer, SparkXr, SplatMesh } from '@sparkjsdev/spark';
import { alignXrRigToCamera, captureXrCameraState, restoreXrCameraState, xrHeadDrifted } from './xr-session';

const params = new URLSearchParams(location.search);
const budget = Number(params.get('budget') ?? 200000);
const mode = params.get('mode') === 'matched' ? 'matched' : params.get('mode') === 'optimized' ? 'optimized' : 'controlled';
const motion = params.get('xrMotion') ?? 'stationary';
const sceneUrl = params.get('scene') ?? '/@fs/home/jack/Repos/vlam/.tmp/benchmark-assets/HOTEL.clean.comp-lod.rad';
const status = document.querySelector<HTMLElement>('#status')!;
const result = document.querySelector<HTMLElement>('#result')!;
const button = document.querySelector<HTMLButtonElement>('#enter-vr')!;
const fullResolution = mode === 'controlled';
const scale = mode === 'matched' ? Number(params.get('xrScale')) || 0.5 : fullResolution ? 1 : 0.5;
const cutoff = Number(params.get('cutoff')) || (mode === 'optimized' ? Math.sqrt(5) : 3);
const sortRadial = mode === 'matched' ? params.get('sortMetric') === 'radial' : !fullResolution;
const sortIntervalMs = mode === 'matched' ? Number(params.get('sortIntervalMs')) || 33 : fullResolution ? 0 : 50;
const fixedFoveation = mode === 'matched' ? Number(params.get('foveation') ?? 1) : fullResolution ? 0 : 1;
const vectorParam = (name: string, fallback: [number, number, number]): THREE.Vector3 => {
  const values = params.get(name)?.split(',').map(Number);
  return new THREE.Vector3(...(values?.length === 3 && values.every(Number.isFinite) ? values as [number, number, number] : fallback));
};
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x1a1a1f, 1);
document.body.append(renderer.domElement);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 10000);
camera.position.copy(vectorParam('cameraPosition', [56.68, 14.91, 0.48]));
camera.lookAt(vectorParam('cameraTarget', [-33.32, -5.1, 0.48]));
const rig = new THREE.Group();
rig.add(camera);
const scene = new THREE.Scene();
scene.add(rig);
const cameraState = captureXrCameraState(camera);
const motionBasePosition = new THREE.Vector3();
const motionBaseQuaternion = new THREE.Quaternion();
const motionRotation = new THREE.Quaternion();
const motionOffset = new THREE.Vector3();
const upAxis = new THREE.Vector3(0, 1, 0);
let placementPending = false;
const spark = new SparkRenderer({
  renderer,
  lodSplatCount: budget,
  lodRenderScale: 1,
  maxStdDev: cutoff,
  ...(params.has('minAlpha') ? { minAlpha: Number(params.get('minAlpha')) } : {}),
  sortRadial,
  minSortIntervalMs: sortIntervalMs,
  coneFov0: 60,
  coneFov: 120,
  coneFoveate: 0.4,
  behindFoveate: 0.2,
});
const mesh = new SplatMesh({ url: sceneUrl });
mesh.rotation.x = Math.PI;
mesh.lodScale = 2;
scene.add(spark, mesh);
let benchmarkProjectionPaused = false;
if (params.get('benchmarkSelection') === '1') {
  installRadSelectionSnapshot(async () => {
    const source = mesh.packedSplats?.lodSplats;
    if (!source || !mesh.context.enableLod.value) throw new Error('RAD snapshot requires resident packed LOD data');
    // Spark uploads replacement index arrays directly to GL without updating
    // texture.image.data. Observe one real publication only after FPS sampling.
    type Publication = { numSplats: number; indices: Uint32Array };
    const adapter = spark as unknown as {
      updateLodIndices: (meshes: Map<string, SplatMesh>, cuts: Record<string, Publication>) => void;
    };
    const original = adapter.updateLodIndices;
    const globalIds = await new Promise<number[]>((resolve, reject) => {
      const restore = () => { adapter.updateLodIndices = original; clearTimeout(timer); };
      const timer = setTimeout(() => { restore(); reject(new Error('RAD publication snapshot timed out')); }, 10000);
      adapter.updateLodIndices = (meshes, cuts) => {
        original.call(spark, meshes, cuts);
        const cut = cuts[mesh.uuid];
        if (!cut) return;
        restore();
        try { resolve(copyResidentRadSelection(cut.indices, cut.numSplats, source.numSplats)); }
        catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      };
    });
    const chosen = [...globalIds].sort((a, b) => a - b).slice(0, 1024);
    mesh.updateWorldMatrix(true, false);
    const positionSamples = chosen.map((globalId) => ({
      globalId,
      worldPosition: source.getSplat(globalId).center.clone().applyMatrix4(mesh.matrixWorld).toArray(),
    }));
    const head = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    let projectedCoverage;
    if (params.get('benchmarkCoverage') === '1') {
      benchmarkProjectionPaused = true;
      try {
        const { captureSparkProjectedCoverage, snapshotXrProjectionEyes } = await import('./rad-projected-coverage');
        projectedCoverage = await captureSparkProjectedCoverage(renderer, spark, snapshotXrProjectionEyes(renderer));
      } finally {
        benchmarkProjectionPaused = false;
      }
    }
    return {
      ...(projectedCoverage ? { projectedCoverage } : {}),
      scope: 'cpu-published-rad-selection' as const,
      capturedAtMs: performance.now(),
      chunkSize: 65536,
      globalIds,
      positionSamples,
      sourceAttributes: { residentNodeCount: source.numSplats, mappingVersion: mesh.mappingVersion },
      mappingAssumption: 'Resident LOD index equals authored RAD global ID; validate common-node positions before interpreting overlap',
      pose: {
        position: head.getWorldPosition(new THREE.Vector3()).toArray(),
        forward: head.getWorldDirection(new THREE.Vector3()).toArray(),
      },
    };
  });
}
const xr = new SparkXr({
  renderer,
  element: button,
  mode: 'vr',
  referenceSpaceType: 'local-floor',
  frameBufferScaleFactor: scale,
  fixedFoveation,
  onEnterXr: () => {
    button.textContent = 'Exit VR';
    placementPending = true;
    motionStart = 0;
    const layer = renderer.xr.getBaseLayer() as {
      textureWidth?: number; textureHeight?: number;
      framebufferWidth?: number; framebufferHeight?: number;
    } | null;
    console.info('SPARK_XR_LAYER', JSON.stringify({
      scale, width: layer?.textureWidth ?? layer?.framebufferWidth ?? null,
      height: layer?.textureHeight ?? layer?.framebufferHeight ?? null,
      foveation: (layer as typeof layer & { fixedFoveation?: number })?.fixedFoveation ?? null,
    }));
    console.info('SPARK_XR_STARTED');
  },
  onExitXr: () => {
    button.textContent = 'Enter VR';
    placementPending = false;
    motionStart = 0;
    restoreXrCameraState(camera, cameraState);
    rig.position.set(0, 0, 0);
    rig.quaternion.identity();
    rig.updateMatrixWorld(true);
    console.info('SPARK_XR_ENDED');
  },
});
const frameMs: number[] = [];
const cpuMs: number[] = [];
const draws: number[] = [];
const activeSplats: number[] = [];
let sampleStart = 0;
let motionStart = 0;
let sampleStartPose: { position: number[]; forward: number[] } | null = null;
let lastFrame = 0;
let phase: 'idle' | 'warmup' | 'sample' | 'done' = 'idle';
const period = 1000 / 72;
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))] ?? null;
};
window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'b' || !xr.session) return;
  renderer.xr.updateCamera(camera);
  const benchmarkHead = renderer.xr.getCamera();
  if (benchmarkHead.cameras.length > 0) {
    alignXrRigToCamera(rig, benchmarkHead, cameraState.worldMatrix);
    renderer.xr.updateCamera(camera);
    motionStart = 0;
  }
  phase = 'warmup';
  sampleStartPose = null;
  sampleStart = 0;
  lastFrame = 0;
  frameMs.length = cpuMs.length = draws.length = activeSplats.length = 0;
  result.textContent = '';
  console.info('SPARK_XR_BENCHMARK_STARTED');
  const head = renderer.xr.getCamera();
  const pose = (view: THREE.Camera) => ({
    position: view.getWorldPosition(new THREE.Vector3()).toArray(),
    forward: view.getWorldDirection(new THREE.Vector3()).toArray(),
  });
  console.info('SPARK_XR_BENCHMARK_POSE', JSON.stringify({ app: pose(camera), head: pose(head), left: head.cameras[0] ? pose(head.cameras[0]) : null }));
});
renderer.setAnimationLoop((time) => {
  if (benchmarkProjectionPaused) return;
  if (xr.session) {
    if (placementPending) {
      renderer.xr.updateCamera(camera);
      const head = renderer.xr.getCamera();
      if (head.cameras.length > 0) {
        alignXrRigToCamera(rig, head, cameraState.worldMatrix);
        renderer.xr.updateCamera(camera);
        placementPending = false;
        console.info('SPARK_XR_POSE', JSON.stringify({
          position: camera.getWorldPosition(new THREE.Vector3()).toArray(),
          forward: camera.getWorldDirection(new THREE.Vector3()).toArray(),
        }));
      }
    }
    if (!placementPending) {
      if (motion === 'stationary') {
        renderer.xr.updateCamera(camera);
        const head = renderer.xr.getCamera();
        if (xrHeadDrifted(head, cameraState.worldMatrix)) {
          alignXrRigToCamera(rig, head, cameraState.worldMatrix);
          renderer.xr.updateCamera(camera);
        }
      }
      if (!motionStart) {
        motionStart = time;
        motionBasePosition.copy(rig.position);
        motionBaseQuaternion.copy(rig.quaternion);
      }
      const elapsed = (time - motionStart) / 1000;
      if (motion === 'rotate') {
        motionRotation.setFromAxisAngle(upAxis, elapsed * 0.12);
        rig.quaternion.copy(motionBaseQuaternion).multiply(motionRotation);
      }
      if (motion === 'translate') {
        rig.position.copy(motionBasePosition).add(
          motionOffset.set(Math.sin((elapsed * Math.PI) / 6) * 0.25, 0, 0),
        );
      }
      rig.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
    }
  } else {
    motionStart = 0;
  }
  const cpuStart = performance.now();
  renderer.render(scene, camera);
  const submit = performance.now() - cpuStart;
  status.textContent = `HOTEL · ${spark.activeSplats.toLocaleString()} / ${budget.toLocaleString()} splats · WebGL2 · ${mode} · XR ${xr.session ? 'active' : 'off'}`;
  if (phase === 'warmup' && xr.session) {
    if (!sampleStart) sampleStart = time;
    if (time - sampleStart >= 5000) {
      phase = 'sample'; sampleStart = time; lastFrame = 0;
      const head = renderer.xr.getCamera();
      sampleStartPose = {
        position: head.getWorldPosition(new THREE.Vector3()).toArray(),
        forward: head.getWorldDirection(new THREE.Vector3()).toArray(),
      };
    }
  } else if (phase === 'sample' && xr.session) {
    if (lastFrame) frameMs.push(time - lastFrame);
    lastFrame = time;
    cpuMs.push(submit);
    draws.push(renderer.info.render.calls);
    activeSplats.push(spark.activeSplats);
    if (time - sampleStart >= 30000) {
      phase = 'done';
      const total = frameMs.reduce((sum, value) => sum + value, 0);
      const report = {
        kind: 'spark-webgl-xr-benchmark', mode, motion, budget, backend: 'WebGL2', backgroundSrgb: '#1a1a1f',
        xrSampleStartPose: sampleStartPose,
        scene: sceneUrl, scale, cutoff, fixedFoveation, sortRadial, sortIntervalMs,
        minAlpha: params.has('minAlpha') ? Number(params.get('minAlpha')) : 0.5 / 255,
        frames: frameMs.length, averageFps: total ? (frameMs.length * 1000) / total : null,
        frameMs: { p50: percentile(frameMs, 0.5), p95: percentile(frameMs, 0.95), p99: percentile(frameMs, 0.99) },
        cpuSubmissionMs: { p50: percentile(cpuMs, 0.5), p95: percentile(cpuMs, 0.95), p99: percentile(cpuMs, 0.99) },
        drawCalls: { mean: draws.reduce((sum, value) => sum + value, 0) / draws.length, p95: percentile(draws, 0.95) },
        activeSplats: { min: Math.min(...activeSplats), max: Math.max(...activeSplats), mean: activeSplats.reduce((sum, value) => sum + value, 0) / activeSplats.length, last: spark.activeSplats },
        missedRefreshOpportunities: frameMs.reduce((sum, value) => sum + Math.max(0, Math.round(value / period) - 1), 0),
        actualRuntimeRate: xr.session.frameRate ?? null,
      };
      result.textContent = JSON.stringify(report);
      console.info('SPARK_XR_BENCHMARK', JSON.stringify(report));
    }
  }
});
void mesh.initialized.catch((error: unknown) => {
  status.textContent = `HOTEL load failed: ${String(error)}`;
  console.error(error);
});
