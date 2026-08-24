/**
 * GPU screen-space picking for `SplatMesh`.
 *
 * Picking renders the splats once more into a 1×1 target, with a
 * material that writes linear view depth instead of color; the depth comes back
 * through an async readback and unprojects to a world point. That needs a whole
 * subsystem of its own - a render target, a proxy mesh, a private scene, saved
 * renderer state - none of which the mesh itself ever touches, so it lives here
 * rather than as ten more fields on an already large class.
 *
 * The picker reaches back into the mesh through {@link SplatPickHost} rather
 * than holding the mesh itself: the four things it needs are otherwise private,
 * and widening them for the picker would put them in the published .d.ts.
 *
 * Internal. Nothing here is exported from `index.ts`.
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import {
  denormalizeViewDepth,
  unpackNormalizedDepth,
  unprojectViewDepth,
} from './splat-depth-pack';
import type { SplatPickOptions, SplatPickResult } from './splat-mesh';
import type { FloatUniform } from './splat-mesh-material';
import { isXrArrayCamera } from './xr-view';

/** What the picker needs from the mesh it picks. */
export interface SplatPickHost {
  /** The mesh, for the transform/visibility the proxy mirrors and its geometry. */
  readonly mesh: THREE.Mesh;
  isDisposed(): boolean;
  getActiveCount(): number;
  /** The mesh's live viewport uniform value, in drawing-buffer pixels. */
  getViewportSize(): THREE.Vector2;
  /** Visibility as resolved by an owning unified renderer, when any. */
  getPickVisible(): boolean;
  /** Whether a sorter exists. A pick never creates one - see {@link prepare}. */
  hasSorter(): boolean;
  updateWorldMatrix(): void;
  /**
   * Brings the GPU to the state `update()` would leave it in: flush pending
   * uploads, refresh the projection uniforms, and refresh an existing sorter's
   * draw list. Ordering matters, so the mesh owns it.
   */
  prepare(camera: THREE.Camera, renderer: THREE.WebGPURenderer): void;
  /**
   * Writes focal / viewport / local-camera uniforms for a camera drawing into
   * a viewport of `width`×`height` pixels. The pick pass crops the frustum to
   * one source pixel and renders into a 1×1 target, so it must rewrite these
   * after the crop and restore the canvas-sized values before returning.
   */
  setView(camera: THREE.Camera, width: number, height: number): void;
  /** Builds the pick-mode TSL graph onto a freshly created material. */
  applyPickGraph(material: THREE.NodeMaterial): void;
}

/**
 * Owns the pick pass and everything it allocates. Resources are created on the
 * first pick, so a mesh that is never picked pays nothing.
 */
export class SplatPicker {
  /** Alpha below which a splat is transparent enough to pick through. */
  private readonly alphaThreshold = uniform(0.1);
  /** Camera planes for the pick material's depth encoding. */
  private readonly near = uniform(0.1);
  private readonly far = uniform(1000);
  private material: THREE.NodeMaterial | null = null;
  private proxy: THREE.Mesh | null = null;
  private target: THREE.RenderTarget | null = null;
  /** Reused sub-frustum camera; preserves the caller's concrete camera type. */
  private pickCamera: THREE.Camera | null = null;
  private readonly scene = new THREE.Scene();
  /** Serializes picks: they share one render target and one renderer. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly point = new THREE.Vector3();
  private readonly savedClearColor = new THREE.Color();

  constructor(private readonly host: SplatPickHost) {}

  /** The pick uniforms the material graph binds. */
  get uniforms(): { alphaThreshold: FloatUniform; near: FloatUniform; far: FloatUniform } {
    return { alphaThreshold: this.alphaThreshold, near: this.near, far: this.far };
  }

