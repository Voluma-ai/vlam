/** Synthetic pixel comparisons for effect transitions, independent of private captures. */
import * as THREE from 'three/webgpu';
import { SplatMesh, type SplatData } from '../lib/core';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '../lib/unified';

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

function maximumDifference(a: Uint8Array, b: Uint8Array): number {
  return a.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - b[index]!)), 0);
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
      ? ['standalone', 'unified']
      : ['standalone']) {
      const mesh = new SplatMesh(fixture(), {
        shBands: 1,
        antialias,
        performanceProfile: 'quality',
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
        else mesh.update(camera, renderer);
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
      const parityMax = unified
        ? Math.max(...names.map((name) => maximumDifference(runs.standalone![name], frames[name])))
        : null;
      results[`${path}-aa-${antialias}`] = { restored, effectsVisible, parityMax };
      unified?.dispose();
      mesh.dispose();
    }
  }
  map.dispose();
  target.dispose();
  return {
    passed: Object.values(results).every(
      (r) => r.restored && r.effectsVisible && (r.parityMax === null || r.parityMax <= 3),
    ),
    results,
  };
}
