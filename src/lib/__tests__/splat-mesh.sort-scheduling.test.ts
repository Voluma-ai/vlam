import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplatMesh, type SplatMeshOptions } from '../core/splat-mesh';
import { writeCovariance } from '../core/splat-data';
import type { SplatSorter } from '../core/sorter';

interface SplatMeshInternals {
  activeCount: number;
  sorter: SplatSorter;
  rebuildActiveList(): void;
  requestSortIfNeeded(camera: THREE.Camera, renderer: THREE.WebGPURenderer): void;
  noteRenderer(renderer: THREE.WebGPURenderer): void;
}

class StagingTestMesh extends SplatMesh {
  deferSort(): void {
    this.deferNextSortRequest();
  }

  appendStaged(count: number): ReturnType<SplatMesh['appendRange']> {
    return this.appendInactiveRange(makeSplatData(count));
  }

  activate(handle: ReturnType<SplatMesh['appendRange']>): void {
    this.setRangeActive(handle, true);
  }

  reserve(count: number): ReturnType<SplatMesh['appendRange']> {
    return this.reserveInactiveRange(count);
  }

  write(
    handle: ReturnType<SplatMesh['appendRange']>,
    data: ReturnType<typeof makeSplatData>,
    offset: number,
  ): void {
    this.writeInactiveRange(handle, data, offset);
  }
}

