import * as THREE from 'three/webgpu';
import { bool, float } from 'three/tsl';
import { describe, expect, it, vi } from 'vitest';
import { writeCovariance, type SplatData } from '../core/splat-data';
import { SplatMesh } from '../core/splat-mesh';
import { MergedSplatMesh } from '../core/merged-splat-mesh';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '../unified/unified-splat-mesh';
import { exactSort, radixSort } from '../sorting/radix';
import { computeProjection } from '../projection/compute';

function source(
  options: {
    maxStdDev?: number;
    minSplatSizePx?: number;
    antialias?: boolean;
    performanceProfile?: 'quality' | 'balanced' | 'smooth';
    minPixelSize?: number;
    minContribution?: number;
    lodAlpha?: boolean;
    sh?: boolean;
    storageMode?: 'editable' | 'render-only';
  } = {},
): SplatMesh {
  const covariance = new Float32Array(6);
  writeCovariance(covariance, 0, 1, 1, 1, 1, 0, 0, 0);
  return new SplatMesh(
    {
      count: 1,
      positions: new Float32Array([0, 0, 0]),
      colors: new Uint8Array([255, 0, 0, 255]),
      covariances: covariance,
      ...(options.sh
        ? {
            shPacked: {
              bands: 1 as const,
              packed: new Uint32Array(3),
              range: { min: [-1, -1, -1] as const, max: [1, 1, 1] as const },
            },
          }
        : {}),
    },
    options,
  );
}

function splatChunk(): SplatData {
  const covariance = new Float32Array(6);
  writeCovariance(covariance, 0, 1, 1, 1, 1, 0, 0, 0);
  return {
    count: 1,
    positions: new Float32Array([0, 0, 0]),
    colors: new Uint8Array([255, 0, 0, 255]),
    covariances: covariance,
  };
}

function mockRenderer(extras: Record<string, unknown> = {}): THREE.WebGPURenderer {
  return {
    compute: vi.fn(),
    copyTextureToTexture: vi.fn(),
    getDrawingBufferSize: (out: THREE.Vector2) => out.set(800, 600),
    backend: { isWebGPUBackend: true },
    ...extras,
  } as unknown as THREE.WebGPURenderer;
}

function pendingGpuCompletion(): {
  renderer: THREE.WebGPURenderer;
  resolve: () => void;
} {
  let resolve = (): void => {};
  const completion = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    renderer: mockRenderer({
      backend: {
        isWebGPUBackend: true,
        device: {
          queue: {
            onSubmittedWorkDone: () => completion,
          },
        },
      },
    }),
    resolve,
  };
}

function gatherSpies(unified: UnifiedSplatMesh) {
  const records = (
    unified as unknown as {
      sources: Array<{
        source: SplatMesh;
        gather: {
          gather: (...args: unknown[]) => void;
          gatherColors: (...args: unknown[]) => void;
        };
      }>;
    }
  ).sources;
  return records.map((record) => ({
    source: record.source,
    gather: vi.spyOn(record.gather, 'gather'),
    gatherColors: vi.spyOn(record.gather, 'gatherColors'),
  }));
}

describe('supportsUnifiedSplatMesh', () => {
  it('accepts a WebGPU backend and rejects others', () => {
    expect(supportsUnifiedSplatMesh(mockRenderer())).toBe(true);
    expect(supportsUnifiedSplatMesh({ backend: {} })).toBe(false);
    expect(supportsUnifiedSplatMesh({})).toBe(false);
  });
});

