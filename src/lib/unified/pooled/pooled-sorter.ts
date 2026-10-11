import type * as THREE from 'three/webgpu';
import {
  intersectSortRange,
  sceneSortRange,
  type SplatSortRange,
} from '../../core/splat-sort-bounds';
import type { SplatSortMetric } from '../../core/splat-mesh-types';
import { logError } from '../../core/logging';
import type { PooledOrderMessage, PooledSortRequest } from './pooled-sort-protocol';
// Inlined worker (blob URL), bundled into this WebGL2-only entry alone.
import PooledSortWorker from './pooled-sort-worker?worker&inline';

/**
 * Main-thread side of the pooled draw's sort worker. One request in flight at
 * a time; a failed request is reported so the owner can requeue its capture.
 */
export class PooledSorter {
  submissionCount = 0;
  lastLatencyMs = Number.NaN;
  private readonly worker: Worker;
  private inFlightId: number | null = null;
  private submittedAt = 0;
  private retains = false;
  private disposed = false;

  constructor(
    capacity: number,
    centers: Float32Array,
    private readonly sortMetric: SplatSortMetric,
    private readonly onOrder: (requestId: number, order: Float32Array, sources: Uint8Array) => void,
    private readonly onFailure: (requestId: number) => void,
  ) {
    this.worker = new PooledSortWorker();
    this.worker.onmessage = (event: MessageEvent<PooledOrderMessage>) => {
      const { requestId, order, orderSources } = event.data;
      if (this.disposed || requestId !== this.inFlightId) return;
      this.inFlightId = null;
      this.lastLatencyMs = performance.now() - this.submittedAt;
      this.onOrder(requestId, order, orderSources);
    };
    // One worker exception must not leave the gate shut for the session.
    this.worker.onerror = (event: ErrorEvent) => this.fail(event.message);
    this.worker.onmessageerror = () => this.fail('message deserialization failed');
    this.post({ type: 'init', capacity });
    // Everything the pool holds so far; later rows arrive with each capture.
    const all = centers.slice(0, capacity * 4);
    this.post({ type: 'write', start: 0, centers: all }, [all.buffer]);
  }

  /** A request is out; the next `sort` must wait for its reply. */
  get busy(): boolean {
    return this.inFlightId !== null;
  }

  /** The worker holds an index list a request may omit to sort again. */
  get retainsIndices(): boolean {
    return this.retains;
  }

  /** Mirrors pool center rows; the buffers stay the caller's (no transfer). */
  write(rows: readonly { start: number; centers: Float32Array }[]): void {
    for (const row of rows) this.post({ type: 'write', start: row.start, centers: row.centers });
  }

  sort(
    requestId: number,
    modelView: THREE.Matrix4,
    matrices: Float32Array,
    bounds: THREE.Sphere,
    visibleRange: SplatSortRange | null,
    list?: { indices: Uint32Array; indexSources: Uint8Array },
  ): void {
    this.inFlightId = requestId;
    this.submittedAt = performance.now();
    this.submissionCount++;
    const sortRange = intersectSortRange(
      sceneSortRange(modelView, bounds, this.sortMetric),
      visibleRange,
    );
    this.post(
      {
        type: 'sort',
        requestId,
        sortMetric: this.sortMetric,
        modelView: new Float32Array(modelView.elements),
        matrices: matrices.slice(),
        ...(list ?? {}),
        ...(sortRange ? { sortRange } : {}),
      },
      list ? [list.indices.buffer as ArrayBuffer, list.indexSources.buffer as ArrayBuffer] : [],
    );
    if (list) this.retains = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
  }

  private post(message: PooledSortRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private fail(reason: string): void {
    logError('pooled sort worker error - retrying on a later frame.', reason);
    const requestId = this.inFlightId;
    this.inFlightId = null;
    // The worker may have died mid-list; never ask it to reuse one.
    this.retains = false;
    if (requestId !== null) this.onFailure(requestId);
  }
}
