import { describe, expect, it } from 'vitest';

import { formatBytes, loadingOverlayText, loadingPercent, loadingPill } from './loading-status';

describe('formatBytes', () => {
  it('picks a unit that fits the magnitude', () => {
    expect(formatBytes(400)).toBe('400 B');
    expect(formatBytes(12_400)).toBe('12 KB');
    expect(formatBytes(540_000_000)).toBe('540 MB');
    expect(formatBytes(1_700_000_000)).toBe('1.7 GB');
  });
});

describe('loadingPercent', () => {
  it('is null until a known total arrives', () => {
    expect(loadingPercent(null)).toBeNull();
    expect(loadingPercent({ loaded: 10, total: 0 })).toBeNull();
  });

  it('floors in-flight reads and only reports 100% when complete', () => {
    expect(loadingPercent({ loaded: 0, total: 100 })).toBe(0);
    expect(loadingPercent({ loaded: 23, total: 100 })).toBe(23);
    expect(loadingPercent({ loaded: 995, total: 1000 })).toBe(99);
    expect(loadingPercent({ loaded: 1000, total: 1000 })).toBe(100);
  });
});

describe('loadingOverlayText', () => {
  it('names the file and stays a spinner with no bytes yet', () => {
    expect(loadingOverlayText('splat.ply', null)).toBe('Loading splat.ply…');
  });

  it('shows percent while the size is known and switches to decoding at 100%', () => {
    expect(loadingOverlayText('splat.ply', { loaded: 150_000_000, total: 650_000_000 })).toBe(
      'Loading splat.ply… 23%',
    );
    expect(loadingOverlayText('splat.ply', { loaded: 650_000_000, total: 650_000_000 })).toBe(
      'Decoding splat.ply…',
    );
  });

  it('falls back to bytes read when Content-Length is missing', () => {
    expect(loadingOverlayText('splat.ply', { loaded: 45_000_000, total: 0 })).toBe(
      'Loading splat.ply… 45 MB',
    );
  });
});

describe('loadingPill', () => {
  it('hides the bar until a total is known', () => {
    expect(loadingPill(null)).toEqual({ text: 'Loading…', fraction: null });
    expect(loadingPill({ loaded: 45_000_000, total: 0 })).toEqual({
      text: 'Reading 45 MB…',
      fraction: null,
    });
  });

  it('fills the bar with percent and byte counts', () => {
    expect(loadingPill({ loaded: 150_000_000, total: 650_000_000 })).toEqual({
      text: '23% · 150 MB / 650 MB',
      fraction: 0.23,
    });
    expect(loadingPill({ loaded: 650_000_000, total: 650_000_000 })).toEqual({
      text: 'Decoding…',
      fraction: 1,
    });
  });
});
