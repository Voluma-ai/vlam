import { describe, expect, it } from 'vitest';
import { isViewerToolAvailable, normalizeViewerTool, parseViewerTool } from '../tool-picker';

describe('parseViewerTool', () => {
  it('accepts known tools', () => {
    expect(parseViewerTool('none')).toBe('none');
    expect(parseViewerTool('paint')).toBe('paint');
    expect(parseViewerTool('annotate')).toBe('annotate');
    expect(parseViewerTool('measure')).toBe('measure');
    expect(parseViewerTool('select')).toBe('select');
  });

  it('rejects unknown or missing values', () => {
    expect(parseViewerTool(null)).toBeNull();
    expect(parseViewerTool(undefined)).toBeNull();
    expect(parseViewerTool('')).toBeNull();
    expect(parseViewerTool('cut')).toBeNull();
  });
});

describe('streamed tool availability', () => {
  it('hides editing tools but keeps pick-only tools available', () => {
    expect(isViewerToolAvailable('paint', true)).toBe(false);
    expect(isViewerToolAvailable('select', true)).toBe(false);
    expect(isViewerToolAvailable('annotate', true)).toBe(true);
    expect(isViewerToolAvailable('measure', true)).toBe(true);
    expect(isViewerToolAvailable('none', true)).toBe(true);
  });

  it('keeps every tool available for fully loaded scenes', () => {
    for (const tool of ['none', 'paint', 'annotate', 'measure', 'select'] as const) {
      expect(isViewerToolAvailable(tool, false)).toBe(true);
    }
  });

  it('normalizes unsupported streamed deep links to camera controls', () => {
    expect(normalizeViewerTool('paint', true)).toBe('none');
    expect(normalizeViewerTool('select', true)).toBe('none');
    expect(normalizeViewerTool('measure', true)).toBe('measure');
    expect(normalizeViewerTool('paint', false)).toBe('paint');
  });
});
