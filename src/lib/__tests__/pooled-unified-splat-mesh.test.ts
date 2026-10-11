import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { writeCovariance, type SplatData } from '../core/splat-data';
import { SplatMesh } from '../core/splat-mesh';
import { SplatPool, SPLAT_DATA_TEXTURE_WIDTH } from '../core/splat-mesh-pool';
import type { SplatContext, SplatModifier } from '../core/splat-modifier';
import type {
  PooledOrderMessage as OrderMessage,
  PooledSortRequest as SortWorkerRequest,
} from '../unified/pooled/pooled-sort-protocol';
import {
  PooledUnifiedSplatMesh,
  supportsPooledUnifiedSplatMesh,
} from '../unified/pooled/pooled-unified-splat-mesh';

/**
 * The pooled unified draw against the real CPU sort worker, driven
 * synchronously: `globalThis.self` is stubbed so `pooled-sort-worker.ts` installs its
 * handler on it, and a fake `Worker` relays messages both ways on the main
 * thread (replies can be held to simulate worker latency).
 */
interface SelfStub {
  onmessage: ((event: { data: SortWorkerRequest }) => void) | null;
  postMessage(message: unknown, transfer?: unknown[]): void;
}

const sent: SortWorkerRequest[] = [];
const replies: OrderMessage[] = [];
let holdReplies = false;
let activeWorker: FakeWorker | null = null;
let selfStub: SelfStub;

