import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ComputeSorter } from '../compute-sorter';
import { RADIX_KEY_MAX, quantizeDepthKey, stableRadixSortReference } from '../radix-sort';
import type { OrderMessage, SortWorkerRequest } from '../sort-worker';

/**
 * Property-based tests for the per-frame sorter invariants (fable-away E11).
 *
 * Two paths are exercised with a seeded PRNG over many randomized rounds:
 *
 * - **Counting path** (`ComputeSorter`): the GPU passes cannot run under
 *   vitest, so a CPU model replays the exact six-stage pipeline - the
 *   real sorter instance supplies `depthMin`/`depthScale`/`bucketMax`
 *   (read through the same internals casts compute-sorter.test.ts uses),
 *   and the model's scatter visits splats in a *shuffled* order to stand in
 *   for the non-deterministic parallel `atomicAdd` scatter. The asserted
 *   invariants are exactly the ones that must hold regardless of scatter
 *   order: exact permutation, and depth non-decreasing within one bucket
 *   width (docs/capabilities.md "Sorting semantics").
 * - **Radix path**: the real `sort-worker` module driven through its message
 *   protocol (same `self` stub technique as sort-worker.test.ts), plus the
 *   `stableRadixSortReference` used to validate the GPU radix sorter.
 *
 * Failure messages carry the seed, round, and a compact repro payload so a
 * shrunk reproduction can be pasted into a focused test directly.
 */

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

function randomInt(random: () => number, maxExclusive: number): number {
  return Math.floor(random() * maxExclusive);
}

/** Fisher–Yates shuffle of 0..n-1, used to model unordered GPU scatter. */
function shuffledPositions(count: number, random: () => number): Uint32Array {
  const positions = new Uint32Array(count);
  for (let i = 0; i < count; i++) positions[i] = i;
  for (let i = count - 1; i > 0; i--) {
    const j = randomInt(random, i + 1);
    const swap = positions[i] as number;
    positions[i] = positions[j] as number;
    positions[j] = swap;
  }
  return positions;
}

/**
 * Asserts `order` is an exact permutation of `active` (no duplicates, no
 * drops, no out-of-range values). Reports the first offending index so a
 * failure message names the concrete counterexample.
 */
function expectExactPermutation(
  order: ArrayLike<number>,
  active: readonly number[],
  context: string,
): void {
  expect(order.length, `${context}: order length`).toBe(active.length);
  const expected = new Set(active);
  const seen = new Set<number>();
  for (let i = 0; i < order.length; i++) {
    const value = order[i] as number;
    expect(expected.has(value), `${context}: order[${i}]=${value} is not an active index`).toBe(
      true,
    );
    expect(seen.has(value), `${context}: order[${i}]=${value} duplicated`).toBe(false);
    seen.add(value);
  }
}

// ---------------------------------------------------------------------------
// Counting path (ComputeSorter pipeline model)
// ---------------------------------------------------------------------------

interface CountingInternals {
  depthMin: { value: number };
  depthScale: { value: number };
  bucketMax: { value: number };
}

/**
 * CPU replay of the six ComputeSorter passes over the given depths, using the
 * uniform values the real sorter computed for this sort. `scatterOrder`
 * permutes the scatter visit order to model the unstable parallel atomicAdd.
 * Returns active-list positions in output order.
 */
function countingSortModel(
  depths: readonly number[],
  internals: CountingInternals,
  scatterOrder: Uint32Array,
): Uint32Array {
  const { value: depthMin } = internals.depthMin;
  const { value: depthScale } = internals.depthScale;
  const { value: bucketMax } = internals.bucketMax;

  // Mirrors the shader's `depth.sub(min).mul(scale).clamp(0, max).toUint()`.
  // WGSL f32→u32 conversion maps NaN to 0 and saturates at the clamp bounds.
  const bucketOf = (depth: number): number => {
    const scaled = (depth - depthMin) * depthScale;
    if (Number.isNaN(scaled)) return 0;
    return Math.floor(Math.min(Math.max(scaled, 0), bucketMax));
  };

  const count = depths.length;
  const buckets = new Uint32Array(count);
  const histogram = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const bucket = bucketOf(depths[i] as number);
    buckets[i] = bucket;
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
  }
  // Exclusive prefix sum over buckets (scanBlocks + scanSums + addOffsets).
  const offsets = new Map<number, number>();
  let total = 0;
  for (const bucket of [...histogram.keys()].sort((a, b) => a - b)) {
    offsets.set(bucket, total);
    total += histogram.get(bucket) as number;
  }
  // Scatter, visited in an arbitrary order like the parallel GPU pass.
  const order = new Uint32Array(count);
  for (const position of scatterOrder) {
    const bucket = buckets[position] as number;
    const target = offsets.get(bucket) as number;
    offsets.set(bucket, target + 1);
    order[target] = position;
  }
  return order;
}