function makeSplatData(count: number): {
  count: number;
  positions: Float32Array;
  colors: Uint8Array;
  covariances: Float32Array;
} {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

function internals(mesh: SplatMesh): SplatMeshInternals {
  return mesh as unknown as SplatMeshInternals;
}

function renderer(webGpu: boolean): THREE.WebGPURenderer {
  return { backend: { isWebGPUBackend: webGpu } } as unknown as THREE.WebGPURenderer;
}

function cameraAt(x: number): THREE.Camera {
  const camera = new THREE.Camera();
  camera.position.set(x, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

describe('SplatMesh sort scheduling', () => {
  const meshes: SplatMesh[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
  });

  function meshWithSorter(
    options: SplatMeshOptions = {},
    accepted = true,
  ): { mesh: SplatMesh; sort: ReturnType<typeof vi.fn> } {
    const mesh = new SplatMesh({ capacity: 4096 }, options);
    mesh.appendRange(makeSplatData(1));
    internals(mesh).rebuildActiveList();
    const sort = vi.fn(() => accepted);
    internals(mesh).sorter = { kind: 'counting', sort, dispose: vi.fn() };
    meshes.push(mesh);
    return { mesh, sort };
  }

  it('throttles WebGPU moving-camera requests', () => {
    const { mesh, sort } = meshWithSorter({ sortIntervalMs: 100 });
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(25).mockReturnValueOnce(100);

    internals(mesh).requestSortIfNeeded(cameraAt(0), renderer(true));
    internals(mesh).requestSortIfNeeded(cameraAt(1), renderer(true));
    internals(mesh).requestSortIfNeeded(cameraAt(2), renderer(true));

    expect(sort).toHaveBeenCalledTimes(2);
  });

  it('leaves WebGL worker-sort request behavior unchanged', () => {
    const { mesh, sort } = meshWithSorter({ sortIntervalMs: 1000 });

    internals(mesh).requestSortIfNeeded(cameraAt(0), renderer(false));
    internals(mesh).requestSortIfNeeded(cameraAt(1), renderer(false));
    internals(mesh).requestSortIfNeeded(cameraAt(2), renderer(false));

    expect(sort).toHaveBeenCalledTimes(3);
  });

  it('forces an immediate sort when the active list changes', () => {
    const { mesh, sort } = meshWithSorter({ sortIntervalMs: 1000 });
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(10).mockReturnValueOnce(11);

    internals(mesh).requestSortIfNeeded(cameraAt(0), renderer(true));
    internals(mesh).requestSortIfNeeded(cameraAt(1), renderer(true));
    expect(sort).toHaveBeenCalledTimes(1);

    mesh.appendRange(makeSplatData(1));
    internals(mesh).rebuildActiveList();
    internals(mesh).requestSortIfNeeded(cameraAt(1), renderer(true));
    expect(sort).toHaveBeenCalledTimes(2);
  });

  it('forces even a one-splat active-list change before cadence expires', () => {
    const mesh = new SplatMesh({ capacity: 4096 }, { sortIntervalMs: 1000 });
    mesh.appendRange(makeSplatData(512));
    internals(mesh).rebuildActiveList();
    const sort = vi.fn(() => true);
    internals(mesh).sorter = { kind: 'counting', sort, dispose: vi.fn() };
    meshes.push(mesh);
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(10).mockReturnValueOnce(1000);

    internals(mesh).requestSortIfNeeded(cameraAt(0), renderer(true));
    mesh.appendRange(makeSplatData(1));
    internals(mesh).rebuildActiveList();
    internals(mesh).requestSortIfNeeded(cameraAt(0), renderer(true));
    internals(mesh).requestSortIfNeeded(cameraAt(0), renderer(true));

    expect(sort).toHaveBeenCalledTimes(2);
  });

  it('does not schedule a CPU splatIndex upload after an accepted GPU sort', () => {
    const { mesh, sort } = meshWithSorter();
    const attr = mesh.geometry.getAttribute('splatIndex') as THREE.BufferAttribute;
    const version = attr.version;
    internals(mesh).requestSortIfNeeded(cameraAt(0), renderer(true));
    expect(sort).toHaveBeenCalledTimes(1);
    expect(attr.version).toBe(version);
  });

  it('does not write an unsorted CPU draw list on WebGPU before the sorter exists', () => {
    const mesh = new StagingTestMesh({ capacity: 4096 });
    meshes.push(mesh);
    internals(mesh).noteRenderer(renderer(true));
    const attr = mesh.geometry.getAttribute('splatIndex') as THREE.BufferAttribute;
    const version = attr.version;
    mesh.appendRange(makeSplatData(8));
    internals(mesh).rebuildActiveList();
    expect(attr.version).toBe(version);
  });

  it('sortIntervalMs zero restores every changed WebGPU frame', () => {
    const { mesh, sort } = meshWithSorter({ sortIntervalMs: 0 });
    vi.spyOn(performance, 'now').mockReturnValue(0);

    internals(mesh).requestSortIfNeeded(cameraAt(0), renderer(true));
    internals(mesh).requestSortIfNeeded(cameraAt(1), renderer(true));
    internals(mesh).requestSortIfNeeded(cameraAt(2), renderer(true));

    expect(sort).toHaveBeenCalledTimes(3);
  });

  it('does not re-sort radial distance when only the camera rotates', () => {
    const { mesh, sort } = meshWithSorter({ sortIntervalMs: 0, sortMetric: 'radial' });
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const camera = cameraAt(3);

    internals(mesh).requestSortIfNeeded(camera, renderer(true));
    camera.rotation.y = 0.5;
    camera.updateMatrixWorld(true);
    internals(mesh).requestSortIfNeeded(camera, renderer(true));

    expect(sort).toHaveBeenCalledTimes(1);
  });

  it('can leave one queue-drain frame before a staged commit sort', () => {
    const mesh = new StagingTestMesh({ capacity: 4096 }, { sortIntervalMs: 0 });
    mesh.appendRange(makeSplatData(1));
    internals(mesh).rebuildActiveList();
    const sort = vi.fn(() => true);
    internals(mesh).sorter = { kind: 'counting', sort, dispose: vi.fn() };
    meshes.push(mesh);
    vi.spyOn(performance, 'now').mockReturnValue(0);

    internals(mesh).requestSortIfNeeded(cameraAt(0), renderer(true));
    mesh.deferSort();
    internals(mesh).requestSortIfNeeded(cameraAt(1), renderer(true));
    internals(mesh).requestSortIfNeeded(cameraAt(2), renderer(true));

    expect(sort).toHaveBeenCalledTimes(2);
  });

  it('still sorts when a group activates rows after the drain frame is asked for', () => {
    const mesh = new StagingTestMesh({ capacity: 4096 }, { sortIntervalMs: 0 });
    mesh.appendRange(makeSplatData(1));
    internals(mesh).rebuildActiveList();
    const sort = vi.fn(() => true);
    internals(mesh).sorter = { kind: 'counting', sort, dispose: vi.fn() };
    meshes.push(mesh);
    vi.spyOn(performance, 'now').mockReturnValue(0);

    internals(mesh).requestSortIfNeeded(cameraAt(0), renderer(true));
    expect(sort).toHaveBeenCalledTimes(1);

    // A staged group wants a drain frame, but a later swap group in the same
    // tick still changed what is active - the order buffer no longer describes
    // the draw list, so the drain frame must yield.
    mesh.deferSort();
    mesh.appendRange(makeSplatData(8));
    internals(mesh).rebuildActiveList();
    internals(mesh).requestSortIfNeeded(cameraAt(1), renderer(true));

    expect(sort).toHaveBeenCalledTimes(2);
  });

  it('still sorts when a group activates rows before the drain frame is asked for', () => {
    const mesh = new StagingTestMesh({ capacity: 4096 }, { sortIntervalMs: 0 });
    mesh.appendRange(makeSplatData(1));
    internals(mesh).rebuildActiveList();
    const sort = vi.fn(() => true);
    internals(mesh).sorter = { kind: 'counting', sort, dispose: vi.fn() };
    meshes.push(mesh);
    vi.spyOn(performance, 'now').mockReturnValue(0);

    internals(mesh).requestSortIfNeeded(cameraAt(0), renderer(true));
    expect(sort).toHaveBeenCalledTimes(1);

    // Pure-removal groups apply first, so the mutation can precede the defer.
    mesh.appendRange(makeSplatData(8));
    internals(mesh).rebuildActiveList();
    mesh.deferSort();
    internals(mesh).requestSortIfNeeded(cameraAt(1), renderer(true));

    expect(sort).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid public sort intervals during construction', () => {
    for (const invalid of [-1, Number.NaN, Infinity, -Infinity]) {
      expect(() => new SplatMesh({ capacity: 1 }, { sortIntervalMs: invalid })).toThrow(RangeError);
    }
  });

  it('accepts all sort strategies and performance profiles', () => {
    const counting = new SplatMesh({ capacity: 1 }, { sortStrategy: 'counting' });
    const worker = new SplatMesh({ capacity: 1 }, { sortStrategy: 'worker' });
    const radix = new SplatMesh(
      { capacity: 1 },
      { sortStrategy: 'radix', performanceProfile: 'smooth' },
    );
    const exact = new SplatMesh({ capacity: 1 }, { sortStrategy: 'exact' });
    meshes.push(counting, worker, radix, exact);
    expect(() => radix.setPerformanceProfile('quality')).not.toThrow();
  });

  it('floors only undersized mobile splats while keeping the reference cutoff', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S928B) Chrome/150.0.0.0 Mobile Safari/537.36',
      platform: '',
      maxTouchPoints: 5,
    });
    try {
      // Use the one-shot/static constructor so this also guards the static
      // material path rather than only dynamic pools used by streaming.
      const mesh = new SplatMesh(makeSplatData(1));
      meshes.push(mesh);
      const defaults = mesh as unknown as {
        performanceProfile: string;
        maxStdDev: number;
        minSplatSizePx: number;
      };
      expect(defaults.performanceProfile).toBe('smooth');
      expect(defaults.maxStdDev).toBe(3);
      expect(defaults.minSplatSizePx).toBe(1.5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the reference-quality defaults off mobile', () => {
    const mesh = new SplatMesh({ capacity: 4096 });
    meshes.push(mesh);
    const defaults = mesh as unknown as {
      performanceProfile: string;
      maxStdDev: number;
      minSplatSizePx: number;
    };
    expect(defaults.performanceProfile).toBe('quality');
    expect(defaults.maxStdDev).toBe(3);
    expect(defaults.minSplatSizePx).toBe(0);
  });

  it('does not apply the mobile floor to a fill-constrained desktop', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
      maxTouchPoints: 0,
    });
    const mesh = new SplatMesh({ capacity: 4096 });
    meshes.push(mesh);
    // GPU classification can make this desktop use the smooth profile later;
    // the mobile-only coverage floor must nevertheless remain disabled.
    expect(mesh.getUnifiedSourceView().minSplatSizePx).toBe(0);
    expect(mesh.getUnifiedSourceView().maxStdDev).toBe(3);
  });

  it('lets explicit options override the device defaults', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S928B) Chrome/150.0.0.0 Mobile Safari/537.36',
      platform: '',
      maxTouchPoints: 5,
    });
    try {
      const mesh = new SplatMesh(
        { capacity: 4096 },
        { performanceProfile: 'quality', maxStdDev: 4, minSplatSizePx: 0 },
      );
      meshes.push(mesh);
      const overridden = mesh as unknown as {
        performanceProfile: string;
        maxStdDev: number;
        minSplatSizePx: number;
      };
      expect(overridden.performanceProfile).toBe('quality');
      expect(overridden.maxStdDev).toBe(4);
      expect(overridden.minSplatSizePx).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a maxStdDev that would collapse or invert every splat', () => {
    for (const invalid of [0, -1, Number.NaN, Infinity]) {
      expect(() => new SplatMesh({ capacity: 1 }, { maxStdDev: invalid })).toThrow(RangeError);
    }
  });

  it('rebuilds the cutoff through setMaxStdDev', () => {
    const mesh = new SplatMesh({ capacity: 1 }, { maxStdDev: 4 });
    meshes.push(mesh);
    expect(mesh.maxStdDev).toBe(4);
    mesh.setMaxStdDev(3);
    expect(mesh.maxStdDev).toBe(3);
  });

  it('rejects setMaxStdDev values that would collapse every splat', () => {
    const mesh = new SplatMesh({ capacity: 1 });
    meshes.push(mesh);
    for (const invalid of [0, -1, Number.NaN, Infinity]) {
      expect(() => mesh.setMaxStdDev(invalid)).toThrow(RangeError);
    }
  });

  it('keeps staged ranges out of the active list until atomic activation', () => {
    const mesh = new StagingTestMesh({ capacity: 4096 });
    meshes.push(mesh);
    const staged = mesh.appendStaged(3);

    internals(mesh).rebuildActiveList();
    expect(internals(mesh).activeCount).toBe(0);

    mesh.activate(staged);
    internals(mesh).rebuildActiveList();
    expect(internals(mesh).activeCount).toBe(3);
  });

  it('fills one inactive range in segments before atomic activation', () => {
    const mesh = new StagingTestMesh({ capacity: 4096 });
    meshes.push(mesh);
    const staged = mesh.reserve(4);

    mesh.write(staged, makeSplatData(2), 0);
    internals(mesh).rebuildActiveList();
    expect(internals(mesh).activeCount).toBe(0);

    mesh.write(staged, makeSplatData(2), 2);
    mesh.activate(staged);
    internals(mesh).rebuildActiveList();
    expect(internals(mesh).activeCount).toBe(4);
  });
});
