/**
 * Web Worker that depth-sorts the active splats of a pool back-to-front for
 * correct alpha blending, through the shared radix kernel
 * (`sort-worker-kernel.ts`), which comfortably sorts a million splats per
 * frame on the CPU.
 *
 * The worker mirrors the pool's centers texture (vec4 stride, xyz used) so
 * it can sort any subset: the main thread sends written rows once, then per
 * sort sends the model-view matrix and an exact captured pool-index list
 * (legacy callers may still send active spans).
 *
 * Protocol:
 *  - main → worker: `{ type: 'init', capacity }` once.
 *  - main → worker: `{ type: 'write', start, centers }` after pool writes.
 *  - main → worker: `{ type: 'sort', requestId, modelView, indices }` per camera change.
 *  - worker → main: `{ type: 'order', requestId, order }` - active pool indices,
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
import type { SplatSortRange } from './splat-sort-bounds';
import { radixOrderByDepth } from './sort-worker-kernel';

let centers: Float32Array = new Float32Array(0);
let sourceIds: Float32Array = new Float32Array(0);

// Per-sort working arrays, grown to the largest active count seen and reused
// across sorts - a per-frame sort of a large pool otherwise allocates them per
// message. Only `order` is freshly allocated each sort: its buffer is
// transferred to the main thread. The radix kernel keeps its own scratch.
let scratchCapacity = 0;
let poolIndexes = new Uint32Array(0);
let depths = new Float32Array(0);

function ensureScratch(activeCount: number): void {
  if (activeCount <= scratchCapacity) return;
  scratchCapacity = activeCount;
  poolIndexes = new Uint32Array(activeCount);
  depths = new Float32Array(activeCount);
}

function sortByDepth(
  modelView: Float32Array,
  spans: Uint32Array,
  indices: Uint32Array | undefined,
  matrices: Float32Array | undefined,
  sortMetric: 'depth' | 'radial',
  sortRange: SplatSortRange | undefined,
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

  let activeCount = indices?.length ?? 0;
  if (!indices) {
    for (let s = 0; s < spans.length; s += 2) activeCount += spans[s + 1] as number;
  }

  ensureScratch(activeCount);
  if (indices) {
    poolIndexes.set(indices, 0);
  } else {
    let slot = 0;
    for (let s = 0; s < spans.length; s += 2) {
      const start = spans[s] as number;
      const end = start + (spans[s + 1] as number);
      for (let i = start; i < end; i++) poolIndexes[slot++] = i;
    }
  }
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  for (let cursor = 0; cursor < activeCount; cursor++) {
    const i = poolIndexes[cursor] as number;
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
    depths[cursor] = depth;
    if (!sortRange) {
      if (depth < minDepth) minDepth = depth;
      if (depth > maxDepth) maxDepth = depth;
    }
  }

  // `poolIndexes` and `depths` are parallel arrays indexed by active position;
  // the kernel orders the active positions, then we emit their pool indices.
  const positions = radixOrderByDepth(
    depths,
    activeCount,
    sortRange?.min ?? minDepth,
    sortRange?.max ?? maxDepth,
  );

  const order = new Uint32Array(activeCount);
  for (let i = 0; i < activeCount; i++) order[i] = poolIndexes[positions[i] as number] as number;
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
  const order = sortByDepth(
    message.modelView,
    message.spans,
    message.indices,
    message.matrices,
    message.sortMetric,
    message.sortRange,
  );
  const reply: OrderMessage = { type: 'order', requestId: message.requestId, order };
  (self as unknown as Worker).postMessage(reply, [order.buffer]);
};
