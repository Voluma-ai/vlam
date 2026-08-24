import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { StreamedSplatMesh } from '../streamed-splat-mesh';
import { packNormalizedDepth, normalizeViewDepth } from '../splat-depth-pack';
import { writeCovariance, type SplatData } from '../splat-data';

/**
 * E6 pick robustness on a StreamedSplatMesh: an empty pool (nothing resident
 * yet) is a clean miss, residency changing while a pick's readback is in
 * flight never corrupts or misattributes the result (a pick answers for the
 * residency it rasterized), and dispose during a pending pick resolves null.
 */

const WIDTH = 2048;

beforeAll(() => {
  if (typeof (globalThis as { Worker?: unknown }).Worker === 'undefined') {
    (globalThis as { Worker: unknown }).Worker = class {
      postMessage(): void {}
      terminate(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
      onmessage: unknown = null;
      onerror: unknown = null;
    };
  }
});

/** A chunk of splats laid on the x axis at (i, 0, 0). */
function makeChunk(count: number): SplatData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i;
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

function makeStreamedMesh(): StreamedSplatMesh {
  const scene = {
    source: { budget: 4 * WIDTH } as unknown,
    chunkUrls: [] as string[],
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: 4 * WIDTH,
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
  ) => StreamedSplatMesh;
  return new Ctor(scene, 4 * WIDTH, 4 * WIDTH, {});
}

type Internals = {
  cache: Map<number, { data: SplatData; bytes: number; lastUsed: number }>;
  appendRun: (run: unknown, now: number) => void;
  resident: Map<string, { run: unknown; handle: unknown }>;
};
function internals(mesh: StreamedSplatMesh): Internals {
  return mesh as unknown as Internals;
}
function run(file: number, offset: number, count: number): Record<string, number> {
  return { file, offset, count, leafStart: file, leafEnd: file + 1, level: 0 };
}

interface MockPickRenderer extends THREE.WebGPURenderer {
  renderLog: Array<{ scene: THREE.Scene; instanceCount: number }>;
  _setPixel(rgba: number[]): void;
}

/** The renderer surface a pick pass touches, plus streamed-upload stubs. */
function createMockRenderer(width = 200, height = 100): MockPickRenderer {
  const state = {
    target: null as THREE.RenderTarget | null,
    scissorTest: false,
    clearColor: new THREE.Color(),
    clearAlpha: 1,
    autoClear: true,
    pixel: new Uint8Array([0, 0, 0, 0]),
    renderLog: [] as Array<{ scene: THREE.Scene; instanceCount: number }>,
  };
  const renderer = {
    backend: { isWebGPUBackend: true },
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
    copyTextureToTexture: vi.fn(),
    compute: vi.fn(),
    render: vi.fn((scene: THREE.Scene) => {
      const proxy = scene.children[0] as THREE.Mesh | undefined;
      const geometry = proxy?.geometry as THREE.InstancedBufferGeometry | undefined;
      state.renderLog.push({ scene, instanceCount: geometry?.instanceCount ?? -1 });
    }),
    readRenderTargetPixelsAsync: vi.fn(async () => state.pixel.slice()),
    _setPixel: (rgba: number[]) => {
      state.pixel.set(rgba);
    },
    get renderLog() {
      return state.renderLog;
    },
  };
  return renderer as unknown as MockPickRenderer;
}

function makeCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function setHitDepth(renderer: MockPickRenderer, viewDepth: number, camera: THREE.Camera): void {
  const near = (camera as THREE.PerspectiveCamera).near;
  const far = (camera as THREE.PerspectiveCamera).far;
  const packed = packNormalizedDepth(normalizeViewDepth(viewDepth, near, far));
  renderer._setPixel([packed.r, packed.g, packed.b, 255]);
}

describe('StreamedSplatMesh.pick (E6)', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });
  function mesh(): StreamedSplatMesh {
    const m = makeStreamedMesh();
    meshes.push(m);
    return m;
  }

  it('misses cleanly on an empty pool (nothing resident yet)', async () => {
    const m = mesh();
    const renderer = createMockRenderer();
    setHitDepth(renderer, 5, makeCamera()); // a hit pixel that must never be read
    const result = await m.pick(new THREE.Vector2(0, 0), makeCamera(), renderer);
    expect(result).toBeNull();
    expect(renderer.render).not.toHaveBeenCalled();
    expect(renderer.readRenderTargetPixelsAsync).not.toHaveBeenCalled();
  });

  it('picks resident splats after a run streams in, with a valid instance count', async () => {
    const m = mesh();
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.appendRun(run(0, 0, 10), 0);

    const camera = makeCamera();
    const renderer = createMockRenderer();
    setHitDepth(renderer, 5, camera);
    const result = await m.pick(new THREE.Vector2(0, 0), camera, renderer);
    expect(result).not.toBeNull();
    expect(result!.distance).toBeCloseTo(5, 4);
    expect(renderer.renderLog[0]!.instanceCount).toBe(10);
  });

  it('keeps a pending pick valid across mid-stream residency changes', async () => {
    const m = mesh();
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.appendRun(run(0, 0, 10), 0);

    const camera = makeCamera();
    const renderer = createMockRenderer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const packed = packNormalizedDepth(normalizeViewDepth(5, camera.near, camera.far));
    vi.mocked(renderer.readRenderTargetPixelsAsync).mockImplementationOnce(async () => {
      await gate;
      return new Uint8Array([packed.r, packed.g, packed.b, 255]);
    });

    const pending = m.pick(new THREE.Vector2(0, 0), camera, renderer);
    await vi.waitFor(() => expect(renderer.readRenderTargetPixelsAsync).toHaveBeenCalledOnce());
    // The pick pass has rasterized the residency of its issue time. Now churn
    // the pool: the old run leaves and a different chunk becomes resident.
    inner.cache.set(1, { data: makeChunk(4), bytes: 0, lastUsed: 1 });
    inner.appendRun(run(1, 0, 4), 1);

    release();
    const result = await pending;
    // A world-space point on the rasterized splat plane - depth semantics, no
    // splat id to misattribute against the changed pool.
    expect(result).not.toBeNull();
    expect(result!.point.z).toBeCloseTo(0, 3);
    expect(result!.distance).toBeCloseTo(5, 4);
    // The pass rendered the pre-change residency, untouched by the churn.
    expect(renderer.renderLog[0]!.instanceCount).toBe(10);

    // A pick issued after the churn rasterizes the new residency.
    setHitDepth(renderer, 5, camera);
    await m.pick(new THREE.Vector2(0, 0), camera, renderer);
    expect(renderer.renderLog[1]!.instanceCount).toBe(14);
  });

  it('resolves null when every run is removed before the pick is issued', async () => {
    const m = mesh();
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.appendRun(run(0, 0, 10), 0);
    for (const entry of inner.resident.values()) {
      (m as unknown as { removeRange: (handle: unknown) => void }).removeRange(entry.handle);
    }
    inner.resident.clear();

    const renderer = createMockRenderer();
    setHitDepth(renderer, 5, makeCamera());
    expect(await m.pick(new THREE.Vector2(0, 0), makeCamera(), renderer)).toBeNull();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('resolves null when disposed while a pick readback is pending', async () => {
    const m = makeStreamedMesh(); // disposed inside the test
    const inner = internals(m);
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });
    inner.appendRun(run(0, 0, 10), 0);

    const camera = makeCamera();
    const renderer = createMockRenderer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const packed = packNormalizedDepth(normalizeViewDepth(5, camera.near, camera.far));
    vi.mocked(renderer.readRenderTargetPixelsAsync).mockImplementationOnce(async () => {
      await gate;
      return new Uint8Array([packed.r, packed.g, packed.b, 255]);
    });

    const pending = m.pick(new THREE.Vector2(0, 0), camera, renderer);
    await vi.waitFor(() => expect(renderer.readRenderTargetPixelsAsync).toHaveBeenCalledOnce());
    m.dispose();
    release();
    await expect(pending).resolves.toBeNull();
  });
});
