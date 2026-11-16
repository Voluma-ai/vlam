/**
 * GPU check of `SkinnedSplatMesh` (`browser-tests/skinned-splat-mesh.spec.ts`):
 * a bent three-bone limb drawn by the skin modifier must match a plain
 * `SplatMesh` of the same splats posed on the CPU (`posedSplatData`), both
 * standalone and (WebGPU) as a `UnifiedSplatMesh` source. A bind-pose draw is
 * the control that shows the probe can see a wrong pose.
 */
import * as THREE from 'three/webgpu';
import { SplatMesh, createWebGPURenderer, writeCovariance, type SplatData } from '../lib/core';
import { SkinnedSplatMesh } from '../lib/dynamic';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '../lib/unified';

const SIZE = 96;
const requested = new URLSearchParams(location.search).get('backend') ?? 'webgpu';
const output = document.querySelector<HTMLElement>('[data-testid="result"]')!;

/** A limb up +y: splats from 0 to 2.4, colored by height, weighted over two bones. */
function limb(count: number) {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  const indices = new Uint16Array(count * 2);
  const weights = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const y = 2.4 * t;
    const angle = i * 2.399963;
    positions.set([0.12 * Math.cos(angle), y, 0.12 * Math.sin(angle)], i * 3);
    colors.set([Math.round(255 * (1 - t)), 80, Math.round(255 * t), 255], i * 4);
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
    const bone = Math.min(Math.floor(y), 2);
    const blend = Math.min(Math.max((y - bone - 0.7) / 0.6, 0), 1);
    indices.set([bone, Math.min(bone + 1, 2)], i * 2);
    weights.set([1 - blend, blend], i * 2);
  }
  const data: SplatData = { count, positions, colors, covariances };
  return { data, skin: { bonesPerSplat: 2 as const, indices, weights } };
}

const renderer = await createWebGPURenderer({
  canvas: document.querySelector<HTMLCanvasElement>('#canvas')!,
  antialias: false,
  forceWebGL: requested === 'webgl2',
  requireWebGpu: requested === 'webgpu',
});
renderer.setSize(SIZE, SIZE, false);
renderer.setClearColor(0, 0);
await renderer.init();
const target = new THREE.RenderTarget(SIZE, SIZE, { type: THREE.UnsignedByteType });
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50);
camera.position.set(0.4, 1.2, 4.2);
camera.lookAt(0.4, 1.2, 0);
camera.updateMatrixWorld();

/** Draws `object` (updating `meshes`) until the image settles, then reads it back. */
async function draw(object: THREE.Object3D, update: () => void): Promise<Uint8Array> {
  const scene = new THREE.Scene();
  scene.add(object);
  let pixels = new Uint8Array(0);
  for (let frame = 0; frame < 24; frame++) {
    update();
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    pixels = new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  scene.remove(object);
  return pixels;
}

const diff = (a: Uint8Array, b: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
};
const coverage = (a: Uint8Array): number => {
  let covered = 0;
  for (let i = 3; i < a.length; i += 4) if (a[i]! > 8) covered++;
  return covered / (a.length / 4);
};

try {
  const { data, skin } = limb(900);
  const bones = [new THREE.Bone(), new THREE.Bone(), new THREE.Bone()];
  bones[1]!.position.set(0, 1, 0);
  bones[2]!.position.set(0, 1, 0);
  bones[0]!.add(bones[1]!);
  bones[1]!.add(bones[2]!);
  const skinned = new SkinnedSplatMesh(data, { skin, sortMetric: 'depth' });
  skinned.add(bones[0]!);
  skinned.bind(new THREE.Skeleton(bones));
  // Bend the limb: the elbow and wrist turn, the wrist stretches.
  bones[0]!.rotation.z = -0.25;
  bones[1]!.rotation.set(0.3, 0, 0.9);
  bones[2]!.rotation.z = 0.7;
  bones[2]!.scale.set(1, 1.3, 1);

  const gpu = await draw(skinned, () => skinned.update(camera, renderer));

  // GPU picking runs the skin too: a pick on the posed tip hits it, and one
  // where the tip rested before the bend does not find it there.
  const posed = skinned.posedSplatData();
  const tipAt = (positions: Float32Array) =>
    new THREE.Vector3()
      .fromArray(positions, (data.count - 1) * 3)
      .applyMatrix4(skinned.matrixWorld);
  const posedTip = tipAt(posed.positions);
  const restTip = tipAt(data.positions);
  const pickAt = async (point: THREE.Vector3) => {
    const ndc = point.clone().project(camera);
    return skinned.pick(new THREE.Vector2(ndc.x, ndc.y), camera, renderer);
  };
  const posedHit = await pickAt(posedTip);
  const restHit = await pickAt(restTip);
  const pick = {
    posedError: posedHit ? posedHit.point.distanceTo(posedTip) : null,
    restHitNearRestTip: restHit ? restHit.point.distanceTo(restTip) < 0.15 : false,
  };
  const cpuMesh = new SplatMesh(skinned.posedSplatData(), {
    orientation: 'source',
    sortMetric: 'depth',
  });
  const cpu = await draw(cpuMesh, () => cpuMesh.update(camera, renderer));
  const restMesh = new SplatMesh(data, { orientation: 'source', sortMetric: 'depth' });
  const rest = await draw(restMesh, () => restMesh.update(camera, renderer));

  let unified: number | null = null;
  if (requested === 'webgpu' && supportsUnifiedSplatMesh(renderer)) {
    const draw2 = new UnifiedSplatMesh(renderer, skinned.capacity, { sortMetric: 'depth' });
    draw2.addSource(skinned, { visible: true });
    const holder = new THREE.Group();
    holder.add(skinned, draw2);
    const pixels = await draw(holder, () => draw2.update(camera));
    unified = diff(pixels, cpu);
    draw2.dispose();
  }
  output.textContent = JSON.stringify({
    backend: requested,
    gpuVsCpu: diff(gpu, cpu),
    restVsCpu: diff(rest, cpu),
    unifiedVsCpu: unified,
    coverage: coverage(gpu),
    pick,
    cpuCoverage: coverage(cpu),
  });
  cpuMesh.dispose();
  restMesh.dispose();
  skinned.dispose();
} catch (error) {
  output.textContent = JSON.stringify({ error: String((error as Error)?.stack ?? error) });
} finally {
  renderer.setRenderTarget(null);
  target.dispose();
}
