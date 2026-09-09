import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import type { WebGLRenderer } from 'three';
import { SplatMesh } from '../core/splat-mesh';
import { SplatPool } from '../core/splat-mesh-pool';
import { writeCovariance, type SplatData } from '../core/splat-data';

const WIDTH = 2048;

function splatData(): SplatData {
  const covariances = new Float32Array(6);
  writeCovariance(covariances, 0, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  return {
    count: 1,
    positions: new Float32Array([1, 2, 3]),
    colors: new Uint8Array([180, 205, 255, 255]),
    covariances,
  };
}

function uploadedRenderer(): THREE.WebGPURenderer {
  const backend = {
    isWebGPUBackend: true,
    has: () => true,
    get: (object: object) =>
      object instanceof THREE.DataTexture ? { texture: {} } : { buffer: {} },
  };
  return { backend } as unknown as THREE.WebGPURenderer;
}

describe('SplatMesh render-only storage', () => {
  it('accepts only an own static WebGPU-compatible mesh', () => {
    class DerivedSplatMesh extends SplatMesh {}
    const sharedPool = new SplatPool({ capacity: WIDTH });
    expect(() => new SplatMesh({ capacity: WIDTH }, { storageMode: 'render-only' })).toThrow(
      /static SplatData/,
    );
    expect(
      () =>
        new SplatMesh(splatData(), {
          storageMode: 'render-only',
          pool: sharedPool,
        }),
    ).toThrow(/shared pool/);
    expect(() => new DerivedSplatMesh(splatData(), { storageMode: 'render-only' })).toThrow(
      /subclasses/,
    );
    expect(
      () => new SplatMesh(splatData(), { storageMode: 'render-only', sortStrategy: 'worker' }),
    ).toThrow(/worker sorting/);
    sharedPool.dispose();
  });

  it('releases every float32 pool and index mirror after upload', () => {
    const mesh = new SplatMesh(splatData(), { storageMode: 'render-only' });
    const view = mesh.getUnifiedSourceView();
    const draw = mesh.geometry.getAttribute('splatIndex');

    mesh.onAfterRender(uploadedRenderer() as unknown as WebGLRenderer);

    expect(mesh.cpuStorageReleased).toBe(true);
    expect(mesh.releasedCpuBytes).toBe(WIDTH * 68);
    expect(view.sourceIndex.array.byteLength).toBe(0);
    expect(draw.array.byteLength).toBe(0);
    expect((view.centersTexture.image as { data: Float32Array }).data.byteLength).toBe(0);
    expect((view.colorsTexture.image as { data: Uint8Array }).data.byteLength).toBe(0);
    expect((view.covarianceATexture.image as { data: Float32Array }).data.byteLength).toBe(0);
    expect((view.covarianceBTexture.image as { data: Float32Array }).data.byteLength).toBe(0);
    expect(() => mesh.dispose()).not.toThrow();
  });

  it('releases additional float16 images and packed SH mirrors', () => {
    const data: SplatData = {
      ...splatData(),
      shPacked: {
        bands: 3,
        packed: new Uint32Array(15),
        range: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    };
    const mesh = new SplatMesh(data, {
      storageMode: 'render-only',
      poolFloatTextures: 'float16',
    });

    mesh.onAfterRender(uploadedRenderer() as unknown as WebGLRenderer);

    expect(mesh.cpuStorageReleased).toBe(true);
    expect(mesh.releasedCpuBytes).toBe(WIDTH * (84 + 64));
    mesh.dispose();
  });

  it('releases a palette image retained by the mesh', () => {
    const palette = new Float32Array(12);
    const mesh = new SplatMesh(
      {
        ...splatData(),
        sh: { bands: 1, labels: new Uint32Array([0]), palette, paletteWidth: 3, paletteHeight: 1 },
      },
      { storageMode: 'render-only' },
    );

    mesh.onAfterRender(uploadedRenderer() as unknown as WebGLRenderer);

    expect(mesh.cpuStorageReleased).toBe(true);
    expect(mesh.releasedCpuBytes).toBe(WIDTH * 68 + palette.byteLength);
    mesh.dispose();
  });

  it('fails CPU-backed operations explicitly while retaining shader controls', async () => {
    const mesh = new SplatMesh(splatData(), { storageMode: 'render-only' });
    const point = new THREE.Vector3();
    const ray = new THREE.Ray(point, new THREE.Vector3(0, 0, -1));

    expect(() => mesh.appendRange(splatData())).toThrow(/render-only/);
    expect(() => mesh.defineChannel('paint')).toThrow(/render-only/);
    expect(() => mesh.compact()).toThrow(/render-only/);
    expect(() => mesh.queryNearest(point, 1)).toThrow(/render-only/);
    expect(() => mesh.queryRay(ray, 1)).toThrow(/render-only/);
    expect(() => mesh.queryHeight(point, 1, 1)).toThrow(/render-only/);
    await expect(mesh.setSortStrategy('worker')).rejects.toThrow(/editable CPU storage/);
    expect(() => mesh.setUnifiedPickVisibility(true)).toThrow(/UnifiedSplatMesh/);
    expect(() => mesh.setMaxStdDev(2.5)).not.toThrow();
    mesh.dispose();
  });

  it('rejects WebGL2 before rendering or picking', () => {
    const mesh = new SplatMesh(splatData(), { storageMode: 'render-only' });
    const renderer = { backend: { isWebGPUBackend: false } } as unknown as THREE.WebGPURenderer;
    const camera = new THREE.PerspectiveCamera();

    expect(() => mesh.update(camera, renderer)).toThrow(/requires a WebGPU backend/);
    expect(() => mesh.pick(new THREE.Vector2(), camera, renderer)).toThrow(
      /requires a WebGPU backend/,
    );
    mesh.dispose();
  });
});
