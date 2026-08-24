import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { SplatMesh } from '../splat-mesh';
import { packNormalizedDepth, normalizeViewDepth } from '../splat-depth-pack';
import { writeCovariance } from '../splat-data';

function makeSplatData(count = 1): {
  count: number;
  positions: Float32Array;
  colors: Uint8Array;
  covariances: Float32Array;
} {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = 0;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = 0;
    colors[i * 4] = 255;
    colors[i * 4 + 1] = 255;
    colors[i * 4 + 2] = 255;
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

type MockRenderer = THREE.WebGPURenderer & {
  _target: THREE.RenderTarget | null;
  _scissorTest: boolean;
  _viewport: THREE.Vector4;
  _scissor: THREE.Vector4;
  _clearColor: THREE.Color;
  _clearAlpha: number;
  _autoClear: boolean;
  _pixel: Uint8Array;
  renderLog: unknown[];
  readLog: Array<{ x: number; y: number }>;
};

function createMockRenderer(width = 200, height = 100): MockRenderer {
  const state = {
    target: null as THREE.RenderTarget | null,
    scissorTest: false,
    viewport: new THREE.Vector4(0, 0, width, height),
    scissor: new THREE.Vector4(0, 0, width, height),
    clearColor: new THREE.Color(1, 1, 1),
    clearAlpha: 1,
    autoClear: true,
    pixel: new Uint8Array([0, 0, 0, 0]),
    renderLog: [] as unknown[],
    readLog: [] as Array<{ x: number; y: number }>,
  };

  const renderer = {
    get autoClear() {
      return state.autoClear;
    },
    set autoClear(v: boolean) {
      state.autoClear = v;
    },
    getDrawingBufferSize: (target: THREE.Vector2) => target.set(width, height),
    getRenderTarget: () => state.target,
    setRenderTarget: (t: THREE.RenderTarget | null) => {
      state.target = t;
    },
    getScissorTest: () => state.scissorTest,
    setScissorTest: (v: boolean) => {
      state.scissorTest = v;
    },
    getViewport: (target: THREE.Vector4) => target.copy(state.viewport),
    setViewport: (x: number, y: number, w: number, h: number) => {
      state.viewport.set(x, y, w, h);
    },
    getScissor: (target: THREE.Vector4) => target.copy(state.scissor),
    setScissor: (x: number, y: number, w: number, h: number) => {
      state.scissor.set(x, y, w, h);
    },
    getClearColor: (target: THREE.Color) => target.copy(state.clearColor),
    setClearColor: (color: THREE.ColorRepresentation, alpha = 1) => {
      state.clearColor.set(color);
      state.clearAlpha = alpha;
    },
    getClearAlpha: () => state.clearAlpha,
    clear: vi.fn(),
    render: vi.fn((scene: unknown, camera: unknown) => {
      if (scene instanceof THREE.Scene) scene.updateMatrixWorld(true);
      state.renderLog.push({
        scene,
        camera,
        target: state.target,
        targetViewport: state.target?.viewport.clone(),
        targetScissor: state.target?.scissor.clone(),
      });
    }),
    readRenderTargetPixelsAsync: vi.fn(async (_rt: unknown, x: number, y: number) => {
      state.readLog.push({ x, y });
      return state.pixel.slice();
    }),
    _setPixel: (rgba: number[]) => {
      state.pixel.set(rgba);
    },
    get renderLog() {
      return state.renderLog;
    },
    get readLog() {
      return state.readLog;
    },
  };

  return renderer as unknown as MockRenderer;
}

describe('SplatMesh.pick', () => {
  const meshes: SplatMesh[] = [];

  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
  });

  function createMesh(count = 1): SplatMesh {
    const mesh = new SplatMesh(makeSplatData(count));
    meshes.push(mesh);
    return mesh;
  }

  it('returns null for out-of-canvas NDC', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer();

    expect(await mesh.pick(new THREE.Vector2(1.5, 0), camera, renderer)).toBeNull();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('returns null for an empty mesh', async () => {
    const mesh = new SplatMesh({ capacity: 2048 });
    meshes.push(mesh);
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    const renderer = createMockRenderer();
    expect(await mesh.pick(new THREE.Vector2(0, 0), camera, renderer)).toBeNull();
  });

  it('returns null on miss (alpha 0)', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer();
    (renderer as unknown as { _setPixel: (rgba: number[]) => void })._setPixel([0, 0, 0, 0]);

    expect(await mesh.pick(new THREE.Vector2(0, 0), camera, renderer)).toBeNull();
    expect(renderer.render).toHaveBeenCalledOnce();
  });

  it('reconstructs a hit from packed depth on the camera axis', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer();

    const viewDepth = 5;
    const packed = packNormalizedDepth(normalizeViewDepth(viewDepth, camera.near, camera.far));
    (renderer as unknown as { _setPixel: (rgba: number[]) => void })._setPixel([
      packed.r,
      packed.g,
      packed.b,
      255,
    ]);

    const result = await mesh.pick(new THREE.Vector2(0, 0), camera, renderer);
    expect(result).not.toBeNull();
    expect(result!.point.x).toBeCloseTo(0, 4);
    expect(result!.point.y).toBeCloseTo(0, 4);
    expect(result!.point.z).toBeCloseTo(0, 4);
    expect(result!.distance).toBeCloseTo(5, 4);
  });

  it('restores renderer state after a successful pick', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer(200, 100);
    renderer.setRenderTarget(null);
    renderer.setViewport(10, 20, 30, 40);
    renderer.setScissor(1, 2, 3, 4);
    renderer.setScissorTest(true);
    renderer.setClearColor(0xff0000, 0.5);
    renderer.autoClear = false;

    const packed = packNormalizedDepth(0.5);
    (renderer as unknown as { _setPixel: (rgba: number[]) => void })._setPixel([
      packed.r,
      packed.g,
      packed.b,
      255,
    ]);

    await mesh.pick(new THREE.Vector2(0, 0), camera, renderer);

    expect(renderer.getRenderTarget()).toBeNull();
    expect(renderer.getScissorTest()).toBe(true);
    const vp = new THREE.Vector4();
    renderer.getViewport(vp);
    expect(vp.toArray()).toEqual([10, 20, 30, 40]);
    const sc = new THREE.Vector4();
    renderer.getScissor(sc);
    expect(sc.toArray()).toEqual([1, 2, 3, 4]);
    expect(renderer.getClearAlpha()).toBe(0.5);
    expect(renderer.autoClear).toBe(false);
  });

  it('sizes pick quads for the 1×1 target and restores the canvas viewport', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer(200, 100);
    const viewport = (mesh as unknown as { viewport: { value: THREE.Vector2 } }).viewport;
    const viewportDuringRender: number[][] = [];
    const packed = packNormalizedDepth(0.5);
    (renderer as unknown as { _setPixel: (rgba: number[]) => void })._setPixel([
      packed.r,
      packed.g,
      packed.b,
      255,
    ]);
    const originalRender = renderer.render;
    renderer.render = vi.fn((...args: Parameters<typeof originalRender>) => {
      viewportDuringRender.push(viewport.value.toArray());
      return originalRender(...args);
    });

    await mesh.pick(new THREE.Vector2(0, 0), camera, renderer);

    expect(viewportDuringRender).toEqual([[1, 1]]);
    expect(viewport.value.toArray()).toEqual([200, 100]);
  });

  it('restores renderer state when readback fails', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer();
    renderer.setClearColor(0x00ff00, 0.25);
    renderer.autoClear = false;
    vi.mocked(renderer.readRenderTargetPixelsAsync).mockRejectedValueOnce(new Error('read failed'));

    await expect(mesh.pick(new THREE.Vector2(0, 0), camera, renderer)).rejects.toThrow(
      'read failed',
    );
    expect(renderer.getRenderTarget()).toBeNull();
    expect(renderer.autoClear).toBe(false);
    expect(renderer.getClearAlpha()).toBe(0.25);
  });

  it('restores shared state before asynchronous readback completes', async () => {
    const mesh = createMesh();
    const parent = new THREE.Group();
    parent.add(mesh);
    const displayMaterial = mesh.material;
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer();
    renderer.autoClear = false;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(renderer.readRenderTargetPixelsAsync).mockImplementationOnce(async () => {
      await gate;
      return new Uint8Array([0, 0, 0, 0]);
    });

    const pendingPick = mesh.pick(new THREE.Vector2(0, 0), camera, renderer);
    await vi.waitFor(() => expect(renderer.readRenderTargetPixelsAsync).toHaveBeenCalledOnce());

    expect(renderer.getRenderTarget()).toBeNull();
    expect(renderer.autoClear).toBe(false);
    expect(mesh.parent).toBe(parent);
    expect(mesh.material).toBe(displayMaterial);
    expect(
      (mesh as unknown as { viewport: { value: THREE.Vector2 } }).viewport.value.toArray(),
    ).toEqual([200, 100]);

    release();
    await expect(pendingPick).resolves.toBeNull();
  });

  it('serializes concurrent pick requests', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    vi.mocked(renderer.readRenderTargetPixelsAsync).mockImplementation(async () => {
      reads += 1;
      if (reads === 1) await gate;
      const packed = packNormalizedDepth(0.5);
      return new Uint8Array([packed.r, packed.g, packed.b, 255]);
    });

    const first = mesh.pick(new THREE.Vector2(0, 0), camera, renderer);
    const second = mesh.pick(new THREE.Vector2(0.1, 0), camera, renderer);

    // Second must not have started its read while the first is gated.
    await Promise.resolve();
    expect(reads).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(reads).toBe(2);
  });

  it('returns null after dispose and disposes pick resources', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer();
    const packed = packNormalizedDepth(0.5);
    (renderer as unknown as { _setPixel: (rgba: number[]) => void })._setPixel([
      packed.r,
      packed.g,
      packed.b,
      255,
    ]);

    await mesh.pick(new THREE.Vector2(0, 0), camera, renderer);
    mesh.dispose();
    expect(await mesh.pick(new THREE.Vector2(0, 0), camera, renderer)).toBeNull();
  });

  it('resolves null when disposed while the readback is pending', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer();
    const packed = packNormalizedDepth(0.5);
    (renderer as unknown as { _setPixel: (rgba: number[]) => void })._setPixel([
      packed.r,
      packed.g,
      packed.b,
      255,
    ]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(renderer.readRenderTargetPixelsAsync).mockImplementationOnce(async () => {
      await gate;
      return new Uint8Array([packed.r, packed.g, packed.b, 255]);
    });

    const pending = mesh.pick(new THREE.Vector2(0, 0), camera, renderer);
    await vi.waitFor(() => expect(renderer.readRenderTargetPixelsAsync).toHaveBeenCalledOnce());
    mesh.dispose();
    release();
    // A hit was rasterized, but the mesh died first: a clean miss, not a stale hit.
    await expect(pending).resolves.toBeNull();
  });

  it('resolves null when dispose makes the pending readback reject', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer();

    let reject!: (error: Error) => void;
    vi.mocked(renderer.readRenderTargetPixelsAsync).mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );

    const pending = mesh.pick(new THREE.Vector2(0, 0), camera, renderer);
    await vi.waitFor(() => expect(renderer.readRenderTargetPixelsAsync).toHaveBeenCalledOnce());
    mesh.dispose(); // tears down the pick target the GPU was copying from
    reject(new Error('Destroyed buffer used in a submit'));
    await expect(pending).resolves.toBeNull();
  });

  it('picks in the orientation-corrected frame: y-up flips a PLY, source does not', async () => {
    const data = { ...makeSplatData(1), sourceFormat: 'ply' as const };
    const yUp = new SplatMesh(data);
    const source = new SplatMesh(data, { orientation: 'source' });
    meshes.push(yUp, source);
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer();

    await yUp.pick(new THREE.Vector2(0, 0), camera, renderer);
    await source.pick(new THREE.Vector2(0, 0), camera, renderer);

    const yUpProxy = (renderer.renderLog[0] as { scene: THREE.Scene }).scene.children[0]!;
    const sourceProxy = (renderer.renderLog[1] as { scene: THREE.Scene }).scene.children[0]!;
    // The 180°-X y-up flip is baked into the mesh matrix, so the pick proxy
    // must carry it too - a local (0, 1, 0) splat picks at world (0, -1, 0).
    const local = new THREE.Vector3(0, 1, 0);
    expect(local.clone().applyMatrix4(yUpProxy.matrixWorld).y).toBeCloseTo(-1, 6);
    expect(local.clone().applyMatrix4(sourceProxy.matrixWorld).y).toBeCloseTo(1, 6);
  });

  it('renders a proxy with the complete world transform without reparenting the mesh', async () => {
    const mesh = createMesh();
    const parent = new THREE.Group();
    parent.position.set(10, 2, -3);
    parent.add(mesh);
    mesh.position.set(1, 0, 0);
    parent.updateMatrixWorld(true);

    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(11, 2, 2);
    camera.lookAt(11, 2, -3);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer();

    const viewDepth = 5;
    const packed = packNormalizedDepth(normalizeViewDepth(viewDepth, camera.near, camera.far));
    (renderer as unknown as { _setPixel: (rgba: number[]) => void })._setPixel([
      packed.r,
      packed.g,
      packed.b,
      255,
    ]);

    const result = await mesh.pick(new THREE.Vector2(0, 0), camera, renderer);
    expect(result).not.toBeNull();
    expect(result!.point.x).toBeCloseTo(11, 3);
    expect(result!.point.y).toBeCloseTo(2, 3);
    expect(result!.point.z).toBeCloseTo(-3, 3);
    expect(mesh.parent).toBe(parent);

    const renderEntry = renderer.renderLog[0] as { scene: THREE.Scene };
    const proxy = renderEntry.scene.children[0]!;
    expect(proxy).not.toBe(mesh);
    expect(proxy.matrixWorld.elements).toEqual(mesh.matrixWorld.elements);
    expect(new THREE.Vector3().setFromMatrixPosition(proxy.matrixWorld).toArray()).toEqual([
      11, 2, -3,
    ]);
  });

  it('renders the selected pixel through a one-pixel target', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer(200, 100);

    await mesh.pick(new THREE.Vector2(0, 0), camera, renderer);

    const renderEntry = renderer.renderLog[0] as {
      target: THREE.RenderTarget;
      targetViewport: THREE.Vector4;
      targetScissor: THREE.Vector4;
    };
    expect(renderEntry.targetViewport.toArray()).toEqual([0, 0, 1, 1]);
    expect(renderEntry.targetScissor.toArray()).toEqual([0, 0, 1, 1]);
    expect(renderEntry.target.width).toBe(1);
    expect(renderEntry.target.height).toBe(1);
  });

  it('crops an off-center WebGL pick into the one-pixel target', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer(200, 100);
    // No `backend.isWebGPUBackend` on the mock → WebGL fallback conventions.

    // NDC y = +0.5 (upper half): bottom-left row = floor(0.75 · 100) = 75.
    await mesh.pick(new THREE.Vector2(0, 0.5), camera, renderer);

    const renderEntry = renderer.renderLog[0] as { camera: THREE.Camera };
    expect(renderEntry.camera).not.toBe(camera);
    // The center of the selected source pixel becomes the center of the 1×1
    // target. Use the exact pixel center because the requested NDC is quantized.
    const sourcePixelCenter = new THREE.Vector3(0.005, 0.51, 0).unproject(camera);
    const croppedNdc = sourcePixelCenter.project(renderEntry.camera);
    expect(croppedNdc.x).toBeCloseTo(0, 10);
    expect(croppedNdc.y).toBeCloseTo(0, 10);
    expect(renderer.readLog[0]).toEqual({ x: 0, y: 0 });
  });

  it('uses the same one-pixel readback coordinates on WebGPU', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const renderer = createMockRenderer(200, 100);
    (renderer as unknown as { backend: object }).backend = { isWebGPUBackend: true };

    await mesh.pick(new THREE.Vector2(0, 0.5), camera, renderer);

    expect(renderer.readLog[0]).toEqual({ x: 0, y: 0 });
  });

  it('keeps the pick target at one pixel when the drawing buffer size changes', async () => {
    const mesh = createMesh();
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);

    const rendererA = createMockRenderer(100, 50);
    const packed = packNormalizedDepth(0.5);
    (rendererA as unknown as { _setPixel: (rgba: number[]) => void })._setPixel([
      packed.r,
      packed.g,
      packed.b,
      255,
    ]);
    await mesh.pick(new THREE.Vector2(0, 0), camera, rendererA);

    const rendererB = createMockRenderer(400, 300);
    (rendererB as unknown as { _setPixel: (rgba: number[]) => void })._setPixel([
      packed.r,
      packed.g,
      packed.b,
      255,
    ]);
    await mesh.pick(new THREE.Vector2(0, 0), camera, rendererB);

    expect(rendererB.readLog[0]).toEqual({ x: 0, y: 0 });
    const renderEntry = rendererB.renderLog[0] as { target: THREE.RenderTarget };
    expect([renderEntry.target.width, renderEntry.target.height]).toEqual([1, 1]);
  });
});
