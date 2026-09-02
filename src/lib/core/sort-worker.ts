/**
 * Web Worker that depth-sorts the active splats of a pool back-to-front for
 * correct alpha blending. Uses a 16-bit counting sort (O(n)), which
 * comfortably sorts a million splats per frame on the CPU.
 *
 * The worker mirrors the pool's centers texture (vec4 stride, xyz used) so
 * it can sort any subset: the main thread sends written rows once, then
 * per sort only the model-view matrix and the active pool-index spans.
 *
 * Protocol:
 *  - main → worker: `{ type: 'init', capacity }` once.
 *  - main → worker: `{ type: 'write', start, centers }` after pool writes.
 *  - main → worker: `{ type: 'sort', modelView, spans }` per camera change.
 *  - worker → main: `{ type: 'order', order }` - active pool indices,
 *    back-to-front, transferred.
 */

export type {
  InitMessage,
  WriteMessage,
  SortMessage,
  OrderMessage,
  SortWorkerRequest,
} from './sort-worker-protocol';
import type { OrderMessage, SortWorkerRequest } from './sort-worker-protocol';

const RADIX = 65536; // 16-bit digit
/** Key precision: 24 bits sorted across two 16-bit radix passes, matching
 * the GPU sorter - enough that dense near-camera splats don't share a key
 * and pop as the camera moves. */
const KEY_MAX = 0xffffff;

let centers: Float32Array = new Float32Array(0);
let sourceIds: Float32Array = new Float32Array(0);
const counts = new Uint32Array(RADIX);

// Per-sort working arrays, grown to the largest active count seen and reused
// across sorts (like `counts`) - a per-frame sort of a large pool otherwise
// allocates five arrays per message. Only `order` is freshly allocated each
// sort: its buffer is transferred to the main thread.
let scratchCapacity = 0;
let poolIndexes = new Uint32Array(0);
let depths = new Float32Array(0);
let keys = new Uint32Array(0);
let srcScratch = new Uint32Array(0);
let dstScratch = new Uint32Array(0);

function ensureScratch(activeCount: number): void {
  if (activeCount <= scratchCapacity) return;
  scratchCapacity = activeCount;
  poolIndexes = new Uint32Array(activeCount);
  depths = new Float32Array(activeCount);
  keys = new Uint32Array(activeCount);
  srcScratch = new Uint32Array(activeCount);
  dstScratch = new Uint32Array(activeCount);
}

function sortByDepth(
  modelView: Float32Array,
  spans: Uint32Array,
  matrices: Float32Array | undefined,
  sortMetric: 'depth' | 'radial',
): Uint32Array {
  // Depth needs row 2; radial distance uses all three camera-space rows.
  const m0 = modelView[0] as number;
  const m4 = modelView[4] as number;
  const m8 = modelView[8] as number;
  const m12 = modelView[12] as number;
  const m1 = modelView[1] as number;
  const m5 = modelView[5] as number;
  const m9 = modelView[9] as number;
  const m13 = modelView[13] as number;
  const m2 = modelView[2] as number;
  const m6 = modelView[6] as number;
  const m10 = modelView[10] as number;
  const m14 = modelView[14] as number;

  let activeCount = 0;
  for (let s = 0; s < spans.length; s += 2) activeCount += spans[s + 1] as number;

  ensureScratch(activeCount);
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  let cursor = 0;
  for (let s = 0; s < spans.length; s += 2) {
    const start = spans[s] as number;
    const end = start + (spans[s + 1] as number);
    for (let i = start; i < end; i++) {
      const p = i * 4;
      const source = sourceIds[i] as number;
      const matrix = matrices ? source * 16 : 0;
      const x = centers[p] as number;
      const y = centers[p + 1] as number;
      const z = centers[p + 2] as number;
      const worldX = matrices
        ? (matrices[matrix] as number) * x +
          (matrices[matrix + 4] as number) * y +
          (matrices[matrix + 8] as number) * z +
          (matrices[matrix + 12] as number)
        : x;
      const worldY = matrices
        ? (matrices[matrix + 1] as number) * x +
          (matrices[matrix + 5] as number) * y +
          (matrices[matrix + 9] as number) * z +
          (matrices[matrix + 13] as number)
        : y;
      const worldZ = matrices
        ? (matrices[matrix + 2] as number) * x +
          (matrices[matrix + 6] as number) * y +
          (matrices[matrix + 10] as number) * z +
          (matrices[matrix + 14] as number)
        : z;
      const viewZ = m2 * worldX + m6 * worldY + m10 * worldZ + m14;
      const depth =
        sortMetric === 'radial'
          ? -Math.hypot(
              m0 * worldX + m4 * worldY + m8 * worldZ + m12,
              m1 * worldX + m5 * worldY + m9 * worldZ + m13,
              viewZ,
            )
          : viewZ;
      poolIndexes[cursor] = i;
      depths[cursor] = depth;
      cursor++;
      if (depth < minDepth) minDepth = depth;
      if (depth > maxDepth) maxDepth = depth;
    }
  }

  // Two-pass 16-bit LSD radix sort on a 24-bit depth key. Ascending
  // view-space z means most-negative (farthest) splats come first:
  // back-to-front. A single 16-bit pass tied thousands of near splats
  // together, which popped as the camera moved. `keys` and `poolIndexes`
  // are parallel arrays indexed by active position; we radix-sort the
  // active positions, then emit their pool indices.
  const depthScale = KEY_MAX / (maxDepth - minDepth || 1);
  let src = srcScratch;
  for (let i = 0; i < activeCount; i++) {
    keys[i] = ((depths[i] as number) - minDepth) * depthScale;
    src[i] = i;
  }

  let dst = dstScratch;
  for (let shift = 0; shift < 24; shift += 16) {
    counts.fill(0);
    for (let i = 0; i < activeCount; i++) {
      const digit = ((keys[src[i] as number] as number) >>> shift) & 0xffff;
      counts[digit] = (counts[digit] as number) + 1;
    }
    let runningTotal = 0;
    for (let b = 0; b < RADIX; b++) {
      const c = counts[b] as number;
      counts[b] = runningTotal;
      runningTotal += c;
    }
    for (let i = 0; i < activeCount; i++) {
      const position = src[i] as number;
      const digit = ((keys[position] as number) >>> shift) & 0xffff;
      const target = counts[digit] as number;
      dst[target] = position;
      counts[digit] = target + 1;
    }
    [src, dst] = [dst, src];
  }
  // Two 16-bit passes swap twice, so src/dst end on their original scratch;
  // keep the module references in step regardless of the pass count.
  srcScratch = src;
  dstScratch = dst;

  const order = new Uint32Array(activeCount);
  for (let i = 0; i < activeCount; i++) order[i] = poolIndexes[src[i] as number] as number;
  return order;
}

self.onmessage = (event: MessageEvent<SortWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    centers = new Float32Array(message.capacity * 4);
    sourceIds = new Float32Array(message.capacity);
    return;
  }
  if (message.type === 'write') {
    centers.set(message.centers, message.start * 4);
    if (message.sourceIds) sourceIds.set(message.sourceIds, message.start);
    return;
  }
  const order = sortByDepth(message.modelView, message.spans, message.matrices, message.sortMetric);
  const reply: OrderMessage = { type: 'order', order };
  (self as unknown as Worker).postMessage(reply, [order.buffer]);
};
