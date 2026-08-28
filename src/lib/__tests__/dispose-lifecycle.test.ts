import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { writeCovariance, type SplatData } from '../splat-data';

/**
 * E8 - dispose / GPU / worker lifetime audit.
 *
 * Verifies that every major class survives double dispose, that dispose during
 * an in-flight update/sort neither throws nor uploads to the GPU afterwards,
 * and that a scene-swap loop (create → load-ish → dispose × N) terminates every
 * worker it spawned and retains nothing.
 */

/** Tracks every inline worker the library spawns, so tests can assert termination. */
class TrackingWorker {
  static created: TrackingWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;

  constructor() {
    TrackingWorker.created.push(this);
  }

  postMessage(message: unknown): void {
    if (this.terminated) throw new Error('postMessage on a terminated worker');
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

vi.mock('../sort-worker?worker&inline', () => ({ default: TrackingWorker }));
vi.mock('../load-worker?worker&inline', () => ({ default: TrackingWorker }));
vi.mock('../one-shot-worker?worker&inline', () => ({ default: TrackingWorker }));

// Imported after the mocks so every spawned worker is a TrackingWorker.
const { SplatMesh } = await import('../splat-mesh');
const { StreamedSplatMesh } = await import('../streamed-splat-mesh');
const { WorkerSorter } = await import('../worker-sorter');
const { UnifiedSplatMesh } = await import('../unified-splat-mesh');

const WIDTH = 2048;

function makeData(count: number): SplatData {
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

function mockWebGPURenderer(extras: Record<string, unknown> = {}): THREE.WebGPURenderer {
  return {
    compute: vi.fn(),
    copyTextureToTexture: vi.fn(),
    getDrawingBufferSize: (out: THREE.Vector2) => out.set(800, 600),
    backend: { isWebGPUBackend: true },
    _attributes: { delete: vi.fn() },
    ...extras,
  } as unknown as THREE.WebGPURenderer;
}

function mockWebGLRenderer(): THREE.WebGPURenderer {
  return {
    compute: vi.fn(),
    copyTextureToTexture: vi.fn(),
    getDrawingBufferSize: (out: THREE.Vector2) => out.set(800, 600),
    backend: {},
  } as unknown as THREE.WebGPURenderer;
}

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.position.set(0, 0, 5);
camera.updateMatrixWorld(true);

type StreamedMesh = import('../streamed-splat-mesh').StreamedSplatMesh;

/** StreamedSplatMesh via the private constructor over a stub scene (as other tests do). */
function makeStreamedMesh(): StreamedMesh {
  const scene = {
    source: {
      budget: 4 * WIDTH,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => [],
      coarsestRunsFor: () => [],
    } as unknown,
    chunkUrls: ['https://host/chunk-0/'],
    chunkKind: 'directory' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: 4 * WIDTH,
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
  ) => StreamedMesh;
  return new Ctor(scene, 4 * WIDTH, 4 * WIDTH, {});
}

describe('SplatMesh dispose lifecycle', () => {
  it('double dispose is safe and disposes the sorter exactly once', () => {
    const mesh = new SplatMesh(makeData(4));
    const sorterDispose = vi.fn();
    (mesh as unknown as { sorter: unknown }).sorter = {
      kind: 'counting',
      sort: vi.fn(() => true),
      dispose: sorterDispose,
    };
    expect(() => {
      mesh.dispose();
      mesh.dispose();
    }).not.toThrow();
    expect(sorterDispose).toHaveBeenCalledTimes(1);
  });

  it('update after dispose is a no-op: no GPU uploads, no compute submits', () => {
    const renderer = mockWebGPURenderer();
    const mesh = new SplatMesh(makeData(4));
    mesh.update(camera, renderer);
    mesh.dispose();
    const compute = renderer.compute as ReturnType<typeof vi.fn>;
    const copy = renderer.copyTextureToTexture as ReturnType<typeof vi.fn>;
    compute.mockClear();
    copy.mockClear();
    expect(() => mesh.update(camera, renderer)).not.toThrow();
    expect(() => mesh.renderView(camera, renderer)).not.toThrow();
    expect(compute).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it('releases the sourceIndex storage buffer through the last renderer', () => {
    const renderer = mockWebGPURenderer();
    const mesh = new SplatMesh(makeData(4));
    mesh.update(camera, renderer);
    mesh.dispose();
    const deleted = (
      renderer as unknown as { _attributes: { delete: ReturnType<typeof vi.fn> } }
    )._attributes.delete.mock.calls.map((call: unknown[]) => call[0]);
    expect(deleted).toContain(
      (mesh as unknown as { sourceIndexAttribute: object }).sourceIndexAttribute,
    );
  });

  it('resolves pick as null after dispose', async () => {
    const renderer = mockWebGPURenderer();
    const mesh = new SplatMesh(makeData(4));
    mesh.dispose();
    await expect(mesh.pick(new THREE.Vector2(0, 0), camera, renderer)).resolves.toBeNull();
  });
});

describe('WorkerSorter dispose lifecycle (WebGL2 fallback)', () => {
  function makeHost() {
    const splatIndexAttribute = new THREE.InstancedBufferAttribute(new Float32Array(8), 1);
    return {
      capacity: 8,
      rowWidth: 4,
      centers: new Float32Array(8 * 4),
      splatIndexAttribute,
      takeDirtyRows: () => [],
      getActiveSpans: () => new Uint32Array([0, 8]),
    };
  }

  it('terminates its worker on dispose, twice safely', () => {
    const before = TrackingWorker.created.length;
    const sorter = new WorkerSorter(makeHost());
    const worker = TrackingWorker.created[before]!;
    sorter.dispose();
    sorter.dispose();
    expect(worker.terminated).toBe(true);
  });

  it('drops an order that lands after dispose - no post-dispose draw-list upload', () => {
    const before = TrackingWorker.created.length;
    const host = makeHost();
    const sorter = new WorkerSorter(host);
    const worker = TrackingWorker.created[before]!;
    sorter.sort(new THREE.Matrix4(), 8, new THREE.Sphere());
    sorter.dispose();
    const versionBefore = host.splatIndexAttribute.version;
    // A message already dispatched when terminate ran still delivers.
    expect(() => worker.emit({ order: new Uint32Array([7, 6, 5, 4, 3, 2, 1, 0]) })).not.toThrow();
    expect(host.splatIndexAttribute.version).toBe(versionBefore);
    expect((host.splatIndexAttribute.array as Float32Array)[0]).toBe(0);
  });

  it('declines sorts after dispose instead of posting to the dead worker', () => {
    const sorter = new WorkerSorter(makeHost());
    sorter.dispose();
    expect(sorter.sort(new THREE.Matrix4(), 8, new THREE.Sphere())).toBe(false);
  });

  it('mesh dispose on the WebGL2 path terminates the sort worker', () => {
    const renderer = mockWebGLRenderer();
    const mesh = new SplatMesh(makeData(4));
    const before = TrackingWorker.created.length;
    // Force a camera-moved sort so the worker sorter is created.
    mesh.update(camera, renderer);
    const spawned = TrackingWorker.created.slice(before);
    expect(spawned.length).toBeGreaterThan(0);
    mesh.dispose();
    for (const worker of spawned) expect(worker.terminated).toBe(true);
  });
});

describe('StreamedSplatMesh dispose lifecycle', () => {
  type Internals = {
    cache: Map<number, { data: SplatData; bytes: number; lastUsed: number }>;
    resident: Map<string, unknown>;
    fetching: Map<number, AbortController>;
    reschedule: (camera: THREE.PerspectiveCamera, now: number) => unknown;
  };

  it('double dispose is safe and clears retained chunk state', () => {
    const mesh = makeStreamedMesh();
    const inner = mesh as unknown as Internals;
    inner.cache.set(0, { data: makeData(16), bytes: 1024, lastUsed: 0 });
    expect(() => {
      mesh.dispose();
      mesh.dispose();
    }).not.toThrow();
    expect(inner.cache.size).toBe(0);
    expect(inner.resident.size).toBe(0);
    expect(inner.fetching.size).toBe(0);
  });

  it('scene-swap loop leaves no live workers or retained chunk state', () => {
    const before = TrackingWorker.created.length;
    for (let cycle = 0; cycle < 5; cycle++) {
      const mesh = makeStreamedMesh();
      const inner = mesh as unknown as Internals;
      inner.cache.set(0, { data: makeData(64), bytes: 4096, lastUsed: 0 });
      inner.reschedule(camera, cycle);
      mesh.update(camera, mockWebGPURenderer());
      mesh.dispose();
      expect(inner.cache.size).toBe(0);
      expect(inner.resident.size).toBe(0);
    }
    const spawned = TrackingWorker.created.slice(before);
    expect(spawned.length).toBeGreaterThanOrEqual(5); // one ChunkLoader worker per mesh
    for (const worker of spawned) expect(worker.terminated).toBe(true);
  });

  it('a chunk resolving after dispose is dropped without touching the cache', async () => {
    const mesh = makeStreamedMesh();
    let resolveLoad!: (data: SplatData) => void;
    (mesh as unknown as { loader: { load: () => Promise<SplatData> } }).loader.load = () =>
      new Promise<SplatData>((resolve) => {
        resolveLoad = resolve;
      });
    (mesh as unknown as { requestChunk: (file: number, kind: string) => void }).requestChunk(
      0,
      'base',
    );
    const inner = mesh as unknown as Internals;
    expect(inner.fetching.size).toBe(1);
    mesh.dispose();
    resolveLoad(makeData(8));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inner.cache.size).toBe(0);
  });
});

describe('UnifiedSplatMesh dispose lifecycle', () => {
  function makeUnified() {
    const renderer = mockWebGPURenderer();
    const unified = new UnifiedSplatMesh(renderer, 4);
    const source = new SplatMesh(makeData(1));
    unified.addSource(source);
    return { renderer, unified, source };
  }

  it('double dispose is safe and update/renderView become no-ops', () => {
    const { renderer, unified, source } = makeUnified();
    unified.update(camera);
    expect(() => {
      unified.dispose();
      unified.dispose();
    }).not.toThrow();
    const compute = renderer.compute as ReturnType<typeof vi.fn>;
    compute.mockClear();
    expect(() => unified.update(camera)).not.toThrow();
    expect(compute).not.toHaveBeenCalled();
    source.dispose();
  });

  it('releases the work buffer, source index and order storage buffers', () => {
    const { renderer, unified, source } = makeUnified();
    unified.dispose();
    const deletes = (
      renderer as unknown as { _attributes: { delete: ReturnType<typeof vi.fn> } }
    )._attributes.delete.mock.calls.map((call: unknown[]) => call[0]);
    const inner = unified as unknown as {
      workBuffer: {
        centers: object;
        colors: object;
        covarianceA: object;
        covarianceB: object;
        isotropicMix: object;
        isotropicScreenRadius: object;
      };
      workSourceIndex: object;
      orderAttribute: object;
    };
    for (const attribute of [
      inner.workBuffer.centers,
      inner.workBuffer.colors,
      inner.workBuffer.covarianceA,
      inner.workBuffer.covarianceB,
      inner.workBuffer.isotropicMix,
      inner.workBuffer.isotropicScreenRadius,
      inner.workSourceIndex,
      inner.orderAttribute,
    ]) {
      expect(deletes).toContain(attribute);
    }
    source.dispose();
  });

  it('resolves pick as null when disposed', async () => {
    const { unified, source } = makeUnified();
    unified.dispose();
    await expect(unified.pick(new THREE.Vector2(0, 0), camera)).resolves.toBeNull();
    source.dispose();
  });
});
