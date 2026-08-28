import * as THREE from 'three/webgpu';

const TWO_MILLION = 2_000_000;
const FIVE_MILLION = 5_000_000;
const EIGHT_MILLION = 8_000_000;
const MODEL_VIEW_EPSILON = 1e-6;
/** Validates the public fixed sort-interval override. */
export function validateSortIntervalMs(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(
      'SplatMesh sortIntervalMs must be a finite number greater than or equal to 0.',
    );
  }
  return value;
}

/**
 * Returns the automatic WebGPU sort interval for the current active splat count.
 *
 * Mobile keeps a floor even for small scenes. A sort is never free: the
 * counting sorter's clear and scan passes cost the same whatever the splat
 * count, so on a mobile GPU an every-changed-frame sort stalls the frame
 * (measured on an Adreno 750: a few frames, then a freeze, repeating). Two
 * frames of sort latency while the camera moves is imperceptible next to that
 * - and {@link WebGpuSortScheduler.shouldSubmit} still sorts immediately once
 * the camera settles, so a stationary view is always exactly ordered.
 */
export function automaticSortIntervalMs(activeCount: number, isMobile = false): number {
  if (activeCount < TWO_MILLION) return isMobile ? 33 : 0;
  if (activeCount < FIVE_MILLION) return isMobile ? 66 : 50;
  if (activeCount < EIGHT_MILLION) return isMobile ? 133 : 100;
  return 1000 / 6;
}

/**
 * Gates WebGPU sort submissions while retaining content swaps and the
 * final camera pose. Accepted-sort state is committed separately so sorter
 * backpressure never causes a request to be forgotten.
 */
export class WebGpuSortScheduler {
  private readonly sortIntervalMs: number | undefined;
  private readonly isMobile: boolean;
  private readonly previousModelView = new THREE.Matrix4();
  private hasPreviousModelView = false;
  private legacyWasMoving = false;
  private forcePending = true;
  private lastAcceptedAt = -Infinity;
  private acceptedCount = 0;

  constructor(sortIntervalMs?: number, isMobile = false) {
    this.sortIntervalMs = validateSortIntervalMs(sortIntervalMs);
    this.isMobile = isMobile;
  }

  /** Forces the next changed or content-invalidated pose to bypass throttling. */
  invalidate(): void {
    this.forcePending = true;
  }

  /**
   * Content changes replace pool indices underneath the current draw order.
   * They must bypass cadence so a newly active range never renders through a
   * stale sort while the camera is moving.
   */
  invalidateContent(): void {
    this.forcePending = true;
  }

  /**
   * Whether an invalidation is still waiting for an accepted sort. The WebGL2
   * worker path consults this directly: it has no cadence, but a content swap
   * under a stationary camera must still trigger a re-sort - the swap reset
   * the draw list to unsorted active order, and without this the scene would
   * render in that unsorted order until the camera next moved (visible
   * blend-order flicker on every streaming swap).
   */
  hasPendingForce(): boolean {
    return this.forcePending;
  }

  /**
   * Returns whether a sort should be submitted at this timestamp.
   */
  shouldSubmit(
    modelView: THREE.Matrix4,
    lastAcceptedModelView: THREE.Matrix4,
    activeCount: number,
    now: number,
  ): boolean {
    return this.shouldSubmitLegacy(modelView, lastAcceptedModelView, activeCount, now);
  }

  /**
   * Commits timing state only after the sorter accepts a submission.
   */
  markAccepted(now: number): void {
    this.lastAcceptedAt = now;
    this.acceptedCount++;
    this.forcePending = false;
  }

  /** Internal diagnostics for the demo HUD; it does not alter scheduling. */
  snapshot(): { acceptedCount: number; lastAcceptedAt: number } {
    return { acceptedCount: this.acceptedCount, lastAcceptedAt: this.lastAcceptedAt };
  }

  private shouldSubmitLegacy(
    modelView: THREE.Matrix4,
    lastAcceptedModelView: THREE.Matrix4,
    activeCount: number,
    now: number,
  ): boolean {
    let settled = false;
    if (this.hasPreviousModelView) {
      const moved = maximumElementDelta(modelView, this.previousModelView) > MODEL_VIEW_EPSILON;
      settled = this.legacyWasMoving && !moved;
      this.legacyWasMoving = moved;
    } else {
      this.hasPreviousModelView = true;
    }
    this.previousModelView.copy(modelView);

    const interval = this.sortIntervalMs ?? automaticSortIntervalMs(activeCount, this.isMobile);
    if (this.forcePending) return true;
    if (modelView.equals(lastAcceptedModelView)) return false;
    if (settled) return true;
    return interval === 0 || now - this.lastAcceptedAt >= interval;
  }
}

function maximumElementDelta(a: THREE.Matrix4, b: THREE.Matrix4): number {
  let maximum = 0;
  for (let i = 0; i < 16; i++) {
    maximum = Math.max(maximum, Math.abs((a.elements[i] as number) - (b.elements[i] as number)));
  }
  return maximum;
}
