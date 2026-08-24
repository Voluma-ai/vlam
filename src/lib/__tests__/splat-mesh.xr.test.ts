import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplatMesh } from '../splat-mesh';
import { writeCovariance, type SplatData } from '../splat-data';
import type { SplatSorter } from '../sorter';

/**
 * XR presentation path of `SplatMesh.update`: while a session presents, the
 * mesh must project with the eye camera's viewport/focal, position SH from the
 * head, and sort exactly once per frame from the head (cyclopean) camera -
 * never once per eye.
 */

interface Internals {
  sorter: SplatSorter;
  viewport: { value: THREE.Vector2 };
  focal: { value: THREE.Vector2 };
  localCameraPosition: { value: THREE.Vector3 };
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

/** An eye camera with an asymmetric XR-style projection and a pixel viewport. */
function eyeCamera(offsetX: number, viewport: THREE.Vector4 | null): THREE.PerspectiveCamera {
  const eye = new THREE.PerspectiveCamera();
  eye.position.set(offsetX, 1.6, 0);
  eye.updateMatrixWorld(true);
  // Asymmetric frustum, as XR runtimes report: fov-derived focal would be wrong.
  eye.projectionMatrix.makePerspective(-0.9, 1.1, 0.8, -0.8, 0.1, 100);
  if (viewport) (eye as { viewport?: THREE.Vector4 }).viewport = viewport;
  return eye;
}

/** A fake renderer presenting an XR session with a two-eye array camera. */
function xrRenderer(eyes: THREE.PerspectiveCamera[]): THREE.WebGPURenderer {
  const head = new THREE.ArrayCamera(eyes);
  head.position.set(0.5, 1.6, 0); // midpoint between the eyes
  head.updateMatrixWorld(true);
  return {
    backend: { isWebGPUBackend: true },
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(3360, 1760),
    xr: { isPresenting: true, getCamera: () => head },
  } as unknown as THREE.WebGPURenderer;
}

describe('SplatMesh.update under XR presentation', () => {
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
    const sort = vi.fn((mv: THREE.Matrix4) => {
      mvs.push(mv.clone());
      return true;
    });
    internals(mesh).sorter = { kind: 'counting', sort, dispose: vi.fn() };
    meshes.push(mesh);
    return { mesh, sort, mvs };
  }

  const desktopCamera = (): THREE.PerspectiveCamera => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld(true);
    return camera;
  };

  it('sorts once per frame from the head camera, not the desktop or eye cameras', () => {
    const { mesh, sort, mvs } = meshWithSorter();
    const left = eyeCamera(0.468, new THREE.Vector4(0, 0, 1680, 1760));
    const right = eyeCamera(0.532, new THREE.Vector4(1680, 0, 1680, 1760));
    const renderer = xrRenderer([left, right]);
    const head = (renderer as unknown as { xr: { getCamera(): THREE.Camera } }).xr.getCamera();

    mesh.update(desktopCamera(), renderer);

    expect(sort).toHaveBeenCalledTimes(1);
    const expected = new THREE.Matrix4().multiplyMatrices(
      head.matrixWorldInverse,
      mesh.matrixWorld,
    );
    expect(mvs[0]!.elements).toEqual(expected.elements);
  });

  it('takes viewport and focal from the eye, and the SH position from the head', () => {
    const { mesh } = meshWithSorter();
    const left = eyeCamera(0.468, new THREE.Vector4(0, 0, 1680, 1760));
    const right = eyeCamera(0.532, new THREE.Vector4(1680, 0, 1680, 1760));
    const renderer = xrRenderer([left, right]);

    mesh.update(desktopCamera(), renderer);

    const { viewport, focal, localCameraPosition } = internals(mesh);
    // Per-eye size, not the both-eyes drawing buffer.
    expect(viewport.value.x).toBe(1680);
    expect(viewport.value.y).toBe(1760);
    // Focal from the asymmetric projection's [0]/[5], scaled by the eye viewport.
    const projection = left.projectionMatrix.elements;
    expect(focal.value.x).toBeCloseTo((projection[0] * 1680) / 2);
    expect(focal.value.y).toBeCloseTo((projection[5] * 1760) / 2);
    // Cyclopean position: the head's, not either eye's or the desktop camera's.
    expect(localCameraPosition.value.x).toBeCloseTo(0.5);
    expect(localCameraPosition.value.y).toBeCloseTo(1.6);
  });

  it('falls back to the drawing buffer before the XR layer reports viewports', () => {
    const { mesh } = meshWithSorter();
    const renderer = xrRenderer([eyeCamera(0.468, null), eyeCamera(0.532, null)]);

    mesh.update(desktopCamera(), renderer);

    const { viewport } = internals(mesh);
    expect(viewport.value.x).toBe(3360);
    expect(viewport.value.y).toBe(1760);
  });

  it('sizes frontier foveation by the eye viewport, never the drawing buffer', () => {
    // `adaptFoveationLimit` and `writeViewUniforms` share `foveationLimitPx` in
    // pixels and each converts it with its own focal length. When one used the
    // both-eyes drawing buffer and the other a per-eye viewport, the estimator
    // judged a cut the shader was not applying and the ratchet ran away toward
    // the maximum limit - the scene visibly over-coarsening. Neither may reach
    // for the drawing buffer while the layer reports viewports.
    const mesh = new SplatMesh(makeSplatData(4), { foveationMode: 'frontier' });
    meshes.push(mesh);
    internals(mesh).sorter = { kind: 'counting', sort: vi.fn(() => true), dispose: vi.fn() };
    const eye = eyeCamera(0.468, new THREE.Vector4(0, 0, 1680, 1760));
    const renderer = xrRenderer([eye]);
    const drawingBufferSize = vi.spyOn(renderer, 'getDrawingBufferSize');

    mesh.update(desktopCamera(), renderer);

    expect(drawingBufferSize).not.toHaveBeenCalled();
    const focalY = (eye.projectionMatrix.elements[5] * 1760) / 2;
    const { pixelScaleLimit, foveationLimitPx } = mesh as unknown as {
      pixelScaleLimit: { value: number };
      foveationLimitPx: number;
    };
    expect(pixelScaleLimit.value).toBeCloseTo(foveationLimitPx / focalY);
  });

  it('refuses to pick through an XR array camera', async () => {
    // An ArrayCamera has no single frustum: no near/far to unproject the
    // encoded depth through, and the pass would rasterize stereo into a mono
    // target. Silently substituting the 0.1/1000 defaults would return a
    // plausible-looking but wrong world point.
    const { mesh } = meshWithSorter();
    const renderer = xrRenderer([eyeCamera(0.468, new THREE.Vector4(0, 0, 1680, 1760))]);
    const head = (renderer as unknown as { xr: { getCamera(): THREE.Camera } }).xr.getCamera();

    await expect(mesh.pick(new THREE.Vector2(0, 0), head, renderer)).rejects.toThrow(
      /array camera has no single frustum/,
    );
  });

  it('uses the passed camera when the session is not presenting', () => {
    const { mesh, mvs } = meshWithSorter();
    const renderer = xrRenderer([]);
    (renderer as unknown as { xr: { isPresenting: boolean } }).xr.isPresenting = false;
    const camera = desktopCamera();

    mesh.update(camera, renderer);

    const expected = new THREE.Matrix4().multiplyMatrices(
      camera.matrixWorldInverse,
      mesh.matrixWorld,
    );
    expect(mvs[0]!.elements).toEqual(expected.elements);
    expect(internals(mesh).viewport.value.x).toBe(3360);
  });
});
