import { describe, expect, it } from 'vitest';
import { parseViewerTool } from '../tool-picker';

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
