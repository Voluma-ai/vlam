import { describe, expect, it } from 'vitest';
import { DoubleTapDetector } from './double-tap';

describe('DoubleTapDetector', () => {
  it('accepts a comfortable mobile double tap on the second press', () => {
    const detector = new DoubleTapDetector();
    expect(detector.begin(1, 100, 100, 1_000)).toBe(false);
    expect(detector.end(1, 102, 99, 1_120)).toBe(false);
    expect(detector.isSecondTap(104, 103, 1_430)).toBe(true);
    expect(detector.begin(1, 104, 103, 1_430)).toBe(true);
    expect(detector.end(1, 105, 104, 1_550)).toBe(false);
  });

  it('does not mistake the first tap near page startup for a double tap', () => {
    const detector = new DoubleTapDetector();
    expect(detector.begin(1, 10, 10, 20)).toBe(false);
    expect(detector.end(1, 10, 10, 80)).toBe(false);
  });

  it('rejects holds and drags and clears the pending first tap', () => {
    const detector = new DoubleTapDetector();
    detector.begin(1, 10, 10, 1_000);
    detector.end(1, 10, 10, 1_050);
    detector.begin(1, 10, 10, 1_200);
    expect(detector.end(1, 10, 10, 1_501)).toBe(false);

    detector.begin(1, 10, 10, 1_600);
    detector.move(1, 60, 10);
    expect(detector.end(1, 60, 10, 1_650)).toBe(false);
    detector.begin(1, 60, 10, 1_700);
    expect(detector.end(1, 60, 10, 1_750)).toBe(false);
  });

  it('treats a cancelled short still press as a tap, not a reset', () => {
    const detector = new DoubleTapDetector();
    expect(detector.begin(1, 100, 100, 1_000)).toBe(false);
    expect(detector.cancel(1, 101, 100, 1_040)).toBe(false);
    expect(detector.begin(1, 102, 101, 1_280)).toBe(true);
  });

  it('still double-taps when the first pointerup is lost', () => {
    const detector = new DoubleTapDetector();
    expect(detector.begin(1, 100, 100, 1_000)).toBe(false);
    // Safari: setPointerCapture synthesizes pointercancel before bubble
    // pointerdown, so the first pointer never reaches end().
    expect(detector.begin(2, 104, 103, 1_260)).toBe(true);
  });

  it('ignores a two-finger chord and does not teleport', () => {
    const detector = new DoubleTapDetector();
    detector.begin(1, 10, 10, 1_000);
    expect(detector.begin(2, 80, 80, 1_010)).toBe(false);
    expect(detector.end(1, 10, 10, 1_080)).toBe(false);
    expect(detector.begin(2, 80, 80, 1_100)).toBe(false);
    expect(detector.end(2, 80, 80, 1_150)).toBe(false);
  });
});
