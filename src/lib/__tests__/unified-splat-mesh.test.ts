import * as THREE from 'three/webgpu';
import { bool, float } from 'three/tsl';
import { describe, expect, it, vi } from 'vitest';
import { writeCovariance, type SplatData } from '../core/splat-data';
import { SplatMesh } from '../core/splat-mesh';
import { MergedSplatMesh } from '../core/merged-splat-mesh';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '../unified/unified-splat-mesh';

function source(
  options: {
    maxStdDev?: number;
    minSplatSizePx?: number;
    antialias?: boolean;
    lodAlpha?: boolean;
    sh?: boolean;
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

function mockRenderer(extras: Record<string, unknown> = {}): THREE.WebGPURenderer {
  return {
    compute: vi.fn(),
    copyTextureToTexture: vi.fn(),
    getDrawingBufferSize: (out: THREE.Vector2) => out.set(800, 600),
    backend: { isWebGPUBackend: true },
    ...extras,
  } as unknown as THREE.WebGPURenderer;
}

function gatherSpies(unified: UnifiedSplatMesh) {
  const records = (
    unified as unknown as {
      sources: Array<{ source: SplatMesh; gather: { gather: (...args: unknown[]) => void } }>;
    }
  ).sources;
  return records.map((record) => ({
    source: record.source,
    gather: vi.spyOn(record.gather, 'gather'),
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
  it.each(['radix', 'exact'] as const)(
    'uses the stable %s sorter when requested',
    (sortStrategy) => {
      const unified = new UnifiedSplatMesh(mockRenderer(), 1, { sortStrategy });
      const sorterName = (unified as unknown as { sorter: { constructor: { name: string } } })
        .sorter.constructor.name;
      expect(sorterName).toBe('RadixSorter');
      expect((unified as unknown as { sorter: { exactDepth: boolean } }).sorter.exactDepth).toBe(
        sortStrategy === 'exact',
      );
      unified.dispose();
    },
  );

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
      unified.setSourceOpacity(mesh, 0.5);
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(2);
      // Settled again: the regathered content is now sorted, nothing changed.
      unified.update(camera);
      expect(sort).toHaveBeenCalledTimes(2);
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
