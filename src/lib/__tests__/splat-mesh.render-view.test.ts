import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplatMesh } from '../core/splat-mesh';
import { writeCovariance, type SplatData } from '../core/splat-data';
import type { SplatSorter } from '../core/sorter';

/**
 * Unit tests for M10's `renderView`: it must sort for the secondary camera and
 * leave the primary view's order "foreign", so the next `update()` re-sorts
 * even from a stationary primary camera (otherwise the primary would draw
 * through the secondary view's order).
 */

interface Internals {
  activeCount: number;
  sorter: SplatSorter;
  deferSortRequestOnce: boolean;
  requestSortIfNeeded(camera: THREE.Camera, renderer: THREE.WebGPURenderer): void;
}
function internals(mesh: SplatMesh): Internals {
  return mesh as unknown as Internals;
}

function makeSplatData(count: number): SplatData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

/** A fake WebGPU renderer that records render-target changes and draws. */
function fakeRenderer(): THREE.WebGPURenderer & {
  targets: (THREE.RenderTarget | null)[];
  renders: number;
} {
  let current: THREE.RenderTarget | null = null;
  const targets: (THREE.RenderTarget | null)[] = [];
  return {
    backend: { isWebGPUBackend: true },
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(800, 600),
    getRenderTarget: () => current,
    setRenderTarget: (t: THREE.RenderTarget | null) => {
      current = t;
      targets.push(t);
    },
    render: function (this: { renders: number }) {
      this.renders++;
    },
    targets,
    renders: 0,
  } as unknown as THREE.WebGPURenderer & {
    targets: (THREE.RenderTarget | null)[];
    renders: number;
  };
}

function perspectiveAt(x: number, z: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(x, 0, z);
  camera.updateMatrixWorld(true);
  return camera;
}

