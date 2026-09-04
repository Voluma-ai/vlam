/** Synthetic pixel comparisons for effect transitions, independent of private captures. */
import * as THREE from 'three/webgpu';
import { SplatMesh, type SplatData } from '../lib/core';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '../lib/unified';
import { shEvaluationDiagnostics } from './sh-evaluation-diagnostics';

const SIZE = 128;

function fixture(): SplatData {
  const palette = new Float32Array(64 * 3 * 4);
  palette[4] = 0.15;
  return {
    count: 1,
    positions: new Float32Array([0, 0, 0]),
    colors: new Uint8Array([160, 130, 110, 230]),
    covariances: new Float32Array([0.08, 0.01, 0, 0.04, 0, 0.03]),
    sh: { bands: 1, labels: new Uint32Array([0]), palette, paletteWidth: 192, paletteHeight: 1 },
  };
}

/** Directionally varied SH3 data for measuring the intentional one-sort color lag. */
function motionFixture(): SplatData {
  const bands = 3;
  const coefficients = 15;
  const paletteWidth = 64 * coefficients;
  const palette = new Float32Array(paletteWidth * 4);
  for (let coefficient = 0; coefficient < coefficients; coefficient++) {
    const texel = coefficient * 4;
    const magnitude = 0.35 / Math.sqrt(coefficient + 1);
    palette[texel] = magnitude * (coefficient % 2 === 0 ? 1 : -1);
    palette[texel + 1] = magnitude * (coefficient % 3 === 0 ? -0.8 : 0.6);
    palette[texel + 2] = magnitude * (coefficient % 4 < 2 ? 0.7 : -0.5);
  }
  return {
    count: 1,
    positions: new Float32Array([0, 0, 0]),
    colors: new Uint8Array([128, 128, 128, 255]),
    covariances: new Float32Array([0.12, 0, 0, 0.12, 0, 0.12]),
    sh: { bands, labels: new Uint32Array([0]), palette, paletteWidth, paletteHeight: 1 },
  };
}

function maximumDifference(a: Uint8Array, b: Uint8Array): number {
  return a.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - b[index]!)), 0);
}

function meanDifference(a: Uint8Array, b: Uint8Array): number {
  return a.reduce((sum, value, index) => sum + Math.abs(value - b[index]!), 0) / a.length;
}

async function capture(
  renderer: THREE.WebGPURenderer,
  target: THREE.RenderTarget,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): Promise<Uint8Array> {
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const bytes = await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
}

