import { describe, expect, it } from 'vitest';
// @ts-expect-error This Node-only runner helper is deliberately plain ESM.
import {
  classifyBenchmarkFailures,
  parseMemoryMode,
  sampleSchedule,
  stopToEquivalentMs,
} from '../../../scripts/rad-detail-benchmark-policy.mjs';

describe('RAD detail benchmark policy', () => {
  it('defaults memory sampling off and rejects unknown modes', () => {
    expect(parseMemoryMode(undefined)).toBe('off');
    expect(parseMemoryMode('off')).toBe('off');
    expect(parseMemoryMode('sample')).toBe('sample');
    expect(() => {
      parseMemoryMode('on');
    }).toThrow(/off\|sample/);
  });

  it('keeps interior 60 s points and always ends on the requested sampleMs', () => {
    expect(sampleSchedule(20_000).at(-1)).toBe(20_000);
    expect(sampleSchedule(20_000)).not.toContain(30_000);
    expect(sampleSchedule(60_000).at(-1)).toBe(60_000);
    expect(sampleSchedule(90_000).at(-1)).toBe(90_000);
    expect(sampleSchedule(90_000)).toContain(60_000);
    expect(sampleSchedule(120_000).at(-1)).toBe(120_000);
  });

  it('records page, device, streaming, and missing first-image failures', () => {
    expect(
      classifyBenchmarkFailures({
        pageErrors: ['boom'],
        deviceLost: 'out of memory',
        streamingError: 'decode failed',
        sawFirstImage: false,
      }),
    ).toEqual(['boom', 'no first image', 'device lost: out of memory', 'streaming: decode failed']);
  });

  it('withholds arrival numbers from failed or unfinished runs', () => {
    const samples = [{ elapsedMs: 250 }, { elapsedMs: 500 }];
    expect(
      stopToEquivalentMs({
        failures: [],
        referenceStillPending: false,
        firstEquivalent: 1,
        samples,
      }),
    ).toBe(500);
    expect(
      stopToEquivalentMs({
        failures: ['device lost: unknown'],
        referenceStillPending: false,
        firstEquivalent: 0,
        samples,
      }),
    ).toBeNull();
    expect(
      stopToEquivalentMs({
        failures: [],
        referenceStillPending: true,
        firstEquivalent: 0,
        samples,
      }),
    ).toBeNull();
  });
});
