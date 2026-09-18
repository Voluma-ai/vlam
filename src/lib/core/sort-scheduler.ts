import * as THREE from 'three/webgpu';

const TWO_MILLION = 2_000_000;
const FIVE_MILLION = 5_000_000;
const EIGHT_MILLION = 8_000_000;
const MODEL_VIEW_EPSILON = 1e-6;
const FALLBACK_HOLD_FRAMES = 2;
const FALLBACK_HOLD_MS = 32;

export type SortSubmissionAction = 'none' | 'submitted' | 'coalesced' | 'suppressed';
export type SortSubmissionTracking = 'pending' | 'gpu-completion' | 'render-ack-fallback';

export type SortSubmissionDiagnostics = {
  serial: number;
  frame: number;
  action: SortSubmissionAction;
  tracking: SortSubmissionTracking | null;
  acknowledgementMs: number | null;
  inputCount: number;
};
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
  private submissionSerialValue = 0;
  private submissionFrameValue = -1;
  private submissionInputCountValue = 0;
  private submissionActionValue: SortSubmissionAction = 'none';
  private submissionTrackingValue: SortSubmissionTracking | null = null;
  private submissionAcknowledgementMsValue: number | null = null;
  private submissionInFlight = false;
  private submissionAwaitingRender = false;
  private submissionAcknowledgedFrame = -1;
  private submissionFallbackReleaseFrame = -1;
  private submissionFallbackReleaseAt = -Infinity;
  private deferredSubmission = false;

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

  /** Starts a render frame and reports whether a previous sort still holds the gate. */
  beginSubmissionFrame(frame: number, now: number): boolean {
    this.submissionActionValue = 'none';
    if (!this.submissionInFlight) return false;
    if (this.submissionAwaitingRender) return false;
    if (
      this.submissionTrackingValue === 'render-ack-fallback' &&
      this.submissionAcknowledgedFrame >= 0 &&
      frame >= this.submissionFallbackReleaseFrame &&
      now >= this.submissionFallbackReleaseAt
    ) {
      this.completeSubmission();
      return false;
    }
    return true;
  }

  /** Records that the current sort candidate was merged behind the outstanding submission. */
  markSubmissionSuppressed(needsResubmission: boolean): void {
    this.submissionActionValue = needsResubmission ? 'coalesced' : 'suppressed';
    if (needsResubmission) this.deferredSubmission = true;
  }

  /** Assigns a serial to an accepted sort; GPU work is acknowledged later, never awaited here. */
  markSubmission(frame: number, inputCount: number): void {
    this.submissionSerialValue++;
    this.submissionFrameValue = frame;
    this.submissionInputCountValue = inputCount;
    this.submissionActionValue = 'submitted';
    this.submissionTrackingValue = 'pending';
    this.submissionAcknowledgementMsValue = null;
    this.submissionInFlight = true;
    this.submissionAwaitingRender = true;
    this.submissionAcknowledgedFrame = -1;
    this.submissionFallbackReleaseFrame = -1;
    this.submissionFallbackReleaseAt = -Infinity;
  }

  /** Whether the matching draw callback still needs to acknowledge the submission. */
  hasSubmissionAwaitingRender(): boolean {
    return this.submissionAwaitingRender;
  }

  /** Acknowledges the rendered submission and arms either the GPU or Chromium fallback release. */
  acknowledgeSubmission(frame: number, now: number, completion?: Promise<void>): void {
    if (!this.submissionInFlight || !this.submissionAwaitingRender) return;
    this.submissionAwaitingRender = false;
    this.submissionAcknowledgedFrame = frame;
    this.submissionAcknowledgementMsValue = Math.max(0, now - this.lastAcceptedAt);
    if (completion) {
      this.submissionTrackingValue = 'gpu-completion';
      void completion.then(
        () => this.completeSubmission(),
        () => this.armFallback(frame, now),
      );
    } else {
      this.armFallback(frame, now);
    }
  }

  /** Development-only state for the frame diagnostics. */
  submissionDiagnostics(): SortSubmissionDiagnostics {
    return {
      serial: this.submissionSerialValue,
      frame: this.submissionFrameValue,
      action: this.submissionActionValue,
      tracking: this.submissionTrackingValue,
      acknowledgementMs: this.submissionAcknowledgementMsValue,
      inputCount: this.submissionInputCountValue,
    };
  }

  /** Internal diagnostics for the demo HUD; it does not alter scheduling. */
  snapshot(): { acceptedCount: number; lastAcceptedAt: number } {
    return { acceptedCount: this.acceptedCount, lastAcceptedAt: this.lastAcceptedAt };
  }

  private armFallback(frame: number, now: number): void {
    this.submissionTrackingValue = 'render-ack-fallback';
    this.submissionFallbackReleaseFrame = frame + FALLBACK_HOLD_FRAMES;
    this.submissionFallbackReleaseAt = now + FALLBACK_HOLD_MS;
  }

  private completeSubmission(): void {
    this.submissionInFlight = false;
    this.submissionAwaitingRender = false;
    if (this.deferredSubmission) {
      this.deferredSubmission = false;
      this.forcePending = true;
    }
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
