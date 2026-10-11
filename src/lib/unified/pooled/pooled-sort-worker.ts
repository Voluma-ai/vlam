/**
 * Web Worker behind the pooled unified draw: depth-sorts the concatenated
 * active lists of every source sharing one pool, each center placed by its own
 * source matrix, and answers with the draw's `splatIndex` / `sourceId` streams.
 * The radix pass is the kernel the standalone worker uses
 * (`core/sort-worker-kernel.ts`); this worker only adds per-entry source ids
 * and keeps the last index list for camera-only re-sorts.
 */
import { radixOrderByDepth } from '../../core/sort-worker-kernel';
import type { PooledOrderMessage, PooledSortRequest } from './pooled-sort-protocol';

let centers = new Float32Array(0);
let indices: Uint32Array | null = null;
let indexSources: Uint8Array | null = null;
let depths = new Float32Array(0);

self.onmessage = (event: MessageEvent<PooledSortRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    centers = new Float32Array(message.capacity * 4);
    return;
  }
  if (message.type === 'write') {
    centers.set(message.centers, message.start * 4);
    return;
  }
  if (message.indices && message.indexSources) {
    indices = message.indices;
    indexSources = message.indexSources;
  }
  if (!indices || !indexSources) throw new Error('pooled sort worker: no index list to sort.');
  const count = indices.length;
  if (depths.length < count) depths = new Float32Array(count);
  const { modelView: v, matrices, sortMetric, sortRange } = message;
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  for (let cursor = 0; cursor < count; cursor++) {
    const p = (indices[cursor] as number) * 4;
    const m = (indexSources[cursor] as number) * 16;
    const x = centers[p] as number;
    const y = centers[p + 1] as number;
    const z = centers[p + 2] as number;
    const wx =
      (matrices[m] as number) * x +
      (matrices[m + 4] as number) * y +
      (matrices[m + 8] as number) * z +
      (matrices[m + 12] as number);
    const wy =
      (matrices[m + 1] as number) * x +
      (matrices[m + 5] as number) * y +
      (matrices[m + 9] as number) * z +
      (matrices[m + 13] as number);
    const wz =
      (matrices[m + 2] as number) * x +
      (matrices[m + 6] as number) * y +
      (matrices[m + 10] as number) * z +
      (matrices[m + 14] as number);
    const viewZ =
      (v[2] as number) * wx + (v[6] as number) * wy + (v[10] as number) * wz + (v[14] as number);
    const depth =
      sortMetric === 'radial'
        ? -Math.hypot(
            (v[0] as number) * wx +
              (v[4] as number) * wy +
              (v[8] as number) * wz +
              (v[12] as number),
            (v[1] as number) * wx +
              (v[5] as number) * wy +
              (v[9] as number) * wz +
              (v[13] as number),
            viewZ,
          )
        : viewZ;
    depths[cursor] = depth;
    if (depth < minDepth) minDepth = depth;
    if (depth > maxDepth) maxDepth = depth;
  }
  const positions = radixOrderByDepth(
    depths,
    count,
    sortRange?.min ?? minDepth,
    sortRange?.max ?? maxDepth,
  );
  const order = new Float32Array(count);
  const orderSources = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const position = positions[i] as number;
    order[i] = indices[position] as number;
    orderSources[i] = indexSources[position] as number;
  }
  const reply: PooledOrderMessage = {
    type: 'order',
    requestId: message.requestId,
    order,
    orderSources,
  };
  (self as unknown as Worker).postMessage(reply, [order.buffer, orderSources.buffer]);
};
