import { describe, expect, it } from 'vitest';
import { isPageTableFoveation, resolveSplatFoveationMode } from '../core/splat-mesh-types';

describe('page-table foveation spelling', () => {
  it('accepts only the canonical page-table spelling', () => {
    expect(resolveSplatFoveationMode('page-table')).toBe('page-table');
    expect(resolveSplatFoveationMode(undefined)).toBe('band');
    expect(isPageTableFoveation('page-table')).toBe(true);
    expect(isPageTableFoveation('pagetable')).toBe(false);
    expect(isPageTableFoveation('frontier')).toBe(false);
  });
});
