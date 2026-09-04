import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { describe, expect, it, vi } from 'vitest';
import { ShComputeCache } from '../core/sh-compute-cache';
import { SplatMesh } from '../core/splat-mesh';
import type { SplatData } from '../core/splat-data';

function data(): SplatData {
  return {
    count: 1,
    positions: new Float32Array(3),
    colors: new Uint8Array([160, 120, 80, 230]),
    covariances: new Float32Array([0.04, 0, 0, 0.04, 0, 0.04]),
    sh: {
      bands: 1,
      labels: new Uint32Array(1),
      palette: new Float32Array(192 * 4),
      paletteWidth: 192,
      paletteHeight: 1,
    },
  };
}

function renderer() {
  return {
    compute: vi.fn(),
    copyTextureToTexture: vi.fn(),
    getDrawingBufferSize: (out: THREE.Vector2) => out.set(800, 600),
    xr: { isPresenting: false },
    backend: {
      isWebGPUBackend: true,
      device: {
        limits: {
          maxStorageBufferBindingSize: 128 * 1024 * 1024,
          maxBufferSize: 256 * 1024 * 1024,
          maxComputeWorkgroupsPerDimension: 65535,
        },
      },
    },
  };
}

function internals(mesh: SplatMesh) {
  return mesh as unknown as {
    ShCacheCtor: typeof ShComputeCache;
    shCache: ShComputeCache | null;
    shEvaluationState: { reason: string };
    contentRevision: number;
    graphRevision: number;
    perSourceSort: object | null;
  };
}

