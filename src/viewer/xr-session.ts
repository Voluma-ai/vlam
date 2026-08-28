import * as THREE from 'three/webgpu';
import { resolveXrSplatBudget } from '../lib/core';

/** Camera state that three mutates while an immersive session presents. */
export interface XrCameraState {
  readonly parent: THREE.Object3D | null;
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  readonly scale: THREE.Vector3;
  readonly up: THREE.Vector3;
  readonly projectionMatrix: THREE.Matrix4;
  readonly projectionMatrixInverse: THREE.Matrix4;
  readonly worldMatrix: THREE.Matrix4;
  readonly fov: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  readonly zoom: number;
}

/** Captures the transform and lens state that three overwrites in XR. */
export function captureXrCameraState(camera: THREE.PerspectiveCamera): XrCameraState {
  camera.updateWorldMatrix(true, false);
  return {
    parent: camera.parent,
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    scale: camera.scale.clone(),
    up: camera.up.clone(),
    projectionMatrix: camera.projectionMatrix.clone(),
    projectionMatrixInverse: camera.projectionMatrixInverse.clone(),
    worldMatrix: camera.matrixWorld.clone(),
    fov: camera.fov,
    aspect: camera.aspect,
    near: camera.near,
    far: camera.far,
    zoom: camera.zoom,
  };
}

/** Restores a camera after three has copied the XR head pose and union lens into it. */
export function restoreXrCameraState(camera: THREE.PerspectiveCamera, state: XrCameraState): void {
  camera.removeFromParent();
  state.parent?.add(camera);
  camera.position.copy(state.position);
  camera.quaternion.copy(state.quaternion);
  camera.scale.copy(state.scale);
  camera.up.copy(state.up);
  camera.fov = state.fov;
  camera.aspect = state.aspect;
  camera.near = state.near;
  camera.far = state.far;
  camera.zoom = state.zoom;
  camera.projectionMatrix.copy(state.projectionMatrix);
  camera.projectionMatrixInverse.copy(state.projectionMatrixInverse);
  camera.updateMatrix();
  camera.updateWorldMatrix(true, false);
}

/**
 * Places an XR rig so the current runtime head pose lands exactly on a desired
 * world-space camera pose. This removes the local-floor eye-height/room offset
 * instead of adding it on top of the desktop eye position.
 */
export function alignXrRigToCamera(
  rig: THREE.Object3D,
  head: THREE.Camera,
  desiredHeadWorld: THREE.Matrix4,
): void {
  rig.updateWorldMatrix(true, false);

  const headInRig = rig.matrixWorld.clone().invert().multiply(head.matrixWorld);
  const desiredRigWorld = desiredHeadWorld.clone().multiply(headInRig.invert());
  const desiredRigLocal = rig.parent
    ? rig.parent.matrixWorld.clone().invert().multiply(desiredRigWorld)
    : desiredRigWorld;

  desiredRigLocal.decompose(rig.position, rig.quaternion, rig.scale);
  rig.updateMatrix();
  rig.updateWorldMatrix(true, true);
}

/**
 * Page (non-XR) budget for a streamed mesh the demo may resize live.
 *
 * Prefers the mesh ceiling so load-time finest-level lifts (LCC / moderate
 * `.rad`) survive `applyScene` / XR session-end. Perf mode pins a low cap.
 * An explicit `?budget=` is handled by the caller (early return) before this.
 */
export function pageSplatBudgetForMesh(options: {
  perfMode: boolean;
  perfModeBudget: number;
  maxBudget: number;
}): number {
  return options.perfMode ? options.perfModeBudget : options.maxBudget;
}

/** Applies the page or presenting-session budget to a live streamed pool. */
export function applyPresentationSplatBudget(
  mesh: { setBudget(budget: number): void },
  pageBudget: number,
  presenting: boolean,
): number {
  const budget = presenting ? resolveXrSplatBudget(pageBudget) : pageBudget;
  mesh.setBudget(budget);
  return budget;
}

/** Returns a scale only for the backend where three 0.185.x consumes it. */
export function xrFramebufferScaleForBackend(
  backend: 'WebGPU' | 'WebGL2',
  recommendedScale: number,
): number | null {
  return backend === 'WebGL2' ? recommendedScale : null;
}

/**
 * Attaches an acquired session and releases it if renderer setup fails. Cleanup
 * errors never mask the original setup failure.
 */
export async function attachXrSession(
  session: XRSession,
  setSession: (session: XRSession) => Promise<void>,
): Promise<void> {
  try {
    await setSession(session);
  } catch (error) {
    try {
      await session.end();
    } catch {
      // Preserve the renderer/setup error; it is the actionable failure.
    }
    throw error;
  }
}