function makeCountingSorter(capacity: number): ComputeSorter {
  return new ComputeSorter({
    renderer: { compute: vi.fn() } as unknown as THREE.WebGPURenderer,
    capacity,
    centersTexture: new THREE.DataTexture(
      new Float32Array(capacity * 4),
      capacity,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    ),
    dataTextureWidth: capacity,
    splatIndexAttribute: new THREE.StorageInstancedBufferAttribute(new Float32Array(capacity), 1),
    sourceIndexAttribute: new THREE.StorageBufferAttribute(new Uint32Array(capacity), 1),
  });
}

/** View-space depth of a point for a modelView matrix (row 2 only). */
function depthOf(modelView: THREE.Matrix4, x: number, y: number, z: number): number {
  const m = modelView.elements;
  return m[2] * x + m[6] * y + m[10] * z + m[14];
}

describe('counting-path pipeline properties', () => {
  it('emits an exact permutation with depth non-decreasing within one bucket, across random scenes', () => {
    const capacity = 2048;
    const sorter = makeCountingSorter(capacity);
    const internals = sorter as unknown as CountingInternals;
    try {
      for (const seed of [1, 7, 42, 1234, 20260723]) {
        const random = mulberry32(seed);
        for (let round = 0; round < 8; round++) {
          const activeCount = 1 + randomInt(random, capacity);
          const extent = 10 ** (randomInt(random, 7) - 3); // 1e-3 .. 1e3 scene scales
          const centers: [number, number, number][] = [];
          for (let i = 0; i < activeCount; i++) {
            centers.push([
              (random() * 2 - 1) * extent,
              (random() * 2 - 1) * extent,
              (random() * 2 - 1) * extent,
            ]);
          }
          const modelView = new THREE.Matrix4()
            .makeRotationFromEuler(
              new THREE.Euler(random() * Math.PI, random() * Math.PI, random() * Math.PI),
            )
            .setPosition(0, 0, -extent * (1 + random() * 4));
          const bounds = new THREE.Sphere(new THREE.Vector3(), extent * Math.sqrt(3));

          sorter.sort(modelView, activeCount, bounds);
          const depths = centers.map(([x, y, z]) => depthOf(modelView, x, y, z));
          const order = countingSortModel(
            depths,
            internals,
            shuffledPositions(activeCount, random),
          );

          const context = `seed=${seed} round=${round} activeCount=${activeCount} extent=${extent}`;
          const active = Array.from({ length: activeCount }, (_, i) => i);
          expectExactPermutation(order, active, context);

          // One bucket of tolerance: splats in the same bucket may land in
          // either order (docs/capabilities.md), so depth may regress by at
          // most one bucket width, never more.
          const bucketWidth = 1 / internals.depthScale.value;
          expect(
            internals.depthScale.value,
            `${context}: depthScale must be positive`,
          ).toBeGreaterThan(0);
          let maxSeen = -Infinity;
          for (let i = 0; i < order.length; i++) {
            const depth = depths[order[i] as number] as number;
            expect(
              depth,
              `${context}: order[${i}] (splat ${order[i]}) depth ${depth} regresses more than one bucket (${bucketWidth}) below ${maxSeen}`,
            ).toBeGreaterThanOrEqual(maxSeen - bucketWidth);
            if (depth > maxSeen) maxSeen = depth;
          }
        }
      }
    } finally {
      sorter.dispose();
    }
  }, 15_000);

  it('stays an exact permutation at the edges: single splat, identical depths, out-of-bounds and non-finite centers', () => {
    const capacity = 512;
    const sorter = makeCountingSorter(capacity);
    const internals = sorter as unknown as CountingInternals;
    const modelView = new THREE.Matrix4(); // depth = z
    try {
      const cases: { name: string; depths: number[]; bounds: THREE.Sphere }[] = [
        {
          name: 'single splat',
          depths: [3.5],
          bounds: new THREE.Sphere(new THREE.Vector3(0, 0, 3.5), 1),
        },
        {
          // Zero-radius bounds: far - near = 0, sort() falls back to `|| 1`.
          name: 'all splats at identical depth, degenerate bounds',
          depths: new Array<number>(300).fill(-2),
          bounds: new THREE.Sphere(new THREE.Vector3(0, 0, -2), 0),
        },
        {
          // Depths far outside the bounds sphere clamp into the end buckets.
          name: 'depths outside the declared bounds',
          depths: [-1e6, -1, 0, 1, 1e6],
          bounds: new THREE.Sphere(new THREE.Vector3(), 1),
        },
        {
          // The shader has no special NaN/Inf handling: WGSL's f32→u32
          // conversion sends NaN to bucket 0 and the clamp saturates ±Inf.
          // The load-bearing invariant is that the result is still an exact
          // permutation - nothing is dropped or duplicated.
          name: 'non-finite centers',
          depths: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 2],
          bounds: new THREE.Sphere(new THREE.Vector3(), 4),
        },
        {
          name: 'extreme depth range',
          depths: [-1e30, -1, 0, 1, 1e30],
          bounds: new THREE.Sphere(new THREE.Vector3(), 1e30),
        },
      ];
      for (const { name, depths, bounds } of cases) {
        const random = mulberry32(99);
        sorter.sort(modelView, depths.length, bounds);
        const order = countingSortModel(
          depths,
          internals,
          shuffledPositions(depths.length, random),
        );
        const active = Array.from({ length: depths.length }, (_, i) => i);
        expectExactPermutation(order, active, `case "${name}"`);

        // Finite-depth inputs additionally keep bucket monotonicity - on
        // *clamped* depths: values beyond the declared bounds intentionally
        // collapse into the first/last bucket, so ordering is only promised
        // within the [near, far] window the bounds sphere declared.
        if (depths.every((depth) => Number.isFinite(depth))) {
          const bucketWidth = 1 / internals.depthScale.value;
          const near = internals.depthMin.value;
          const far = near + internals.bucketMax.value * bucketWidth;
          let maxSeen = -Infinity;
          for (const position of order) {
            const depth = Math.min(Math.max(depths[position] as number, near), far);
            expect(
              depth,
              `case "${name}": clamped depth ${depth} regresses more than one bucket`,
            ).toBeGreaterThanOrEqual(maxSeen - bucketWidth);
            if (depth > maxSeen) maxSeen = depth;
          }
        }
      }

      // Empty active list: sort() reports done without dispatching at all.
      const compute = (sorter as unknown as { renderer: { compute: ReturnType<typeof vi.fn> } })
        .renderer.compute;
      compute.mockClear();
      expect(sorter.sort(modelView, 0, new THREE.Sphere(new THREE.Vector3(), 1))).toBe(true);
      expect(compute).not.toHaveBeenCalled();
    } finally {
      sorter.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Radix reference (GPU radix validation logic)
// ---------------------------------------------------------------------------

describe('stableRadixSortReference properties', () => {
  it('matches a spec-stable sort exactly for random 24-bit keys', () => {
    for (const seed of [3, 11, 77, 20260723]) {
      const random = mulberry32(seed);
      const count = 1 + randomInt(random, 3000);
      // Mix full-range keys with heavy tie clusters to stress stability.
      const distinct = 1 + randomInt(random, count);
      const keys = Uint32Array.from({ length: count }, () =>
        random() < 0.5 ? randomInt(random, RADIX_KEY_MAX + 1) : randomInt(random, distinct),
      );
      const order = stableRadixSortReference(keys);

      const context = `seed=${seed} count=${count} distinct≈${distinct}`;
      const expected = Array.from(keys.keys()).sort(
        (a, b) => (keys[a] as number) - (keys[b] as number), // Array#sort is stable per spec
      );
      expect(Array.from(order), context).toEqual(expected);
    }
  });

  it('quantizeDepthKey stays in range and monotonic for random and degenerate spans', () => {
    for (const seed of [5, 21]) {
      const random = mulberry32(seed);
      for (let round = 0; round < 50; round++) {
        const minimum = (random() * 2 - 1) * 10 ** (randomInt(random, 6) - 2);
        const span = random() * 10 ** (randomInt(random, 8) - 4);
        const maximum = minimum + span;
        const a = minimum + random() * span;
        const b = minimum + random() * span;
        const keyA = quantizeDepthKey(a, minimum, maximum);
        const keyB = quantizeDepthKey(b, minimum, maximum);
        const context = `seed=${seed} round=${round} min=${minimum} max=${maximum} a=${a} b=${b}`;
        expect(keyA, context).toBeGreaterThanOrEqual(0);
        expect(keyA, context).toBeLessThanOrEqual(RADIX_KEY_MAX);
        if (a <= b) expect(keyA, context).toBeLessThanOrEqual(keyB);
        else expect(keyA, context).toBeGreaterThanOrEqual(keyB);
      }
    }
    // Documented degenerate handling: non-finite inputs and empty spans → 0.
    expect(quantizeDepthKey(Number.NaN, 0, 1)).toBe(0);
    expect(quantizeDepthKey(Number.POSITIVE_INFINITY, 0, 1)).toBe(0);
    expect(quantizeDepthKey(1, 5, 5)).toBe(0);
    expect(quantizeDepthKey(1, 5, 2)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CPU worker (WebGL2 radix path), driven through its real message protocol
// ---------------------------------------------------------------------------

/** Must match KEY_MAX in sort-worker.ts (24-bit quantized depth key). */
const WORKER_KEY_MAX = 0xffffff;

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
  await import('../sort-worker');
  if (!stub.onmessage) throw new Error('sort-worker did not install a message handler');
});

function send(message: SortWorkerRequest): void {
  stub.onmessage!({ data: message });
}

function sortAndReceive(modelView: Float32Array, spans: Uint32Array): Uint32Array {
  replies.length = 0;
  send({ type: 'sort', modelView, spans });
  expect(replies).toHaveLength(1);
  return replies[0]!.order;
}

function activePoolIndices(spans: readonly [number, number][]): number[] {
  const active: number[] = [];
  for (const [start, count] of spans) {
    for (let i = start; i < start + count; i++) active.push(i);
  }
  return active;
}

/** Reproduces the worker's exact key quantization for the tolerance check. */
function workerKeys(
  centers: Float32Array,
  modelView: Float32Array,
  active: readonly number[],
): Map<number, number> {
  const m2 = modelView[2] as number;
  const m6 = modelView[6] as number;
  const m10 = modelView[10] as number;
  const m14 = modelView[14] as number;
  let min = Infinity;
  let max = -Infinity;
  const depths = active.map((i) => {
    const p = i * 4;
    const depth =
      m2 * (centers[p] as number) +
      m6 * (centers[p + 1] as number) +
      m10 * (centers[p + 2] as number) +
      m14;
    if (depth < min) min = depth;
    if (depth > max) max = depth;
    return depth;
  });
  const scale = WORKER_KEY_MAX / (max - min || 1);
  const keys = new Map<number, number>();
  active.forEach((poolIndex, i) => {
    // Float32Array-stored depths, double-precision min/scale, ToUint32.
    keys.set(poolIndex, ((Math.fround(depths[i] as number) - min) * scale) >>> 0);
  });
  return keys;
}

describe('sort-worker properties under streamed active-list edits', () => {
  it('keeps every sort an exact permutation with non-decreasing keys while spans churn', () => {
    for (const seed of [2, 13, 314159]) {
      const random = mulberry32(seed);
      const capacity = 2048;
      const centers = new Float32Array(capacity * 4);
      for (let i = 0; i < capacity; i++) {
        centers[i * 4 + 0] = (random() * 2 - 1) * 50;
        centers[i * 4 + 1] = (random() * 2 - 1) * 50;
        centers[i * 4 + 2] = (random() * 2 - 1) * 50;
      }
      send({ type: 'init', capacity });
      send({ type: 'write', start: 0, centers: centers.slice() });

      // A mutable list of disjoint (start, count) spans, edited every round
      // like a streaming mesh activating/deactivating/appending/removing
      // ranges between sorts.
      const spanList: [number, number][] = [[0, 128]];
      for (let round = 0; round < 30; round++) {
        const op = randomInt(random, 4);
        if (op === 0 && spanList.length < 12) {
          // Append: a fresh span after the current maximum extent.
          const end = spanList.reduce((m, [s, c]) => Math.max(m, s + c), 0);
          const count = 1 + randomInt(random, 100);
          if (end + count <= capacity) spanList.push([end, count]);
        } else if (op === 1 && spanList.length > 0) {
          // Remove/deactivate a random span.
          spanList.splice(randomInt(random, spanList.length), 1);
        } else if (op === 2 && spanList.length > 0) {
          // Shrink to an active prefix (setRangeActivePrefix analogue).
          const target = spanList[randomInt(random, spanList.length)]!;
          target[1] = Math.max(1, randomInt(random, target[1] + 1));
        } else if (spanList.length > 0) {
          // Rewrite centers under a live span mid-stream (pool row reuse).
          const [start, count] = spanList[randomInt(random, spanList.length)]!;
          const fresh = new Float32Array(count * 4);
          for (let i = 0; i < fresh.length; i++) fresh[i] = (random() * 2 - 1) * 50;
          centers.set(fresh, start * 4);
          send({ type: 'write', start, centers: fresh.slice() });
        }
        // Shuffle span order: active-list order need not match pool order.
        for (let i = spanList.length - 1; i > 0; i--) {
          const j = randomInt(random, i + 1);
          const swap = spanList[i]!;
          spanList[i] = spanList[j]!;
          spanList[j] = swap;
        }

        const spans = new Uint32Array(spanList.flat());
        const modelView = new Float32Array(16);
        const direction = new THREE.Vector3(
          random() * 2 - 1,
          random() * 2 - 1,
          random() * 2 - 1,
        ).normalize();
        modelView[2] = direction.x;
        modelView[6] = direction.y;
        modelView[10] = direction.z;
        modelView[14] = random() * 20 - 10;

        const order = sortAndReceive(modelView, spans);
        const active = activePoolIndices(spanList);
        const context = `seed=${seed} round=${round} spans=[${spanList.map((s) => s.join('+')).join(', ')}]`;
        expectExactPermutation(order, active, context);

        // The worker's radix scatter is stable and exact for its 24-bit keys.
        const keys = workerKeys(centers, modelView, active);
        for (let i = 1; i < order.length; i++) {
          const prev = keys.get(order[i - 1] as number) as number;
          const next = keys.get(order[i] as number) as number;
          expect(
            next,
            `${context}: key inversion at order[${i}] (pool ${order[i]} after ${order[i - 1]})`,
          ).toBeGreaterThanOrEqual(prev);
        }
      }
    }
  });

  it('handles the documented edge cases: empty, single, all-tied, extreme ranges', () => {
    const capacity = 600;
    const modelView = new Float32Array(16);
    modelView[10] = 1; // depth = z

    // Empty active list.
    send({ type: 'init', capacity });
    send({ type: 'write', start: 0, centers: new Float32Array(capacity * 4) });
    expect(sortAndReceive(modelView, new Uint32Array(0))).toHaveLength(0);

    // Single splat.
    expect(Array.from(sortAndReceive(modelView, new Uint32Array([37, 1])))).toEqual([37]);

    // All splats at identical depth: the `|| 1` span fallback makes every key
    // 0 and the stable scatter must preserve active-list (span) order.
    const tiedOrder = sortAndReceive(modelView, new Uint32Array([400, 5, 100, 5]));
    expect(Array.from(tiedOrder)).toEqual([400, 401, 402, 403, 404, 100, 101, 102, 103, 104]);

    // Extreme depth magnitudes (1e±30) still quantize into range and sort.
    for (const magnitude of [1e-30, 1e30]) {
      const centers = new Float32Array(capacity * 4);
      for (let i = 0; i < 64; i++) centers[i * 4 + 2] = (i - 32) * magnitude;
      send({ type: 'write', start: 0, centers });
      const order = sortAndReceive(modelView, new Uint32Array([0, 64]));
      const active = Array.from({ length: 64 }, (_, i) => i);
      expectExactPermutation(order, active, `magnitude=${magnitude}`);
      // Distinct, evenly spaced depths: the order must be exactly ascending z.
      expect(Array.from(order), `magnitude=${magnitude}`).toEqual(active);
    }
  });
});
