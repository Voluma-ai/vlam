import { describe, expect, it } from 'vitest';

import {
  PRESS_FORWARD_DELAY_MS,
  PRESS_FORWARD_SLOP_PX,
  PressForwardDetector,
} from './press-forward';

describe('PressForwardDetector', () => {
  it('engages after a still hold past the delay', () => {
    const detector = new PressForwardDetector();
    detector.begin(1, 100, 100, 1_000);
    expect(detector.active(1_000 + PRESS_FORWARD_DELAY_MS)).toBe(false);
    expect(detector.active(1_000 + PRESS_FORWARD_DELAY_MS + 1)).toBe(true);
  });

  it('ignores jitter inside the slop disk', () => {
    const detector = new PressForwardDetector();
    detector.begin(1, 100, 100, 1_000);
    detector.move(1, 100 + PRESS_FORWARD_SLOP_PX, 100, 1_100);
    expect(detector.active(1_000 + PRESS_FORWARD_DELAY_MS + 1)).toBe(true);
  });

  it('does not engage when the press looks around first', () => {
    const detector = new PressForwardDetector();
    detector.begin(1, 100, 100, 1_000);
    detector.move(1, 100 + PRESS_FORWARD_SLOP_PX + 0.1, 100, 1_100);
    expect(detector.active(1_000 + PRESS_FORWARD_DELAY_MS + 1)).toBe(false);
  });

  it('keeps moving forward after a still hold, even if the pointer then looks around', () => {
    const detector = new PressForwardDetector();
    detector.begin(1, 100, 100, 1_000);
    expect(detector.active(1_400)).toBe(true);
    detector.move(1, 180, 40, 1_450);
    expect(detector.active(1_500)).toBe(true);
  });

  it('promotes on the move that crosses the delay so a later look does not cancel', () => {
    const detector = new PressForwardDetector();
    detector.begin(1, 100, 100, 1_000);
    detector.move(1, 160, 80, 1_000 + PRESS_FORWARD_DELAY_MS + 1);
    expect(detector.active(1_400)).toBe(true);
  });

  it('ignores other pointers and resets on cancellation', () => {
    const detector = new PressForwardDetector();
    detector.begin(1, 10, 10, 1_000);
    detector.move(2, 80, 80, 1_100);
    detector.cancel(2);
    expect(detector.active(1_400)).toBe(true);
    detector.cancel(1);
    expect(detector.active(1_500)).toBe(false);
  });
});
