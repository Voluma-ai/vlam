import type * as THREE from 'three/webgpu';
import type { SplatSorter } from './sorter';
import type { SplatSortMetric } from './splat-mesh-types';
import { intersectSortRange, sceneSortRange, type SplatSortRange } from './splat-sort-bounds';
import type { SortWorkerRequest, OrderMessage } from './sort-worker-protocol';
// Inlined worker (blob URL): survives library bundling in any consumer
// setup, unlike an asset file referenced via `new URL(...)`.
import SortWorker from './sort-worker?worker&inline';
import { logError } from './logging';

/** Immutable inputs for one worker request, supplied by a dynamic mesh. */
export interface WorkerSortSnapshot {
  readonly requestId: number;
  readonly spans: Uint32Array;
  readonly indices: Uint32Array;
  /** Center deltas captured with the snapshot, not live pool views. */
  readonly centerWrites: readonly {
    start: number;
    centers: Float32Array;
    sourceIds?: Float32Array;
  }[];
}

/**
 * Stable CPU radix sorter in a Web Worker. Used by the WebGL2 fallback and,
 * when explicitly selected, alongside WebGPU rendering for Spark-like sort
 * cadence. Works for static and dynamic-capacity meshes alike: the worker
 * keeps a mirror of the pool's centers. Dynamic hosts additionally provide an
 * immutable active-index snapshot, so compaction and slot reuse cannot change
 * what a request means while the worker is busy.
 *
 * One sort/publication runs at a time; requests that arrive while the worker
 * is busy or its completed snapshot awaits render preparation are declined.
 * This is the backpressure that guarantees an older complete snapshot still
 * makes forward progress during continuous loading.
 */
export class WorkerSorter implements SplatSorter {
  readonly kind = 'worker' as const;
  private readonly worker: Worker;
  private readonly splatIndexAttribute: THREE.InstancedBufferAttribute;
  private readonly host: WorkerSorterHost;
  private readonly sortMetric: SplatSortMetric;
  private inFlight = false;
  /** Set by {@link dispose}; drops any already-delivered order message. */
  private disposed = false;
  /** The active spans the in-flight sort was computed against. */
  private sentSpans: Uint32Array | null = null;
  private submittedCount = 0;
  private completedCount = 0;
  private lastSubmittedAt = -Infinity;
  private lastCompletedAt = -Infinity;
  private lastLatencyMs = Number.NaN;
  private inFlightRequestId: number | null = null;
  private nextRequestId = 0;

  constructor(host: WorkerSorterHost, sortMetric: SplatSortMetric = 'depth') {
    this.host = host;
    this.sortMetric = sortMetric;
    this.splatIndexAttribute = host.splatIndexAttribute;
    this.worker = new SortWorker();
    this.worker.onmessage = (event: MessageEvent<OrderMessage>) => {
      this.applyOrder(event.data);
    };
    // Without these, one worker-side exception would leave `inFlight` stuck
    // true and silently freeze depth ordering for the rest of the session.
    this.worker.onerror = (event: ErrorEvent) => {
      logError('sort worker error - retrying on a later frame.', event.message);
      this.failInFlight();
    };
    this.worker.onmessageerror = () => {
      logError('sort worker message deserialization failed.');
      this.failInFlight();
    };
    const init: SortWorkerRequest = { type: 'init', capacity: host.capacity };
    this.worker.postMessage(init);
    // Everything written so far is one dirty span from the mirror's view.
    this.pushCenters([{ start: 0, count: Math.ceil(host.capacity / host.rowWidth) }]);
  }

  sort(
    modelView: THREE.Matrix4,
    _activeCount: number,
    bounds: THREE.Sphere,
    visibleRange?: SplatSortRange | null,
  ): boolean {
    if (this.disposed || this.inFlight || this.host.hasPendingPublication?.()) return false;
    const snapshot = this.host.captureSnapshot?.();
    if (this.host.captureSnapshot && !snapshot) return false;
    this.inFlight = true;
    const requestId = snapshot?.requestId ?? ++this.nextRequestId;
    this.inFlightRequestId = requestId;
    this.submittedCount++;
    this.lastSubmittedAt = performance.now();

    if (snapshot) this.pushCenterWrites(snapshot.centerWrites);
    else this.pushCenters(this.host.takeDirtyRows());
    const spans = snapshot?.spans ?? this.host.getActiveSpans();
    this.sentSpans = spans;
    const message: SortWorkerRequest = {
      type: 'sort',
      requestId,
      sortMetric: this.sortMetric,
      modelView: new Float32Array(modelView.elements),
      spans,
      indices: snapshot?.indices,
      matrices: this.host.perSource ? new Float32Array(this.host.perSource.matrices) : undefined,
      sortRange: intersectSortRange(
        sceneSortRange(modelView, bounds, this.sortMetric),
        visibleRange,
      ),
    };
    this.worker.postMessage(message);
    return true;
  }

