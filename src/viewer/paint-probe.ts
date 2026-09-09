/** GPU regression for surface-aware channel painting on both render backends. */
import * as THREE from 'three/webgpu';
import { createWebGPURenderer, SplatMesh, type SplatData } from '../lib/core';
import { selectBrushStrokeInData, type BrushStroke } from '../lib/selection';
import { createPaintTool } from './paint';

const requested = new URLSearchParams(location.search).get('backend') ?? 'webgpu';
if (requested !== 'webgpu' && requested !== 'webgl2') {
  throw new Error(`Unknown backend: ${requested}`);
}
const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
const output = document.querySelector<HTMLOutputElement>('[data-testid="result"]');
if (!canvas || !output) throw new Error('Missing paint probe elements.');

const renderer = await createWebGPURenderer({
  canvas,
  antialias: false,
  forceWebGL: requested === 'webgl2',
  requireWebGpu: requested === 'webgpu',
});
renderer.setSize(96, 96, false);
renderer.setClearColor(0, 0);
await renderer.init();
const actual =
  (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
    ? 'webgpu'
    : 'webgl2';
if (actual !== requested) throw new Error(`Requested ${requested}, initialized ${actual}.`);

// Front and back share a projected center. The third mean sits just outside
// the brush, but its wide covariance footprint intersects it.
const data: SplatData = {
  count: 3,
  positions: new Float32Array([0, 0, 0, 0, 0, -0.4, 0.75, 0, 0]),
  colors: new Uint8Array([160, 160, 160, 255, 160, 160, 160, 255, 160, 160, 160, 255]),
  covariances: new Float32Array([
    0.01, 0, 0, 0.01, 0, 0.01, 0.0001, 0, 0, 0.0001, 0, 0.0001, 0.01, 0, 0, 0.01, 0, 0.01,
  ]),
};
const mesh = new SplatMesh({ capacity: data.count });
const range = mesh.appendRange(data);
const paint = createPaintTool(mesh, [{ range, data }]);
const scene = new THREE.Scene();
scene.add(mesh);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
camera.position.z = 2;
camera.updateMatrixWorld();
const target = new THREE.RenderTarget(96, 96, { type: THREE.UnsignedByteType });
const stroke: BrushStroke = {
  paths: [[{ point: new THREE.Vector3(0, 0, 0), radius: 0.6, viewDepth: 2 }]],
  viewMatrix: camera.matrixWorldInverse.clone(),
};

async function draw(): Promise<Uint8Array> {
  mesh.update(camera, renderer);
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  // The unsigned-byte target guarantees this narrower runtime array type.
  return (await renderer.readRenderTargetPixelsAsync(target, 0, 0, 96, 96)) as Uint8Array;
}

function changedPixels(before: Uint8Array, after: Uint8Array): number {
  let changed = 0;
  for (let i = 0; i < before.length; i += 4) {
    const delta =
      Math.abs((before[i] as number) - (after[i] as number)) +
      Math.abs((before[i + 1] as number) - (after[i + 1] as number)) +
      Math.abs((before[i + 2] as number) - (after[i + 2] as number));
    if (delta >= 8) changed++;
  }
  return changed;
}

try {
  // Warm both the sort and material pipelines before taking reference pixels.
  for (let i = 0; i < 4; i++) {
    await draw();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const before = await draw();
  const modes = {
    surfaceCenter: selectBrushStrokeInData(data, stroke, {
      depth: 'surface',
      footprint: 'center',
    }).length,
    throughCenter: selectBrushStrokeInData(data, stroke, {
      depth: 'through',
      footprint: 'center',
    }).length,
    surfaceFootprint: selectBrushStrokeInData(data, stroke, {
      depth: 'surface',
      footprint: 'footprint',
    }).length,
    throughFootprint: selectBrushStrokeInData(data, stroke, {
      depth: 'through',
      footprint: 'footprint',
    }).length,
  };
  paint.paintStroke(stroke, { depth: 'surface', footprint: 'center' });
  const after = await draw();
  const center = (48 * 96 + 48) * 4;
  output.textContent = JSON.stringify({
    backend: actual,
    modes,
    changedPixels: changedPixels(before, after),
    centerBefore: Array.from(before.subarray(center, center + 4)),
    centerAfter: Array.from(after.subarray(center, center + 4)),
  });
} finally {
  renderer.setRenderTarget(null);
  target.dispose();
  mesh.dispose();
  renderer.dispose();
}