/** Runs standalone on either backend and adds unified parity on WebGPU. */
export async function verifyRenderEffects(renderer: THREE.WebGPURenderer) {
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 1);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const mapBytes = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 256; i++) {
    mapBytes.set(i % 16 < 8 ? [80, 150, 220, 255] : [220, 90, 50, 100], i * 4);
  }
  const map = new THREE.DataTexture(mapBytes, 16, 16);
  map.needsUpdate = true;
  const target = new THREE.RenderTarget(SIZE, SIZE, { type: THREE.UnsignedByteType });
  const names = [
    'base',
    'blend-zero',
    'hard-light',
    'soft-light',
    'light-off',
    'dof',
    'focus',
    'dof-off',
  ] as const;
  type EffectName = (typeof names)[number];
  const results: Record<
    string,
    { restored: boolean; effectsVisible: boolean; parityMax: number | null }
  > = {};

  for (const antialias of [false, true]) {
    const runs: Record<string, Record<EffectName, Uint8Array>> = {};
    for (const path of supportsUnifiedSplatMesh(renderer)
      ? ['standalone', 'compute', 'unified']
      : ['standalone']) {
      const mesh = new SplatMesh(fixture(), {
        shBands: 1,
        antialias,
        performanceProfile: 'quality',
        shEvaluation: path === 'compute' ? 'compute' : 'vertex',
      });
      // Non-identity placement exercises SH direction and mirrored covariance.
      mesh.rotation.y = 0.2;
      mesh.scale.x = -1;
      const unified = path === 'unified' ? new UnifiedSplatMesh(renderer, 1) : null;
      unified?.addSource(mesh);
      const drawable = unified ?? mesh;
      const scene = new THREE.Scene();
      scene.add(drawable);
      const frames = {} as Record<EffectName, Uint8Array>;
      const row = document.createElement('section');
      const title = document.createElement('h3');
      title.textContent = `${path}, SH1, antialias ${antialias}`;
      row.append(title);
      for (const name of names) {
        if (name === 'blend-zero') drawable.setRelighting({ map, blend: 0, brightness: 1 });
        if (name === 'hard-light') drawable.setRelighting({ map, blend: 0.8, softness: 0 });
        if (name === 'soft-light') drawable.setRelighting({ map, blend: 0.8, softness: 4 });
        if (name === 'light-off') drawable.setRelighting(null);
        if (name === 'dof') drawable.setDepthOfField({ aperture: 0.4, focusDistance: 1 });
        if (name === 'focus') drawable.setDepthOfField({ focusDistance: 2 });
        if (name === 'dof-off') drawable.setDepthOfField({ aperture: 0 });
        if (unified) unified.update(camera);
        else {
          mesh.update(camera, renderer);
          const deadline = performance.now() + 30000;
          while (shEvaluationDiagnostics(mesh).reason === 'loading-compute-module') {
            if (performance.now() > deadline) throw new Error('SH cache initialization timed out.');
            await new Promise((resolve) => setTimeout(resolve, 16));
            mesh.update(camera, renderer);
          }
          if (path === 'compute' && shEvaluationDiagnostics(mesh).resolved !== 'compute') {
            throw new Error(`Compute SH fell back: ${shEvaluationDiagnostics(mesh).reason}`);
          }
        }
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        const bytes = await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE);
        frames[name] = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
        const image = document.createElement('canvas');
        image.width = image.height = SIZE;
        image.title = name;
        image
          .getContext('2d')!
          .putImageData(new ImageData(new Uint8ClampedArray(frames[name]), SIZE, SIZE), 0, 0);
        row.append(image);
      }
      document.body.append(row);
      runs[path] = frames;
      const restored = ['blend-zero', 'light-off', 'dof-off'].every(
        (name) => maximumDifference(frames.base, frames[name as EffectName]) === 0,
      );
      const effectsVisible =
        maximumDifference(frames.base, frames['hard-light']) > 5 &&
        maximumDifference(frames['hard-light'], frames['soft-light']) > 0 &&
        maximumDifference(frames.base, frames.dof) > 5 &&
        maximumDifference(frames.dof, frames.focus) > 0;
      const parityMax =
        path !== 'standalone'
          ? Math.max(
              ...names.map((name) => maximumDifference(runs.standalone![name], frames[name])),
            )
          : null;
      results[`${path}-aa-${antialias}`] = { restored, effectsVisible, parityMax };
      unified?.dispose();
      mesh.dispose();
    }
  }

  // The orbit benchmark advances by roughly 0.02 rad between accepted sorts.
  // Compare the deliberately reused cache at that offset with exact vertex SH.
  const motionTarget = new THREE.RenderTarget(SIZE, SIZE, { type: THREE.UnsignedByteType });
  const cached = new SplatMesh(motionFixture(), {
    shBands: 3,
    performanceProfile: 'quality',
    shEvaluation: 'compute',
  });
  const exact = new SplatMesh(motionFixture(), {
    shBands: 3,
    performanceProfile: 'quality',
    shEvaluation: 'vertex',
  });
  const cachedScene = new THREE.Scene();
  const exactScene = new THREE.Scene();
  cachedScene.add(cached);
  exactScene.add(exact);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  cached.update(camera, renderer, { sort: false });
  const deadline = performance.now() + 30000;
  while (shEvaluationDiagnostics(cached).reason === 'loading-compute-module') {
    if (performance.now() > deadline) throw new Error('SH cache initialization timed out.');
    await new Promise((resolve) => setTimeout(resolve, 16));
    cached.update(camera, renderer, { sort: false });
  }
  const angle = 0.02;
  camera.position.set(Math.sin(angle) * 3, 0, Math.cos(angle) * 3);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  // First update writes the moved camera uniforms and takes the ordinary
  // sort:false vertex fallback. The second call models a rejected sort and
  // deliberately re-enables the previous cache for this frame.
  cached.update(camera, renderer, { sort: false });
  (
    cached as unknown as {
      prepareShEvaluation(
        renderer: THREE.WebGPURenderer,
        force: boolean,
        refreshForSort: boolean,
        reuseBetweenSorts: boolean,
      ): void;
    }
  ).prepareShEvaluation(renderer, false, false, true);
  exact.update(camera, renderer, { sort: false });
  const staleFrame = await capture(renderer, motionTarget, cachedScene, camera);
  const exactFrame = await capture(renderer, motionTarget, exactScene, camera);
  const motionLag = {
    radians: angle,
    maximumDifference: maximumDifference(staleFrame, exactFrame),
    meanDifference: meanDifference(staleFrame, exactFrame),
  };
  cached.dispose();
  exact.dispose();
  motionTarget.dispose();
  map.dispose();
  target.dispose();
  return {
    passed:
      Object.values(results).every(
        (r) => r.restored && r.effectsVisible && (r.parityMax === null || r.parityMax <= 3),
      ) && motionLag.maximumDifference <= 1,
    results,
    motionLag,
  };
}
