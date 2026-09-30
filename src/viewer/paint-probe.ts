/** GPU regression for surface-aware channel painting on both render backends. */
import * as THREE from 'three/webgpu';
import { createWebGPURenderer, SplatMesh, type SplatData } from '../lib/core';
import {
  selectBrushStrokeInData,
  type BrushStroke,
  type BrushStrokeSelectionOptions,
} from '../lib/selection';
import { createPaintTool } from './paint';
import { sdfEffects } from '../lib/effects';
import { createSelectionVolume } from '../lib/selection';

const requested = new URLSearchParams(location.search).get('backend') ?? 'webgpu';
if (requested !== 'webgpu' && requested !== 'webgl2') {
  throw new Error(`Unknown backend: ${requested}`);
}
const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
const output = document.querySelector<HTMLOutputElement>('[data-testid="result"]');
if (!canvas || !output) throw new Error('Missing paint probe elements.');

// Three's sync compute/render path leaves popErrorScope untracked. Chromium
// (Linux SwiftShader in CI especially) can reject those as "Instance dropped"
// after the probe has already published pixels. preventDefault keeps that
// Dawn teardown from becoming a Playwright pageerror.
window.addEventListener('unhandledrejection', (event) => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  if (message.includes('Instance dropped')) event.preventDefault();
});

const renderer = await createWebGPURenderer({
  canvas,
  antialias: false,
  forceWebGL: requested === 'webgl2',
  requireWebGpu: requested === 'webgpu',
});
renderer.setSize(96, 96, false);
renderer.setClearColor(0x17171d, 1);
await renderer.init();
const actual =
  (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
    ? 'webgpu'
    : 'webgl2';
if (actual !== requested) throw new Error(`Requested ${requested}, initialized ${actual}.`);

// The back splat is offset enough to remain visible beside the front one. The
// third mean sits just outside the brush, but its wide covariance footprint
// intersects it. A rotated, non-uniform mesh transform exercises world-space
// selection and rendered covariance together.
const data: SplatData = {
  count: 3,
  positions: new Float32Array([0, 0, 0, 0.35, 0, -0.4, 0.75, 0, 0]),
  colors: new Uint8Array([160, 160, 160, 255, 160, 160, 160, 255, 160, 160, 160, 255]),
  covariances: new Float32Array([
    0.01, 0, 0, 0.01, 0, 0.01, 0.0001, 0, 0, 0.0001, 0, 0.0001, 0.01, 0, 0, 0.01, 0, 0.01,
  ]),
};
const mesh = new SplatMesh({ capacity: data.count });
const range = mesh.appendRange(data);
const paint = createPaintTool(mesh, [{ range, data }]);
mesh.rotation.z = 0.18;
mesh.scale.set(1.2, 0.8, 1);
mesh.updateMatrixWorld();
const scene = new THREE.Scene();
scene.add(mesh);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
camera.position.z = 2;
camera.updateMatrixWorld();
const target = new THREE.RenderTarget(96, 96, { type: THREE.UnsignedByteType });
const stroke: BrushStroke = {
  paths: [[{ point: new THREE.Vector3(0, 0, 0), radius: 0.72, viewDepth: 2 }]],
  viewMatrix: camera.matrixWorldInverse.clone(),
};

const depth = new URLSearchParams(location.search).get('depth');
const footprint = new URLSearchParams(location.search).get('footprint');
const paintOptions: BrushStrokeSelectionOptions = {
  depth: depth === 'through' ? 'through' : 'surface',
  footprint: footprint === 'footprint' ? 'footprint' : 'center',
};
let compiledOffscreen = false;

async function compileFor(renderTarget: THREE.RenderTarget | null): Promise<void> {
  if (actual !== 'webgpu') return;
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(renderTarget);
  try {
    // render() creates pipelines with an untracked popErrorScope. Awaiting
    // compileAsync drains validation before Playwright can treat a late
    // "Instance dropped" rejection as a pageerror. WebGL2 has no such scope.
    await renderer.compileAsync(scene, camera);
  } finally {
    renderer.setRenderTarget(previous);
  }
}

async function readPixels(): Promise<Uint8Array> {
  const pixels = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, 96, 96)) as Uint8Array;
  // WebGPU aligns all but the final row to 256 bytes; WebGL2 is tightly packed.
  const rowBytes = actual === 'webgpu' ? 512 : 384;
  const packed = new Uint8Array(96 * 96 * 4);
  for (let row = 0; row < 96; row++)
    packed.set(pixels.subarray(row * rowBytes, row * rowBytes + 384), row * 384);
  return packed;
}