describe('SplatMesh.renderView (M10)', () => {
  const meshes: SplatMesh[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
  });

  function meshWithSorter(): {
    mesh: SplatMesh;
    sort: ReturnType<typeof vi.fn>;
    mvs: THREE.Matrix4[];
  } {
    const mesh = new SplatMesh(makeSplatData(4));
    const mvs: THREE.Matrix4[] = [];
    // The mesh reuses one model-view matrix instance across sorts, so snapshot
    // a clone at call time - the recorded reference would otherwise hold only
    // the last camera's matrix.
    const sort = vi.fn((mv: THREE.Matrix4) => {
      mvs.push(mv.clone());
      return true;
    });
    internals(mesh).sorter = { kind: 'counting', sort, dispose: vi.fn() };
    meshes.push(mesh);
    return { mesh, sort, mvs };
  }

  it('sorts for the secondary camera and renders into the given target', () => {
    const { mesh, sort, mvs } = meshWithSorter();
    const renderer = fakeRenderer();
    const target = new THREE.RenderTarget(256, 256);
    const view = perspectiveAt(5, 5);

    mesh.renderView(view, renderer, target);

    expect(sort).toHaveBeenCalledTimes(1);
    // The sort ran for the view camera's model-view (camera at (5,0,5)).
    const expected = new THREE.Matrix4().multiplyMatrices(
      view.matrixWorldInverse,
      mesh.matrixWorld,
    );
    expect(mvs[0]!.elements).toEqual(expected.elements);
    // Rendered into the target, then restored the previous target (null).
    expect(renderer.renders).toBe(1);
    expect(renderer.targets).toEqual([target, null]);
    target.dispose();
  });

  it('restores the render target and marks the order foreign when rendering throws', () => {
    const { mesh } = meshWithSorter();
    const renderer = fakeRenderer();
    const previous = new THREE.RenderTarget(16, 16);
    const target = new THREE.RenderTarget(256, 256);
    renderer.setRenderTarget(previous);
    renderer.targets.length = 0;
    vi.spyOn(renderer, 'render').mockImplementationOnce(() => {
      throw new Error('secondary draw failed');
    });

    expect(() => mesh.renderView(perspectiveAt(5, 5), renderer, target)).toThrow(
      'secondary draw failed',
    );
    expect(renderer.targets).toEqual([target, previous]);
    expect((mesh as unknown as { orderIsForeign: boolean }).orderIsForeign).toBe(true);

    target.dispose();
    previous.dispose();
  });

  it('forces the primary view to re-sort after a renderView, even when still', () => {
    const { mesh, sort } = meshWithSorter();
    const renderer = fakeRenderer();
    const main = perspectiveAt(0, 10);

    // Prime the primary sort, then confirm a stationary repeat is skipped.
    internals(mesh).requestSortIfNeeded(main, renderer);
    expect(sort).toHaveBeenCalledTimes(1);
    internals(mesh).requestSortIfNeeded(main, renderer);
    expect(sort).toHaveBeenCalledTimes(1); // unchanged camera → skipped

    // A secondary view sorts the shared buffer for its own camera...
    mesh.renderView(perspectiveAt(-8, 0), renderer, null);
    expect(sort).toHaveBeenCalledTimes(2);

    // ...so the very next primary update must re-sort despite no camera move.
    internals(mesh).requestSortIfNeeded(main, renderer);
    expect(sort).toHaveBeenCalledTimes(3);
    // And once the primary order is restored, stationary skipping resumes.
    internals(mesh).requestSortIfNeeded(main, renderer);
    expect(sort).toHaveBeenCalledTimes(3);
  });

  it('renders to the canvas (null target) when none is given', () => {
    const { mesh } = meshWithSorter();
    const renderer = fakeRenderer();
    mesh.renderView(perspectiveAt(1, 1), renderer);
    expect(renderer.targets).toEqual([null, null]);
  });

  it('never submits the secondary camera to the async WebGL2 worker sorter', () => {
    // On WebGL2 the sorter is a shared async worker: sorting for the mirror
    // camera would land the *mirror* order between frames and claim the worker
    // every frame ahead of the primary's request, starving the main view of
    // its own sort. renderView must not sort there - and must not flag the
    // (still primary) order as foreign either.
    const { mesh, sort } = meshWithSorter();
    const renderer = fakeRenderer();
    (renderer as unknown as { backend: object }).backend = {}; // no isWebGPUBackend
    const main = perspectiveAt(0, 10);

    internals(mesh).requestSortIfNeeded(main, renderer);
    expect(sort).toHaveBeenCalledTimes(1); // primary sort works as usual

    mesh.renderView(perspectiveAt(-8, 0), renderer, null);
    expect(sort).toHaveBeenCalledTimes(1); // secondary view did not sort

    internals(mesh).requestSortIfNeeded(main, renderer);
    expect(sort).toHaveBeenCalledTimes(1); // order still primary → still skipped
  });

  it('a foreign order overrides the staged-swap sort deferral', () => {
    // deferNextSortRequest's drain frame may only skip a sort the current
    // order still describes; after a renderView the buffer holds the
    // secondary camera's order, so skipping would draw the primary view
    // through the mirror's order for a frame.
    const { mesh, sort } = meshWithSorter();
    const renderer = fakeRenderer();
    const main = perspectiveAt(0, 10);

    internals(mesh).requestSortIfNeeded(main, renderer);
    expect(sort).toHaveBeenCalledTimes(1);

    mesh.renderView(perspectiveAt(-8, 0), renderer, null);
    expect(sort).toHaveBeenCalledTimes(2);

    internals(mesh).deferSortRequestOnce = true;
    internals(mesh).requestSortIfNeeded(main, renderer);
    expect(sort).toHaveBeenCalledTimes(3); // foreign order → deferral yields
  });

  it('generalizes to N views: each renderView sorts for its own camera (M10.3)', () => {
    const { mesh, sort, mvs } = meshWithSorter();
    const renderer = fakeRenderer();
    const cameras = [perspectiveAt(3, 0), perspectiveAt(0, 3), perspectiveAt(-3, 0)];

    for (const cam of cameras) mesh.renderView(cam, renderer, null);

    expect(sort).toHaveBeenCalledTimes(cameras.length);
    cameras.forEach((cam, i) => {
      const expected = new THREE.Matrix4().multiplyMatrices(
        cam.matrixWorldInverse,
        mesh.matrixWorld,
      );
      expect(mvs[i]!.elements).toEqual(expected.elements);
    });
    expect(renderer.renders).toBe(cameras.length);
  });
});
