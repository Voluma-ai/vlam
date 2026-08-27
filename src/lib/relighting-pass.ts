/**
 * Host-safe lighting-map pass for {@link SplatMesh.setRelighting}.
 *
 * The relight example is a sidecar `render(relightScene, camera)` into an RT.
 * That only fills TSL `shadow()` maps when the renderer looks like a fresh
 * `createSplatRenderer` (`autoClear` true, no tone-map wrap). Host apps often
 * already own a `WebGPURenderer` with `autoClear: false` and an inline ACES /
 * sRGB `contextNode`. This helper isolates those for one pass, then restores
 * them, so the example works in a custom scene.
 *
 * Important: do **not** assign `contextNode = undefined`. WebGPURenderer reads
 * `contextNode.id` while building render objects; clearing it throws and the
 * lighting RT never fills.
 */
import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';

const size = new THREE.Vector2();
const clearColor = new THREE.Color();

/**
 * Passthrough context: keeps a stable `.id` for the render-object cache, but
 * does not apply host tone-mapping / sRGB encode to the linear factor map.
 */
const RELIGHT_PASS_CONTEXT = context({
  getOutput: (node: THREE.Node) => node,
});

/**
 * Minimal renderer surface {@link renderRelightingFactorMap} needs. A real
 * `THREE.WebGPURenderer` satisfies this; tests can pass a stub.
 */
export type RelightingFactorRenderer = {
  autoClear: boolean;
  shadowMap: { enabled: boolean; autoUpdate?: boolean };
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2;
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderTarget(target: THREE.RenderTarget | null): void;
  getClearColor(target: THREE.Color): THREE.Color;
  getClearAlpha(): number;
  setClearColor(color: THREE.ColorRepresentation, alpha?: number): void;
  clear(): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  contextNode?: unknown;
};

/**
 * Renders `scene` from `camera` into `target` as a shadow-factor map:
 * resizes to the drawing buffer, clears **white + A0**, forces `autoClear`
 * and shadow maps on, and swaps in a passthrough `contextNode` so a host
 * ACES/sRGB wrap cannot turn the linear multiplier into speckle.
 *
 * Call each frame **before** `splats.update` / the main splat draw. Restore
 * is guaranteed even if `render` throws.
 */
export function renderRelightingFactorMap(
  renderer: RelightingFactorRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.RenderTarget,
): void {
  renderer.getDrawingBufferSize(size);
  target.setSize(Math.max(1, size.x), Math.max(1, size.y));

  const previousTarget = renderer.getRenderTarget();
  const previousAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const previousShadowEnabled = renderer.shadowMap.enabled;
  const previousShadowAutoUpdate = renderer.shadowMap.autoUpdate;
  const previousContext = renderer.contextNode;
  renderer.getClearColor(clearColor);

  try {
    renderer.contextNode = RELIGHT_PASS_CONTEXT;
    renderer.autoClear = true;
    renderer.shadowMap.enabled = true;
    if (previousShadowAutoUpdate === false) renderer.shadowMap.autoUpdate = true;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0xffffff, 0);
    renderer.clear();
    renderer.render(scene, camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(clearColor, previousAlpha);
    renderer.autoClear = previousAutoClear;
    renderer.shadowMap.enabled = previousShadowEnabled;
    if (previousShadowAutoUpdate !== undefined) {
      renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
    }
    renderer.contextNode = previousContext;
  }
}
