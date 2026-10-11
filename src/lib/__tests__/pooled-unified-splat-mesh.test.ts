import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { writeCovariance, type SplatData } from '../core/splat-data';
import { SplatMesh } from '../core/splat-mesh';
import { SplatPool, SPLAT_DATA_TEXTURE_WIDTH } from '../core/splat-mesh-pool';
import type { OrderMessage, SortWorkerRequest } from '../core/sort-worker-protocol';
import {
  PooledUnifiedSplatMesh,
  supportsPooledUnifiedSplatMesh,
} from '../unified/pooled/pooled-unified-splat-mesh';

/**
 * The pooled unified draw against the real CPU sort worker, driven
 * synchronously: `globalThis.self` is stubbed so `sort-worker.ts` installs its
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
  await import('../core/sort-worker');
  if (!selfStub.onmessage) throw new Error('sort-worker did not install a message handler');
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
    expect(near.pooledUnifiedPublicationOwner).toBe(pooled);

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
    expect(drawList(pooled)).toEqual({ indices: [W, 0], sources: [1, 0] });
    expect(instanceCount(near)).toBe(0);
    expect(near.activeSplatCount).toBe(1);
    expect(far.activeSplatCount).toBe(1);
    expect(pooled.getDrawPublicationSnapshot().ready).toBe(false);
    pooled.onAfterRender(renderer as never, new THREE.Scene(), camera);
    expect(pooled.getDrawPublicationSnapshot().ready).toBe(true);

    // Camera on the other side: the order flips after the next round trip.
    const behind = cameraAt(-3);
    pooled.update(behind);
    pooled.update(behind);
    expect(drawList(pooled)).toEqual({ indices: [0, W], sources: [0, 1] });

    // A stationary camera requests no further sort.
    const before = sent.filter((message) => message.type === 'sort').length;
    pooled.update(behind);
    expect(sent.filter((message) => message.type === 'sort').length).toBe(before);

    pooled.dispose();
    expect(near.visible).toBe(true);
    expect(near.pooledUnifiedPublicationOwner).toBeNull();
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
    expect(b.pooledUnifiedPublicationOwner).toBeNull();
    expect(pooled.removeSource(b)).toBe(false);
    pooled.dispose();
    a.dispose();
    b.dispose();
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
