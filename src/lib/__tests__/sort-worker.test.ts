import { beforeAll, describe, expect, it } from 'vitest';
import type { OrderMessage, SortWorkerRequest } from '../core/sort-worker';

/**
 * Tests for the CPU depth sorter in sort-worker.ts.
 *
 * The worker's sort routine is not exported - the module's only entry point
 * is the `self.onmessage` handler it installs at import time. Rather than
 * modifying the file, this suite installs a minimal `self` stub before
 * dynamically importing the module (the same stub-a-global technique
 * streamed-splat-mesh.channels.test.ts uses for `Worker`), then drives the
 * sorter through its documented message protocol.
 */

/** Must match KEY_MAX in sort-worker.ts (24-bit quantized depth key). */
const KEY_MAX = 0xffffff;

interface SelfStub {
  onmessage: ((event: { data: SortWorkerRequest }) => void) | null;
  postMessage(message: unknown, transfer?: unknown[]): void;
}

const replies: OrderMessage[] = [];
let stub: SelfStub;

beforeAll(async () => {
  stub = {
    onmessage: null,
    postMessage: (message) => {
      replies.push(message as OrderMessage);
    },
  };
  (globalThis as { self?: unknown }).self = stub;
  await import('../core/sort-worker');
  if (!stub.onmessage) throw new Error('sort-worker did not install a message handler');
});

function send(message: SortWorkerRequest): void {
  stub.onmessage!({ data: message });
}

/** Sends init + full centers mirror, matching the worker's write protocol. */
function initPool(centers: Float32Array): void {
  const capacity = centers.length / 4;
  send({ type: 'init', capacity });
  // Split the mirror into two writes to also exercise the `start` offset.
  const half = Math.floor(capacity / 2);
  send({ type: 'write', start: 0, centers: centers.subarray(0, half * 4) });
  send({ type: 'write', start: half, centers: centers.subarray(half * 4) });
}

function sortAndReceive(modelView: Float32Array, spans: Uint32Array): Uint32Array {
  replies.length = 0;
  send({ type: 'sort', modelView, spans });
  expect(replies).toHaveLength(1);
  expect(replies[0]!.type).toBe('order');
  return replies[0]!.order;
}

function writeSourceIds(sourceIds: Float32Array): void {
  send({ type: 'write', start: 0, centers: new Float32Array(sourceIds.length * 4), sourceIds });
}

/** Deterministic PRNG (mulberry32) so failures reproduce exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A modelView whose only populated entries are the ones the worker reads
 * (row 2: elements 2, 6, 10, 14), pointing along a random unit direction. */
function randomModelView(random: () => number): Float32Array {
  const x = random() * 2 - 1;
  const y = random() * 2 - 1;
  const z = random() * 2 - 1;
  const len = Math.hypot(x, y, z) || 1;
  const m = new Float32Array(16);
  m[2] = x / len;
  m[6] = y / len;
  m[10] = z / len;
  m[14] = random() * 20 - 10;
  return m;
}

/** Active pool indices in span (active-list) order - the sort's input set. */
function activePoolIndices(spans: Uint32Array): number[] {
  const active: number[] = [];
  for (let s = 0; s < spans.length; s += 2) {
    const start = spans[s] as number;
    const end = start + (spans[s + 1] as number);
    for (let i = start; i < end; i++) active.push(i);
  }
  return active;
}

/**
 * Reference sorter replicating the worker's exact key quantization
 * (float32-stored depths, double-precision min/max and scale, ToUint32
 * truncation) and a spec-stable JS sort. If the worker's stable-scatter
 * invariant holds, its output must equal this order exactly.
 */
function referenceSort(
  centers: Float32Array,
  modelView: Float32Array,
  spans: Uint32Array,
): { order: number[]; keyOf: Map<number, number> } {
  const m2 = modelView[2] as number;
  const m6 = modelView[6] as number;
  const m10 = modelView[10] as number;
  const m14 = modelView[14] as number;

  const pool = activePoolIndices(spans);
  const depths: number[] = [];
  let min = Infinity;
  let max = -Infinity;
  for (const i of pool) {
    const p = i * 4;
    const depth =
      m2 * (centers[p] as number) +
      m6 * (centers[p + 1] as number) +
      m10 * (centers[p + 2] as number) +
      m14;
    depths.push(depth);
    if (depth < min) min = depth;
    if (depth > max) max = depth;
  }

  const scale = KEY_MAX / (max - min || 1);
  const keyOf = new Map<number, number>();
  const keys = pool.map((poolIndex, i) => {
    // The worker stores depths in a Float32Array but tracks min/max in
    // doubles; Math.fround + >>> 0 reproduce that arithmetic bit-for-bit.
    const key = ((Math.fround(depths[i] as number) - min) * scale) >>> 0;
    keyOf.set(poolIndex, key);
    return key;
  });

  const positions = pool.map((_, i) => i);
  positions.sort((a, b) => (keys[a] as number) - (keys[b] as number)); // Array#sort is stable per spec
  return { order: positions.map((i) => pool[i] as number), keyOf };
}

