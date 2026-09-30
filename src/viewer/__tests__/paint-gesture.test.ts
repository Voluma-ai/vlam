import { describe, expect, it } from 'vitest';
import { PaintGestures } from '../paint-gesture';

describe('paint gesture ownership', () => {
  it('rejects delayed results from a previous mouse press with the same pointer ID', () => {
    const gestures = new PaintGestures<object, object>();
    const source = {},
      tool = {};
    const first = gestures.begin(1, source, tool, 0, 0);
    first.released = true;
    const second = gestures.begin(1, source, tool, 10, 20);
    gestures.move(1, 11, 21);
    gestures.move(1, 12, 22);
    expect(gestures.owns(first)).toBe(false);
    expect(gestures.owns(second)).toBe(true);
    expect(second.samples.map((point) => point.toArray())).toEqual([
      [10, 20],
      [11, 21],
      [12, 22],
    ]);
    expect(first.samples).toHaveLength(1);
  });
  it('invalidates callbacks on cancellation, scene replacement and tool changes', () => {
    const gestures = new PaintGestures<object, object>();
    for (const cancel of [() => gestures.cancel(1), () => gestures.cancel()]) {
      const gesture = gestures.begin(1, {}, {}, 0, 0);
      cancel();
      expect(gestures.owns(gesture)).toBe(false);
    }
  });
});