class FakeWorker {
  onmessage: ((event: { data: OrderMessage }) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  constructor() {
    registerWorker(this);
  }
  postMessage(message: SortWorkerRequest): void {
    sent.push(message);
    selfStub.onmessage?.({ data: message });
    if (!holdReplies) flushReplies();
  }
  terminate(): void {}
}

function registerWorker(worker: FakeWorker): void {
  activeWorker = worker;
}

function flushReplies(): void {
  while (replies.length > 0) {
    const reply = replies.shift() as OrderMessage;
    activeWorker?.onmessage?.({ data: reply });
  }
}

beforeAll(async () => {
  selfStub = {
    onmessage: null,
    postMessage: (message) => {
      replies.push(message as OrderMessage);
    },
  };
  (globalThis as { self?: unknown }).self = selfStub;
  await import('../unified/pooled/pooled-sort-worker');
  if (!selfStub.onmessage) throw new Error('pooled-sort-worker did not install a message handler');
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
});

const W = SPLAT_DATA_TEXTURE_WIDTH;

function splat(count = 1, z = 0): SplatData {
  const covariances = new Float32Array(6 * count);
  const positions = new Float32Array(3 * count);
  const colors = new Uint8Array(4 * count);
  for (let i = 0; i < count; i++) {
    writeCovariance(covariances, i, 1, 1, 1, 1, 0, 0, 0);
    positions[i * 3 + 2] = z;
    colors.set([255, 0, 0, 255], i * 4);
  }
  return { count, positions, colors, covariances };
}

function mockRenderer(webgpu = false): THREE.WebGPURenderer {
  return {
    backend: { isWebGPUBackend: webgpu },
    getDrawingBufferSize: (out: THREE.Vector2) => out.set(800, 600),
    copyTextureToTexture: vi.fn(),
    getRenderTarget: () => null,
    setRenderTarget: vi.fn(),
    render: vi.fn(),
  } as unknown as THREE.WebGPURenderer;
}

function cameraAt(z: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

function instanceCount(mesh: THREE.Mesh): number {
  return (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
}

function drawList(mesh: PooledUnifiedSplatMesh): { indices: number[]; sources: number[] } {
  const count = instanceCount(mesh);
  const geometry = mesh.geometry as THREE.InstancedBufferGeometry;
  const indices = Array.from(
    (geometry.getAttribute('splatIndex').array as Float32Array).subarray(0, count),
  );
  const sources = Array.from(
    (geometry.getAttribute('sourceId').array as Float32Array).subarray(0, count),
  );
  return { indices, sources };
}

function lastSort(): Extract<SortWorkerRequest, { type: 'sort' }> {
  for (let i = sent.length - 1; i >= 0; i--) {
    const message = sent[i];
    if (message?.type === 'sort') return message;
  }
  throw new Error('no sort request was sent');
}

describe('supportsPooledUnifiedSplatMesh', () => {
  it('accepts any initialized backend, WebGL2 included', () => {
    expect(supportsPooledUnifiedSplatMesh(mockRenderer(false))).toBe(true);
    expect(supportsPooledUnifiedSplatMesh(mockRenderer(true))).toBe(true);
    expect(supportsPooledUnifiedSplatMesh({})).toBe(false);
  });
});

describe('PooledUnifiedSplatMesh', () => {
  it('rejects sources that draw from another pool or disagree on draw settings', () => {
    const renderer = mockRenderer();
    const pool = new SplatPool({ capacity: 3 * W });
    const other = new SplatPool({ capacity: W });
    const pooled = new PooledUnifiedSplatMesh(renderer, pool);
    const inside = new SplatMesh(splat(), { pool });
    const outside = new SplatMesh(splat(), { pool: other });
    const wider = new SplatMesh(splat(), { pool, maxStdDev: 2 });
    pooled.addSource(inside);
    expect(() => pooled.addSource(outside)).toThrow(/same pool|the pool this mesh/);
    expect(() => pooled.addSource(wider)).toThrow(/maxStdDev/);
    expect(pooled.sourceCount).toBe(1);
    pooled.dispose();
    inside.dispose();
    outside.dispose();
    wider.dispose();
    pool.dispose();
    other.dispose();
  });

  it('sorts two sources back-to-front through their own world matrices and publishes together', () => {
    sent.length = 0;
    const renderer = mockRenderer();
    const pool = new SplatPool({ capacity: 2 * W });
    const near = new SplatMesh(splat(), { pool });
    const far = new SplatMesh(splat(), { pool });
    near.position.z = 0.5;
    far.position.z = -0.5;
    const pooled = new PooledUnifiedSplatMesh(renderer, pool);
    pooled.addSource(near);
    pooled.addSource(far);
    expect(near.visible).toBe(false);
    expect(far.visible).toBe(false);
    // Owned: another pooled draw cannot adopt the same source.
    expect(() => near.adoptPooledPublication({})).toThrow(/another pooled/);

    const camera = cameraAt(3);
    // Frame 1: sources update, the combined capture is sent and (synchronously)
    // answered; the order is pending until the next update publishes it.
    pooled.update(camera);
    const request = lastSort();
    expect(Array.from(request.indices ?? [])).toEqual([0, W]);
    expect(Array.from(request.indexSources ?? [])).toEqual([0, 1]);
    // Column-major matrices: the translation z of source 1 sits at 1*16 + 14.
    expect(request.matrices?.[14]).toBeCloseTo(0.5);
    expect(request.matrices?.[16 + 14]).toBeCloseTo(-0.5);
    expect(instanceCount(pooled)).toBe(0);

    // Frame 2: publication - the far source draws first.
    pooled.update(camera);
    expect(instanceCount(pooled)).toBe(2);
    // Static usage: three re-sends a DynamicDrawUsage attribute's whole array
    // every frame (2 × 4 B per pool splat), which cost ~36 ms/frame at 8M.
    const geometry = pooled.geometry as THREE.InstancedBufferGeometry;
    expect((geometry.getAttribute('splatIndex') as THREE.BufferAttribute).usage).toBe(
      THREE.StaticDrawUsage,
    );
    expect((geometry.getAttribute('sourceId') as THREE.BufferAttribute).usage).toBe(
      THREE.StaticDrawUsage,
    );
    expect(drawList(pooled)).toEqual({ indices: [W, 0], sources: [1, 0] });
    expect(instanceCount(near)).toBe(0);
    expect(near.activeSplatCount).toBe(1);
    expect(far.activeSplatCount).toBe(1);
    expect(pooled.getDrawPublicationSnapshot().ready).toBe(false);
    pooled.onAfterRender(renderer as never, new THREE.Scene(), camera);
    expect(pooled.getDrawPublicationSnapshot().ready).toBe(true);

    // Camera on the other side: the order flips after the next round trip.
    // Nothing changed in either source, so the worker re-sorts the index
    // list it retained from the first request.
    const behind = cameraAt(-3);
    pooled.update(behind);
    const reused = lastSort();

    expect(reused.indices).toBeUndefined();

    pooled.update(behind);
    expect(drawList(pooled)).toEqual({ indices: [0, W], sources: [0, 1] });

    // A stationary camera requests no further sort.
    const before = sent.filter((message) => message.type === 'sort').length;
    pooled.update(behind);
    expect(sent.filter((message) => message.type === 'sort').length).toBe(before);

    pooled.dispose();
    expect(near.visible).toBe(true);
    // Released: a new owner may adopt it.
    expect(() => near.adoptPooledPublication({}).release()).not.toThrow();
    near.dispose();
    far.dispose();
    pool.dispose();
  });

  it('holds appended rows behind the combined order and uploads them at publication', () => {
    sent.length = 0;
    const renderer = mockRenderer();
    const copy = renderer.copyTextureToTexture as unknown as ReturnType<typeof vi.fn>;
    const pool = new SplatPool({ capacity: 2 * W });
    const stream = new SplatMesh({ capacity: W }, { pool });
    const pooled = new PooledUnifiedSplatMesh(renderer, pool);
    pooled.addSource(stream);
    const camera = cameraAt(3);
    pooled.update(camera);
    expect(instanceCount(pooled)).toBe(0);

    stream.appendRange(splat(3));
    pooled.update(camera); // captures the appended rows with the new list
    expect(copy).not.toHaveBeenCalled();
    expect(instanceCount(pooled)).toBe(0);
    pooled.update(camera); // publishes rows and order together
    expect(copy).toHaveBeenCalled();
    expect(instanceCount(pooled)).toBe(3);
    expect(stream.activeSplatCount).toBe(3);
    pooled.dispose();
    stream.dispose();
    pool.dispose();
  });

  it('discards an in-flight order when membership changes and re-sorts the new set', () => {
    sent.length = 0;
    const renderer = mockRenderer();
    const pool = new SplatPool({ capacity: 2 * W });
    const a = new SplatMesh(splat(), { pool });
    const b = new SplatMesh(splat(), { pool });
    const pooled = new PooledUnifiedSplatMesh(renderer, pool);
    pooled.addSource(a);
    pooled.addSource(b);
    const camera = cameraAt(3);
    holdReplies = true;
    try {
      pooled.update(camera);
      expect(replies.length).toBe(1);
      pooled.setSourceVisible(b, false);
      flushReplies(); // stale: both sources were captured, b is now hidden
      pooled.update(camera);
      expect(instanceCount(pooled)).toBe(0);
      flushReplies();
      pooled.update(camera);
      expect(drawList(pooled)).toEqual({ indices: [0], sources: [0] });
      expect(b.effectiveVisibility).toBe(false);
    } finally {
      holdReplies = false;
    }
    // Removal restores the source's standalone draw and frees its slot.
    expect(pooled.removeSource(b)).toBe(true);
    expect(b.visible).toBe(true);
    expect(() => b.adoptPooledPublication({}).release()).not.toThrow();
    expect(pooled.removeSource(b)).toBe(false);
    pooled.dispose();
    a.dispose();
    b.dispose();
    pool.dispose();
  });

  it('publishes an empty or hidden source without a worker round trip and acknowledges its render', async () => {
    sent.length = 0;
    const renderer = mockRenderer();
    const pool = new SplatPool({ capacity: 2 * W });
    const main = new SplatMesh({ capacity: W }, { pool });
    const hidden = new SplatMesh(splat(), { pool });
    const ready = vi.spyOn(
      main as unknown as { onActiveListReady(v: number): void },
      'onActiveListReady',
    );
    const rendered = vi.spyOn(main, 'notifyUnifiedPublication');
    const hiddenReady = vi.spyOn(
      hidden as unknown as { onActiveListReady(v: number): void },
      'onActiveListReady',
    );
    const pooled = new PooledUnifiedSplatMesh(renderer, pool);
    pooled.addSource(main);
    pooled.addSource(hidden, { visible: false });
    const camera = cameraAt(3);
    // Nothing is drawn, so no sort is requested - yet both sources' active
    // lists are acknowledged the way a standalone worker mesh acknowledges an
    // empty publication, which streamed sources wait for before staging.
    pooled.update(camera);
    expect(sent.filter((message) => message.type === 'sort')).toHaveLength(0);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(hiddenReady).toHaveBeenCalledTimes(1);
    pooled.onAfterRender(renderer as never, new THREE.Scene(), camera);
    await Promise.resolve();
    expect(rendered).toHaveBeenCalledTimes(1);
    // A hidden source keeps publishing its row changes as it streams.
    hidden.visible = false;
    expect(instanceCount(pooled)).toBe(0);
    // Once the main has splats it joins the worker cycle.
    main.appendRange(splat(2));
    pooled.update(camera);
    pooled.update(camera);
    expect(drawList(pooled).indices).toHaveLength(2);
    expect(ready).toHaveBeenCalledTimes(2);
    pooled.dispose();
    main.dispose();
    hidden.dispose();
    pool.dispose();
  });

  it('skips a source with zero opacity in the combined list and keeps it pickable only while visible', () => {
    sent.length = 0;
    const renderer = mockRenderer();
    const pool = new SplatPool({ capacity: 2 * W });
    const a = new SplatMesh(splat(), { pool });
    const b = new SplatMesh(splat(), { pool });
    const pooled = new PooledUnifiedSplatMesh(renderer, pool);
    pooled.addSource(a);
    pooled.addSource(b, { opacity: 0 });
    const camera = cameraAt(3);
    pooled.update(camera);
    expect(Array.from(lastSort().indices ?? [])).toEqual([0]);
    pooled.setSourceOpacity(b, 0.5);
    pooled.update(camera);
    pooled.update(camera);
    expect(Array.from(lastSort().indices ?? []).sort()).toEqual([0, W].sort());
    pooled.dispose();
    a.dispose();
    b.dispose();
    pool.dispose();
  });
});

describe('PooledUnifiedSplatMesh source stacks', () => {
  type Internals = {
    tables: {
      capacity: number;
      dataNode: { array: THREE.Vector4[] };
      columnsNode: { array: THREE.Vector4[] };
    };
    shaderRevision: number;
  };
  const internals = (mesh: PooledUnifiedSplatMesh) => mesh as unknown as Internals;

  it('groups sources by stack contents and skips empty stacks', async () => {
    const { groupSourceStacks } = await import('../unified/pooled/pooled-source-stacks');
    const a: SplatModifier = () => ({});
    const b: SplatModifier = () => ({});
    const groups = groupSourceStacks([
      { id: 0, modifiers: [a, b] },
      { id: 1, modifiers: [] },
      { id: 2, modifiers: [a, b] },
      { id: 3, modifiers: [b, a] },
    ]);
    expect(groups.map((group) => group.ids)).toEqual([[0, 2], [3]]);
  });

  it('evaluates a source stack in that source frame and rebuilds only on structural change', () => {
    const renderer = mockRenderer();
    const pool = new SplatPool({ capacity: 2 * W });
    const main = new SplatMesh(splat(), { pool });
    const marker = new SplatMesh(splat(), { pool });
    marker.position.set(4, 0, 0);
    marker.scale.setScalar(2);
    marker.updateMatrixWorld();
    const pooled = new PooledUnifiedSplatMesh(renderer, pool);
    pooled.addSource(main);
    pooled.addSource(marker);
    const camera = cameraAt(3);
    pooled.update(camera);
    const builtBefore = internals(pooled).shaderRevision;

    const seen: SplatContext[] = [];
    const tint: SplatModifier = (ctx) => {
      seen.push(ctx);
      return {};
    };
    const stack = [tint];
    pooled.setSourceModifiers(marker, stack);
    pooled.update(camera);
    expect(internals(pooled).shaderRevision).toBe(builtBefore + 1);
    // The fold remaps the frame: local = pre-placement pool center.
    const ctx = seen.at(-1) as SplatContext;
    expect(ctx.localCenter).toBe(ctx.sourceCenter);

    // Same contents (new array): no rebuild. A uniform-only change never asks.
    pooled.setSourceModifiers(marker, [tint]);
    pooled.update(camera);
    expect(internals(pooled).shaderRevision).toBe(builtBefore + 1);

    // The camera reaches the source's frame through its inverse placement:
    // world (0,0,3) relative to a source at x=4 scaled 2 is (-2, 0, 1.5).
    const data = internals(pooled).tables.dataNode.array;
    const markerId = 1;
    const cameraRow = data[markerId * 7 + 3] as THREE.Vector4;
    expect([cameraRow.x, cameraRow.y, cameraRow.z]).toEqual([-2, 0, 1.5]);
    // Inverse linear columns: a uniform 2× scale inverts to 0.5.
    expect((data[markerId * 7 + 4] as THREE.Vector4).x).toBeCloseTo(0.5);

    pooled.setSourceModifiers(marker, []);
    pooled.update(camera);
    expect(internals(pooled).shaderRevision).toBe(builtBefore + 2);
    pooled.dispose();
    main.dispose();
    marker.dispose();
    pool.dispose();
  });

  it('sizes the per-source tables to the live source count', () => {
    const renderer = mockRenderer();
    const pool = new SplatPool({ capacity: 4 * W });
    const meshes = [0, 1, 2].map(() => new SplatMesh(splat(), { pool }));
    const pooled = new PooledUnifiedSplatMesh(renderer, pool, { maxSources: 64 });
    pooled.addSource(meshes[0] as SplatMesh);
    pooled.addSource(meshes[1] as SplatMesh);
    expect(internals(pooled).tables.capacity).toBe(2);
    expect(internals(pooled).tables.columnsNode.array).toHaveLength(8);
    const camera = cameraAt(3);
    pooled.update(camera);
    const revision = internals(pooled).shaderRevision;
    pooled.addSource(meshes[2] as SplatMesh);
    expect(internals(pooled).tables.capacity).toBe(4);
    pooled.update(camera);
    expect(internals(pooled).shaderRevision).toBe(revision + 1);
    pooled.dispose();
    for (const mesh of meshes) mesh.dispose();
    pool.dispose();
  });

  it('reports no WebGL2 shader budget on a WebGPU backend', async () => {
    const renderer = mockRenderer(true);
    const pool = new SplatPool({ capacity: W });
    const mesh = new SplatMesh(splat(), { pool });
    const pooled = new PooledUnifiedSplatMesh(renderer, pool);
    pooled.addSource(mesh);
    await expect(pooled.checkShaderBudget(cameraAt(3))).resolves.toBeNull();
    expect(pooled.shaderBudget).toBeNull();
    pooled.dispose();
    mesh.dispose();
    pool.dispose();
  });
});