function randomCenters(capacity: number, random: () => number, extent = 50): Float32Array {
  const centers = new Float32Array(capacity * 4);
  for (let i = 0; i < capacity; i++) {
    centers[i * 4 + 0] = (random() * 2 - 1) * extent;
    centers[i * 4 + 1] = (random() * 2 - 1) * extent;
    centers[i * 4 + 2] = (random() * 2 - 1) * extent;
  }
  return centers;
}

describe('sort-worker 2-pass 24-bit radix depth sort', () => {
  it('emits an exact permutation in non-decreasing quantized depth for random scenes', () => {
    for (const seed of [1, 42, 20260716]) {
      const random = mulberry32(seed);
      const capacity = 4096;
      const centers = randomCenters(capacity, random);
      initPool(centers);

      // Several disjoint spans with gaps, out of increasing-size order.
      const spans = new Uint32Array([16, 1500, 2000, 1200, 3900, 100]);
      const modelView = randomModelView(random);
      const order = sortAndReceive(modelView, spans);

      const active = activePoolIndices(spans);
      expect(order).toHaveLength(active.length);

      // (a) Exact permutation of the active pool indices.
      expect(Array.from(order).sort((a, b) => a - b)).toEqual([...active].sort((a, b) => a - b));

      // (b) Non-decreasing quantized depth key along the output.
      const { order: expected, keyOf } = referenceSort(centers, modelView, spans);
      for (let i = 1; i < order.length; i++) {
        const prev = keyOf.get(order[i - 1] as number) as number;
        const next = keyOf.get(order[i] as number) as number;
        expect(next).toBeGreaterThanOrEqual(prev);
      }

      // Stability makes the order fully deterministic: it must equal a
      // spec-stable reference sort on identical keys.
      expect(Array.from(order)).toEqual(expected);
    }
  });

  it('orders splats farthest-first (back-to-front) for a straight-ahead view', () => {
    // modelView row 2 = (0, 0, 1, 0): view-space depth is the raw z. The most
    // negative z is farthest in front of a -z-looking camera and sorts first.
    const centers = new Float32Array(4 * 4);
    centers.set([0, 0, -1, 0], 0); // pool 0, nearest
    centers.set([0, 0, -5, 0], 4); // pool 1, farthest
    centers.set([0, 0, -3, 0], 8); // pool 2, middle
    initPool(centers);

    const modelView = new Float32Array(16);
    modelView[10] = 1;
    const order = sortAndReceive(modelView, new Uint32Array([0, 3]));
    expect(Array.from(order)).toEqual([1, 2, 0]);
  });

  it('sorts unified-pool centers after their per-source world transforms', () => {
    // Both local centers are identical. Source 1 is placed farther away, so
    // it must sort first; without the fallback transform this would tie.
    initPool(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]));
    writeSourceIds(new Float32Array([0, 1]));
    const matrices = new Float32Array(32);
    matrices[0] = matrices[5] = matrices[10] = matrices[15] = 1;
    matrices[16] = matrices[21] = matrices[26] = matrices[31] = 1;
    matrices[16 + 14] = -10;
    const modelView = new Float32Array(16);
    modelView[10] = 1;
    replies.length = 0;
    send({ type: 'sort', modelView, spans: new Uint32Array([0, 2]), matrices });
    expect(Array.from(replies[0]!.order)).toEqual([1, 0]);
  });

  it('keeps active-list order among tied depths (stable-scatter invariant)', () => {
    // 3000 splats sharing only 5 distinct depths - 600-way ties per key.
    const capacity = 4096;
    const count = 3000;
    const random = mulberry32(7);
    const centers = new Float32Array(capacity * 4);
    for (let i = 0; i < count; i++) {
      centers[i * 4 + 0] = random() * 100; // x/y noise must not affect depth
      centers[i * 4 + 1] = random() * 100;
      centers[i * 4 + 2] = (i % 5) - 2;
    }
    initPool(centers);

    const modelView = new Float32Array(16);
    modelView[10] = 1;
    const spans = new Uint32Array([0, count]);
    const order = sortAndReceive(modelView, spans);

    expect(order).toHaveLength(count);
    // Depth groups appear in ascending z, and within each tied group the
    // pool indices (== active-list order here) must stay ascending.
    let previousZ = -Infinity;
    let previousIndex = -1;
    for (const poolIndex of order) {
      const z = centers[poolIndex * 4 + 2] as number;
      expect(z).toBeGreaterThanOrEqual(previousZ);
      if (z === previousZ) expect(poolIndex).toBeGreaterThan(previousIndex);
      previousZ = z;
      previousIndex = poolIndex;
    }
  });

  it('preserves span order across spans when every depth ties', () => {
    const capacity = 3000;
    const centers = new Float32Array(capacity * 4); // all splats at the origin
    initPool(centers);

    const modelView = new Float32Array(16);
    modelView[10] = 1;
    // Later pool rows listed first: the active-list order, not the pool
    // order, must survive a full-tie sort.
    const spans = new Uint32Array([2000, 4, 0, 4]);
    const order = sortAndReceive(modelView, spans);
    expect(Array.from(order)).toEqual([2000, 2001, 2002, 2003, 0, 1, 2, 3]);
  });

  it('returns an empty order for empty spans', () => {
    initPool(new Float32Array(16 * 4));
    const modelView = new Float32Array(16);
    modelView[10] = 1;
    const order = sortAndReceive(modelView, new Uint32Array(0));
    expect(order).toHaveLength(0);
  });
});
