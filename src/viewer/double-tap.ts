/** Maximum duration of either tap before it becomes a hold, in milliseconds. */
const TAP_MAX_DURATION_MS = 300;
/** Maximum pause from the first release through the second press. */
const DOUBLE_TAP_INTERVAL_MS = 500;
/** Maximum distance between taps, in CSS pixels. */
const TAP_SLOP_PX = 40;
/**
 * Two pointers this close in time are a chord (pinch), not sequential taps.
 * A double tap's second down arrives after the first finger has lifted.
 */
const CHORD_MS = 50;

interface TapSample {
  pointerId: number;
  startedAt: number;
  x: number;
  y: number;
}

interface CompletedTap {
  endedAt: number;
  x: number;
  y: number;
}

const nearby = (ax: number, ay: number, bx: number, by: number): boolean =>
  Math.hypot(ax - bx, ay - by) <= TAP_SLOP_PX;

/**
 * Recognizes two short, nearby touch taps without relying on mobile `dblclick`.
 *
 * The pair is accepted on the second **press** so a later `pointercancel` (WebKit
 * often synthesizes one from `setPointerCapture`, or from a leftover
 * double-tap-zoom gesture) cannot swallow the teleport. A cancelled short,
 * still press still counts as a tap; a hold, drag, or two-finger chord does not.
 */
export class DoubleTapDetector {
  private active: TapSample | null = null;
  private previous: CompletedTap | null = null;
  private maxMoved = 0;

  /**
   * Starts a candidate tap. `true` when this press completes a double tap.
   *
   * A second finger within 50 ms aborts the sequence (pinch). A later nearby
   * press can still complete a pair whose first `pointerup` was lost, which is
   * the Safari `setPointerCapture` → `pointercancel` race.
   */
  begin(pointerId: number, x: number, y: number, now: number): boolean {
    if (this.active !== null && this.active.pointerId !== pointerId) {
      if (now - this.active.startedAt <= CHORD_MS) {
        this.reset();
        return false;
      }
      // Finish the orphaned first press at its origin. If that already
      // completed a pair, this extra pointer is not another teleport.
      if (this.finishActive(this.active.x, this.active.y, now)) {
        this.reset();
        return false;
      }
    }

    if (
      this.previous !== null &&
      now - this.previous.endedAt <= DOUBLE_TAP_INTERVAL_MS &&
      nearby(x, y, this.previous.x, this.previous.y)
    ) {
      this.reset();
      return true;
    }

    this.active = { pointerId, startedAt: now, x, y };
    this.maxMoved = 0;
    return false;
  }

  /**
   * `true` when a press at this point would complete a double tap. Used to
   * `preventDefault` the second `touchstart` before iOS treats it as zoom.
   */
  isSecondTap(x: number, y: number, now: number): boolean {
    return (
      this.previous !== null &&
      this.active === null &&
      now - this.previous.endedAt <= DOUBLE_TAP_INTERVAL_MS &&
      nearby(x, y, this.previous.x, this.previous.y)
    );
  }

  /** Notes movement so a drag cannot complete as a tap on release. */
  move(pointerId: number, x: number, y: number): void {
    if (this.active?.pointerId !== pointerId) return;
    this.maxMoved = Math.max(this.maxMoved, Math.hypot(x - this.active.x, y - this.active.y));
  }

  /** Finishes a candidate and reports whether it completed a double tap. */
  end(pointerId: number, x: number, y: number, now: number): boolean {
    if (this.active === null || this.active.pointerId !== pointerId) return false;
    return this.finishActive(x, y, now);
  }

  /**
   * The active pointer was cancelled. A short still press still counts as a
   * tap; a hold or drag breaks the sequence. Other pointers are ignored.
   */
  cancel(pointerId: number, x: number, y: number, now: number): boolean {
    if (this.active === null || this.active.pointerId !== pointerId) return false;
    return this.finishActive(x, y, now);
  }

  private finishActive(x: number, y: number, now: number): boolean {
    const active = this.active;
    if (active === null) return false;
    this.active = null;

    const duration = now - active.startedAt;
    const moved = Math.max(this.maxMoved, Math.hypot(x - active.x, y - active.y));
    this.maxMoved = 0;
    if (duration > TAP_MAX_DURATION_MS || moved > TAP_SLOP_PX) {
      this.previous = null;
      return false;
    }

    if (
      this.previous !== null &&
      now - this.previous.endedAt <= DOUBLE_TAP_INTERVAL_MS &&
      nearby(x, y, this.previous.x, this.previous.y)
    ) {
      this.previous = null;
      return true;
    }

    this.previous = { endedAt: now, x: active.x, y: active.y };
    return false;
  }

  private reset(): void {
    this.active = null;
    this.previous = null;
    this.maxMoved = 0;
  }
}
