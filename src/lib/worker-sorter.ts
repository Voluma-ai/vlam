import type * as THREE from 'three/webgpu';
import type { SplatSorter } from './sorter';
import type { SortWorkerRequest, OrderMessage } from './sort-worker-protocol';
// Inlined worker (blob URL): survives library bundling in any consumer
// setup, unlike an asset file referenced via `new URL(...)`.
import SortWorker from './sort-worker?worker&inline';
import { logError } from './logging';

/**
 * CPU depth sorter: counting sort in a Web Worker. Used on the WebGL2
 * fallback backend, which has no compute shaders. Works for static and
 * dynamic-capacity (streamed) meshes alike: the worker keeps a mirror of
 * the pool's centers, and each sort covers only the active pool spans.
 *
 * One sort runs at a time; requests that arrive while the worker is busy
 * are declined so the caller retries with the then-current camera on a
 * later frame.
 */
export class WorkerSorter implements SplatSorter {
  readonly kind = 'worker' as const;
  private readonly worker: Worker;
  private readonly splatIndexAttribute: THREE.InstancedBufferAttribute;
  private readonly host: WorkerSorterHost;
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

  constructor(host: WorkerSorterHost) {
    this.host = host;
    this.splatIndexAttribute = host.splatIndexAttribute;
    this.worker = new SortWorker();
    this.worker.onmessage = (event: MessageEvent<OrderMessage>) => {
      this.applyOrder(event.data.order);
    };
    // Without these, one worker-side exception would leave `inFlight` stuck
    // true and silently freeze depth ordering for the rest of the session.
    this.worker.onerror = (event: ErrorEvent) => {
      logError('sort worker error - retrying on a later frame.', event.message);
      this.inFlight = false;
    };
    this.worker.onmessageerror = () => {
      logError('sort worker message deserialization failed.');
      this.inFlight = false;
    };
    const init: SortWorkerRequest = { type: 'init', capacity: host.capacity };
    this.worker.postMessage(init);
    // Everything written so far is one dirty span from the mirror's view.
    this.pushCenters([{ start: 0, count: Math.ceil(host.capacity / host.rowWidth) }]);
  }

  sort(modelView: THREE.Matrix4, _activeCount: number, _bounds: THREE.Sphere): boolean {
    if (this.disposed || this.inFlight) return false;
    this.inFlight = true;
    this.submittedCount++;
    this.lastSubmittedAt = performance.now();

    this.pushCenters(this.host.takeDirtyRows());
    const spans = this.host.getActiveSpans();
    this.sentSpans = spans;
    const message: SortWorkerRequest = {
      type: 'sort',
      modelView: new Float32Array(modelView.elements),
      spans,
      matrices: this.host.perSource ? new Float32Array(this.host.perSource.matrices) : undefined,
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

  private applyOrder(order: Uint32Array): void {
    this.inFlight = false;
    this.completedCount++;
    this.lastCompletedAt = performance.now();
    this.lastLatencyMs = this.lastCompletedAt - this.lastSubmittedAt;
    // An order event already dispatched when dispose ran still lands here;
    // writing it would flag a post-dispose GPU upload on the dead draw list.
    if (this.disposed) return;
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
  /** Active ranges as (start, count) pool-index pairs, active-list order. */
  getActiveSpans(): Uint32Array;
  /**
   * Called after a worker order lands in the draw list, so the host knows the
   * list holds a sorted permutation (not identity active order) and must fully
   * resync - not patch - it on the next active-list mutation.
   */
  onOrderApplied?(): void;
}
