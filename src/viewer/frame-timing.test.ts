import { describe, expect, it } from 'vitest';
import { estimateRefreshMetrics } from './frame-timing';

describe('estimateRefreshMetrics', () => {
  it('uses an explicit refresh rate before the screen rate', () => {
    expect(
      estimateRefreshMetrics([16.7, 33.4, 50.1], { refreshHz: 60, screenRefreshRate: 120 }),
    ).toEqual({
      observedCallbackCadenceMs: 16.7,
      displayRefreshMs: 1000 / 60,
      missedRefreshOpportunities: 3,
      refreshSource: 'provided',
    });
  });

  it.each([
    [60, 1000 / 60],
    [90, 1000 / 90],
    [120, 1000 / 120],
  ])('normalizes a provided %d Hz cadence', (refreshHz, displayRefreshMs) => {
    expect(estimateRefreshMetrics([displayRefreshMs], { refreshHz })).toMatchObject({
      observedCallbackCadenceMs: displayRefreshMs,
      displayRefreshMs,
      refreshSource: 'provided',
      missedRefreshOpportunities: 0,
    });
  });

  it('uses screen refresh when no override is provided', () => {
    expect(estimateRefreshMetrics([16.7, 33.4], { screenRefreshRate: 90 })).toMatchObject({
      displayRefreshMs: 1000 / 90,
      refreshSource: 'screen',
      missedRefreshOpportunities: 3,
    });
  });

  it.each([60, 90, 120])('normalizes a screen refresh rate of %d Hz', (screenRefreshRate) => {
    expect(estimateRefreshMetrics([1000 / screenRefreshRate], { screenRefreshRate })).toMatchObject(
      {
        observedCallbackCadenceMs: 1000 / screenRefreshRate,
        displayRefreshMs: 1000 / screenRefreshRate,
        refreshSource: 'screen',
        missedRefreshOpportunities: 0,
      },
    );
  });

  it('reports callback cadence without inferring a display rate', () => {
    expect(estimateRefreshMetrics([16.7, 16.8, 33.4, 50.1])).toEqual({
      observedCallbackCadenceMs: 16.7,
      displayRefreshMs: null,
      missedRefreshOpportunities: null,
      refreshSource: 'unavailable',
    });
  });

  it.each([
    [20, 16.7],
    [241, 16.7],
  ])('rejects an invalid supplied rate %d Hz', (refreshHz, frameMs) => {
    expect(estimateRefreshMetrics([frameMs, frameMs], { refreshHz })).toEqual({
      observedCallbackCadenceMs: frameMs,
      displayRefreshMs: null,
      missedRefreshOpportunities: null,
      refreshSource: 'unavailable',
    });
  });

  it('reports a 60 FPS callback stream without missed-refresh totals', () => {
    expect(estimateRefreshMetrics([1000 / 60, 1000 / 60, 1000 / 60])).toEqual({
      observedCallbackCadenceMs: 1000 / 60,
      displayRefreshMs: null,
      missedRefreshOpportunities: null,
      refreshSource: 'unavailable',
    });
  });

  it.each([[33.3], [50], [1008]])(
    'reports slow callback cadence without display refresh',
    (frameMs) => {
      expect(estimateRefreshMetrics([frameMs, frameMs, frameMs])).toEqual({
        observedCallbackCadenceMs: frameMs,
        displayRefreshMs: null,
        missedRefreshOpportunities: null,
        refreshSource: 'unavailable',
      });
    },
  );

  it('returns unavailable for an empty sample without a refresh reference', () => {
    expect(estimateRefreshMetrics([])).toEqual({
      observedCallbackCadenceMs: null,
      displayRefreshMs: null,
      missedRefreshOpportunities: null,
      refreshSource: 'unavailable',
    });
  });
});
