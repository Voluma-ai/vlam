import * as THREE from 'three/webgpu';

const TWO_MILLION = 2_000_000;
const FIVE_MILLION = 5_000_000;
const EIGHT_MILLION = 8_000_000;
const MODEL_VIEW_EPSILON = 1e-6;
const MOBILE_ROTATION_EPSILON = 1e-3;
const MOBILE_POSITION_EPSILON = 1e-3;
const FALLBACK_HOLD_FRAMES = 2;
const FALLBACK_HOLD_MS = 32;
const FRAME_EMA_ALPHA = 0.2;
const MIN_FRAME_SAMPLE_MS = 4;
const MAX_FRAME_SAMPLE_MS = 5000;
/** Default EMA assumes a 60 Hz frame so tests that never sample stay healthy. */
const DEFAULT_FRAME_INTERVAL_EMA_MS = 1000 / 60;

/** Slowest automatic cadence: at least one sort per second while the view is dirty. */
export const MAX_ADAPTIVE_SORT_INTERVAL_MS = 1000;
/** Frames at or below this stay on the count/device automatic interval. */
export const SORT_HEALTHY_FRAME_MS = 20;
/** Frames at or above this stretch cadence all the way to {@link MAX_ADAPTIVE_SORT_INTERVAL_MS}. */
export const SORT_STRESSED_FRAME_MS = 33;
/**
 * A single frame this long starts a 1 s sort cooldown.
 * Chromium often reports a triple-vsync stall as ~49.9 ms, which missed the
 * previous 50 ms gate and kept scheduling radix into the hitch.
 */
export const SORT_HITCH_FRAME_MS = 48;

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
 * Stretches the automatic sort interval when recent frames are already long.
 *
 * GPU radix/counting is queued (`renderer.compute`), not CPU-awaited, but it
 * still shares the WebGPU queue with the splat draw, so a scheduled sort can
 * hitch that one frame. Backing off toward 1 s after a hitch is what stops a
 * hitch every vsync; {@link MAX_ADAPTIVE_SORT_INTERVAL_MS} keeps a dirty view
 * from going longer than one second without a sort. An explicit
 * `sortIntervalMs` override is not passed through here.
 */
export function adaptiveSortIntervalMs(
  baseIntervalMs: number,
  frameIntervalEma: number,
  hitchCooldownUntil: number,
  now: number,
): number {
  if (now < hitchCooldownUntil) return MAX_ADAPTIVE_SORT_INTERVAL_MS;
  if (frameIntervalEma <= SORT_HEALTHY_FRAME_MS) return baseIntervalMs;
  if (frameIntervalEma >= SORT_STRESSED_FRAME_MS) return MAX_ADAPTIVE_SORT_INTERVAL_MS;
  const t =
    (frameIntervalEma - SORT_HEALTHY_FRAME_MS) / (SORT_STRESSED_FRAME_MS - SORT_HEALTHY_FRAME_MS);
  return baseIntervalMs + t * (MAX_ADAPTIVE_SORT_INTERVAL_MS - baseIntervalMs);
}

/**
 * Gates WebGPU sort submissions while retaining content swaps and the
 * final camera pose. Accepted-sort state is committed separately so sorter
 * backpressure never causes a request to be forgotten.
 */
export class WebGpuSortScheduler {
  private readonly sortIntervalMs: number | undefined;
  private readonly isMobile: boolean;
  private xrJitterToleranceEnabled = false;
  private readonly previousModelView = new THREE.Matrix4();
  private readonly currentInverseModelView = new THREE.Matrix4();
  private readonly acceptedInverseModelView = new THREE.Matrix4();
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
  private lastBeginAt = Number.NEGATIVE_INFINITY;
  private frameIntervalEma = DEFAULT_FRAME_INTERVAL_EMA_MS;
  private hitchCooldownUntil = Number.NEGATIVE_INFINITY;

  constructor(sortIntervalMs?: number, isMobile = false) {
    this.sortIntervalMs = validateSortIntervalMs(sortIntervalMs);
    this.isMobile = isMobile;
  }