async function draw(): Promise<Uint8Array> {
  mesh.update(camera, renderer);
  renderer.setRenderTarget(target);
  if (!compiledOffscreen) {
    await compileFor(target);
    compiledOffscreen = true;
  }
  renderer.clear();
  renderer.render(scene, camera);
  // The unsigned-byte target guarantees this narrower runtime array type.
  return readPixels();
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

// Warm both the sort and material pipelines before taking reference pixels.
for (let i = 0; i < 4; i++) {
  await draw();
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const before = await draw();
const batchPicks = await mesh.pickMany(
  [new THREE.Vector2(0, 0), new THREE.Vector2(0, 2 / 96)],
  camera,
  renderer,
);

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
paint.paintStroke(stroke, paintOptions);
let after = await draw();
// WebGL publishes a channel edit with the worker's next completed sort, so
// inspect the first frame that actually contains the stroke.
for (
  let attempt = 0;
  actual === 'webgl2' && changedPixels(before, after) <= 20 && attempt < 50;
  attempt++
) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  after = await draw();
}
const center = (48 * 96 + 48) * 4;

// Compare exact affine tinting with an independently CPU-selected color reference.
const affinePreviews: { kind: string; maxDifference: number; selected: number }[] = [];
const captures = document.createElement('div');
captures.id = 'affine-captures';
document.body.append(captures);
async function previewPixels(preview: SplatMesh): Promise<Uint8Array> {
  const previewScene = new THREE.Scene();
  previewScene.add(preview);
  preview.rotation.copy(mesh.rotation);
  preview.scale.copy(mesh.scale);
  renderer.setRenderTarget(target);
  for (let frame = 0; frame < 100; frame++) {
    preview.update(camera, renderer);
    if (frame === 0) await renderer.compileAsync(previewScene, camera);
    renderer.clear();
    renderer.render(previewScene, camera);
    const pixels = await readPixels();
    if (frame >= 3 && pixels.some((value, index) => index % 4 === 0 && value > 80)) return pixels;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Preview did not publish visible pixels: ${(preview.geometry as THREE.InstancedBufferGeometry).instanceCount} instances.`,
  );
}
for (const kind of ['sphere', 'box', 'cylinder'] as const) {
  const transform = new THREE.Matrix4().set(0.2, 0.1, 0, 0, 0, 1, 0.2, 0, 0, 0, -1, 0, 0, 0, 0, 1);
  const shape = { kind, transform, radius: 1, height: 2, halfExtents: [1, 1, 1] as const };
  const selection = createSelectionVolume(shape);
  const colors = data.colors.slice();
  let selected = 0;
  for (let i = 0; i < data.count; i++) {
    if (
      selection.containsPoint(
        data.positions[i * 3]!,
        data.positions[i * 3 + 1]!,
        data.positions[i * 3 + 2]!,
      )
    ) {
      colors.set([255, 0, 255], i * 4);
      selected++;
    }
  }
  const reference = new SplatMesh({ ...data, colors });
  const preview = new SplatMesh(data);
  preview.modifiers = [
    sdfEffects([{ ...shape, mode: 'tint', color: [1, 0, 1] }], { maxShapes: 1 }).modifier,
  ];
  const expected = await previewPixels(reference);
  const actualPixels = await previewPixels(preview);
  let maxDifference = 0;
  for (let i = 0; i < expected.length; i++)
    maxDifference = Math.max(maxDifference, Math.abs(expected[i]! - actualPixels[i]!));
  affinePreviews.push({ kind, maxDifference, selected });
  const image = document.createElement('canvas');
  image.width = image.height = 96;
  // Display the compared RGB independently of the offscreen target's alpha.
  const capture = new Uint8ClampedArray(actualPixels);
  for (let i = 3; i < capture.length; i += 4) capture[i] = 255;
  image
    .getContext('2d', { willReadFrequently: true })!
    .putImageData(new ImageData(capture, 96, 96), 0, 0);
  image.dataset.pixels = JSON.stringify(Array.from(capture));
  image.title = kind;
  captures.append(image);
  reference.dispose();
  preview.dispose();
}

// The readbacks above already synchronize the pixels under test. Do not await
// the whole device queue here: Linux SwiftShader can leave that promise pending
// during Dawn teardown, which would prevent the probe from publishing a result.
renderer.setRenderTarget(null);
mesh.update(camera, renderer);
await compileFor(null);
renderer.render(scene, camera);

output.textContent = JSON.stringify({
  backend: actual,
  affinePreviews,
  batchPicks: batchPicks.map((hit) => hit?.point.toArray() ?? null),
  paintedMode: paintOptions,
  modes,
  changedPixels: changedPixels(before, after),
  centerBefore: Array.from(before.subarray(center, center + 4)),
  centerAfter: Array.from(after.subarray(center, center + 4)),
});