  /** Internal timing diagnostics used by the demo's opt-in XR A/B harness. */
  snapshot(): {
    submittedCount: number;
    completedCount: number;
    lastSubmittedAt: number;
    lastCompletedAt: number;
    lastLatencyMs: number;
  } {
    return {
      submittedCount: this.submittedCount,
      completedCount: this.completedCount,
      lastSubmittedAt: this.lastSubmittedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastLatencyMs: this.lastLatencyMs,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
  }

  /** Sends written pool rows to keep the worker's centers mirror current. */
  private pushCenters(rows: readonly { start: number; count: number }[]): void {
    const width = this.host.rowWidth;
    for (const row of rows) {
      const centers = this.host.centers.slice(
        row.start * width * 4,
        (row.start + row.count) * width * 4,
      );
      const start = row.start * width;
      const count = row.count * width;
      const sourceIds = this.host.perSource?.sourceIds.slice(start, start + count);
      const message: SortWorkerRequest = { type: 'write', start, centers, sourceIds };
      this.worker.postMessage(message, [centers.buffer]);
    }
  }

  private pushCenterWrites(
    rows: readonly { start: number; centers: Float32Array; sourceIds?: Float32Array }[],
  ): void {
    for (const row of rows) {
      const message: SortWorkerRequest = {
        type: 'write',
        start: row.start,
        centers: row.centers,
        sourceIds: row.sourceIds,
      };
      // This is also the immutable GPU-upload source for the pending
      // publication, so it deliberately stays owned by the main thread.
      this.worker.postMessage(message);
    }
  }

  private applyOrder(message: OrderMessage): void {
    if (message.requestId !== this.inFlightRequestId) return;
    const order = message.order;
    this.inFlight = false;
    this.inFlightRequestId = null;
    this.completedCount++;
    this.lastCompletedAt = performance.now();
    this.lastLatencyMs = this.lastCompletedAt - this.lastSubmittedAt;
    // An order event already dispatched when dispose ran still lands here;
    // writing it would flag a post-dispose GPU upload on the dead draw list.
    if (this.disposed) return;
    if (this.host.onOrderReady) {
      this.host.onOrderReady(message.requestId, order);
      return;
    }
    // A reply computed against an outdated active set must not overwrite the
    // identity draw list `rebuildActiveList` wrote for the new one - it would
    // resurrect the pool slots of a just-removed range for several frames.
    // The caller's forced re-sort delivers a fresh order right after.
    const current = this.host.getActiveSpans();
    const sent = this.sentSpans;
    this.sentSpans = null;
    if (!sent || sent.length !== current.length) return;
    for (let i = 0; i < sent.length; i++) {
      if (sent[i] !== current[i]) return;
    }
    const indexes = this.splatIndexAttribute.array as Float32Array;
    for (let i = 0; i < order.length; i++) {
      indexes[i] = order[i] as number;
    }
    // An explicit update range covering the whole order: if the attribute
    // already carries narrow ranges from an active-list patch this frame, a
    // bare `needsUpdate` would upload only those slots and clip the new
    // permutation to a fragment - draw-list garbage until the next sort.
    this.splatIndexAttribute.addUpdateRange(0, order.length);
    this.splatIndexAttribute.needsUpdate = true;
    // The draw list now holds a depth permutation, not the identity active
    // order - the host must stop patching it incrementally (see
    // SplatMesh.commitActiveListMutation).
    this.host.onOrderApplied?.();
  }

  private failInFlight(): void {
    const requestId = this.inFlightRequestId;
    this.inFlight = false;
    this.inFlightRequestId = null;
    if (requestId !== null) this.host.onSortFailure?.(requestId);
  }
}

/** What the sorter needs from its mesh; see SplatMesh.createSorter. */
export interface WorkerSorterHost {
  /** Pool capacity in splats. */
  readonly capacity: number;
  /** Splats per pool texture row. */
  readonly rowWidth: number;
  /** The pool's centers backing array (vec4 stride; xyz used). */
  readonly centers: Float32Array;
  /** Source metadata for a unified pool; omitted for a normal mesh. */
  readonly perSource?: {
    readonly sourceIds: Float32Array;
    readonly matrices: Float32Array;
  };
  readonly splatIndexAttribute: THREE.InstancedBufferAttribute;
  /** Drains the row spans written since the last call. */
  takeDirtyRows(): { start: number; count: number }[];
  /** Captures the exact pending scene that a worker reply may publish. */
  captureSnapshot?(): WorkerSortSnapshot | null;
  /** True while a completed snapshot is waiting for render preparation. */
  hasPendingPublication?(): boolean;
  /** Active ranges as (start, count) pool-index pairs, active-list order. */
  getActiveSpans(): Uint32Array;
  /**
   * Called after a worker order lands in the draw list, so the host knows the
   * list holds a sorted permutation (not identity active order) and must fully
   * resync - not patch - it on the next active-list mutation.
   */
  onOrderApplied?(): void;
  /** Queues a completed immutable snapshot; the host publishes it before drawing. */
  onOrderReady?(requestId: number, order: Uint32Array): void;
  /** Restores dirty coverage after an asynchronous worker failure. */
  onSortFailure?(requestId: number): void;
}
