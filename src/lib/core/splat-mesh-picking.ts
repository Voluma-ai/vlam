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
  /** Pick from the full active list instead of the display's GPU-culled list. */
  usesUnculledPickList(): boolean;
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
  private unculledGeometry: THREE.InstancedBufferGeometry | null = null;
  private target: THREE.RenderTarget | null = null;
  /** Renderer/material pair whose validation scopes compileAsync has drained. */
  private compiledRenderer: THREE.WebGPURenderer | null = null;
  private compiledMaterialVersion = -1;
  /** In-flight validation shared by render-only preparation and the first pick. */
  private compilation: {
    renderer: THREE.WebGPURenderer;
    material: THREE.NodeMaterial;
    version: number;
    promise: Promise<void>;
  } | null = null;
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
    return this.pickMany([ndc], camera, renderer, options).then((results) => results[0] ?? null);
  }

  /** Runs one bounded pick pass for an ordered set of screen coordinates. */
  pickMany(
    ndcs: readonly THREE.Vector2[],
    camera: THREE.Camera,
    renderer: THREE.WebGPURenderer,
    options?: SplatPickOptions,
  ): Promise<readonly (SplatPickResult | null)[]> {
    // Snapshot synchronously: this request may sit behind an earlier readback.
    camera.updateMatrixWorld(true);
    const cameraSnapshot = camera.clone();
    const samples = ndcs.map((ndc) => ndc.clone());
    // The mesh uniform can still be its constructor-time 1×1 before the first
    // update. The renderer is the authority for the request's canvas frame.
    const viewport = renderer.getDrawingBufferSize(new THREE.Vector2());
    const run = this.queue.then(() =>
      this.runMany(samples, cameraSnapshot, renderer, viewport, options),
    );
    // Keep the queue alive even when a pick rejects, so later calls still run.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Builds and validates the lazy pick bindings while CPU storage still exists.
   *
   * Three's `NodeStorageBuffer` captures `attribute.array` while compiling a
   * new material. Render-only meshes replace that array with a zero-length
   * mirror after upload, so compiling the pick material afterwards can create
   * an invalid WebGPU binding on strict backends such as SwiftShader. The mesh
   * awaits this preparation before releasing those mirrors.
   */
  async prepareForCpuRelease(camera: THREE.Camera, renderer: THREE.WebGPURenderer): Promise<void> {
    if (this.host.isDisposed() || this.host.getActiveCount() === 0) return;
    this.ensureResources(camera);
    await this.compilePipeline(
      renderer,
      this.target!,
      this.pickCamera!,
      renderer.getRenderTarget(),
    );
  }

  /** Rebuilds the pick graph after a settings change. No-op before the first pick. */
  rebuildMaterial(): void {
    if (!this.material) return;
    this.host.applyPickGraph(this.material);
    this.compiledRenderer = null;
  }

  /** Flags the pick graph for recompile (e.g. the modifier list changed). */
  markNeedsUpdate(): void {
    if (this.material) {
      this.material.needsUpdate = true;
      this.compiledRenderer = null;
    }
  }

  dispose(): void {
    this.material?.dispose();
    this.material = null;
    this.scene.clear();
    this.proxy = null;
    this.unculledGeometry?.dispose();
    this.unculledGeometry = null;
    this.target?.dispose();
    this.target = null;
    this.pickCamera = null;
    this.compiledRenderer = null;
    this.compiledMaterialVersion = -1;
    this.compilation = null;
  }

  private async runMany(
    ndcs: readonly THREE.Vector2[],
    camera: THREE.Camera,
    renderer: THREE.WebGPURenderer,
    viewport: THREE.Vector2,
    options?: SplatPickOptions,
  ): Promise<readonly (SplatPickResult | null)[]> {
    const misses = (): readonly null[] => ndcs.map(() => null);
    if (ndcs.length === 0) return [];
    if (this.host.isDisposed()) return misses();
    if (this.host.getActiveCount() === 0) return misses();
    // An XR array camera has no single frustum: no `near`/`far` to unproject
    // the encoded depth through (the fallbacks below would silently substitute
    // 0.1/1000 and return a plausible-looking but wrong world point), and the
    // pass would rasterize stereo into a mono target. Fail loudly instead.
    if (isXrArrayCamera(camera)) {
      throw new Error(
        'SplatMesh.pick/pickMany: an XR array camera has no single frustum to pick through. ' +
          'Pass one eye (renderer.xr.getCamera().cameras[i]) or a mono camera, and ' +
          'give `ndc` in that eye’s viewport.',
      );
    }

    this.host.updateWorldMatrix();
    // Match the state `update()` establishes: appended-but-unflushed rows must
    // reach the GPU, and an existing sorter's draw list must be refreshed for
    // the current active set - or the pick pass rasterizes stale pool data
    // (garbage centers, or "ghost" splats from a just-removed range still in
    // the GPU-sorted order). The pick pass itself is depth-tested, so it does
    // not need a *sorted* order - only a valid one - hence no sorter is
    // created here when none exists yet (the identity draw list is valid).
    this.host.prepare(camera, renderer);

    const width = Math.max(1, Math.floor(viewport.x));
    const height = Math.max(1, Math.floor(viewport.y));
    const pixels = ndcs.map((ndc) => ({
      x: Math.floor((ndc.x * 0.5 + 0.5) * width),
      // NDC +y is up, so this row is measured from the bottom edge.
      y: Math.floor((ndc.y * 0.5 + 0.5) * height),
    }));
    const valid = pixels.filter(({ x, y }) => x >= 0 && y >= 0 && x < width && y < height);
    if (valid.length === 0) return misses();
    const x0 = Math.min(...valid.map(({ x }) => x));
    const y0 = Math.min(...valid.map(({ y }) => y));
    const x1 = Math.max(...valid.map(({ x }) => x));
    const y1 = Math.max(...valid.map(({ y }) => y));
    const targetWidth = x1 - x0 + 1;
    const targetHeight = y1 - y0 + 1;
    this.ensureResources(camera, targetWidth, targetHeight);
    const pickTarget = this.target!;
    const pickProxy = this.proxy!;
    const pickCamera = this.pickCamera!;
    this.cropCameraToRect(pickCamera, camera, width, height, x0, y0, targetWidth, targetHeight);
    // Quad extent is `pixelOffset * 2 / viewport`, so the viewport must match
    // the bounded pick target. Focal follows the cropped projection at this size
    // and matches the canvas-pixel covariance the display pass used.
    this.host.setView(pickCamera, targetWidth, targetHeight);

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
    pickTarget.viewport.set(0, 0, targetWidth, targetHeight);
    pickTarget.scissor.set(0, 0, targetWidth, targetHeight);

    // Normal render() creates a pipeline synchronously but leaves its WebGPU
    // validation popErrorScope promise untracked. If the host disposes the
    // renderer after this awaited pick, a slow backend can reject that orphaned
    // promise as "Instance dropped". Compile once through three's awaited path.
    try {
      await this.compilePipeline(renderer, pickTarget, pickCamera, previousTarget);
    } catch (error) {
      if (this.host.isDisposed()) return misses();
      throw error;
    }
    if (this.host.isDisposed()) return misses();

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
        return renderer.readRenderTargetPixelsAsync(pickTarget, 0, 0, targetWidth, targetHeight);
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
      if (this.host.isDisposed()) return misses();
      throw error;
    }
    if (this.host.isDisposed()) return misses();

    return ndcs.map((ndc, index) => {
      const pixel = pixels[index] as { x: number; y: number };
      if (pixel.x < 0 || pixel.y < 0 || pixel.x >= width || pixel.y >= height) return null;
      const offset = ((pixel.y - y0) * targetWidth + pixel.x - x0) * 4;
      const r = rgba[offset] as number;
      const g = rgba[offset + 1] as number;
      const b = rgba[offset + 2] as number;
      const a = rgba[offset + 3] as number;
      if (a === 0) return null;
      const viewDepth = denormalizeViewDepth(unpackNormalizedDepth(r, g, b), near, far);
      const result = unprojectViewDepth(ndc.x, ndc.y, viewDepth, camera, this.point);
      return { point: result.point.clone(), distance: result.distance };
    });
  }

  private ensureResources(camera: THREE.Camera, width = 1, height = 1): void {
    if (this.target === null) {
      this.target = new THREE.RenderTarget(width, height, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
      });
    } else if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height);
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
    if (this.host.usesUnculledPickList()) {
      if (!this.unculledGeometry) {
        // Only copy the four-vertex quad: the pick shader reads the existing
        // active-index buffer, independently of the display order and count.
        this.unculledGeometry = new THREE.InstancedBufferGeometry();
        this.unculledGeometry.setIndex(this.host.mesh.geometry.index!.clone());
        this.unculledGeometry.setAttribute(
          'position',
          this.host.mesh.geometry.getAttribute('position').clone(),
        );
      }
      this.unculledGeometry.instanceCount = this.host.getActiveCount();
      this.proxy!.geometry = this.unculledGeometry;
    } else {
      this.proxy!.geometry = this.host.mesh.geometry;
    }
  }

  /** Compiles for the pick target while restoring renderer state before the first async yield. */
  private async compilePipeline(
    renderer: THREE.WebGPURenderer,
    target: THREE.RenderTarget,
    camera: THREE.Camera,
    previousTarget: THREE.RenderTarget | null,
  ): Promise<void> {
    const material = this.material as THREE.NodeMaterial;
    if (this.compiledRenderer === renderer && this.compiledMaterialVersion === material.version) {
      return;
    }

    const pending = this.compilation;
    if (
      pending?.renderer === renderer &&
      pending.material === material &&
      pending.version === material.version
    ) {
      await pending.promise;
      return;
    }

    let compilation: Promise<void>;
    try {
      renderer.setRenderTarget(target);
      // compileAsync captures the render context synchronously, restores its
      // own render state, then awaits pipeline validation.
      compilation = renderer.compileAsync(this.scene, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
    }
    const version = material.version;
    const tracked = compilation.then(() => {
      if (this.material === material && material.version === version && !this.host.isDisposed()) {
        this.compiledRenderer = renderer;
        this.compiledMaterialVersion = version;
      }
    });
    this.compilation = { renderer, material, version, promise: tracked };
    try {
      await tracked;
    } finally {
      if (this.compilation?.promise === tracked) this.compilation = null;
    }
  }

  /** Maps a source framebuffer rectangle onto the complete pick target. */
  private cropCameraToRect(
    target: THREE.Camera,
    source: THREE.Camera,
    width: number,
    height: number,
    x: number,
    yBottom: number,
    cropWidth: number,
    cropHeight: number,
  ): void {
    // The concrete subclasses have compatible `copy` overrides; ensureResources
    // keeps source and target constructors equal before this call.
    target.copy(source);
    const projection = target.projectionMatrix;
    const elements = projection.elements;
    const xOffset = 2 * x + cropWidth - width;
    const yOffset = 2 * yBottom + cropHeight - height;
    for (let column = 0; column < 4; column++) {
      const rowW = elements[column * 4 + 3] as number;
      elements[column * 4] =
        ((elements[column * 4] as number) * width - xOffset * rowW) / cropWidth;
      elements[column * 4 + 1] =
        ((elements[column * 4 + 1] as number) * height - yOffset * rowW) / cropHeight;
    }
    target.projectionMatrixInverse.copy(projection).invert();
  }
}
