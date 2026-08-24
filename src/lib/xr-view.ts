/**
 * Resolving the active WebXR view for a presenting renderer.
 *
 * Every render path (a static {@link SplatMesh}, a streamed one, the unified
 * renderer) needs the same three things while an immersive session presents -
 * a cyclopean camera to sort and place SH by, one eye camera to take the
 * projection from, and the *per-eye* viewport in pixels - so they all resolve
 * them here rather than each reading `renderer.xr` its own way.
 *
 * Internal. Nothing here is exported from `index.ts`.
 */
import * as THREE from 'three/webgpu';

/** The cameras and pixel size describing one frame of a presenting XR session. */
export interface XrView {
  /**
   * The XR array camera: the head pose, midway between the eyes. Depth order
   * and the SH view direction come from here - at a ~63 mm IPD the per-eye
   * difference is imperceptible except within the near plane, so one
   * cyclopean sort serves both eyes instead of doubling the frame's dominant
   * cost. Its `projectionMatrix` is the union frustum covering both eyes,
   * which is also the right frustum for LOD scheduling.
   */
  head: THREE.Camera;
  /**
   * The first eye camera, for projection-derived quantities. Left and right
   * XR projections differ only in their center offset, not their focal
   * length, so a focal length taken from one eye is exact for both - it is
   * not an approximation.
   */
  eye: THREE.PerspectiveCamera;
  /** Per-eye viewport width in device pixels. */
  width: number;
  /** Per-eye viewport height in device pixels. */
  height: number;
}

/**
 * Structural view of the bits of three's XR manager this module uses. Every
 * member is optional: the renderer may be a stub in tests, and older three
 * versions predate parts of this surface.
 */
interface XrManagerLike {
  isPresenting?: boolean;
  cameraAutoUpdate?: boolean;
  getCamera?: () => THREE.Camera;
  updateCamera?: (camera: THREE.PerspectiveCamera) => void;
}

const _drawingBufferSize = new THREE.Vector2();

/**
 * The active XR view, or `null` when the renderer is not presenting one.
 *
 * **Freshens the XR camera before reading it.** three splits its per-frame XR
 * work in two: the sub-cameras' *local* `matrix`, `projectionMatrix` and
 * `viewport` are set in the XR manager's own animation-frame callback (which
 * runs before the host's loop body), but their `matrixWorld` /
 * `matrixWorldInverse`, the head's world matrices, and the two-eye union
 * projection are only computed in `XRManager.updateCamera()` - which the
 * renderer calls from inside `render()`. A `SplatMesh.update()` that runs
 * before `render()` would therefore read last frame's world pose, and on the
 * first presenting frame an identity one (sorting the scene from the world
 * origin). Calling `updateCamera` here closes that gap; it is idempotent and
 * cheap (a handful of matrix products - `session.updateRenderState` only
 * fires when near/far actually change), so the renderer's own call moments
 * later costs nothing.
 *
 * @param camera - The *application* camera. `updateCamera` reads its near/far,
 * layers and parent, so the app camera is required here - not the head.
 * @returns The resolved view, or `null` when not presenting (or before the
 * session has produced its first viewer pose).
 */
export function resolveXrView(
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGPURenderer,
): XrView | null {
  const xr = (renderer as { xr?: XrManagerLike }).xr;
  if (xr?.isPresenting !== true || typeof xr.getCamera !== 'function') return null;
  // A host that drives the XR camera itself sets `cameraAutoUpdate = false`;
  // freshening it here would fight that.
  if (xr.cameraAutoUpdate !== false && typeof xr.updateCamera === 'function') {
    xr.updateCamera(camera);
  }
  const head = xr.getCamera();
  const eye = (head as { cameras?: THREE.PerspectiveCamera[] }).cameras?.[0];
  if (!eye) return null;

  // The eye viewport is authoritative: the drawing buffer spans both eyes, so
  // using it would halve every splat's apparent horizontal size. It is only
  // the fallback for the frames before the XR layer reports viewports.
  const viewport = (eye as { viewport?: THREE.Vector4 }).viewport;
  let width = viewport?.z ?? 0;
  let height = viewport?.w ?? 0;
  if (!(width > 0) || !(height > 0)) {
    renderer.getDrawingBufferSize(_drawingBufferSize);
    width = _drawingBufferSize.x;
    height = _drawingBufferSize.y;
  }
  return { head, eye, width, height };
}

/**
 * Whether `camera` is an XR array camera. Code that needs a single frustum -
 * picking, anything unprojecting depth through `near`/`far` - must reject one
 * rather than silently read the defaults off a camera that has neither.
 */
export function isXrArrayCamera(camera: THREE.Camera): boolean {
  return (camera as { isArrayCamera?: boolean }).isArrayCamera === true;
}

/**
 * Session options for `navigator.xr.requestSession('immersive-vr', …)` that
 * match the renderer's backend.
 *
 * three's XR manager **throws** out of `setSession` when a WebGPU-backed
 * renderer meets a session that did not enable the `webgpu` feature - it has a
 * genuine WebGPU XR path (an `XRGPUBinding` projection layer) and refuses to
 * silently fall back to WebGL. three's own `VRButton` never asks for that
 * feature, so a host pairing it with a `WebGPURenderer` fails to enter VR on
 * exactly the browsers that support XR best. This returns the init that avoids
 * the mismatch:
 *
 * ```js
 * const session = await navigator.xr.requestSession('immersive-vr', xrSessionInit(renderer));
 * await renderer.xr.setSession(session);
 * ```
 *
 * `webgpu` is marked **required** rather than optional deliberately: an
 * optional feature the browser declines still yields a session, which is the
 * very mismatch that throws. Required turns it into a `requestSession`
 * rejection the host can catch and explain - typically by falling back to a
 * WebGL2 renderer, since three's own `WebGLXRFallback` helper swaps the entire
 * renderer and is unusable once GPU resources are bound to the current one.
 *
 * @param base - Extra options to merge. Its `requiredFeatures` and
 * `optionalFeatures` are concatenated, not replaced.
 */
export function xrSessionInit(
  renderer: THREE.WebGPURenderer,
  base: XRSessionInit = {},
): XRSessionInit {
  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  const required = [...(base.requiredFeatures ?? []), ...(isWebGPU ? ['webgpu'] : [])];
  const optional = base.optionalFeatures ?? [];
  return {
    ...base,
    ...(required.length > 0 ? { requiredFeatures: required } : {}),
    ...(optional.length > 0 ? { optionalFeatures: optional } : {}),
  };
}