  /** Ignore submillimetre headset tracking noise only while XR presents. */
  setXrJitterTolerance(enabled: boolean): void {
    this.xrJitterToleranceEnabled = enabled;
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
   * Whether the adaptive cadence would admit a sort at `now`, without touching
   * the motion tracking {@link shouldSubmit} maintains (it is consulted once
   * per frame). A compute-projection re-dispatch under a held gate asks this
   * so the replacement projection and sort follow the cadence the vertex path
   * and the SH refresh already share, instead of landing on every frame the
   * GPU fence outlasts: at 8.7M splats that per-frame re-projection doubled
   * the overview frame p95 on an RTX 3090. Interval 0 (small scenes, explicit
   * `sortIntervalMs: 0`) is always due, so those still re-project every held
   * frame.
   */
  isCadenceDue(activeCount: number, now: number): boolean {
    const interval = this.resolveInterval(activeCount, now);
    return interval === 0 || now - this.lastAcceptedAt >= interval;
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
    this.noteFrameDuration(now);
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

  /**
   * Records that the current sort candidate was skipped because a previous
   * GPU pass still owns the order buffer. Pass `true` only for content /
   * active-list changes that must re-sort when the buffer is free. Camera-only
   * motion should pass `false` and keep {@link shouldSubmit} cadence.
   */
  markSubmissionSuppressed(needsResubmission: boolean): void {
    this.submissionActionValue = needsResubmission ? 'coalesced' : 'suppressed';
    if (needsResubmission) this.deferredSubmission = true;
  }

  /**
   * Assigns a serial to an accepted sort. GPU work is queued, never awaited
   * here: {@link acknowledgeSubmission} watches `onSubmittedWorkDone` only to
   * release this gate so a second radix pass cannot stack on the same order
   * buffer.
   */
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
    // A replacement sort already covers any coalesced camera/content request.
    this.deferredSubmission = false;
  }

  /** Whether a GPU sort still owns the shared order buffer. */
  hasSubmissionInFlight(): boolean {
    return this.submissionInFlight;
  }

  /** Whether the matching draw callback still needs to acknowledge the submission. */
  hasSubmissionAwaitingRender(): boolean {
    return this.submissionAwaitingRender;
  }

  /** Acknowledges the rendered submission and arms either the GPU or Chromium fallback release. */
  acknowledgeSubmission(frame: number, now: number, completion?: Promise<void>): void {
    if (!this.submissionInFlight || !this.submissionAwaitingRender) return;
    const serial = this.submissionSerialValue;
    this.submissionAwaitingRender = false;
    this.submissionAcknowledgedFrame = frame;
    this.submissionAcknowledgementMsValue = Math.max(0, now - this.lastAcceptedAt);
    if (completion) {
      this.submissionTrackingValue = 'gpu-completion';
      void completion.then(
        () => this.completeSubmission(serial),
        () => this.armFallback(frame, now, serial),
      );
    } else {
      this.armFallback(frame, now, serial);
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

  private noteFrameDuration(now: number): void {
    if (Number.isFinite(this.lastBeginAt)) {
      const delta = now - this.lastBeginAt;
      if (delta >= MIN_FRAME_SAMPLE_MS && delta <= MAX_FRAME_SAMPLE_MS) {
        this.frameIntervalEma += FRAME_EMA_ALPHA * (delta - this.frameIntervalEma);
        if (delta >= SORT_HITCH_FRAME_MS) {
          this.hitchCooldownUntil = now + MAX_ADAPTIVE_SORT_INTERVAL_MS;
        }
      }
    }
    this.lastBeginAt = now;
  }

  private resolveInterval(activeCount: number, now: number): number {
    const base = this.sortIntervalMs ?? automaticSortIntervalMs(activeCount, this.isMobile);
    if (this.sortIntervalMs !== undefined) return base;
    return adaptiveSortIntervalMs(base, this.frameIntervalEma, this.hitchCooldownUntil, now);
  }

  private armFallback(frame: number, now: number, serial: number): void {
    if (serial !== this.submissionSerialValue) return;
    this.submissionTrackingValue = 'render-ack-fallback';
    this.submissionFallbackReleaseFrame = frame + FALLBACK_HOLD_FRAMES;
    this.submissionFallbackReleaseAt = now + FALLBACK_HOLD_MS;
  }

  private completeSubmission(serial?: number): void {
    if (serial !== undefined && serial !== this.submissionSerialValue) return;
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

    const interval = this.resolveInterval(activeCount, now);
    const due = interval === 0 || now - this.lastAcceptedAt >= interval;
    // A new active list or a secondary view invalidates the existing order.
    // Backoff is safe only for camera motion over unchanged draw contents.
    if (this.forcePending) return true;
    if (modelView.equals(lastAcceptedModelView)) return false;
    if (settled) return true;
    if (
      this.isMobile &&
      this.xrJitterToleranceEnabled &&
      this.isWithinMobilePoseTolerance(modelView, lastAcceptedModelView)
    ) {
      return false;
    }
    return due;
  }

  private isWithinMobilePoseTolerance(current: THREE.Matrix4, accepted: THREE.Matrix4): boolean {
    const a = current.elements;
    const b = accepted.elements;
    for (const index of [0, 1, 2, 4, 5, 6, 8, 9, 10]) {
      if (Math.abs((a[index] as number) - (b[index] as number)) > MOBILE_ROTATION_EPSILON) {
        return false;
      }
    }
    // Model-view translation includes rotation around the scene origin. Invert
    // to compare the camera's actual position in mesh-local space instead.
    const currentPose = this.currentInverseModelView.copy(current).invert().elements;
    const acceptedPose = this.acceptedInverseModelView.copy(accepted).invert().elements;
    return [12, 13, 14].every(
      (index) =>
        Math.abs((currentPose[index] as number) - (acceptedPose[index] as number)) <=
        MOBILE_POSITION_EPSILON,
    );
  }
}

function maximumElementDelta(a: THREE.Matrix4, b: THREE.Matrix4): number {
  let maximum = 0;
  for (let i = 0; i < 16; i++) {
    maximum = Math.max(maximum, Math.abs((a.elements[i] as number) - (b.elements[i] as number)));
  }
  return maximum;
}