describe('pool-indexed SH compute cache', () => {
  it('invalidates on content, graph, camera and explicit view changes, not idle frames', () => {
    const gpu = renderer();
    const r = gpu as unknown as THREE.WebGPURenderer;
    const texture = new THREE.DataTexture(new Float32Array(4), 1, 1);
    const cache = new ShComputeCache({
      capacity: 513,
      sourceIndex: new THREE.StorageBufferAttribute(new Uint32Array(513), 1),
      centersTexture: texture,
      covarianceBTexture: texture,
      dataTextureWidth: 1,
      sh: { mode: 'palette', bands: 1, paletteTexture: texture },
      localCameraPosition: uniform(new THREE.Vector3()),
    });
    const camera = new THREE.Vector3(0, 0, 3);
    cache.prepare(r, 17, camera, 0, 0, 0);
    expect(cache.pass.count).toBe(17);
    expect(cache.snapshot()).toMatchObject({
      dispatches: 1,
      gpuBytes: 513 * 12,
      peakBytes: 513 * 24,
    });
    cache.prepare(r, 17, camera, 0, 0, 1);
    expect(gpu.compute).toHaveBeenCalledTimes(1);
    expect(cache.enabled.value).toBe(true);
    cache.prepare(r, 17, camera.set(1, 0, 3), 0, 0, 2);
    expect(cache.enabled.value).toBe(false);
    expect(gpu.compute).toHaveBeenCalledTimes(1);
    cache.prepare(r, 17, camera, 0, 0, 151);
    expect(gpu.compute).toHaveBeenCalledTimes(1);
    cache.prepare(r, 17, camera, 0, 0, 152);
    expect(gpu.compute).toHaveBeenCalledTimes(2);
    expect(cache.enabled.value).toBe(true);
    cache.prepare(r, 17, camera, 1, 0, 153);
    cache.prepare(r, 17, camera, 1, 1, 154);
    cache.prepare(r, 18, camera, 1, 1, 155);
    cache.prepare(r, 18, camera.set(2, 0, 3), 1, 1, 156, true);
    expect(cache.enabled.value).toBe(true);
    cache.invalidate();
    cache.prepare(r, 18, camera, 1, 1, 157);
    expect(gpu.compute).toHaveBeenCalledTimes(7);
    cache.prepare(r, 0, camera, 2, 1, 158);
    expect(gpu.compute).toHaveBeenCalledTimes(7);
    cache.dispose(r);
    cache.dispose(r);
    cache.prepare(r, 18, camera, 3, 1, 159);
    expect(gpu.compute).toHaveBeenCalledTimes(7);
    texture.dispose();
  });

  it('does not accept a failed dispatch as a valid cache', () => {
    const gpu = renderer();
    const mesh = new SplatMesh(data(), { shEvaluation: 'compute' });
    internals(mesh).ShCacheCtor = ShComputeCache;
    const camera = new THREE.PerspectiveCamera();
    gpu.compute.mockImplementationOnce(() => {
      throw new Error('dispatch failed');
    });
    expect(() =>
      mesh.update(camera, gpu as unknown as THREE.WebGPURenderer, { sort: false }),
    ).toThrow('dispatch failed');
    expect(internals(mesh).shCache?.snapshot().dispatches).toBe(0);
    mesh.update(camera, gpu as unknown as THREE.WebGPURenderer, { sort: false });
    expect(internals(mesh).shCache?.snapshot().dispatches).toBe(1);
    mesh.dispose();
  });

  it('reuses moving colors between sorts and refreshes on sort or settling', () => {
    const gpu = renderer();
    const r = gpu as unknown as THREE.WebGPURenderer;
    const texture = new THREE.DataTexture(new Float32Array(4), 1, 1);
    const cache = new ShComputeCache({
      capacity: 8,
      sourceIndex: new THREE.StorageBufferAttribute(new Uint32Array(8), 1),
      centersTexture: texture,
      covarianceBTexture: texture,
      dataTextureWidth: 1,
      sh: { mode: 'palette', bands: 1, paletteTexture: texture },
      localCameraPosition: uniform(new THREE.Vector3()),
    });
    const camera = new THREE.Vector3(0, 0, 3);
    expect(cache.prepare(r, 8, camera, 0, 0, 0)).toBe('cache');
    expect(cache.prepare(r, 8, camera.set(1, 0, 3), 0, 0, 10, false, false, true)).toBe(
      'cache-between-sorts',
    );
    expect(cache.prepare(r, 8, camera, 0, 0, 50, false, false, true)).toBe('cache-between-sorts');
    expect(gpu.compute).toHaveBeenCalledTimes(1);
    expect(cache.prepare(r, 8, camera.set(2, 0, 3), 0, 0, 60, false, true, true)).toBe('cache');
    expect(gpu.compute).toHaveBeenCalledTimes(2);
    cache.prepare(r, 8, camera.set(3, 0, 3), 0, 0, 70, false, false, true);
    expect(cache.prepare(r, 8, camera, 0, 0, 220, false, false, true)).toBe('cache');
    expect(gpu.compute).toHaveBeenCalledTimes(3);
    cache.prepare(r, 8, camera, 1, 0, 221, false, false, true);
    expect(gpu.compute).toHaveBeenCalledTimes(4);
    expect(cache.snapshot()).toMatchObject({
      motionFallbacks: 0,
      sortCadenceDeferrals: 3,
      phase: 'cache',
    });
    cache.dispose(r);
    texture.dispose();
  });
});

