import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplatMesh, type SplatMeshOptions } from '../core/splat-mesh';
import { writeCovariance } from '../core/splat-data';
import type { SplatSorter } from '../core/sorter';
import { computeProjection } from '../projection/compute';
import { exactSort, radixSort } from '../sorting/radix';

interface SplatMeshInternals {
  activeCount: number;
  sorter: SplatSorter;
  rebuildActiveList(): void;
  requestSortIfNeeded(camera: THREE.Camera, renderer: THREE.WebGPURenderer): void;
  noteRenderer(renderer: THREE.WebGPURenderer): void;
  sortScheduler: {
    submissionDiagnostics(): { action: string; serial: number };
    hasSubmissionInFlight(): boolean;
  };
  sourceIndexAttribute: THREE.BufferAttribute;
  projectedPipeline: { projectionDispatches: number } | null;
  projectedSorter: { submissionCount: number } | null;
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

function graphRevision(mesh: SplatMesh): number {
  return (mesh as unknown as { graphRevision: number }).graphRevision;
}

function pickerOf(mesh: SplatMesh): { markNeedsUpdate(): void } {
  return (mesh as unknown as { picker: { markNeedsUpdate(): void } }).picker;
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

function perspectiveAt(x: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(x, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function rendererWithPendingGpu(completion?: Promise<void>): THREE.WebGPURenderer {
  return {
    backend: {
      isWebGPUBackend: true,
      device: {
        queue: {
          onSubmittedWorkDone: () => completion ?? new Promise<void>(() => {}),
        },
      },
    },
    getDrawingBufferSize: (out: THREE.Vector2) => out.set(800, 600),
    compute: vi.fn(),
    copyTextureToTexture: vi.fn(),
  } as unknown as THREE.WebGPURenderer;
}

function pendingGpuCompletion(): { renderer: THREE.WebGPURenderer; resolve: () => void } {
  let resolve = (): void => {};
  const completion = new Promise<void>((done) => {
    resolve = done;
  });
  return { renderer: rendererWithPendingGpu(completion), resolve };
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

  it('sorts every frame through update() with a WebGL worker sorter', () => {
    // A real `WorkerSorter` is created by `update()` on the WebGL backend; the
    // stubbed Worker answers each sort request within the same frame. The
    // worker owns no GPU order buffer, so no submission hold may ever gate it:
    // `onAfterRender()` arms the render-ack fallback for marked submissions
    // and would otherwise suppress every other frame's sort.
    const globalWorker = globalThis as { Worker?: unknown };
    const previousWorker = globalWorker.Worker;
    let sortRequests = 0;
    globalWorker.Worker = class {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      postMessage(message: { type: string; requestId?: number; spans?: Uint32Array }): void {
        if (message.type !== 'sort') return;
        sortRequests++;
        const spans = message.spans ?? new Uint32Array(0);
        const order: number[] = [];
        for (let i = 0; i < spans.length; i += 2) {
          for (let j = 0; j < (spans[i + 1] as number); j++) order.push((spans[i] as number) + j);
        }
        this.onmessage?.({
          data: { type: 'order', requestId: message.requestId, order: Uint32Array.from(order) },
        });
      }
      terminate(): void {}
    };
    try {
      const mesh = new SplatMesh({ capacity: 4096 });
      meshes.push(mesh);
      mesh.appendRange(makeSplatData(1));
      internals(mesh).rebuildActiveList();
      const webgl = {
        backend: { isWebGPUBackend: false },
        getDrawingBufferSize: (out: THREE.Vector2) => out.set(800, 600),
        copyTextureToTexture: vi.fn(),
      } as unknown as THREE.WebGPURenderer;
      const scene = new THREE.Scene();
      const now = vi.spyOn(performance, 'now');
      const perFrame: number[] = [];
      for (let frame = 0; frame < 10; frame++) {
        now.mockReturnValue(frame * 16.7);
        const camera = perspectiveAt(frame);
        mesh.update(camera, webgl);
        mesh.onAfterRender(webgl as never, scene, camera);
        perFrame.push(sortRequests);
      }
      expect(internals(mesh).sorter.kind).toBe('worker');
      expect(perFrame).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      globalWorker.Worker = previousWorker;
    }
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

  it('releases a standalone sort when unified takes over before the source draws', async () => {
    const { mesh, sort } = meshWithSorter();
    const gpu = pendingGpuCompletion();
    const camera = perspectiveAt(0);
    mesh.update(camera, gpu.renderer);
    expect(internals(mesh).sortScheduler.hasSubmissionInFlight()).toBe(true);
    mesh.setUnifiedPickVisibility(true);
    mesh.visible = false;
    mesh.update(camera, gpu.renderer, { sort: false });
    expect(internals(mesh).sortScheduler.hasSubmissionInFlight()).toBe(true);
    gpu.resolve();
    await Promise.resolve();
    expect(internals(mesh).sortScheduler.hasSubmissionInFlight()).toBe(false);
    expect(sort).toHaveBeenCalledTimes(1);
  });

  it('advances the fallback sort gate for unified sources without a queue fence', () => {
    const { mesh, sort } = meshWithSorter();
    const gpuRenderer = rendererWithPendingGpu();
    delete (gpuRenderer.backend as unknown as { device?: unknown }).device;
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const camera = perspectiveAt(0);
    mesh.update(camera, gpuRenderer);
    mesh.setUnifiedPickVisibility(true);
    mesh.visible = false;
    mesh.update(camera, gpuRenderer, { sort: false });
    now.mockReturnValue(1000);
    for (let frame = 0; frame < 5; frame++) mesh.update(camera, gpuRenderer, { sort: false });
    expect(internals(mesh).sortScheduler.hasSubmissionInFlight()).toBe(false);
    expect(sort).toHaveBeenCalledTimes(1);
  });

  it('holds an in-flight GPU sort across an active-list swap and coalesces', () => {
    const { mesh, sort } = meshWithSorter({ sortIntervalMs: 1000 });
    const gpuRenderer = rendererWithPendingGpu();
    const camera = perspectiveAt(0);
    const scene = new THREE.Scene();

    mesh.update(camera, gpuRenderer);
    expect(sort).toHaveBeenCalledTimes(1);
    mesh.onAfterRender(gpuRenderer as never, scene, camera);

    const sourceVersion = internals(mesh).sourceIndexAttribute.version;
    mesh.appendRange(makeSplatData(1));
    internals(mesh).rebuildActiveList();
    mesh.update(camera, gpuRenderer);
    expect(sort).toHaveBeenCalledTimes(1);
    expect(internals(mesh).sortScheduler.submissionDiagnostics().action).toBe('coalesced');
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);
    expect(internals(mesh).sourceIndexAttribute.version).toBe(sourceVersion);
    expect(internals(mesh).activeCount).toBe(2);
  });

  it('keeps the previous WebGPU instanceCount when a removal is held', () => {
    const { mesh, sort } = meshWithSorter({ sortIntervalMs: 1000 });
    const gpuRenderer = rendererWithPendingGpu();
    const camera = perspectiveAt(0);
    const scene = new THREE.Scene();

    const extra = mesh.appendRange(makeSplatData(1));
    internals(mesh).rebuildActiveList();
    mesh.update(camera, gpuRenderer);
    expect(sort).toHaveBeenCalledTimes(1);
    mesh.onAfterRender(gpuRenderer as never, scene, camera);
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(2);

    mesh.removeRange(extra);
    const sourceVersion = internals(mesh).sourceIndexAttribute.version;
    internals(mesh).rebuildActiveList();
    mesh.update(camera, gpuRenderer);
    expect(sort).toHaveBeenCalledTimes(1);
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(2);
    expect(internals(mesh).sourceIndexAttribute.version).toBe(sourceVersion);
    expect(internals(mesh).activeCount).toBe(1);
  });

  it('restores the primary order over a secondary view while the gate is held', async () => {
    const { mesh, sort } = meshWithSorter({ sortIntervalMs: 1000 });
    const modelViews: THREE.Matrix4[] = [];
    sort.mockImplementation((modelView: THREE.Matrix4) => {
      modelViews.push(modelView.clone());
      return true;
    });
    const gpu = pendingGpuCompletion();
    Object.assign(gpu.renderer, {
      getRenderTarget: () => null,
      setRenderTarget: vi.fn(),
      render: vi.fn(),
    });
    const scene = new THREE.Scene();
    const main = perspectiveAt(0);
    const mirror = perspectiveAt(3);

    mesh.update(main, gpu.renderer);
    const serial = internals(mesh).sortScheduler.submissionDiagnostics().serial;
    mesh.renderView(mirror, gpu.renderer, new THREE.RenderTarget(64, 64));
    mesh.onAfterRender(gpu.renderer as never, scene, mirror);
    mesh.update(main, gpu.renderer);

    expect(sort).toHaveBeenCalledTimes(3);
    const primary = new THREE.Matrix4().multiplyMatrices(main.matrixWorldInverse, mesh.matrixWorld);
    expect(modelViews[2]!.elements).toEqual(primary.elements);
    expect(internals(mesh).sortScheduler.submissionDiagnostics().serial).toBe(serial);

    mesh.update(main, gpu.renderer);
    expect(sort).toHaveBeenCalledTimes(3);

    gpu.resolve();
    await Promise.resolve();
    expect(internals(mesh).sortScheduler.hasSubmissionInFlight()).toBe(false);
  });

  it('still holds a camera-only sort while a previous GPU sort is in flight', () => {
    const { mesh, sort } = meshWithSorter({ sortIntervalMs: 0 });
    const gpuRenderer = rendererWithPendingGpu();
    const scene = new THREE.Scene();

    mesh.update(perspectiveAt(0), gpuRenderer);
    expect(sort).toHaveBeenCalledTimes(1);
    mesh.onAfterRender(gpuRenderer as never, scene, perspectiveAt(0));

    mesh.update(perspectiveAt(1), gpuRenderer);
    expect(sort).toHaveBeenCalledTimes(1);
    expect(internals(mesh).sortScheduler.submissionDiagnostics().action).toBe('suppressed');
  });

  it('re-projects a camera move under a held gate with compute projection', async () => {
    // The hardware projection probe: move, draw, move again before the GPU
    // acknowledges the first sort, then hold the camera. Compute projection
    // draws from cached clip-space centers, so the second move must dispatch
    // even while the first submission still holds the gate; the stationary
    // updates afterwards must not.
    const gpu = pendingGpuCompletion();
    const mesh = new SplatMesh(makeSplatData(1), {
      sortIntervalMs: 0,
      projectionStrategy: computeProjection(),
    });
    meshes.push(mesh);
    const scene = new THREE.Scene();
    const orbit = perspectiveAt(3);
    const front = perspectiveAt(0);

    mesh.update(orbit, gpu.renderer);
    expect(mesh.projectionStrategyStatus.effective).toBe('compute');
    const pipeline = internals(mesh).projectedPipeline!;
    const sorter = internals(mesh).projectedSorter!;
    expect(pipeline.projectionDispatches).toBe(1);
    expect(sorter.submissionCount).toBe(1);
    mesh.onAfterRender(gpu.renderer as never, scene, orbit);
    const firstSerial = internals(mesh).sortScheduler.submissionDiagnostics().serial;

    mesh.update(front, gpu.renderer);
    expect(pipeline.projectionDispatches).toBe(2);
    expect(sorter.submissionCount).toBe(2);
    expect(internals(mesh).sortScheduler.submissionDiagnostics().action).toBe('submitted');
    // The gate now follows the replacement dispatch, not the superseded one.
    const secondSerial = internals(mesh).sortScheduler.submissionDiagnostics().serial;
    expect(secondSerial).toBeGreaterThan(firstSerial);

    mesh.update(front, gpu.renderer);
    mesh.update(front, gpu.renderer);
    expect(pipeline.projectionDispatches).toBe(2);
    expect(sorter.submissionCount).toBe(2);

    gpu.resolve();
    await Promise.resolve();
    expect(internals(mesh).sortScheduler.hasSubmissionInFlight()).toBe(true);
    expect(internals(mesh).sortScheduler.submissionDiagnostics().serial).toBe(secondSerial);
  });

  it('keeps coalescing content changes under a held gate with compute projection', () => {
    // A content change must still wait for the buffer to be free; only the
    // camera-only re-projection bypasses the hold.
    const gpu = pendingGpuCompletion();
    const mesh = new SplatMesh(
      { capacity: 4096 },
      {
        sortIntervalMs: 0,
        projectionStrategy: computeProjection(),
      },
    );
    mesh.appendRange(makeSplatData(1));
    internals(mesh).rebuildActiveList();
    meshes.push(mesh);
    const scene = new THREE.Scene();
    const camera = perspectiveAt(0);

    mesh.update(camera, gpu.renderer);
    expect(mesh.projectionStrategyStatus.effective).toBe('compute');
    const pipeline = internals(mesh).projectedPipeline!;
    expect(pipeline.projectionDispatches).toBe(1);
    mesh.onAfterRender(gpu.renderer as never, scene, camera);

    mesh.appendRange(makeSplatData(1));
    internals(mesh).rebuildActiveList();
    mesh.update(perspectiveAt(1), gpu.renderer);
    expect(pipeline.projectionDispatches).toBe(1);
    expect(internals(mesh).sortScheduler.submissionDiagnostics().action).toBe('coalesced');
  });

  it('does not force a coalesced camera-only sort ahead of cadence', async () => {
    const { renderer, resolve } = pendingGpuCompletion();
    const { mesh, sort } = meshWithSorter({ sortIntervalMs: 1000 });
    const scene = new THREE.Scene();
    vi.spyOn(performance, 'now').mockReturnValue(0);

    mesh.update(perspectiveAt(0), renderer);
    expect(sort).toHaveBeenCalledTimes(1);
    mesh.onAfterRender(renderer as never, scene, perspectiveAt(0));
    mesh.update(perspectiveAt(1), renderer);
    expect(sort).toHaveBeenCalledTimes(1);

    resolve();
    await Promise.resolve();
    mesh.update(perspectiveAt(2), renderer);
    expect(sort).toHaveBeenCalledTimes(1);
  });

  it('forces a coalesced content sort once the in-flight GPU pass completes', async () => {
    const { renderer, resolve } = pendingGpuCompletion();
    const { mesh, sort } = meshWithSorter({ sortIntervalMs: 1000 });
    const camera = perspectiveAt(0);
    const scene = new THREE.Scene();
    vi.spyOn(performance, 'now').mockReturnValue(0);

    mesh.update(camera, renderer);
    expect(sort).toHaveBeenCalledTimes(1);
    mesh.onAfterRender(renderer as never, scene, camera);

    mesh.appendRange(makeSplatData(1));
    internals(mesh).rebuildActiveList();
    mesh.update(camera, renderer);
    expect(sort).toHaveBeenCalledTimes(1);
    expect(internals(mesh).sortScheduler.submissionDiagnostics().action).toBe('coalesced');
    const sourceVersion = internals(mesh).sourceIndexAttribute.version;

    resolve();
    await Promise.resolve();
    mesh.update(camera, renderer);
    expect(sort).toHaveBeenCalledTimes(2);
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(2);
    expect(internals(mesh).sourceIndexAttribute.version).toBeGreaterThan(sourceVersion);
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
      { sortStrategy: radixSort(), performanceProfile: 'smooth' },
    );
    const exact = new SplatMesh({ capacity: 1 }, { sortStrategy: exactSort() });
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

  it('preserves full detail off mobile', () => {
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

  // The cutoff and the contribution culls live in the compiled shader. three's
  // render-object cache only recompiles when `material.version` changes, so a
  // setter that rebuilt the node graph without bumping it left the previously
  // compiled pipeline drawing while the getter already reported the new value.
  it('publishes a setMaxStdDev rebuild through material.version and graphRevision', () => {
    const mesh = new SplatMesh({ capacity: 1 }, { maxStdDev: 4 });
    meshes.push(mesh);
    const material = mesh.material as THREE.Material;
    const pickerInvalidated = vi.spyOn(pickerOf(mesh), 'markNeedsUpdate');
    const versionBefore = material.version;
    const revisionBefore = graphRevision(mesh);

    mesh.setMaxStdDev(3);
    expect(material.version).toBeGreaterThan(versionBefore);
    expect(graphRevision(mesh)).toBeGreaterThan(revisionBefore);
    expect(pickerInvalidated).toHaveBeenCalledTimes(1);

    // Same value again is a no-op: nothing recompiles.
    const versionAfter = material.version;
    const revisionAfter = graphRevision(mesh);
    mesh.setMaxStdDev(3);
    expect(material.version).toBe(versionAfter);
    expect(graphRevision(mesh)).toBe(revisionAfter);
    expect(pickerInvalidated).toHaveBeenCalledTimes(1);
  });

  it('publishes a setPerformanceProfile rebuild through material.version and graphRevision', () => {
    const mesh = new SplatMesh({ capacity: 1 }, { performanceProfile: 'quality' });
    meshes.push(mesh);
    const material = mesh.material as THREE.Material;
    const pickerInvalidated = vi.spyOn(pickerOf(mesh), 'markNeedsUpdate');
    expect(mesh.performanceProfile).toBe('quality');
    const versionBefore = material.version;
    const revisionBefore = graphRevision(mesh);

    mesh.setPerformanceProfile('smooth');
    expect(mesh.performanceProfile).toBe('smooth');
    expect(material.version).toBeGreaterThan(versionBefore);
    expect(graphRevision(mesh)).toBeGreaterThan(revisionBefore);
    expect(pickerInvalidated).toHaveBeenCalledTimes(1);

    const versionAfter = material.version;
    const revisionAfter = graphRevision(mesh);
    mesh.setPerformanceProfile('smooth');
    expect(material.version).toBe(versionAfter);
    expect(graphRevision(mesh)).toBe(revisionAfter);
    expect(pickerInvalidated).toHaveBeenCalledTimes(1);
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
