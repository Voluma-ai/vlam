import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { writeCovariance } from '../core/splat-data';
import { SplatMesh } from '../core/splat-mesh';
import { UnifiedSplatMesh } from '../unified/unified-splat-mesh';

/**
 * The unified renderer does not inherit `SplatMesh.update`, so it needs its own
 * XR resolution. Without it: the viewport came from the drawing buffer, which
 * spans *both* eyes, halving every splat's apparent horizontal size; and the
 * global gather/sort ran against the application camera, which does not move
 * while a session presents.
 */

function source(): SplatMesh {
  const covariances = new Float32Array(6);
  writeCovariance(covariances, 0, 1, 1, 1, 1, 0, 0, 0);
  return new SplatMesh({
    count: 1,
    positions: new Float32Array([0, 0, 0]),
    colors: new Uint8Array([255, 0, 0, 255]),
    covariances,
  });
}

/** A presenting renderer whose eyes each cover half the drawing buffer. */
function xrRenderer(): { renderer: THREE.WebGPURenderer; head: THREE.ArrayCamera } {
  const eye = new THREE.PerspectiveCamera();
  eye.projectionMatrix.makePerspective(-0.9, 1.1, 0.8, -0.8, 0.1, 100);
  (eye as { viewport?: THREE.Vector4 }).viewport = new THREE.Vector4(0, 0, 1680, 1760);
  const head = new THREE.ArrayCamera([eye]);
  head.position.set(9, 1.6, -4);
  head.updateMatrix();
  const renderer = {
    compute: vi.fn(),
    copyTextureToTexture: vi.fn(),
    getDrawingBufferSize: (out: THREE.Vector2) => out.set(3360, 1760),
    backend: { isWebGPUBackend: true },
    xr: {
      isPresenting: true,
      getCamera: () => head,
      updateCamera: () => {
        head.matrixWorld.copy(head.matrix);
        head.matrixWorldInverse.copy(head.matrixWorld).invert();
      },
    },
  } as unknown as THREE.WebGPURenderer;
  return { renderer, head };
}

describe('UnifiedSplatMesh under XR presentation', () => {
  it('takes the per-eye viewport and focal, and sorts from the head', () => {
    const { renderer, head } = xrRenderer();
    const mesh = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    unified.addSource(mesh);
    // The child resolves XR for itself; stub it out so this test observes only
    // the unified renderer's own uniforms and sort.
    (mesh as unknown as { update: () => void }).update = vi.fn();
    const sorter = (unified as unknown as { sorter: { sort: (mv: THREE.Matrix4) => void } }).sorter;
    const sort = vi.spyOn(sorter, 'sort').mockImplementation(() => undefined);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 0);
    camera.updateMatrixWorld(true);
    unified.update(camera);

    const uniforms = unified as unknown as {
      viewport: { value: THREE.Vector2 };
      focal: { value: THREE.Vector2 };
    };
    expect(uniforms.viewport.value.x).toBe(1680);
    expect(uniforms.viewport.value.y).toBe(1760);
    const projection = head.cameras[0]!.projectionMatrix.elements;
    expect(uniforms.focal.value.x).toBeCloseTo((projection[0] * 1680) / 2);

    // Sorted from the head 9 m away, not the application camera at the origin.
    expect(sort).toHaveBeenCalledTimes(1);
    const sortView = sort.mock.calls[0]![0];
    expect(sortView.elements).toEqual(head.matrixWorldInverse.elements);

    unified.dispose();
    mesh.dispose();
  });

  it('leaves a secondary view on its own camera and target size', () => {
    // `renderView` states both explicitly, so the XR path must not override it.
    const { renderer } = xrRenderer();
    const mesh = source();
    const unified = new UnifiedSplatMesh(
      Object.assign(renderer, {
        getRenderTarget: () => null,
        setRenderTarget: vi.fn(),
        render: vi.fn(),
      }),
      4,
    );
    unified.addSource(mesh);
    (mesh as unknown as { update: () => void }).update = vi.fn();
    const sorter = (unified as unknown as { sorter: { sort: (mv: THREE.Matrix4) => void } }).sorter;
    const sort = vi.spyOn(sorter, 'sort').mockImplementation(() => undefined);

    const mirror = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    mirror.position.set(-5, 0, 0);
    mirror.updateMatrixWorld(true);
    const target = new THREE.RenderTarget(320, 180);
    unified.renderView(mirror, renderer, target);

    const uniforms = unified as unknown as { viewport: { value: THREE.Vector2 } };
    expect(uniforms.viewport.value.x).toBe(320);
    expect(uniforms.viewport.value.y).toBe(180);
    const sortView = sort.mock.calls[0]![0];
    expect(sortView.elements).toEqual(mirror.matrixWorldInverse.elements);

    target.dispose();
    unified.dispose();
    mesh.dispose();
  });
});
