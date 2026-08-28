import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { packNormalizedDepth, normalizeViewDepth } from '../splat-depth-pack';
import { writeCovariance } from '../splat-data';
import { SplatMesh } from '../splat-mesh';
import { UnifiedSplatMesh } from '../unified-splat-mesh';

/**
 * E6 unified multi-source picking semantics: every visible source runs its own
 * pick pass, the hit nearest the camera wins, the result names its source,
 * hidden sources never hit, and hits whose source left the renderer while the
 * readback was in flight are dropped.
 */

function source(): SplatMesh {
  const covariance = new Float32Array(6);
  writeCovariance(covariance, 0, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  return new SplatMesh({
    count: 1,
    positions: new Float32Array(3),
    colors: new Uint8Array([255, 255, 255, 255]),
    covariances: covariance,
  });
}

type PickMockRenderer = THREE.WebGPURenderer & {
  render: ReturnType<typeof vi.fn>;
  readRenderTargetPixelsAsync: ReturnType<typeof vi.fn>;
  /** Queued per-readback pixels, consumed in pick-issue (registration) order. */
  queuePixels(...pixels: (Uint8Array | (() => Promise<Uint8Array>))[]): void;
};

/** Mock covering unified construction (compute/copy) plus the pick surface. */
function mockRenderer(width = 200, height = 100): PickMockRenderer {
  const state = {
    target: null as THREE.RenderTarget | null,
    scissorTest: false,
    clearColor: new THREE.Color(),
    clearAlpha: 1,
    autoClear: true,
    queue: [] as (Uint8Array | (() => Promise<Uint8Array>))[],
  };
  const renderer = {
    backend: { isWebGPUBackend: true },
    compute: vi.fn(),
    copyTextureToTexture: vi.fn(),
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
    getClearColor: (target: THREE.Color) => target.copy(state.clearColor),
    setClearColor: (color: THREE.ColorRepresentation, alpha = 1) => {
      state.clearColor.set(color);
      state.clearAlpha = alpha;
    },
    getClearAlpha: () => state.clearAlpha,
    clear: vi.fn(),
    render: vi.fn(),
    readRenderTargetPixelsAsync: vi.fn(async () => {
      const next = state.queue.shift();
      if (next === undefined) return new Uint8Array([0, 0, 0, 0]);
      return typeof next === 'function' ? next() : next;
    }),
    queuePixels: (...pixels: (Uint8Array | (() => Promise<Uint8Array>))[]) => {
      state.queue.push(...pixels);
    },
  };
  return renderer as unknown as PickMockRenderer;
}

function makeCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function hitPixel(viewDepth: number, camera: THREE.PerspectiveCamera): Uint8Array {
  const packed = packNormalizedDepth(normalizeViewDepth(viewDepth, camera.near, camera.far));
  return new Uint8Array([packed.r, packed.g, packed.b, 255]);
}

const MISS = new Uint8Array([0, 0, 0, 0]);

describe('UnifiedSplatMesh.pick (E6)', () => {
  it('returns null with no sources registered', async () => {
    const renderer = mockRenderer();
    const unified = new UnifiedSplatMesh(renderer, 4);
    expect(await unified.pick(new THREE.Vector2(0, 0), makeCamera())).toBeNull();
    unified.dispose();
  });

  it('nearest hit wins across sources and identifies its source mesh', async () => {
    const renderer = mockRenderer();
    const camera = makeCamera();
    const near = source();
    const far = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    unified.addSource(near);
    unified.addSource(far);
    // Readbacks resolve in registration order: near at depth 2, far at depth 6.
    renderer.queuePixels(hitPixel(2, camera), hitPixel(6, camera));

    const result = await unified.pick(new THREE.Vector2(0, 0), camera);
    expect(result).not.toBeNull();
    expect(result!.source).toBe(near);
    expect(result!.distance).toBeCloseTo(2, 4);
    expect(result!.point.z).toBeCloseTo(3, 3); // camera z=5 minus depth 2

    unified.dispose();
    near.dispose();
    far.dispose();
  });

  it('misses on one source fall through to a hit on another', async () => {
    const renderer = mockRenderer();
    const camera = makeCamera();
    const a = source();
    const b = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    unified.addSource(a);
    unified.addSource(b);
    renderer.queuePixels(MISS, hitPixel(4, camera));

    const result = await unified.pick(new THREE.Vector2(0, 0), camera);
    expect(result!.source).toBe(b);
    expect(result!.distance).toBeCloseTo(4, 4);

    unified.dispose();
    a.dispose();
    b.dispose();
  });

  it('returns null when every source misses', async () => {
    const renderer = mockRenderer();
    const camera = makeCamera();
    const a = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    unified.addSource(a);
    renderer.queuePixels(MISS);
    expect(await unified.pick(new THREE.Vector2(0, 0), camera)).toBeNull();
    unified.dispose();
    a.dispose();
  });

  it('never picks a hidden source, even if it would be nearest', async () => {
    const renderer = mockRenderer();
    const camera = makeCamera();
    const hidden = source();
    const visible = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    unified.addSource(hidden);
    unified.addSource(visible);
    unified.setSourceVisible(hidden, false);
    // Only the visible source is picked at all: one readback, one render.
    renderer.queuePixels(hitPixel(6, camera));

    const result = await unified.pick(new THREE.Vector2(0, 0), camera);
    expect(result!.source).toBe(visible);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(renderer.readRenderTargetPixelsAsync).toHaveBeenCalledTimes(1);

    unified.dispose();
    hidden.dispose();
    visible.dispose();
  });

  it('drops a hit whose source was removed while its readback was in flight', async () => {
    const renderer = mockRenderer();
    const camera = makeCamera();
    const near = source();
    const far = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    unified.addSource(near);
    unified.addSource(far);

    let releaseNear!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseNear = resolve;
    });
    renderer.queuePixels(
      async () => {
        await gate;
        return hitPixel(2, camera);
      },
      hitPixel(6, camera),
    );

    const pending = unified.pick(new THREE.Vector2(0, 0), camera);
    await vi.waitFor(() => expect(renderer.readRenderTargetPixelsAsync).toHaveBeenCalledTimes(2));
    unified.removeSource(near);
    releaseNear();

    // The nearer hit belongs to a source no longer in the renderer: dropped,
    // never misattributed. The remaining source wins.
    const result = await pending;
    expect(result!.source).toBe(far);
    expect(result!.distance).toBeCloseTo(6, 4);

    unified.dispose();
    near.dispose();
    far.dispose();
  });

  it('resolves null when disposed while picks are pending', async () => {
    const renderer = mockRenderer();
    const camera = makeCamera();
    const mesh = source();
    const unified = new UnifiedSplatMesh(renderer, 4);
    unified.addSource(mesh);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderer.queuePixels(async () => {
      await gate;
      return hitPixel(2, camera);
    });

    const pending = unified.pick(new THREE.Vector2(0, 0), camera);
    await vi.waitFor(() => expect(renderer.readRenderTargetPixelsAsync).toHaveBeenCalledOnce());
    unified.dispose();
    release();
    await expect(pending).resolves.toBeNull();

    expect(await unified.pick(new THREE.Vector2(0, 0), camera)).toBeNull();
    mesh.dispose();
  });
});