  pick(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    renderer: THREE.WebGPURenderer,
    options?: SplatPickOptions,
  ): Promise<SplatPickResult | null> {
    const run = this.queue.then(() => this.run(ndc, camera, renderer, options));
    // Keep the queue alive even when a pick rejects, so later calls still run.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Rebuilds the pick graph after a settings change. No-op before the first pick. */
  rebuildMaterial(): void {
    if (!this.material) return;
    this.host.applyPickGraph(this.material);
  }

  /** Flags the pick graph for recompile (e.g. the modifier list changed). */
  markNeedsUpdate(): void {
    if (this.material) this.material.needsUpdate = true;
  }

  dispose(): void {
    this.material?.dispose();
    this.material = null;
    this.scene.clear();
    this.proxy = null;
    this.target?.dispose();
    this.target = null;
    this.pickCamera = null;
  }

  private async run(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    renderer: THREE.WebGPURenderer,
    options?: SplatPickOptions,
  ): Promise<SplatPickResult | null> {
    if (this.host.isDisposed()) return null;
    if (this.host.getActiveCount() === 0) return null;
    if (ndc.x < -1 || ndc.x > 1 || ndc.y < -1 || ndc.y > 1) return null;
    // An XR array camera has no single frustum: no `near`/`far` to unproject
    // the encoded depth through (the fallbacks below would silently substitute
    // 0.1/1000 and return a plausible-looking but wrong world point), and the
    // pass would rasterize stereo into a mono target. Fail loudly instead.
    if (isXrArrayCamera(camera)) {
      throw new Error(
        'SplatMesh.pick: an XR array camera has no single frustum to pick through. ' +
          'Pass one eye (renderer.xr.getCamera().cameras[i]) or a mono camera, and ' +
          'give `ndc` in that eye’s viewport.',
      );
    }

    camera.updateMatrixWorld(true);
    this.host.updateWorldMatrix();
    // Match the state `update()` establishes: appended-but-unflushed rows must
    // reach the GPU, and an existing sorter's draw list must be refreshed for
    // the current active set - or the pick pass rasterizes stale pool data
    // (garbage centers, or "ghost" splats from a just-removed range still in
    // the GPU-sorted order). The pick pass itself is depth-tested, so it does
    // not need a *sorted* order - only a valid one - hence no sorter is
    // created here when none exists yet (the identity draw list is valid).
    this.host.prepare(camera, renderer);

    const width = Math.max(1, Math.floor(this.host.getViewportSize().x));
    const height = Math.max(1, Math.floor(this.host.getViewportSize().y));
    const px = Math.floor((ndc.x * 0.5 + 0.5) * width);
    // NDC +y is up, so this row index is measured from the BOTTOM edge.
    const pyBottom = Math.floor((ndc.y * 0.5 + 0.5) * height);
    if (px < 0 || pyBottom < 0 || px >= width || pyBottom >= height) return null;
    this.ensureResources(camera);
    const pickTarget = this.target!;
    const pickProxy = this.proxy!;
    const pickCamera = this.pickCamera!;
    this.cropCameraToPixel(pickCamera, camera, width, height, px, pyBottom);
    // The crop maps one source pixel onto NDC [-1, 1]. Quad extent is
    // `pixelOffset * 2 / viewport`, so viewport must be the 1×1 pick target
    // or a splat tens of pixels wide shrinks to a sliver that never covers
    // the clicked pixel. Focal follows the cropped projection at this size
    // and matches the canvas-pixel covariance the display pass used.
    this.host.setView(pickCamera, 1, 1);

    const near = 'near' in camera && typeof camera.near === 'number' ? camera.near : 0.1;
    const far = 'far' in camera && typeof camera.far === 'number' ? camera.far : 1000;
    this.near.value = near;
    this.far.value = far;
    this.alphaThreshold.value =
      options?.alphaThreshold !== undefined ? options.alphaThreshold : 0.1;

    const mesh = this.host.mesh;
    const previousTarget = renderer.getRenderTarget();
    const previousScissorTest = renderer.getScissorTest();
    renderer.getClearColor(this.savedClearColor);
    const previousClearAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;

    pickProxy.matrix.copy(mesh.matrixWorld);
    pickProxy.matrixWorld.copy(mesh.matrixWorld);
    pickProxy.visible = this.host.getPickVisible();
    pickProxy.layers.mask = mesh.layers.mask;
    pickProxy.renderOrder = mesh.renderOrder;
    pickTarget.viewport.set(0, 0, 1, 1);
    pickTarget.scissor.set(0, 0, 1, 1);

    // Start readback while the target is bound, but restore shared renderer
    // state synchronously. Awaiting while mutated would corrupt normal frames.
    const readback = (() => {
      try {
        renderer.setRenderTarget(pickTarget);
        renderer.setScissorTest(false);
        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = true;
        renderer.clear();

        renderer.setScissorTest(true);
        renderer.autoClear = false;
        renderer.render(this.scene, pickCamera);
        return renderer.readRenderTargetPixelsAsync(pickTarget, 0, 0, 1, 1);
      } finally {
        this.host.setView(camera, width, height);
        renderer.setRenderTarget(previousTarget);
        renderer.setScissorTest(previousScissorTest);
        renderer.setClearColor(this.savedClearColor, previousClearAlpha);
        renderer.autoClear = previousAutoClear;
      }
    })();

    let rgba: Uint8Array | Uint8ClampedArray | Float32Array;
    try {
      rgba = (await readback) as Uint8Array;
    } catch (error) {
      // A dispose while the readback was in flight tears down the render
      // target the GPU was copying from; the readback rejection is then an
      // expected consequence of dispose, not a pick failure - resolve as a
      // clean miss so hosts never need a try/catch around a cursor pick.
      if (this.host.isDisposed()) return null;
      throw error;
    }
    if (this.host.isDisposed()) return null;

    const r = rgba[0] as number;
    const g = rgba[1] as number;
    const b = rgba[2] as number;
    const a = rgba[3] as number;
    if (a === 0) return null;

    const viewDepth = denormalizeViewDepth(unpackNormalizedDepth(r, g, b), near, far);
    const { point, distance } = unprojectViewDepth(ndc.x, ndc.y, viewDepth, camera, this.point);
    return { point: point.clone(), distance };
  }

  private ensureResources(camera: THREE.Camera): void {
    if (this.target === null) {
      this.target = new THREE.RenderTarget(1, 1, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
      });
    }
    if (this.material === null) {
      this.material = new THREE.NodeMaterial();
      this.host.applyPickGraph(this.material);
      this.proxy = new THREE.Mesh(this.host.mesh.geometry, this.material);
      this.proxy.matrixAutoUpdate = false;
      this.proxy.frustumCulled = false;
      this.scene.add(this.proxy);
    }
    if (this.pickCamera === null || this.pickCamera.constructor !== camera.constructor) {
      this.pickCamera = camera.clone();
    }
  }

  /** Maps one original framebuffer pixel onto the complete 1×1 pick target. */
  private cropCameraToPixel(
    target: THREE.Camera,
    source: THREE.Camera,
    width: number,
    height: number,
    px: number,
    pyBottom: number,
  ): void {
    // The concrete subclasses have compatible `copy` overrides; ensureResources
    // keeps source and target constructors equal before this call.
    target.copy(source);
    const projection = target.projectionMatrix;
    const elements = projection.elements;
    const xOffset = 2 * px + 1 - width;
    const yOffset = 2 * pyBottom + 1 - height;
    for (let column = 0; column < 4; column++) {
      const rowW = elements[column * 4 + 3] as number;
      elements[column * 4] = (elements[column * 4] as number) * width - xOffset * rowW;
      elements[column * 4 + 1] = (elements[column * 4 + 1] as number) * height - yOffset * rowW;
    }
    target.projectionMatrixInverse.copy(projection).invert();
  }
}
