import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  MAX_LIVE_OPACITY_RANGES,
  isFractionalOpacity,
  resolveGatherOpacity,
  writeLiveOpacityRanges,
} from '../unified/live-opacity';

const table = () => Array.from({ length: MAX_LIVE_OPACITY_RANGES }, () => new THREE.Vector4());

describe('live opacity', () => {
  it('bakes only drawability for live sources and the full value otherwise', () => {
    expect(resolveGatherOpacity(0.3, true)).toBe(1);
    expect(resolveGatherOpacity(0, true)).toBe(0);
    expect(resolveGatherOpacity(0.3, false)).toBe(0.3);
    expect(isFractionalOpacity(0.5)).toBe(true);
    expect(isFractionalOpacity(1)).toBe(false);
    expect(isFractionalOpacity(0)).toBe(false);
  });

  it('writes a range only for slices whose display opacity differs from the gather', () => {
    const ranges = table();
    const count = writeLiveOpacityRanges(
      [
        { offset: 0, activeCount: 10, gatheredOpacity: 1, currentOpacity: 1 },
        { offset: 10, activeCount: 5, gatheredOpacity: 1, currentOpacity: 0.25 },
        // Baked slice whose source moved on a held frame: corrected by ratio.
        { offset: 15, activeCount: 4, gatheredOpacity: 0.5, currentOpacity: 0.4 },
        // Culled by its gather: a scale cannot revive it.
        { offset: 19, activeCount: 3, gatheredOpacity: 0, currentOpacity: 0.7 },
      ],
      ranges,
    );
    expect(count).toBe(2);
    expect(ranges[0]!.toArray()).toEqual([10, 15, 0.25, 0]);
    expect(ranges[1]!.x).toBe(15);
    expect(ranges[1]!.y).toBe(19);
    expect(ranges[1]!.z).toBeCloseTo(0.8, 10);
  });

  it('fades a gathered slice out to zero and stops at the table capacity', () => {
    const ranges = table();
    const slices = Array.from({ length: MAX_LIVE_OPACITY_RANGES + 3 }, (_, i) => ({
      offset: i,
      activeCount: 1,
      gatheredOpacity: 1,
      currentOpacity: i === 0 ? -1 : 0.5,
    }));
    expect(writeLiveOpacityRanges(slices, ranges)).toBe(MAX_LIVE_OPACITY_RANGES);
    expect(ranges[0]!.z).toBe(0);
  });
});