describe('UnifiedSplatMesh', () => {
  it('accepts the lightweight vertex default', () => {
    const unified = new UnifiedSplatMesh(mockRenderer(), 1);
    expect(unified.projectionStrategy).toBe('vertex');
    expect(unified.projectionStrategyStatus).toEqual({
      effective: 'vertex',
      reason: 'explicit-vertex',
    });
    unified.dispose();
  });

  it('rejects render-only sources before mutating registration state', () => {
    const renderer = mockRenderer();
    const mesh = source({ storageMode: 'render-only' });
    const unified = new UnifiedSplatMesh(renderer, 1);

    expect(() => unified.addSource(mesh)).toThrow(/render-only/);
    expect(mesh.visible).toBe(true);
    expect(unified.removeSource(mesh)).toBe(false);

    unified.dispose();
    mesh.dispose();
  });

  it.each([
    ['radix', radixSort(), false],
    ['exact', exactSort(), true],
  ] as const)('uses the stable %s sorter when requested', (_label, sortStrategy, exactDepth) => {
    const unified = new UnifiedSplatMesh(mockRenderer(), 1, { sortStrategy });
    const sorterName = (unified as unknown as { sorter: { constructor: { name: string } } }).sorter
      .constructor.name;
    expect(sorterName).toBe('RadixSorter');
    expect((unified as unknown as { sorter: { exactDepth: boolean } }).sorter.exactDepth).toBe(
      exactDepth,
    );
    unified.dispose();
  });

  it('rejects the former radix string instead of falling through to counting', () => {
    expect(
      () => new UnifiedSplatMesh(mockRenderer(), 1, { sortStrategy: 'radix' as never }),
    ).toThrow(/unsupported sortStrategy "radix"/);
  });

  it('rejects worker sorting instead of falling through to counting', () => {
    expect(
      () => new UnifiedSplatMesh(mockRenderer(), 1, { sortStrategy: 'worker' as never }),
    ).toThrow(/worker sorting is unsupported/);
  });

  it('copies the source projected-footprint floor into the unified draw path', () => {
    const renderer = mockRenderer();
    const mesh = source({ minSplatSizePx: 1.5 });
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    expect((unified as unknown as { minSplatSizePx: { value: number } }).minSplatSizePx.value).toBe(
      1.5,
    );
    unified.dispose();
    mesh.dispose();
  });

  it('applies balanced contribution culls to the shared vertex and compute paths', () => {
    const renderer = mockRenderer();
    const mesh = source({ performanceProfile: 'balanced' });
    const computeMesh = source({ performanceProfile: 'balanced' });
    const vertex = new UnifiedSplatMesh(renderer, 1, { performanceProfile: 'balanced' });
    const compute = new UnifiedSplatMesh(renderer, 1, {
      performanceProfile: 'balanced',
      projectionStrategy: computeProjection(),
    });

    vertex.addSource(mesh);
    compute.addSource(computeMesh);
    expect(vertex as unknown as { minPixelSize: number; minContribution: number }).toMatchObject({
      minPixelSize: 2,
      minContribution: 3,
    });
    expect(compute as unknown as { minPixelSize: number; minContribution: number }).toMatchObject({
      minPixelSize: 2,
      minContribution: 3,
    });

    vertex.dispose();
    compute.dispose();
    mesh.dispose();
    computeMesh.dispose();
  });

  it('rejects a source whose contribution culls differ from the unified draw', () => {
    const renderer = mockRenderer();
    const unified = new UnifiedSplatMesh(renderer, 1, { performanceProfile: 'balanced' });
    const quality = source({ performanceProfile: 'quality' });

    expect(() => unified.addSource(quality)).toThrow(/contribution-culling/);

    unified.dispose();
    quality.dispose();
  });

  it('gathers registered source pools into one draw range', () => {
    const renderer = mockRenderer();
    const first = source();
    const second = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    expect(unified.capacity).toBe(4);
    unified.addSource(first);
    unified.addSource(second);
    const update = vi.fn();
    (first as unknown as { update: typeof update }).update = update;
    (second as unknown as { update: typeof update }).update = update;
    unified.update(new THREE.PerspectiveCamera());
    expect(update).toHaveBeenCalledTimes(2);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(2);
    unified.dispose();
    first.dispose();
    second.dispose();
  });

  it('does not draw identity order while the first GPU sort is in flight', async () => {
    const { renderer, resolve } = pendingGpuCompletion();
    const first = source();
    const second = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    unified.addSource(first);
    unified.addSource(second);
    const camera = new THREE.PerspectiveCamera();
    const scene = new THREE.Scene();

    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);
    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);

    unified.onAfterRender(renderer as never, scene, camera);
    resolve();
    await Promise.resolve();
    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(2);

    unified.dispose();
    first.dispose();
    second.dispose();
  });

  it('publishes the first GPU-sorted count without a zero-instance draw callback', async () => {
    const { renderer, resolve } = pendingGpuCompletion();
    const first = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    unified.addSource(first);
    const camera = new THREE.PerspectiveCamera();

    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);

    resolve();
    await Promise.resolve();
    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);

    unified.dispose();
    first.dispose();
  });

  it('gathers a newly visible source after an empty frame without a draw callback', () => {
    const renderer = mockRenderer();
    const first = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    unified.addSource(first);
    const camera = new THREE.PerspectiveCamera();
    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);

    unified.setSourceVisible(first, false);
    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);

    const second = source();
    unified.addSource(second);
    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);
    expect(unified.droppedSourceCount).toBe(0);

    unified.dispose();
    first.dispose();
    second.dispose();
  });

  it('draws a new LOD cut on the same ordered GPU queue after the first sort', async () => {
    const { renderer, resolve } = pendingGpuCompletion();
    const first = source();
    const second = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    const camera = new THREE.PerspectiveCamera();
    const scene = new THREE.Scene();
    unified.addSource(first);

    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);
    unified.onAfterRender(renderer as never, scene, camera);
    resolve();
    await Promise.resolve();
    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);

    // A streamed LOD replacement changes the gathered layout while the camera
    // moves. Its compute sort precedes this frame's draw on the WebGPU queue.
    unified.addSource(second);
    unified.update(camera);
    expect(unified.performanceTimings.sortSubmitted).toBe(true);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(2);

    unified.dispose();
    first.dispose();
    second.dispose();
  });

  it('keeps the last ordered count while a camera-only GPU sort is in flight', async () => {
    let completion: Promise<void> = Promise.resolve();
    let resolveCurrent = (): void => {};
    const renderer = mockRenderer({
      backend: {
        isWebGPUBackend: true,
        device: {
          queue: {
            onSubmittedWorkDone: () => completion,
          },
        },
      },
    });
    const mesh = source();
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    const scene = new THREE.Scene();
    const firstCamera = new THREE.PerspectiveCamera();
    firstCamera.position.set(0, 0, 1);
    firstCamera.updateMatrixWorld(true);

    completion = new Promise<void>((done) => {
      resolveCurrent = done;
    });
    unified.update(firstCamera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);
    unified.onAfterRender(renderer as never, scene, firstCamera);
    resolveCurrent();
    await Promise.resolve();
    unified.update(firstCamera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);

    const movingCamera = new THREE.PerspectiveCamera();
    movingCamera.position.set(2, 0, 1);
    movingCamera.updateMatrixWorld(true);
    completion = new Promise<void>(() => {});
    unified.update(movingCamera);
    expect(unified.performanceTimings.sortSubmitted).toBe(true);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);

    unified.dispose();
    mesh.dispose();
  });

  function computeInternals(unified: UnifiedSplatMesh) {
    return unified as unknown as {
      projectedPipeline: { projectionDispatches: number };
      projectedSorter: { submissionCount: number };
      sortScheduler: {
        submissionDiagnostics(): { serial: number; action: string };
        hasSubmissionInFlight(): boolean;
        hasPendingForce(): boolean;
      };
    };
  }

  function cameraAt(z: number): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, z);
    camera.updateMatrixWorld(true);
    return camera;
  }

  it('re-projects a camera move under a held gate with compute projection', async () => {
    // The hardware frame loop: prepare, draw, acknowledge; the GPU completion
    // lands after the next frame's prepare, so that frame finds the gate held.
    // Compute projection draws from cached clip-space centers, so a camera
    // move must dispatch the replacement projection and sort right away while
    // stationary frames under the same hold must not.
    const { renderer, resolve } = pendingGpuCompletion();
    const mesh = source();
    const unified = new UnifiedSplatMesh(renderer, 1, { projectionStrategy: computeProjection() });
    unified.addSource(mesh);
    const scene = new THREE.Scene();
    const orbit = cameraAt(3);
    const front = cameraAt(0);
    const {
      projectedPipeline: pipeline,
      projectedSorter: sorter,
      sortScheduler,
    } = computeInternals(unified);

    unified.update(orbit);
    expect(unified.projectionStrategyStatus.effective).toBe('compute');
    expect(pipeline.projectionDispatches).toBe(1);
    expect(sorter.submissionCount).toBe(1);
    unified.onAfterRender(renderer as never, scene, orbit);
    const firstSerial = sortScheduler.submissionDiagnostics().serial;

    unified.update(front);
    expect(pipeline.projectionDispatches).toBe(2);
    expect(sorter.submissionCount).toBe(2);
    expect(unified.performanceTimings.sortSubmitted).toBe(true);
    expect(unified.performanceTimings.projectionSubmissions).toBe(1);
    expect(unified.performanceTimings.sortSubmissions).toBe(1);
    expect(sortScheduler.submissionDiagnostics().action).toBe('submitted');
    // The gate now follows the replacement dispatch, not the superseded one.
    const secondSerial = sortScheduler.submissionDiagnostics().serial;
    expect(secondSerial).toBeGreaterThan(firstSerial);
    unified.onAfterRender(renderer as never, scene, front);

    unified.update(front);
    unified.update(front);
    expect(pipeline.projectionDispatches).toBe(2);
    expect(sorter.submissionCount).toBe(2);
    expect(unified.performanceTimings.sortSubmitted).toBe(false);
    expect(unified.performanceTimings.projectionSubmissions).toBe(0);
    expect(sortScheduler.submissionDiagnostics().action).toBe('suppressed');
    expect(sortScheduler.submissionDiagnostics().serial).toBe(secondSerial);

    resolve();
    await Promise.resolve();
    expect(sortScheduler.hasSubmissionInFlight()).toBe(false);

    unified.dispose();
    mesh.dispose();
  });

  it('defers a held-gate re-projection to the sort cadence', () => {
    // A hitch stretches the adaptive cadence into its one-second cooldown. A
    // held camera move inside that window must not stack a replacement
    // projection and counting sort on top of the hitch (the free path would
    // still dispatch once the gate releases); one after it re-projects.
    const { renderer } = pendingGpuCompletion();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const mesh = source();
    const unified = new UnifiedSplatMesh(renderer, 1, { projectionStrategy: computeProjection() });
    unified.addSource(mesh);
    const scene = new THREE.Scene();
    const {
      projectedPipeline: pipeline,
      projectedSorter: sorter,
      sortScheduler,
    } = computeInternals(unified);

    unified.update(cameraAt(3));
    expect(unified.projectionStrategyStatus.effective).toBe('compute');
    expect(pipeline.projectionDispatches).toBe(1);
    unified.onAfterRender(renderer as never, scene, cameraAt(3));

    // A 100 ms frame starts the hitch cooldown; the gate is still held.
    now.mockReturnValue(100);
    unified.update(cameraAt(2));
    expect(pipeline.projectionDispatches).toBe(1);
    expect(sorter.submissionCount).toBe(1);
    expect(unified.performanceTimings.sortSubmitted).toBe(false);
    expect(sortScheduler.submissionDiagnostics().action).toBe('suppressed');

    now.mockReturnValue(1200);
    unified.update(cameraAt(1));
    expect(pipeline.projectionDispatches).toBe(2);
    expect(sorter.submissionCount).toBe(2);
    expect(unified.performanceTimings.sortSubmitted).toBe(true);
    expect(sortScheduler.submissionDiagnostics().action).toBe('submitted');

    now.mockRestore();
    unified.dispose();
    mesh.dispose();
  });

  it('keeps coalescing content changes under a held gate with compute projection', async () => {
    // A content change must still wait for the buffer to be free even when
    // the camera moved with it; only camera-only motion re-projects.
    const { renderer, resolve } = pendingGpuCompletion();
    const mesh = new SplatMesh({ capacity: 4096 });
    mesh.appendRange(splatChunk());
    const unified = new UnifiedSplatMesh(renderer, 4096, {
      projectionStrategy: computeProjection(),
    });
    unified.addSource(mesh);
    const scene = new THREE.Scene();
    const camera = cameraAt(0);
    const {
      projectedPipeline: pipeline,
      projectedSorter: sorter,
      sortScheduler,
    } = computeInternals(unified);

    unified.update(camera);
    expect(unified.projectionStrategyStatus.effective).toBe('compute');
    expect(pipeline.projectionDispatches).toBe(1);
    unified.onAfterRender(renderer as never, scene, camera);

    mesh.appendRange(splatChunk());
    unified.update(cameraAt(1));
    expect(pipeline.projectionDispatches).toBe(1);
    expect(sorter.submissionCount).toBe(1);
    expect(unified.performanceTimings.sortSubmitted).toBe(false);
    expect(sortScheduler.submissionDiagnostics().action).toBe('coalesced');

    // Once the buffer is free the coalesced change gathers and sorts.
    resolve();
    await Promise.resolve();
    unified.update(cameraAt(1));
    expect(pipeline.projectionDispatches).toBe(2);
    expect(sorter.submissionCount).toBe(2);
    expect(unified.performanceTimings.activeCount).toBe(2);

    unified.dispose();
    mesh.dispose();
  });

  it('does not re-project a held frame on the vertex path', () => {
    const { renderer } = pendingGpuCompletion();
    const mesh = source();
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    const scene = new THREE.Scene();
    const sortScheduler = computeInternals(unified).sortScheduler;

    unified.update(cameraAt(3));
    unified.onAfterRender(renderer as never, scene, cameraAt(3));
    const serial = sortScheduler.submissionDiagnostics().serial;
    unified.update(cameraAt(0));
    expect(unified.performanceTimings.sortSubmitted).toBe(false);
    expect(sortScheduler.submissionDiagnostics().action).toBe('suppressed');
    expect(sortScheduler.submissionDiagnostics().serial).toBe(serial);

    unified.dispose();
    mesh.dispose();
  });

  it('advances a crossfade on a held frame without re-gathering or re-sorting', () => {
    const { renderer } = pendingGpuCompletion();
    const mesh = source();
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    const scene = new THREE.Scene();
    const sortScheduler = computeInternals(unified).sortScheduler;
    const live = unified as unknown as {
      liveOpacityRangeValues: THREE.Vector4[];
      liveOpacityCount: { value: number };
    };
    const gather = gatherSpies(unified)[0]!.gather;

    unified.update(cameraAt(3));
    unified.onAfterRender(renderer as never, scene, cameraAt(3));
    expect(live.liveOpacityCount.value).toBe(0);
    const gathers = gather.mock.calls.length;

    // The previous sort is still in flight: this frame is held. The fade must
    // still reach the draw, and must not queue a regather or forced sort.
    unified.setSourceOpacity(mesh, 0.4);
    unified.update(cameraAt(3));
    expect(sortScheduler.submissionDiagnostics().action).toBe('suppressed');
    expect(live.liveOpacityCount.value).toBe(1);
    expect(live.liveOpacityRangeValues[0]!.toArray()).toEqual([0, 1, 0.4, 0]);
    expect(gather.mock.calls.length).toBe(gathers);
    expect(sortScheduler.hasPendingForce()).toBe(false);

    unified.dispose();
    mesh.dispose();
  });

  it('keeps source picking aligned with unified visibility and restores it on removal', () => {
    const renderer = mockRenderer();
    const mesh = source();
    const pickVisibility = vi.spyOn(mesh, 'setUnifiedPickVisibility');
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    expect(mesh.visible).toBe(false);
    expect(pickVisibility).toHaveBeenLastCalledWith(true);
    unified.setSourceVisible(mesh, false);
    expect(pickVisibility).toHaveBeenLastCalledWith(false);
    expect(unified.removeSource(mesh)).toBe(true);
    expect(mesh.visible).toBe(true);
    expect(pickVisibility).toHaveBeenLastCalledWith(null);
    unified.dispose();
    mesh.dispose();
  });

  it('restores a source’s original standalone visibility on removal', () => {
    const renderer = mockRenderer();
    const mesh = source();
    mesh.visible = false;
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    unified.removeSource(mesh);
    expect(mesh.visible).toBe(false);
    unified.dispose();
    mesh.dispose();
  });

  it('renders a globally sorted secondary view into a mirror target', () => {
    const render = vi.fn();
    const setRenderTarget = vi.fn();
    const renderer = mockRenderer({
      getRenderTarget: () => null,
      setRenderTarget,
      render,
    });
    const mesh = source();
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    const target = new THREE.RenderTarget(320, 180);
    unified.renderView(new THREE.PerspectiveCamera(), renderer, target);
    expect(setRenderTarget).toHaveBeenNthCalledWith(1, target);
    expect(render).toHaveBeenCalledWith(unified, expect.any(THREE.PerspectiveCamera));
    expect(setRenderTarget).toHaveBeenNthCalledWith(2, null);
    unified.dispose();
    target.dispose();
    mesh.dispose();
  });

  it('restores the render target and invalidates foreign order when a secondary draw throws', () => {
    const target = new THREE.RenderTarget(320, 180);
    const previous = new THREE.RenderTarget(16, 16);
    const setRenderTarget = vi.fn();
    const renderer = mockRenderer({
      getRenderTarget: () => previous,
      setRenderTarget,
      render: vi.fn(() => {
        throw new Error('secondary draw failed');
      }),
    });
    const mesh = source();
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    const invalidate = vi.spyOn(
      (unified as unknown as { sortScheduler: { invalidate(): void } }).sortScheduler,
      'invalidate',
    );

    expect(() => unified.renderView(new THREE.PerspectiveCamera(), renderer, target)).toThrow(
      'secondary draw failed',
    );
    expect(setRenderTarget).toHaveBeenNthCalledWith(1, target);
    expect(setRenderTarget).toHaveBeenNthCalledWith(2, previous);
    expect(invalidate).toHaveBeenCalledOnce();

    unified.dispose();
    target.dispose();
    previous.dispose();
    mesh.dispose();
  });

  it('drops whole low-priority sources when its fixed work buffer is full', () => {
    const renderer = mockRenderer();
    const low = source();
    const high = source();
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(low, { priority: 0 });
    unified.addSource(high, { priority: 1 });
    unified.update(new THREE.PerspectiveCamera());
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);
    expect(unified.droppedSourceCount).toBe(1);
    expect(unified.droppedSplatCount).toBe(1);
    unified.dispose();
    low.dispose();
    high.dispose();
  });

  it('reuses an unchanged static source work slice and skips the redundant global sort', () => {
    const compute = vi.fn();
    const renderer = mockRenderer({ compute });
    const mesh = source();
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    const camera = new THREE.PerspectiveCamera();
    unified.update(camera);
    const afterFirstUpdate = compute.mock.calls.length;
    unified.update(camera);
    // The second frame reuses the gather and, with a stationary camera and
    // unchanged content, also skips the whole-buffer sorter dispatch.
    expect(compute.mock.calls.length).toBe(afterFirstUpdate);
    unified.dispose();
    mesh.dispose();
  });

  it('reuses SH gathers until the camera position changes', () => {
    const renderer = mockRenderer();
    const mesh = source({ sh: true });
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    const gather = gatherSpies(unified)[0]!.gather;
    const camera = new THREE.PerspectiveCamera();

    unified.update(camera);
    expect(gather).toHaveBeenCalledOnce();
    unified.update(camera);
    expect(gather).toHaveBeenCalledOnce();

    camera.position.x = 1;
    unified.update(camera);
    expect(gather).toHaveBeenCalledTimes(2);

    unified.dispose();
    mesh.dispose();
  });

  it('toggles modifier caching on a registered source without re-adding it', () => {
    const renderer = mockRenderer();
    const mesh = source();
    mesh.modifiers = [() => ({ visible: bool(true) })];
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    const gather = gatherSpies(unified)[0]!.gather;
    const camera = new THREE.PerspectiveCamera();

    unified.update(camera);
    unified.update(camera);
    expect(gather).toHaveBeenCalledTimes(2);

    expect(unified.setSourceCacheModifiers(mesh, true)).toBe(true);
    unified.update(camera);
    expect(gather).toHaveBeenCalledTimes(2);

    expect(unified.setSourceCacheModifiers(mesh, false)).toBe(true);
    unified.update(camera);
    expect(gather).toHaveBeenCalledTimes(3);

    const unregistered = source();
    expect(unified.setSourceCacheModifiers(unregistered, true)).toBe(false);
    unregistered.dispose();
    unified.dispose();
    mesh.dispose();
  });

  it('caches opted-in modifiers until the host invalidates their source', () => {
    const renderer = mockRenderer();
    const mesh = source();
    mesh.modifiers = [() => ({ visible: bool(true) })];
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh, { cacheModifiers: true });
    const gather = gatherSpies(unified)[0]!.gather;
    const camera = new THREE.PerspectiveCamera();

    unified.update(camera);
    unified.update(camera);
    expect(gather).toHaveBeenCalledOnce();

    expect(unified.invalidateSource(mesh)).toBe(true);
    unified.update(camera);
    expect(gather).toHaveBeenCalledTimes(2);
    const unregistered = source();
    expect(unified.invalidateSource(unregistered)).toBe(false);
    unregistered.dispose();

    unified.dispose();
    mesh.dispose();
  });

  it('re-gathers cached modifiers after transform, active-list, and uniform invalidation', () => {
    const renderer = mockRenderer();
    const mesh = source();
    mesh.modifiers = [() => ({ visible: bool(true) })];
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh, { cacheModifiers: true });
    const gather = gatherSpies(unified)[0]!.gather;
    const camera = new THREE.PerspectiveCamera();

    unified.update(camera);
    expect(gather).toHaveBeenCalledOnce();

    mesh.position.x = 2;
    mesh.updateMatrixWorld(true);
    unified.update(camera);
    expect(gather).toHaveBeenCalledTimes(2);

    (
      mesh as unknown as { replaceActiveIndices: (indices: Uint32Array) => number }
    ).replaceActiveIndices(new Uint32Array([0]));
    unified.update(camera);
    expect(gather).toHaveBeenCalledTimes(3);

    expect(unified.invalidateSource(mesh)).toBe(true);
    unified.update(camera);
    expect(gather).toHaveBeenCalledTimes(4);

    unified.dispose();
    mesh.dispose();
  });

  it('reuses cached modifiers while orbiting without SH and refreshes SH color only', () => {
    const renderer = mockRenderer();
    const clip = source();
    clip.modifiers = [() => ({ visible: bool(true) })];
    const sh = source({ sh: true });
    sh.modifiers = [() => ({ visible: bool(true) })];
    const unified = new UnifiedSplatMesh(renderer, 2);
    unified.addSource(clip, { cacheModifiers: true, shColorRefresh: true });
    unified.addSource(sh, { cacheModifiers: true, shColorRefresh: true });
    const [clipGather, shGather] = gatherSpies(unified);
    const camera = new THREE.PerspectiveCamera();

    unified.update(camera);
    camera.position.x = 3;
    unified.update(camera);
    expect(clipGather!.gather).toHaveBeenCalledOnce();
    expect(clipGather!.gatherColors).not.toHaveBeenCalled();
    expect(shGather!.gather).toHaveBeenCalledOnce();
    expect(shGather!.gatherColors).toHaveBeenCalledOnce();

    camera.lookAt(1, 0, 0);
    unified.update(camera);
    expect(shGather!.gather).toHaveBeenCalledOnce();
    expect(shGather!.gatherColors).toHaveBeenCalledOnce();

    unified.dispose();
    clip.dispose();
    sh.dispose();
  });

  it('re-gathers cached SH sources on camera motion unless color refresh is opted in', () => {
    const renderer = mockRenderer();
    const mesh = source({ sh: true });
    mesh.modifiers = [() => ({ visible: bool(true) })];
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh, { cacheModifiers: true });
    const [spy] = gatherSpies(unified);
    const camera = new THREE.PerspectiveCamera();

    unified.update(camera);
    camera.position.x = 3;
    unified.update(camera);
    expect(spy!.gather).toHaveBeenCalledTimes(2);
    expect(spy!.gatherColors).not.toHaveBeenCalled();

    unified.dispose();
    mesh.dispose();
  });

  it('clears cached modifier gathers on dispose', () => {
    const renderer = mockRenderer();
    const mesh = source();
    mesh.modifiers = [() => ({ visible: bool(true) })];
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh, { cacheModifiers: true });
    unified.update(new THREE.PerspectiveCamera());
    unified.dispose();
    expect(() => unified.setSourceCacheModifiers(mesh, false)).toThrow(/after dispose/);
    mesh.dispose();
  });

  it('keeps live modifiers on the safe per-frame gather path by default', () => {
    const renderer = mockRenderer();
    const mesh = source();
    mesh.modifiers = [() => ({ visible: bool(true) })];
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    const gather = gatherSpies(unified)[0]!.gather;
    const camera = new THREE.PerspectiveCamera();

    unified.update(camera);
    unified.update(camera);
    expect(gather).toHaveBeenCalledTimes(2);

    unified.dispose();
    mesh.dispose();
  });

  it('follows a dynamic source active cut as ranges are added and removed', () => {
    const renderer = mockRenderer();
    const mesh = new SplatMesh({ capacity: 2048 });
    const range = mesh.appendRange({
      count: 1,
      positions: new Float32Array([0, 0, 0]),
      colors: new Uint8Array([255, 0, 0, 255]),
      covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
    });
    const unified = new UnifiedSplatMesh(renderer, 2048);
    unified.addSource(mesh);
    const camera = new THREE.PerspectiveCamera();
    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);
    mesh.removeRange(range);
    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);
    unified.dispose();
    mesh.dispose();
  });

  it('regathers both slices after hide/show lets another source occupy offset zero', () => {
    const renderer = mockRenderer();
    const first = source();
    const second = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    unified.addSource(first);
    unified.addSource(second);
    const camera = new THREE.PerspectiveCamera();
    unified.update(camera);
    const spies = gatherSpies(unified);
    const firstGather = spies.find((entry) => entry.source === first)!.gather;
    const secondGather = spies.find((entry) => entry.source === second)!.gather;
    firstGather.mockClear();
    secondGather.mockClear();

    unified.setSourceVisible(first, false);
    unified.update(camera);
    expect(firstGather).not.toHaveBeenCalled();
    expect(secondGather).toHaveBeenCalledOnce();
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);

    firstGather.mockClear();
    secondGather.mockClear();
    unified.setSourceVisible(first, true);
    unified.update(camera);
    expect(firstGather).toHaveBeenCalledOnce();
    expect(secondGather).toHaveBeenCalledOnce();
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(2);

    unified.dispose();
    first.dispose();
    second.dispose();
  });

  it('regathers an evicted low-priority source after the high-priority source is removed', () => {
    const renderer = mockRenderer();
    const low = source();
    const high = source();
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(low, { priority: 0 });
    const camera = new THREE.PerspectiveCamera();
    unified.update(camera);
    unified.addSource(high, { priority: 1 });
    const spies = gatherSpies(unified);
    const lowGather = spies.find((entry) => entry.source === low)!.gather;
    const highGather = spies.find((entry) => entry.source === high)!.gather;
    lowGather.mockClear();
    highGather.mockClear();

    unified.update(camera);
    expect(highGather).toHaveBeenCalledOnce();
    expect(lowGather).not.toHaveBeenCalled();
    expect(unified.droppedSourceCount).toBe(1);

    lowGather.mockClear();
    expect(unified.removeSource(high)).toBe(true);
    unified.update(camera);
    expect(lowGather).toHaveBeenCalledOnce();
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);

    unified.dispose();
    low.dispose();
    high.dispose();
  });

  it('regathers every following source whose offset shifts after a leading remove', () => {
    const renderer = mockRenderer();
    const leading = source();
    const following = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    unified.addSource(leading);
    unified.addSource(following);
    const camera = new THREE.PerspectiveCamera();
    unified.update(camera);
    const spies = gatherSpies(unified);
    const followingGather = spies.find((entry) => entry.source === following)!.gather;
    followingGather.mockClear();

    expect(unified.removeSource(leading)).toBe(true);
    unified.update(camera);
    expect(followingGather).toHaveBeenCalledOnce();
    expect(followingGather.mock.calls[0]?.[2]).toBe(0);

    unified.dispose();
    leading.dispose();
    following.dispose();
  });

  it('resets shared maxStdDev and antialias constraints when the last source is removed', () => {
    const renderer = mockRenderer();
    const first = source({ maxStdDev: 3, antialias: false });
    const unified = new UnifiedSplatMesh(renderer, 2);
    unified.addSource(first);
    expect(unified.removeSource(first)).toBe(true);
    const second = source({ maxStdDev: 2.5, antialias: true });
    expect(() => unified.addSource(second)).not.toThrow();
    unified.dispose();
    first.dispose();
    second.dispose();
  });

  it('rejects a MergedSplatMesh, which carries a placement the gather cannot resolve', () => {
    // A merged mesh's sources move by writing its own uniform array; the gather only
    // knows the mesh's `matrixWorld`, so nesting one would draw every source at
    // its pool-local position - and, with an empty modifier list, the gather
    // cache would then happily reuse that wrong result.
    const renderer = mockRenderer();
    const unified = new UnifiedSplatMesh(renderer, 4);
    const scene = new MergedSplatMesh({ capacity: 2048 });
    expect(scene.getUnifiedSourceView().hasSourcePlacement).toBe(true);
    expect(() => unified.addSource(scene)).toThrow(/already a unified pool/);
    const plain = source();
    expect(() => unified.addSource(plain)).not.toThrow();
    unified.dispose();
    scene.dispose();
    plain.dispose();
  });

  it('makes dispose idempotent and restores visibility and picking exactly once', () => {
    const renderer = mockRenderer();
    const mesh = source();
    const pickVisibility = vi.spyOn(mesh, 'setUnifiedPickVisibility');
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    pickVisibility.mockClear();
    unified.dispose();
    expect(mesh.visible).toBe(true);
    expect(pickVisibility).toHaveBeenCalledTimes(1);
    expect(pickVisibility).toHaveBeenCalledWith(null);
    pickVisibility.mockClear();
    unified.dispose();
    expect(pickVisibility).not.toHaveBeenCalled();
    expect(() => unified.addSource(source())).toThrow(/after dispose/);
    unified.update(new THREE.PerspectiveCamera());
    mesh.dispose();
  });

  it('fails early when constructed without a WebGPU backend', () => {
    expect(
      () =>
        new UnifiedSplatMesh(
          { backend: { isWebGPUBackend: false } } as unknown as THREE.WebGPURenderer,
          1,
        ),
    ).toThrow(/WebGPU/);
  });

  it('keeps modifier-hidden splats in the sort capacity as stable work slots', () => {
    const renderer = mockRenderer();
    const mesh = source();
    mesh.modifiers = [() => ({ visible: bool(false) })];
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    unified.update(new THREE.PerspectiveCamera());
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);
    unified.dispose();
    mesh.dispose();
  });

  it('gathers and draws with an isotropic covariance modifier without throwing', () => {
    const renderer = mockRenderer();
    const mesh = source();
    mesh.modifiers = [
      () => ({
        isotropicCovarianceMix: float(1),
        isotropicVarianceScale: float(0.35 * 0.35),
      }),
    ];
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    expect(() => unified.update(new THREE.PerspectiveCamera())).not.toThrow();
    unified.dispose();
    mesh.dispose();
  });

  it('gathers with an opt-in isotropic screen-radius cap without throwing', () => {
    const renderer = mockRenderer();
    const mesh = source();
    mesh.modifiers = [
      () => ({
        isotropicCovarianceMix: float(1),
        isotropicScreenRadiusPx: float(1),
      }),
    ];
    const unified = new UnifiedSplatMesh(renderer, 1);
    unified.addSource(mesh);
    expect(() => unified.update(new THREE.PerspectiveCamera())).not.toThrow();
    unified.dispose();
    mesh.dispose();
  });

  describe('sort gating', () => {
    function sorterSpy(unified: UnifiedSplatMesh) {
      const sorter = (
        unified as unknown as {
          sorter: { sort: (...args: unknown[]) => boolean };
        }
      ).sorter;
      return vi.spyOn(sorter, 'sort');
    }

    it('acknowledges sources only after the unified draw callback', async () => {
      const renderer = mockRenderer();
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 1);
      unified.addSource(mesh);
      const notify = vi.spyOn(mesh, 'notifyUnifiedPublication');
      const camera = new THREE.PerspectiveCamera();

      unified.update(camera);
      expect(notify).not.toHaveBeenCalled();

      unified.onAfterRender({} as never, new THREE.Scene(), camera);
      expect(notify).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(notify).toHaveBeenCalledOnce();

      unified.onAfterRender({} as never, new THREE.Scene(), camera);
      await Promise.resolve();
      expect(notify).toHaveBeenCalledOnce();
      unified.dispose();
      mesh.dispose();
    });

    it('acknowledges replaced source active lists through the resolved XR camera', async () => {
      const eye = new THREE.PerspectiveCamera();
      eye.viewport = new THREE.Vector4(0, 0, 400, 600);
      const head = new THREE.ArrayCamera([eye]);
      const renderer = mockRenderer({
        xr: { enabled: true, isPresenting: true, cameraAutoUpdate: false, getCamera: () => head },
        backend: {
          isWebGPUBackend: true,
          device: { queue: { onSubmittedWorkDone: () => Promise.resolve() } },
        },
      });
      const mesh = new SplatMesh({ capacity: 4096 }, { lodAlpha: true });
      const chunk: SplatData = {
        count: 1,
        positions: new Float32Array([0, 0, 0]),
        colors: new Uint8Array([255, 0, 0, 127]),
        covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
      };
      mesh.appendRange(chunk);
      const unified = new UnifiedSplatMesh(renderer, 4096);
      unified.addSource(mesh);
      const notify = vi.spyOn(mesh, 'notifyUnifiedPublication');
      const camera = new THREE.PerspectiveCamera();
      const scene = new THREE.Scene();

      unified.update(camera);
      unified.onAfterRender(renderer as never, scene, head);
      await Promise.resolve();
      unified.update(camera);
      unified.onAfterRender(renderer as never, scene, new THREE.PerspectiveCamera());
      await Promise.resolve();
      expect(notify).not.toHaveBeenCalled();
      unified.onAfterRender(renderer as never, scene, head);
      await Promise.resolve();
      expect(notify).toHaveBeenCalledOnce();
      expect(unified.getDrawPublicationSnapshot().ready).toBe(true);

      mesh.appendRange(chunk);
      const replacementVersion = mesh.getUnifiedSourceView().activeListVersion;
      unified.update(camera);
      unified.onAfterRender(renderer as never, scene, head);
      await Promise.resolve();
      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenLastCalledWith(replacementVersion);
      expect(unified.getDrawPublicationSnapshot()).toMatchObject({ ready: true, activeCount: 2 });

      unified.dispose();
      mesh.dispose();
    });

    it('does not acknowledge a secondary view through the primary XR camera', async () => {
      const eye = new THREE.PerspectiveCamera();
      eye.viewport = new THREE.Vector4(0, 0, 400, 600);
      const head = new THREE.ArrayCamera([eye]);
      const renderer = mockRenderer({
        xr: { enabled: true, isPresenting: true, cameraAutoUpdate: false, getCamera: () => head },
        getRenderTarget: () => null,
        setRenderTarget: vi.fn(),
        render: vi.fn(),
      });
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 1);
      unified.addSource(mesh);
      const notify = vi.spyOn(mesh, 'notifyUnifiedPublication');
      const camera = new THREE.PerspectiveCamera();
      const scene = new THREE.Scene();

      unified.update(camera);
      unified.renderView(new THREE.PerspectiveCamera(), renderer);
      // Three substitutes the XR head even for a secondary draw to its output
      // target. Camera identity alone cannot make that a primary publication.
      unified.onAfterRender(renderer as never, scene, head);
      await Promise.resolve();
      expect(notify).not.toHaveBeenCalled();
      expect(unified.getDrawPublicationSnapshot().ready).toBe(false);

      unified.update(camera);
      unified.onAfterRender(renderer as never, scene, head);
      await Promise.resolve();
      expect(notify).toHaveBeenCalledOnce();
      expect(unified.getDrawPublicationSnapshot().ready).toBe(true);

      unified.dispose();
      mesh.dispose();
    });

    it('restores the application publication camera after leaving XR', async () => {
      const eye = new THREE.PerspectiveCamera();
      eye.viewport = new THREE.Vector4(0, 0, 400, 600);
      const head = new THREE.ArrayCamera([eye]);
      const xr = {
        enabled: true,
        isPresenting: true,
        cameraAutoUpdate: false,
        getCamera: () => head,
      };
      const renderer = mockRenderer({
        xr,
        backend: {
          isWebGPUBackend: true,
          device: { queue: { onSubmittedWorkDone: () => Promise.resolve() } },
        },
      });
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 1);
      unified.addSource(mesh);
      const notify = vi.spyOn(mesh, 'notifyUnifiedPublication');
      const camera = new THREE.PerspectiveCamera();
      const scene = new THREE.Scene();

      unified.update(camera);
      unified.onAfterRender(renderer as never, scene, head);
      await Promise.resolve();
      unified.update(camera);
      unified.onAfterRender(renderer as never, scene, head);
      await Promise.resolve();
      expect(notify).toHaveBeenCalledOnce();

      xr.isPresenting = false;
      unified.invalidateSource(mesh);
      unified.update(camera);
      unified.onAfterRender(renderer as never, scene, head);
      await Promise.resolve();
      expect(notify).toHaveBeenCalledOnce();
      unified.onAfterRender(renderer as never, scene, camera);
      await Promise.resolve();
      expect(notify).toHaveBeenCalledTimes(2);
      expect(unified.getDrawPublicationSnapshot().ready).toBe(true);

      unified.dispose();
      mesh.dispose();
    });

    it.each([
      { enabled: false, isPresenting: true },
      { enabled: true, isPresenting: false },
    ])(
      'rejects the XR camera when enabled=$enabled and presenting=$isPresenting',
      async (state) => {
        const eye = new THREE.PerspectiveCamera();
        eye.viewport = new THREE.Vector4(0, 0, 400, 600);
        const head = new THREE.ArrayCamera([eye]);
        const renderer = mockRenderer({
          xr: { ...state, cameraAutoUpdate: false, getCamera: () => head },
        });
        const mesh = source();
        const unified = new UnifiedSplatMesh(renderer, 1);
        unified.addSource(mesh);
        const notify = vi.spyOn(mesh, 'notifyUnifiedPublication');
        const camera = new THREE.PerspectiveCamera();
        const scene = new THREE.Scene();

        unified.update(camera);
        unified.onAfterRender(renderer as never, scene, head);
        await Promise.resolve();
        expect(notify).not.toHaveBeenCalled();
        unified.onAfterRender(renderer as never, scene, camera);
        await Promise.resolve();
        expect(notify).toHaveBeenCalledOnce();
        expect(unified.getDrawPublicationSnapshot().ready).toBe(true);

        unified.dispose();
        mesh.dispose();
      },
    );

    it('skips the sorter dispatch for a stationary camera with unchanged content', () => {
      const renderer = mockRenderer();
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 1);
      unified.addSource(mesh);
      const sort = sorterSpy(unified);
      const camera = new THREE.PerspectiveCamera();
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(1);
      unified.update(camera);
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(1);
      unified.dispose();
      mesh.dispose();
    });

    it('re-sorts when the camera moves', () => {
      const renderer = mockRenderer();
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 1);
      unified.addSource(mesh);
      const sort = sorterSpy(unified);
      const camera = new THREE.PerspectiveCamera();
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(1);
      camera.position.set(0, 0, 5);
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(2);
      unified.dispose();
      mesh.dispose();
    });

    it('skips rotation-only sorts in radial mode but sorts after translation', () => {
      const renderer = mockRenderer();
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 1, { sortMetric: 'radial' });
      unified.addSource(mesh);
      const sort = sorterSpy(unified);
      const camera = new THREE.PerspectiveCamera();
      camera.updateMatrixWorld();
      unified.update(camera);
      camera.rotation.y = Math.PI / 2;
      camera.updateMatrixWorld();
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(1);
      camera.position.x = 1;
      camera.updateMatrixWorld();
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(2);
      unified.dispose();
      mesh.dispose();
    });

    it('re-sorts after a content regather under a stationary camera', () => {
      const renderer = mockRenderer();
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 1);
      unified.addSource(mesh);
      const sort = sorterSpy(unified);
      const camera = new THREE.PerspectiveCamera();
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(1);
      // Fading to zero culls the slice in the gather: a content regather.
      unified.setSourceOpacity(mesh, 0);
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(2);
      // Settled again: the regathered content is now sorted, nothing changed.
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(2);
      unified.dispose();
      mesh.dispose();
    });

    it('does not re-gather or re-sort a fractional crossfade under a stationary camera', () => {
      const renderer = mockRenderer();
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 1);
      unified.addSource(mesh);
      const sort = sorterSpy(unified);
      const gather = gatherSpies(unified)[0]!.gather;
      const camera = new THREE.PerspectiveCamera();
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(1);
      for (const opacity of [0.9, 0.6, 0.3, 0.05]) {
        unified.setSourceOpacity(mesh, opacity);
        unified.update(camera);
      }
      expect(sort).toHaveBeenCalledTimes(1);
      expect(gather).toHaveBeenCalledTimes(1);
      unified.dispose();
      mesh.dispose();
    });

    it('propagates a source reveal multiplier into the unified gather opacity', () => {
      const renderer = mockRenderer();
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 1);
      unified.addSource(mesh);
      const gather = gatherSpies(unified)[0]!.gather;
      const camera = new THREE.PerspectiveCamera();

      unified.update(camera);
      expect(gather.mock.calls[0]?.[5]).toBe(1);

      (mesh as unknown as { setRevealMultiplier: (value: number) => void }).setRevealMultiplier(0);
      unified.update(camera);
      expect(gather.mock.calls[1]?.[5]).toBe(0);

      unified.dispose();
      mesh.dispose();
    });

    it('re-sorts after the active cut changes under a stationary camera', () => {
      const renderer = mockRenderer();
      const mesh = new SplatMesh({ capacity: 4096 });
      const chunk = () =>
        ({
          count: 1,
          positions: new Float32Array([0, 0, 0]),
          colors: new Uint8Array([255, 0, 0, 255]),
          covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
        }) as SplatData;
      const first = mesh.appendRange(chunk());
      const unified = new UnifiedSplatMesh(renderer, 4096);
      unified.addSource(mesh);
      const sort = sorterSpy(unified);
      const camera = new THREE.PerspectiveCamera();
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(1);
      mesh.appendRange(chunk());
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(2);
      mesh.removeRange(first);
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(3);
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(3);
      unified.dispose();
      mesh.dispose();
    });

    it('sorts changed work-buffer contents immediately during hitch backoff', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(0);
      const renderer = mockRenderer();
      const first = source();
      const second = source();
      const unified = new UnifiedSplatMesh(renderer, 2);
      const camera = new THREE.PerspectiveCamera();
      try {
        unified.addSource(first);
        unified.addSource(second);
        const sort = sorterSpy(unified);
        unified.update(camera);
        expect(sort).toHaveBeenCalledTimes(1);
        now.mockReturnValue(80);
        unified.removeSource(first);
        unified.update(camera);
        expect(sort).toHaveBeenCalledTimes(2);
        expect(sort.mock.calls[1]?.[1]).toBe(1);
        expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);
      } finally {
        unified.dispose();
        first.dispose();
        second.dispose();
        now.mockRestore();
      }
    });

    it('does not re-sort on a depth-of-field change', () => {
      const renderer = mockRenderer();
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 1);
      unified.addSource(mesh);
      const sort = sorterSpy(unified);
      const camera = new THREE.PerspectiveCamera();
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(1);
      unified.setDepthOfField({ focusDistance: 3, aperture: 0.08 });
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(1);
      unified.dispose();
      mesh.dispose();
    });

    it('re-sorts the primary view after a secondary renderView leaves a foreign order', () => {
      const renderer = mockRenderer({
        getRenderTarget: () => null,
        setRenderTarget: vi.fn(),
        render: vi.fn(),
      });
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 1);
      unified.addSource(mesh);
      const sort = sorterSpy(unified);
      const camera = new THREE.PerspectiveCamera();
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(1);
      const mirrorCamera = new THREE.PerspectiveCamera();
      mirrorCamera.position.set(0, 0, -7);
      mirrorCamera.updateMatrixWorld(true);
      unified.renderView(mirrorCamera, renderer);
      expect(sort).toHaveBeenCalledTimes(2);
      // The shared order buffer holds the mirror's order; the primary view
      // must re-sort even though its own camera has not moved.
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(3);
      unified.dispose();
      mesh.dispose();
    });
  });

  describe('compute projection stationary guard', () => {
    function projectorSpies(unified: UnifiedSplatMesh) {
      const internals = unified as unknown as {
        projectedPipeline: { prepare: (...args: unknown[]) => void };
        projectedSorter: { sort: (...args: unknown[]) => unknown };
      };
      return {
        prepare: vi.spyOn(internals.projectedPipeline, 'prepare'),
        sort: vi.spyOn(internals.projectedSorter, 'sort'),
      };
    }

    /** Draws once and resolves the queued completion so the sort gate is free. */
    async function settleFirstSort(
      unified: UnifiedSplatMesh,
      renderer: THREE.WebGPURenderer,
      camera: THREE.PerspectiveCamera,
      resolve: () => void,
    ): Promise<void> {
      unified.onAfterRender(renderer as never, new THREE.Scene(), camera);
      resolve();
      // One tick releases the scheduler's completion watch, one publishes.
      await Promise.resolve();
      await Promise.resolve();
    }

    it('dispatches the projector once for two stationary updates', async () => {
      const { renderer, resolve } = pendingGpuCompletion();
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 4, {
        projectionStrategy: computeProjection(),
      });
      unified.addSource(mesh);
      const { prepare, sort } = projectorSpies(unified);
      const camera = new THREE.PerspectiveCamera();

      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(sort).toHaveBeenCalledTimes(1);
      expect(unified.performanceTimings.sortSubmitted).toBe(true);
      await settleFirstSort(unified, renderer, camera, resolve);
      expect(unified.getDrawPublicationSnapshot().ready).toBe(true);

      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(sort).toHaveBeenCalledTimes(1);
      expect(unified.performanceTimings.sortSubmitted).toBe(false);
      expect(unified.performanceTimings.projectionSubmissions).toBe(0);
      // The skipped dispatch keeps the published draw valid: compute
      // projection draws the whole work buffer through indirect arguments.
      expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(4);
      expect(unified.getDrawPublicationSnapshot().ready).toBe(true);

      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(unified.getDrawPublicationSnapshot().ready).toBe(true);
      unified.dispose();
      mesh.dispose();
    });

    it('re-projects when the camera moves', async () => {
      const { renderer, resolve } = pendingGpuCompletion();
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 4, {
        projectionStrategy: computeProjection(),
      });
      unified.addSource(mesh);
      const { prepare, sort } = projectorSpies(unified);
      const camera = new THREE.PerspectiveCamera();
      unified.update(camera);
      await settleFirstSort(unified, renderer, camera, resolve);
      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(1);

      camera.position.set(0, 0, 5);
      camera.updateMatrixWorld(true);
      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(sort).toHaveBeenCalledTimes(2);
      expect(unified.performanceTimings.sortSubmitted).toBe(true);
      unified.dispose();
      mesh.dispose();
    });

    it('re-projects when the viewport changes', async () => {
      const { renderer, resolve } = pendingGpuCompletion();
      const size = new THREE.Vector2(800, 600);
      (
        renderer as unknown as { getDrawingBufferSize: (out: THREE.Vector2) => THREE.Vector2 }
      ).getDrawingBufferSize = (out) => out.copy(size);
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 4, {
        projectionStrategy: computeProjection(),
      });
      unified.addSource(mesh);
      const { prepare } = projectorSpies(unified);
      const camera = new THREE.PerspectiveCamera();
      unified.update(camera);
      await settleFirstSort(unified, renderer, camera, resolve);
      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(1);

      size.set(1280, 720);
      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(2);
      unified.dispose();
      mesh.dispose();
    });

    it('re-projects when depth of field changes', async () => {
      const { renderer, resolve } = pendingGpuCompletion();
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 4, {
        projectionStrategy: computeProjection(),
      });
      unified.addSource(mesh);
      const { prepare } = projectorSpies(unified);
      const camera = new THREE.PerspectiveCamera();
      unified.update(camera);
      await settleFirstSort(unified, renderer, camera, resolve);
      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(1);

      // DoF is a live uniform the projector consumes, unlike the vertex path
      // where it never reaches the sort (see the sort gating suite).
      unified.setDepthOfField({ focusDistance: 3, aperture: 0.08 });
      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(2);
      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(2);
      unified.dispose();
      mesh.dispose();
    });

    it('re-projects after a source content change', async () => {
      const { renderer, resolve } = pendingGpuCompletion();
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 4, {
        projectionStrategy: computeProjection(),
      });
      unified.addSource(mesh);
      const { prepare, sort } = projectorSpies(unified);
      const camera = new THREE.PerspectiveCamera();
      unified.update(camera);
      await settleFirstSort(unified, renderer, camera, resolve);
      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(1);

      // Fading to zero culls the slice in the gather: a content regather.
      unified.setSourceOpacity(mesh, 0);
      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(sort).toHaveBeenCalledTimes(2);
      unified.dispose();
      mesh.dispose();
    });

    it('always dispatches a secondary view and re-projects the primary afterwards', () => {
      const renderer = mockRenderer({
        getRenderTarget: () => null,
        setRenderTarget: vi.fn(),
        render: vi.fn(),
      });
      const mesh = source();
      const unified = new UnifiedSplatMesh(renderer, 4, {
        projectionStrategy: computeProjection(),
      });
      unified.addSource(mesh);
      const { prepare } = projectorSpies(unified);
      const camera = new THREE.PerspectiveCamera();
      unified.update(camera);
      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(1);

      unified.renderView(camera, renderer);
      expect(prepare).toHaveBeenCalledTimes(2);
      // The secondary draw left a foreign order; the stationary primary view
      // still has to re-project through the pending force it raised.
      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(3);
      unified.update(camera);
      expect(prepare).toHaveBeenCalledTimes(3);
      unified.dispose();
      mesh.dispose();
    });
  });

  /**
   * `.rad` stores `alpha ÷ 2`. The standalone display path recovers it, but the
   * unified path used to pass the stored value straight through, so a `.rad`
   * scene drawn through `UnifiedSplatMesh` (which is what a multi-mesh
   * scene gets) rendered at half opacity and without the merged-node coverage
   * plateau - visibly lighter and softer than the same capture in Spark.
   *
   * `lodAlpha` is deliberately *per source*, not a compatibility field: the
   * gather stores decoded original alpha in `colors.a` and visual opacity in
   * `centers.w` so one shared draw material serves a scene that mixes `.rad`
   * and non-`.rad` sources without fade-driven reclassification.
   */
  describe('.rad LOD alpha', () => {
    it('carries lodAlpha on the source view and into that source gather', () => {
      const renderer = mockRenderer();
      const rad = source({ lodAlpha: true });
      const plain = source();
      expect(rad.getUnifiedSourceView().lodAlpha).toBe(true);
      expect(plain.getUnifiedSourceView().lodAlpha).toBe(false);

      const unified = new UnifiedSplatMesh(renderer, 4);
      unified.addSource(rad);
      unified.addSource(plain);
      const records = (
        unified as unknown as {
          sources: Array<{ source: SplatMesh; gather: unknown }>;
        }
      ).sources;
      // Mixed sources are accepted, each gathering under its own convention.
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.source)).toEqual([rad, plain]);

      unified.dispose();
      rad.dispose();
      plain.dispose();
    });

    it('does not treat lodAlpha as a cross-source compatibility field', () => {
      const renderer = mockRenderer();
      const rad = source({ lodAlpha: true });
      const plain = source();
      const unified = new UnifiedSplatMesh(renderer, 4);
      unified.addSource(rad);
      // maxStdDev/antialias/srgbOutput must still match; lodAlpha must not.
      expect(() => unified.addSource(plain)).not.toThrow();
      unified.dispose();
      rad.dispose();
      plain.dispose();
    });
  });

  it('stays at identity with matrixAutoUpdate disabled', () => {
    const renderer = mockRenderer();
    const unified = new UnifiedSplatMesh(renderer, 1);
    expect(unified.matrixAutoUpdate).toBe(false);
    expect(unified.matrix.equals(new THREE.Matrix4())).toBe(true);
    unified.dispose();
  });
});
