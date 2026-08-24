import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import {
  alignXrRigToCamera,
  applyPresentationSplatBudget,
  attachXrSession,
  captureXrCameraState,
  pageSplatBudgetForMesh,
  restoreXrCameraState,
  xrFramebufferScaleForBackend,
} from '../xr-session';

describe('XR camera lifecycle', () => {
  it('restores the transform, parent and exact pre-session projection', () => {
    const parent = new THREE.Group();
    parent.position.set(2, 3, 4);
    const camera = new THREE.PerspectiveCamera(61, 1.7, 0.05, 700);
    camera.position.set(5, 6, 7);
    camera.rotation.set(0.2, -0.4, 0.1);
    camera.zoom = 1.25;
    camera.updateProjectionMatrix();
    parent.add(camera);
    parent.updateMatrixWorld(true);
    const state = captureXrCameraState(camera);

    camera.removeFromParent();
    camera.position.set(-10, 1.6, 20);
    camera.quaternion.identity();
    camera.fov = 95;
    camera.projectionMatrix.makePerspective(-1, 1.2, 1, -1, 0.1, 1000);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    restoreXrCameraState(camera, state);

    expect(camera.parent).toBe(parent);
    expect(camera.position.equals(state.position)).toBe(true);
    expect(camera.quaternion.equals(state.quaternion)).toBe(true);
    expect(camera.fov).toBe(61);
    expect(camera.zoom).toBe(1.25);
    expect(camera.projectionMatrix.equals(state.projectionMatrix)).toBe(true);
    expect(camera.projectionMatrixInverse.equals(state.projectionMatrixInverse)).toBe(true);
  });

  it('cancels a nonzero local-floor head pose when placing the rig', () => {
    const scene = new THREE.Scene();
    const rig = new THREE.Group();
    scene.add(rig);
    scene.updateMatrixWorld(true);

    const head = new THREE.PerspectiveCamera();
    head.position.set(0.35, 1.72, -0.4);
    head.rotation.set(0.05, 0.4, 0);
    head.updateMatrixWorld(true);

    const desired = new THREE.Matrix4().compose(
      new THREE.Vector3(12, 4, -8),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.1, -0.7, 0)),
      new THREE.Vector3(1, 1, 1),
    );

    alignXrRigToCamera(rig, head, desired);
    const placedHead = rig.matrixWorld.clone().multiply(head.matrixWorld);

    for (let i = 0; i < 16; i++) {
      expect(placedHead.elements[i]).toBeCloseTo(desired.elements[i] as number, 8);
    }
  });
});

describe('XR presentation policy', () => {
  it('caps a newly mounted pool while presenting and restores the page budget', () => {
    const setBudget = vi.fn();
    const mesh = { setBudget };

    // The stereo ceiling is `HEADSET_BUDGET_MAX`, so this tracks that tier.
    expect(applyPresentationSplatBudget(mesh, 3_000_000, true)).toBe(600_000);
    expect(applyPresentationSplatBudget(mesh, 3_000_000, false)).toBe(3_000_000);
    expect(setBudget.mock.calls).toEqual([[600_000], [3_000_000]]);
  });

  it('page budget prefers the mesh ceiling over the raw device default', () => {
    expect(
      pageSplatBudgetForMesh({
        perfMode: false,
        perfModeBudget: 1_000_000,
        maxBudget: 4_743_855,
      }),
    ).toBe(4_743_855);
    expect(
      pageSplatBudgetForMesh({
        perfMode: true,
        perfModeBudget: 1_000_000,
        maxBudget: 4_743_855,
      }),
    ).toBe(1_000_000);
  });

  it('applies framebuffer undersampling only on three WebGL XR', () => {
    expect(xrFramebufferScaleForBackend('WebGL2', 0.8)).toBe(0.8);
    expect(xrFramebufferScaleForBackend('WebGPU', 0.8)).toBeNull();
  });

  it('ends an acquired session when renderer attachment rejects', async () => {
    const setupError = new Error('projection layer failed');
    const end = vi.fn().mockResolvedValue(undefined);
    const session = { end } as unknown as XRSession;

    await expect(attachXrSession(session, () => Promise.reject(setupError))).rejects.toBe(
      setupError,
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it('does not end a successfully attached session', async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const session = { end } as unknown as XRSession;

    await attachXrSession(session, () => Promise.resolve());
    expect(end).not.toHaveBeenCalled();
  });
});
