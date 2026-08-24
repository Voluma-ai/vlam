/** Hold still this long before a camera press becomes a forward input. */
export const PRESS_FORWARD_DELAY_MS = 300;
/**
 * Movement from the press origin that still counts as holding still, in CSS
 * pixels. Finger and mouse jitter sit inside this disk; a look-around drag
 * does not.
 */
export const PRESS_FORWARD_SLOP_PX = 2;

type Phase = 'idle' | 'pending' | 'active';

/**
 * Distinguishes a still hold (walk/fly forward) from a look-around drag.
 *
 * A press that stays inside {@link PRESS_FORWARD_SLOP_PX} for
 * {@link PRESS_FORWARD_DELAY_MS} becomes a forward input. Looking around
 * during that window cancels the hold. After it engages, later pointer
 * movement is allowed so the camera can look while moving.
 */
export class PressForwardDetector {
  private pointerId: number | null = null;
  private startedAt = 0;
  private originX = 0;
  private originY = 0;
  private phase: Phase = 'idle';

  /** Arms a candidate hold. A new press replaces any previous one. */
  begin(pointerId: number, x: number, y: number, now: number): void {
    this.pointerId = pointerId;
    this.startedAt = now;
    this.originX = x;
    this.originY = y;
    this.phase = 'pending';
  }

  /**
   * Notes a pointer move. Cancels a still-pending hold that left the slop
   * disk. A hold that has already engaged is left alone so looking around
   * while moving stays possible.
   */
  move(pointerId: number, x: number, y: number, now: number): void {
    if (pointerId !== this.pointerId) return;
    this.promote(now);
    if (this.phase !== 'pending') return;
    if (Math.hypot(x - this.originX, y - this.originY) > PRESS_FORWARD_SLOP_PX) {
      this.reset();
    }
  }

  /** True once a still hold has lasted past the delay. */
  active(now: number): boolean {
    this.promote(now);
    return this.phase === 'active';
  }

  /** Cancels the current gesture. Other pointers are ignored. */
  cancel(pointerId?: number): void {
    if (pointerId !== undefined && pointerId !== this.pointerId) return;
    this.reset();
  }

  private promote(now: number): void {
    if (this.phase === 'pending' && now - this.startedAt > PRESS_FORWARD_DELAY_MS) {
      this.phase = 'active';
    }
  }

  private reset(): void {
    this.pointerId = null;
    this.phase = 'idle';
  }
}
