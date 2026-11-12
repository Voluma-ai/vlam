/**
 * Splat depth for post effects. Splats write no depth, so fog, aerial
 * perspective and depth of field would otherwise run straight through them.
 */
import * as THREE from 'three/webgpu';
import { Discard, Fn, uniform, vec4 } from 'three/tsl';

/** Options for {@link renderSplatDepth}. */
export interface SplatDepthOptions {
  /**
   * Fragment alpha below which a splat writes no depth (default `0.5`). Faint
   * Gaussian tails and thin stacks of low-opacity splats are not a surface: a
   * lower cutoff stops a fog ray at each splat's footprint, which reads as an
   * opaque blob around every splat.
   */
  alphaThreshold?: number;
}

interface DepthMaterial {
  material: THREE.NodeMaterial;
  threshold: { value: number };
  version: number;
  vertexNode: THREE.Node | null;
  fragmentNode: THREE.Node | null;
}

/** Any of the three VLAM draws: `SplatMesh` (and its subclasses) and both unified meshes. */
interface SplatDraw extends THREE.Mesh {
  readonly isSplatDraw: true;
}

const isSplatDraw = (object: THREE.Object3D): object is SplatDraw =>
  (object as Partial<SplatDraw>).isSplatDraw === true;

// Keyed by the draw's own material and object, so both are released with them.
const depthMaterials = new WeakMap<THREE.Material, DepthMaterial>();
const proxies = new WeakMap<THREE.Object3D, THREE.Mesh>();

/**
 * Renders the depth of every visible splat draw in `scene` into `target`'s
 * depth buffer, alpha-tested at `alphaThreshold`. Other objects are skipped:
 * the result is splat depth only, in the renderer's own depth convention
 * (reversed when the renderer uses a reversed depth buffer).
 *
 * Draws what is already prepared: call it after the frame's `update`, before
 * or after the main render. It does not sort, update LOD, or count as a
 * rendered frame, so a staged streamed generation is not acknowledged by it,
 * and a draw that is staged and hidden (`colorWrite` off) writes no depth.
 * Works on standalone meshes and unified draws, on both backends.
 *
 * `target` must have a depth buffer (give it a `depthTexture` to sample the
 * result); its size is the host's choice, half the drawing buffer is usually
 * enough. Renderer state is restored afterwards.
 */
export function renderSplatDepth(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.RenderTarget,
  options: SplatDepthOptions = {},
): void {
  const alphaThreshold = options.alphaThreshold ?? 0.5;
  const state = THREE.RendererUtils.saveRendererState(renderer);
  const sceneState = THREE.RendererUtils.saveSceneState(scene);
  const viewport = renderer.getViewport(new THREE.Vector4());
  const scissor = renderer.getScissor(new THREE.Vector4());
  const shadowEnabled = renderer.shadowMap.enabled;
  const { autoClearColor, autoClearDepth, autoClearStencil, opaque, transparent } = renderer;
  try {
    THREE.RendererUtils.resetRendererState(renderer, state);
    // Drops the background and scene fog for this pass.
    THREE.RendererUtils.resetSceneState(scene, sceneState);
    renderer.shadowMap.enabled = false;
    renderer.autoClearColor = true;
    renderer.autoClearDepth = true;
    renderer.autoClearStencil = false;
    renderer.opaque = true;
    renderer.transparent = true;
    renderer.setScissorTest(false);
    renderer.setRenderObjectFunction(
      (object, objectScene, objectCamera, geometry, material, group, lights, clipping, passId) => {
        if (!isSplatDraw(object)) return;
        // A staged generation stays submitted only so it can be acknowledged.
        if (!material.colorWrite || !(material instanceof THREE.NodeMaterial)) return;
        if (!material.fragmentNode) return;
        const depth = depthMaterialFor(material);
        depth.threshold.value = alphaThreshold;
        const proxy = proxyFor(object, geometry, depth.material, objectCamera);
        // A plain Mesh, so the draw's onAfterRender does not run: it would
        // acknowledge a publication or release CPU mirrors for a frame the
        // user never saw.
        renderer.renderObject(
          proxy,
          objectScene,
          objectCamera,
          geometry,
          depth.material,
          group,
          lights,
          clipping,
          passId,
        );
      },
    );
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  } finally {
    renderer.shadowMap.enabled = shadowEnabled;
    renderer.autoClearColor = autoClearColor;
    renderer.autoClearDepth = autoClearDepth;
    renderer.autoClearStencil = autoClearStencil;
    renderer.opaque = opaque;
    renderer.transparent = transparent;
    THREE.RendererUtils.restoreSceneState(scene, sceneState);
    THREE.RendererUtils.restoreRendererState(renderer, state);
    renderer.setViewport(viewport);
    renderer.setScissor(scissor);
  }
}

/** A depth-only clone of a splat draw's material, rebuilt when the draw's graph changes. */
function depthMaterialFor(source: THREE.NodeMaterial): DepthMaterial {
  const cached = depthMaterials.get(source);
  if (
    cached &&
    cached.version === source.version &&
    cached.vertexNode === source.vertexNode &&
    cached.fragmentNode === source.fragmentNode
  ) {
    return cached;
  }
  if (cached) cached.material.dispose();
  // A NodeMaterial clone shares the shader graph and its uniforms, so the
  // depth draw keeps the splat's projection, falloff, opacity and modifiers.
  const material = source.clone();
  const threshold = uniform(0.5);
  const fragment = source.fragmentNode as THREE.Node<'vec4'>;
  material.fragmentNode = Fn(() => {
    const color = fragment.toVar();
    Discard(color.a.lessThan(threshold));
    return vec4(0);
  })();
  material.name = 'VLAM splat depth';
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.depthTest = true;
  material.depthWrite = true;
  material.colorWrite = false;
  material.lights = false;
  material.fog = false;
  // A scene override material must not replace the depth draw.
  material.allowOverride = false;
  const entry: DepthMaterial = {
    material,
    threshold,
    version: source.version,
    vertexNode: source.vertexNode,
    fragmentNode: source.fragmentNode,
  };
  if (!cached) {
    source.addEventListener('dispose', () => {
      depthMaterials.get(source)?.material.dispose();
      depthMaterials.delete(source);
    });
  }
  depthMaterials.set(source, entry);
  return entry;
}

/** A plain mesh standing in for a splat draw, placed where the draw is. */
function proxyFor(
  object: SplatDraw,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  camera: THREE.Camera,
): THREE.Mesh {
  let proxy = proxies.get(object);
  if (!proxy) {
    proxy = new THREE.Mesh(geometry, material);
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    proxy.frustumCulled = false;
    proxies.set(object, proxy);
  }
  proxy.geometry = geometry;
  proxy.material = material;
  proxy.matrix.copy(object.matrixWorld);
  proxy.matrixWorld.copy(object.matrixWorld);
  proxy.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld);
  proxy.normalMatrix.getNormalMatrix(proxy.modelViewMatrix);
  return proxy;
}
