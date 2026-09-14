import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplatMesh } from '../core/splat-mesh';
import { MergedSplatMesh } from '../core/merged-splat-mesh';
import { writeCovariance } from '../core/splat-data';
import type { SortWorkerRequest, OrderMessage, SortMessage } from '../core/sort-worker';
import type { SplatSorter } from '../core/sorter';

/**
 * Deterministic reproductions of the WebGL2 CPU-worker sort races behind the
 * streamed-scene flicker (ROADMAP L5). The inlined sort
 * worker is replaced with a controllable fake so tests can observe exactly
 * what the mesh sends and deliver order replies at chosen moments, replaying
 * each race without a browser.
 */

const workers = vi.hoisted(() => {
  class FakeSortWorker {
    static instances: FakeSortWorker[] = [];
    onmessage: ((event: { data: OrderMessage }) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: unknown = null;
    posted: SortWorkerRequest[] = [];
    constructor() {
      FakeSortWorker.instances.push(this);
    }
    postMessage(message: SortWorkerRequest): void {
      this.posted.push(message);
    }
    terminate(): void {}
    /** Delivers a back-to-front order reply, as the real worker would. */
    reply(order: Uint32Array): void {
      const requestId = this.sortMessages().at(-1)?.requestId ?? 0;
      this.onmessage?.({ data: { type: 'order', requestId, order } });
    }
    sortMessages(): SortMessage[] {
      return this.posted.filter((m): m is SortMessage => m.type === 'sort');
    }
    fail(): void {
      this.onerror?.({ message: 'simulated worker failure' } as ErrorEvent);
    }
  }
  return { FakeSortWorker };
});

vi.mock('../core/sort-worker?worker&inline', () => ({ default: workers.FakeSortWorker }));

interface Internals {
  activeCount: number;
  sorter: SplatSorter | null;
  splatIndexAttribute: THREE.InstancedBufferAttribute;
  rebuildActiveList(): void;
  requestSortIfNeeded(camera: THREE.Camera, renderer: THREE.WebGPURenderer): void;
  workerPublicationEnabled: boolean;
  prepareWorkerPublication(renderer: THREE.WebGPURenderer): void;
  geometry: THREE.InstancedBufferGeometry;
}

class TestMesh extends SplatMesh {
  activate(handle: ReturnType<SplatMesh['appendRange']>, active: boolean): void {
    this.setRangeActive(handle, active);
  }
  activatePrefix(handle: ReturnType<SplatMesh['appendRange']>, prefix: number): void {
    this.setRangeActivePrefix(handle, prefix);
  }
}

function makeSplatData(count: number): {
  count: number;
  positions: Float32Array;
  colors: Uint8Array;
  covariances: Float32Array;
} {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3 + 2] = i; // distinct depths
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

function internals(mesh: SplatMesh): Internals {
  return mesh as unknown as Internals;
}

function webglRenderer(): THREE.WebGPURenderer {
  return {
    backend: { isWebGPUBackend: false },
    copyTextureToTexture: vi.fn(),
  } as unknown as THREE.WebGPURenderer;
}

function publish(mesh: SplatMesh): void {
  const state = internals(mesh);
  state.workerPublicationEnabled = true;
  state.prepareWorkerPublication(webglRenderer());
}

function cameraAt(x: number): THREE.Camera {
  const camera = new THREE.Camera();
  camera.matrixWorldInverse.makeTranslation(-x, 0, 0);
  return camera;
}

function lastWorker(): InstanceType<typeof workers.FakeSortWorker> {
  const instance = workers.FakeSortWorker.instances.at(-1);
  if (!instance) throw new Error('no sort worker constructed');
  return instance;
}

function spanTotal(message: SortMessage): number {
  let total = 0;
  for (let i = 0; i < message.spans.length; i += 2) total += message.spans[i + 1] as number;
  return total;
}

function timingSnapshot(mesh: SplatMesh): {
  submittedCount: number;
  completedCount: number;
  lastLatencyMs: number;
} {
  const sorter = internals(mesh).sorter as SplatSorter & {
    snapshot(): { submittedCount: number; completedCount: number; lastLatencyMs: number };
  };
  return sorter.snapshot();
}

describe('WorkerSorter / active-list race regressions', () => {
  const meshes: SplatMesh[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
    workers.FakeSortWorker.instances.length = 0;
  });

  function meshWith(counts: number[]): {
    mesh: TestMesh;
    handles: ReturnType<SplatMesh['appendRange']>[];
  } {
    const mesh = new TestMesh({ capacity: 8192 });
    meshes.push(mesh);
    const handles = counts.map((count) => mesh.appendRange(makeSplatData(count)));
    internals(mesh).rebuildActiveList();
    return { mesh, handles };
  }

  it('reports accepted and completed sort timing for XR diagnostics', () => {
    const { mesh } = meshWith([16]);
    internals(mesh).requestSortIfNeeded(cameraAt(1), webglRenderer());
    expect(timingSnapshot(mesh)).toMatchObject({ submittedCount: 1, completedCount: 0 });

    lastWorker().reply(Uint32Array.from({ length: 16 }, (_, index) => index));
    const completed = timingSnapshot(mesh);
    expect(completed).toMatchObject({ submittedCount: 1, completedCount: 1 });
    expect(completed.lastLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends only the active prefix of a partially activated range to the worker', () => {
    const { mesh, handles } = meshWith([64]);
    mesh.activatePrefix(handles[0]!, 16);
    expect(internals(mesh).activeCount).toBe(16);

    internals(mesh).requestSortIfNeeded(cameraAt(1), webglRenderer());
    const sorts = lastWorker().sortMessages();
    expect(sorts).toHaveLength(1);
    // Before the fix the spans covered the whole 64-splat slab, so the worker
    // returned an order longer than the active list, drawing the inactive
    // page-table tail in place of live splats.
    expect(spanTotal(sorts[0]!)).toBe(16);
  });

  it('keeps the active prefix across a full active-list rebuild', () => {
    const { mesh, handles } = meshWith([64]);
    mesh.activatePrefix(handles[0]!, 16);
    internals(mesh).rebuildActiveList();
    // Before the fix the rebuild re-activated the whole slab (64).
    expect(internals(mesh).activeCount).toBe(16);
  });

  it('re-sorts on WebGL2 after a content swap even with a stationary camera', () => {
    const { mesh } = meshWith([4]);
    const camera = cameraAt(1);
    internals(mesh).requestSortIfNeeded(camera, webglRenderer());
    const worker = lastWorker();
    expect(worker.sortMessages()).toHaveLength(1);
    worker.reply(Uint32Array.from([3, 2, 1, 0]));

    // Streaming swap under an unmoved camera: the draw list is reset to
    // unsorted active order and must be re-sorted, or the scene renders with
    // broken blend order until the camera next moves.
    mesh.appendRange(makeSplatData(2));
    internals(mesh).rebuildActiveList();
    // A completed snapshot remains visible until render preparation publishes
    // it; only then may the next snapshot begin.
    publish(mesh);
    internals(mesh).requestSortIfNeeded(camera, webglRenderer());
    expect(worker.sortMessages()).toHaveLength(2);
  });

  it('keeps the draw list a permutation of the active set when a range leaves mid-sort-cycle', () => {
    const { mesh, handles } = meshWith([3, 3]);
    internals(mesh).requestSortIfNeeded(cameraAt(1), webglRenderer());
    const worker = lastWorker();
    const sort = worker.sortMessages()[0]!;
    // Pool indices of the two row-aligned ranges, back-to-front (reversed).
    const active: number[] = [];
    for (let i = 0; i < sort.spans.length; i += 2) {
      const start = sort.spans[i] as number;
      for (let j = 0; j < (sort.spans[i + 1] as number); j++) active.push(start + j);
    }
    worker.reply(Uint32Array.from(active.slice().reverse()));

    // Remove the second range while the draw list holds that permutation.
    mesh.activate(handles[1]!, false);
    const count = internals(mesh).activeCount;
    expect(count).toBe(3);
    const draw = Array.from(
      (internals(mesh).splatIndexAttribute.array as Float32Array).subarray(0, count),
    );
    // Before the fix the drawn prefix still held the removed range's pool
    // indices (the tail of the old permutation): removed splats rendered,
    // live ones vanished, until the next worker order landed.
    expect(new Set(draw)).toEqual(new Set(active.slice(0, 3)));
  });

  it('uploads the whole applied order even when narrow update ranges are pending', () => {
    const { mesh } = meshWith([4]);
    internals(mesh).requestSortIfNeeded(cameraAt(1), webglRenderer());
    const worker = lastWorker();
    const attribute = internals(mesh).splatIndexAttribute;
    // Simulate the renderer having flushed (and cleared) earlier ranges.
    attribute.clearUpdateRanges();
    worker.reply(Uint32Array.from([3, 2, 1, 0]));

    // The reply only queues a publication: no changed draw range can escape
    // before its matching pool rows are ready.
    expect(attribute.updateRanges).toHaveLength(0);
    publish(mesh);
    // Publication uploads the whole permutation, never a stale narrow range.
    const covering = attribute.updateRanges.some((range) => range.start === 0 && range.count >= 4);
    expect(covering).toBe(true);
  });

  it('keeps the published data, order, and count intact while a replacement waits', () => {
    const { mesh, handles } = meshWith([3]);
    const camera = cameraAt(1);
    const state = internals(mesh);
    state.workerPublicationEnabled = true;
    state.requestSortIfNeeded(camera, webglRenderer());
    const worker = lastWorker();
    worker.reply(Uint32Array.from([2, 1, 0]));
    publish(mesh);
    const publishedOrder = Array.from(
      (state.splatIndexAttribute.array as Float32Array).subarray(0, 3),
    );
    const publishedCount = state.geometry.instanceCount;

    // Reuse the same row-aligned slots: this is the RAD replacement case that
    // cannot be identified by comparing active ranges alone.
    mesh.removeRange(handles[0]!);
    mesh.appendRange(makeSplatData(3));
    state.rebuildActiveList();
    state.requestSortIfNeeded(camera, webglRenderer());
    expect(worker.sortMessages()).toHaveLength(2);
    expect(Array.from((state.splatIndexAttribute.array as Float32Array).subarray(0, 3))).toEqual(
      publishedOrder,
    );
    expect(state.geometry.instanceCount).toBe(publishedCount);

    worker.reply(Uint32Array.from([2, 1, 0]));
    publish(mesh);
    expect(state.geometry.instanceCount).toBe(3);
  });

  it('restores failed snapshot coverage and retries without dropping the published view', () => {
    const { mesh } = meshWith([3]);
    const camera = cameraAt(1);
    const state = internals(mesh);
    state.workerPublicationEnabled = true;
    state.requestSortIfNeeded(camera, webglRenderer());
    const worker = lastWorker();
    worker.reply(Uint32Array.from([2, 1, 0]));
    publish(mesh);
    const previous = Array.from((state.splatIndexAttribute.array as Float32Array).subarray(0, 3));

    mesh.appendRange(makeSplatData(2));
    state.rebuildActiveList();
    state.requestSortIfNeeded(camera, webglRenderer());
    worker.fail();
    expect(Array.from((state.splatIndexAttribute.array as Float32Array).subarray(0, 3))).toEqual(
      previous,
    );
    state.requestSortIfNeeded(camera, webglRenderer());
    expect(worker.sortMessages()).toHaveLength(3);
  });

  it('publishes a channel edit without camera movement', () => {
    const { mesh, handles } = meshWith([3]);
    mesh.defineChannel('paint');
    const state = internals(mesh);
    const camera = cameraAt(1);
    state.workerPublicationEnabled = true;
    state.requestSortIfNeeded(camera, webglRenderer());
    const worker = lastWorker();
    worker.reply(Uint32Array.from([2, 1, 0]));
    publish(mesh);

    mesh.writeChannel(handles[0]!, 'paint', [1, 1, 1]);
    state.requestSortIfNeeded(camera, webglRenderer());
    expect(worker.sortMessages()).toHaveLength(2);
    expect(worker.sortMessages()[1]?.indices).toEqual(Uint32Array.from([0, 1, 2]));
  });

  it('sends source IDs with captured center rows after adding a merged source', () => {
    const mesh = new MergedSplatMesh({ capacity: 8192 });
    meshes.push(mesh);
    mesh.addSource(makeSplatData(3));
    const state = internals(mesh);
    const camera = cameraAt(1);
    state.workerPublicationEnabled = true;
    state.requestSortIfNeeded(camera, webglRenderer());
    const worker = lastWorker();
    worker.reply(Uint32Array.from([2, 1, 0]));
    publish(mesh);

    const before = worker.posted.length;
    mesh.addSource(makeSplatData(3), new THREE.Matrix4().makeTranslation(0, 0, 10));
    state.requestSortIfNeeded(camera, webglRenderer());
    const writes = worker.posted.slice(before).filter((message) => message.type === 'write');
    expect(writes.some((message) => message.sourceIds?.includes(1))).toBe(true);
  });

  it('uploads worker-configured sources when unified rendering owns sorting', () => {
    const mesh = new SplatMesh({ capacity: 4096 }, { sortStrategy: 'worker' });
    meshes.push(mesh);
    mesh.appendRange(makeSplatData(3));
    mesh.setUnifiedPickVisibility(true);
    const copy = vi.fn();
    const renderer = {
      backend: { isWebGPUBackend: true },
      copyTextureToTexture: copy,
      getDrawingBufferSize: (size: THREE.Vector2) => size.set(800, 600),
    } as unknown as THREE.WebGPURenderer;
    mesh.update(new THREE.PerspectiveCamera(), renderer, { sort: false });
    expect(copy).toHaveBeenCalled();
    expect(internals(mesh).workerPublicationEnabled).toBe(false);
  });

  it('releases an in-flight standalone snapshot when unified rendering takes over', () => {
    const mesh = new SplatMesh({ capacity: 4096 }, { sortStrategy: 'worker' });
    meshes.push(mesh);
    mesh.appendRange(makeSplatData(3));
    const state = internals(mesh);
    state.workerPublicationEnabled = true;
    state.requestSortIfNeeded(cameraAt(1), webglRenderer());
    const worker = lastWorker();
    mesh.setUnifiedPickVisibility(true);
    const copy = vi.fn();
    const renderer = {
      backend: { isWebGPUBackend: true },
      copyTextureToTexture: copy,
      getDrawingBufferSize: (size: THREE.Vector2) => size.set(800, 600),
    } as unknown as THREE.WebGPURenderer;
    mesh.update(new THREE.PerspectiveCamera(), renderer, { sort: false });
    expect(copy).toHaveBeenCalled();
    expect(state.workerPublicationEnabled).toBe(false);
    worker.reply(Uint32Array.from([2, 1, 0]));
    expect(state.geometry.instanceCount).toBe(3);
  });

  it('keeps the standalone worker boundary while XR skips a sort', () => {
    const mesh = new SplatMesh({ capacity: 4096 });
    meshes.push(mesh);
    mesh.appendRange(makeSplatData(3));
    const renderer = {
      backend: { isWebGPUBackend: false },
      copyTextureToTexture: vi.fn(),
      getDrawingBufferSize: (size: THREE.Vector2) => size.set(800, 600),
    } as unknown as THREE.WebGPURenderer;
    mesh.update(new THREE.PerspectiveCamera(), renderer);
    expect(lastWorker().sortMessages()).toHaveLength(1);
    mesh.update(new THREE.PerspectiveCamera(), renderer, { sort: false });
    expect(internals(mesh).workerPublicationEnabled).toBe(true);
    expect(internals(mesh).geometry.instanceCount).toBe(0);
    expect(lastWorker().sortMessages()).toHaveLength(1);
  });

  it('drops a worker order computed against an outdated active set', () => {
    const { mesh } = meshWith([4]);
    internals(mesh).requestSortIfNeeded(cameraAt(1), webglRenderer());
    const worker = lastWorker();

    // The active set changes while the sort is in flight.
    mesh.appendRange(makeSplatData(2));
    internals(mesh).rebuildActiveList();
    const before = Array.from(
      (internals(mesh).splatIndexAttribute.array as Float32Array).subarray(0, 6),
    );
    worker.reply(Uint32Array.from([3, 2, 1, 0]));
    const after = Array.from(
      (internals(mesh).splatIndexAttribute.array as Float32Array).subarray(0, 6),
    );
    expect(after).toEqual(before);
  });
});
