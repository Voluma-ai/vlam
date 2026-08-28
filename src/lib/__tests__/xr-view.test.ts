import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { isXrArrayCamera, resolveXrView, xrSessionInit } from '../core/xr-view';

/**
 * The XR view resolver. Its whole reason to exist is that three splits its
 * per-frame XR work in two: sub-camera *local* matrices, projections and
 * viewports land in the XR manager's animation-frame callback (before the host
 * loop body), but every *world* matrix - and the two-eye union projection -
 * only in `XRManager.updateCamera()`, which the renderer calls from inside
 * `render()`. Anything reading the head before `render()` therefore sees last
 * frame's pose, or an identity one on the first presenting frame.
 */

function eyeCamera(offsetX: number, viewport: THREE.Vector4 | null): THREE.PerspectiveCamera {
  const eye = new THREE.PerspectiveCamera();
  eye.position.set(offsetX, 1.6, 0);
  eye.updateMatrixWorld(true);
  eye.projectionMatrix.makePerspective(-0.9, 1.1, 0.8, -0.8, 0.1, 100);
  if (viewport) (eye as { viewport?: THREE.Vector4 }).viewport = viewport;
  return eye;
}

/**
 * A renderer presenting a session whose head world matrix is stale until
 * `updateCamera` runs - exactly three's split. `head.matrix` (local) already
 * holds this frame's pose; `matrixWorld` lags behind it.
 */
function staleXrRenderer(options: { cameraAutoUpdate?: boolean } = {}): {
  renderer: THREE.WebGPURenderer;
  head: THREE.ArrayCamera;
  updateCamera: ReturnType<typeof vi.fn>;
} {
  const head = new THREE.ArrayCamera([
    eyeCamera(-0.032, new THREE.Vector4(0, 0, 1680, 1760)),
    eyeCamera(0.032, new THREE.Vector4(1680, 0, 1680, 1760)),
  ]);
  // This frame's head pose, as the XR manager's animation-frame callback
  // leaves it: local matrix current, world matrix untouched (identity).
  head.matrix.setPosition(4, 1.6, -7);
  head.matrixWorld.identity();
  head.matrixWorldInverse.identity();

  const updateCamera = vi.fn(() => {
    head.matrixWorld.copy(head.matrix);
    head.matrixWorldInverse.copy(head.matrixWorld).invert();
  });

  const renderer = {
    backend: { isWebGPUBackend: true },
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(3360, 1760),
    xr: {
      isPresenting: true,
      getCamera: () => head,
      updateCamera,
      ...(options.cameraAutoUpdate === undefined
        ? {}
        : { cameraAutoUpdate: options.cameraAutoUpdate }),
    },
  } as unknown as THREE.WebGPURenderer;
  return { renderer, head, updateCamera };
}

const appCamera = (): THREE.PerspectiveCamera => new THREE.PerspectiveCamera(60, 1, 0.1, 100);

describe('resolveXrView', () => {
  it('freshens the head pose before returning it', () => {
    const { renderer, head, updateCamera } = staleXrRenderer();

    const view = resolveXrView(appCamera(), renderer);

    expect(updateCamera).toHaveBeenCalledTimes(1);
    expect(view).not.toBeNull();
    // Without the freshening this is the identity the manager left behind -
    // i.e. the whole scene ordered and shaded from the world origin.
    expect(view!.head.matrixWorld.elements).toEqual(head.matrix.elements);
  });

  it('passes the application camera to updateCamera, not the head', () => {
    // three reads near/far, layers and `parent` off the app camera there; the
    // head has no parent of its own and no near/far to contribute.
    const { renderer, updateCamera } = staleXrRenderer();
    const camera = appCamera();

    resolveXrView(camera, renderer);

    expect(updateCamera).toHaveBeenCalledWith(camera);
  });

  it('leaves the camera alone when the host drives it itself', () => {
    const { renderer, updateCamera } = staleXrRenderer({ cameraAutoUpdate: false });

    resolveXrView(appCamera(), renderer);

    expect(updateCamera).not.toHaveBeenCalled();
  });

  it('reports the per-eye viewport, not the both-eyes drawing buffer', () => {
    const { renderer } = staleXrRenderer();

    const view = resolveXrView(appCamera(), renderer)!;

    expect(view.width).toBe(1680);
    expect(view.height).toBe(1760);
  });

  it('falls back to the drawing buffer until the layer reports viewports', () => {
    const { renderer, head } = staleXrRenderer();
    for (const eye of head.cameras) delete (eye as { viewport?: THREE.Vector4 }).viewport;

    const view = resolveXrView(appCamera(), renderer)!;

    expect(view.width).toBe(3360);
    expect(view.height).toBe(1760);
  });

  it('returns null when not presenting, and before the first viewer pose', () => {
    const { renderer, head } = staleXrRenderer();
    expect(resolveXrView(appCamera(), renderer)).not.toBeNull();

    head.cameras.length = 0; // session started, no pose yet
    expect(resolveXrView(appCamera(), renderer)).toBeNull();

    const idle = { backend: {}, xr: { isPresenting: false } } as unknown as THREE.WebGPURenderer;
    expect(resolveXrView(appCamera(), idle)).toBeNull();
  });

  it('tolerates a renderer with no XR manager at all', () => {
    const bare = { backend: {} } as unknown as THREE.WebGPURenderer;
    expect(resolveXrView(appCamera(), bare)).toBeNull();
  });
});

describe('isXrArrayCamera', () => {
  it('distinguishes an array camera from a mono one', () => {
    expect(isXrArrayCamera(new THREE.ArrayCamera([]))).toBe(true);
    expect(isXrArrayCamera(new THREE.PerspectiveCamera())).toBe(false);
  });
});

describe('xrSessionInit', () => {
  const withBackend = (isWebGPUBackend: boolean): THREE.WebGPURenderer =>
    ({ backend: { isWebGPUBackend } }) as unknown as THREE.WebGPURenderer;

  it('requires the webgpu feature on a WebGPU backend', () => {
    // three's XRManager throws out of setSession on a WebGPU backend whose
    // session lacks this feature, and its own VRButton never asks for it.
    expect(xrSessionInit(withBackend(true)).requiredFeatures).toContain('webgpu');
  });

  it('does not request it on a WebGL backend', () => {
    // Asking would make requestSession reject on every Quest shipping today,
    // where WebGPU is behind a flag and the backend is WebGL2.
    const init = xrSessionInit(withBackend(false));
    expect(init.requiredFeatures ?? []).not.toContain('webgpu');
  });

  it('marks it required rather than optional', () => {
    // An optional feature the browser declines still yields a session - which
    // is precisely the mismatch that throws. Required fails cleanly instead.
    const init = xrSessionInit(withBackend(true));
    expect(init.optionalFeatures ?? []).not.toContain('webgpu');
  });

  it('merges rather than replaces caller features', () => {
    const init = xrSessionInit(withBackend(true), {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['hand-tracking'],
    });
    expect(init.requiredFeatures).toEqual(['local-floor', 'webgpu']);
    expect(init.optionalFeatures).toEqual(['hand-tracking']);
  });

  it('omits empty feature lists instead of sending empty arrays', () => {
    expect(xrSessionInit(withBackend(false))).toEqual({});
  });
});