describe('SH path selection and mesh lifecycle', () => {
  it.each(['auto', 'vertex'] as const)('allocates nothing on the %s path', (shEvaluation) => {
    const mesh = new SplatMesh(data(), { shEvaluation });
    mesh.update(new THREE.PerspectiveCamera(), renderer() as unknown as THREE.WebGPURenderer, {
      sort: false,
    });
    expect(internals(mesh).shCache).toBeNull();
    mesh.dispose();
  });

  it('selects the hybrid cache for an identified Apple Mac but excludes touch devices', () => {
    const gpu = renderer();
    const device = gpu.backend.device as typeof gpu.backend.device & {
      adapterInfo: { vendor: string; architecture: string };
    };
    device.adapterInfo = { vendor: 'apple', architecture: 'metal-3' };
    vi.stubGlobal('navigator', { platform: 'MacIntel', maxTouchPoints: 0 });
    const mac = new SplatMesh(data(), { shEvaluation: 'auto' });
    internals(mac).ShCacheCtor = ShComputeCache;
    mac.update(new THREE.PerspectiveCamera(), gpu as unknown as THREE.WebGPURenderer, {
      sort: false,
    });
    expect(internals(mac).shCache).not.toBeNull();
    expect(internals(mac).shEvaluationState.reason).toBe('apple-mac-auto');
    mac.dispose();

    vi.stubGlobal('navigator', { platform: 'MacIntel', maxTouchPoints: 5 });
    const touch = new SplatMesh(data(), { shEvaluation: 'auto' });
    internals(touch).ShCacheCtor = ShComputeCache;
    touch.update(new THREE.PerspectiveCamera(), gpu as unknown as THREE.WebGPURenderer, {
      sort: false,
    });
    expect(internals(touch).shCache).toBeNull();
    expect(internals(touch).shEvaluationState.reason).toBe('unvalidated-auto-device');
    touch.dispose();
    vi.unstubAllGlobals();
  });

  it.each([
    'webgl',
    'xr',
    'sh-disabled',
    'device-limits',
    'unified-source',
    'source-placement',
    'dynamic-or-shared-pool',
  ])('falls back before allocation for %s', (reason) => {
    const gpu = renderer();
    const mesh = new SplatMesh(reason === 'dynamic-or-shared-pool' ? { capacity: 8 } : data(), {
      shEvaluation: 'compute',
      ...(reason === 'sh-disabled' ? { shBands: 0 } : {}),
    });
    internals(mesh).ShCacheCtor = ShComputeCache;
    if (reason === 'webgl') gpu.backend.isWebGPUBackend = false;
    if (reason === 'xr') gpu.xr.isPresenting = true;
    if (reason === 'device-limits') gpu.backend.device.limits.maxStorageBufferBindingSize = 1;
    if (reason === 'unified-source') mesh.setUnifiedPickVisibility(true);
    if (reason === 'source-placement') internals(mesh).perSourceSort = {};
    // Call just the preparation seam: XR projection has a different camera contract.
    (mesh as unknown as { prepareShEvaluation(r: unknown): void }).prepareShEvaluation(gpu);
    expect(internals(mesh).shCache).toBeNull();
    expect(internals(mesh).shEvaluationState.reason).toBe(reason);
    expect(gpu.compute).not.toHaveBeenCalled();
    mesh.dispose();
  });

  it('reuses rotation-only SH and refreshes after content, transform and graph changes', () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const gpu = renderer() as unknown as THREE.WebGPURenderer;
    const mesh = new SplatMesh(data(), { shEvaluation: 'compute' });
    internals(mesh).ShCacheCtor = ShComputeCache;
    const camera = new THREE.PerspectiveCamera();
    camera.position.z = 3;
    const update = () => mesh.update(camera, gpu, { sort: false });
    update();
    const cache = internals(mesh).shCache!;
    update();
    camera.rotation.y = 0.2;
    update();
    expect(cache.snapshot().dispatches).toBe(1);
    camera.position.x = 1;
    update();
    expect(cache.enabled.value).toBe(false);
    expect(cache.snapshot().dispatches).toBe(1);
    now = 150;
    update();
    expect(cache.enabled.value).toBe(true);
    mesh.position.x = 0.5;
    update();
    expect(cache.enabled.value).toBe(false);
    now = 300;
    update();
    internals(mesh).contentRevision++;
    update();
    internals(mesh).graphRevision++;
    update();
    expect(cache.snapshot().dispatches).toBe(5);
    mesh.setUnifiedPickVisibility(true);
    update();
    expect(internals(mesh).shCache).toBeNull();
    mesh.setUnifiedPickVisibility(null);
    update();
    expect(internals(mesh).shCache).not.toBe(cache);
    mesh.dispose();
    update();
    expect(internals(mesh).shCache).toBeNull();
    clock.mockRestore();
  });
});
