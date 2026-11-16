/**
 * Dev bench for `SkinnedSplatMesh` (not a test): the cost of the skin per
 * bones-per-splat, on a large synthetic limb. Each variant (0 = a plain
 * dynamic-capacity `SplatMesh`, the pool a skinned mesh uses, then 1, 2 and 4
 * bones per splat) draws the same splats with
 * the camera orbiting and `sortIntervalMs: 0`, so every variant sorts every
 * frame and the compute time compares the sorts themselves, and the skinned
 * ones animate a 24-bone chain. Reports median frame time and the mean GPU
 * render and compute (sort) time per variant in `#result`.
 *
 *   /src/viewer/skinned-splat-bench.html?n=2000000&size=1600x900
 */
import * as THREE from 'three/webgpu';
import { SplatMesh, createWebGPURenderer, writeCovariance, type SplatData } from '../lib/core';
import { SkinnedSplatMesh } from '../lib/dynamic';

const params = new URLSearchParams(location.search);
const N = Number(params.get('n') ?? 2_000_000);
const [W, H] = (params.get('size') ?? '1600x900').split('x').map(Number) as [number, number];
const VARIANTS = (params.get('bones') ?? '0,1,2,4,4,2,1,0').split(',').map(Number) as (
  0 | 1 | 2 | 4
)[];
const BONES = 24;
const HEIGHT = 2.4;
const output = document.querySelector<HTMLElement>('#result')!;

const renderer = await createWebGPURenderer({
  canvas: document.querySelector<HTMLCanvasElement>('#canvas')!,
  antialias: false,
  requireWebGpu: true,
  trackTimestamp: true,
});
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.setClearColor(0x111111);
await renderer.init();

// A column of N splats, weighted along a chain of BONES bones.
const positions = new Float32Array(N * 3);
const colors = new Uint8Array(N * 4);
const covariances = new Float32Array(N * 6);
for (let i = 0; i < N; i++) {
  const y = Math.random() * HEIGHT;
  const a = Math.random() * 2 * Math.PI;
  const r = 0.3 * Math.sqrt(Math.random());
  positions.set([r * Math.cos(a), y, r * Math.sin(a)], i * 3);
  colors.set([120 + 100 * (y / HEIGHT), 90, 200 - 100 * (y / HEIGHT), 200], i * 4);
  writeCovariance(covariances, i, 0.006, 0.006, 0.006, 1, 0, 0, 0);
}
const data: SplatData = { count: N, positions, colors, covariances };

/** Bones nearest each splat along the chain, weights falling off with distance. */
function skinFor(n: 1 | 2 | 4) {
  const indices = new Uint16Array(N * n);
  const weights = new Float32Array(N * n);
  const step = HEIGHT / BONES;
  for (let i = 0; i < N; i++) {
    const t = positions[i * 3 + 1]! / step - 0.5;
    const first = Math.floor(t) - Math.floor((n - 1) / 2);
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const bone = Math.min(Math.max(first + k, 0), BONES - 1);
      const w = Math.max(0, 1 - Math.abs(t - (first + k)) / (n / 2 + 0.5));
      indices[i * n + k] = bone;
      weights[i * n + k] = w;
      sum += w;
    }
    for (let k = 0; k < n; k++)
      weights[i * n + k] = sum > 0 ? weights[i * n + k]! / sum : k === 0 ? 1 : 0;
  }
  return { bonesPerSplat: n, indices, weights };
}

const camera = new THREE.PerspectiveCamera(40, W / H, 0.05, 50);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(variant: 0 | 1 | 2 | 4) {
  const scene = new THREE.Scene();
  let mesh: SplatMesh;
  let bones: THREE.Bone[] = [];
  if (variant === 0) {
    // The same dynamic pool a SkinnedSplatMesh uses, without the skin.
    mesh = new SplatMesh({ capacity: N }, { sortIntervalMs: 0 });
    mesh.appendRange(data);
  } else {
    const skinned = new SkinnedSplatMesh(data, { skin: skinFor(variant), sortIntervalMs: 0 });
    bones = Array.from({ length: BONES }, () => new THREE.Bone());
    bones.forEach((bone, i) => {
      if (i > 0) {
        bone.position.y = HEIGHT / BONES;
        bones[i - 1]!.add(bone);
      }
    });
    skinned.add(bones[0]!);
    skinned.bind(new THREE.Skeleton(bones));
    mesh = skinned;
  }
  scene.add(mesh);
  const frames: number[] = [];
  const renders: number[] = [];
  const computes: number[] = [];
  const started = performance.now();
  let last = started;
  while (performance.now() - started < 10_000) {
    await new Promise(requestAnimationFrame);
    const now = performance.now();
    const t = (now - started) / 1000;
    // The camera orbits, so every variant sorts every frame.
    camera.position.set(3.2 * Math.sin(t * 0.6), 1.3, 3.2 * Math.cos(t * 0.6));
    camera.lookAt(0, 1.2, 0);
    camera.updateMatrixWorld();
    bones.forEach((bone, i) => (bone.rotation.z = 0.06 * Math.sin(2 * t + i * 0.4)));
    mesh.update(camera, renderer);
    renderer.render(scene, camera);
    // Timestamps are read every frame (one frame's passes each), which
    // stalls the loop: frame times here are not frame rates, GPU times are.
    const r = await renderer.resolveTimestampsAsync('render');
    const c = await renderer.resolveTimestampsAsync('compute');
    if (now - started > 3000) {
      frames.push(now - last);
      if (typeof r === 'number' && r > 0) renders.push(r);
      if (typeof c === 'number' && c > 0) computes.push(c);
    }
    last = now;
  }
  scene.remove(mesh);
  mesh.dispose();
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return Number((sorted[Math.floor(sorted.length / 2)] ?? NaN).toFixed(2));
  };
  return {
    bonesPerSplat: variant,
    frames: frames.length,
    gpuRenderMedianMs: median(renders),
    // Compute runs at the sort cadence, not every frame, so its per-frame
    // mean is the comparable cost (it holds the skin's sort-key twin).
    gpuComputeMeanMs: Number(
      (computes.reduce((sum, ms) => sum + ms, 0) / Math.max(frames.length, 1)).toFixed(2),
    ),
    gpuComputeMaxMs: Number(Math.max(0, ...computes).toFixed(2)),
  };
}

const results = [];
for (const variant of VARIANTS) {
  output.textContent = `running ${variant} bones per splat…\n${JSON.stringify(results, null, 1)}`;
  results.push(await run(variant));
  await sleep(500);
}
output.textContent = JSON.stringify({ n: N, size: `${W}x${H}`, results }, null, 1);
