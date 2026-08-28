import { describe, expect, it } from 'vitest';
import { isPageTableFoveation, resolveSplatFoveationMode } from '../splat-mesh-types';

describe('page-table foveation spelling', () => {
  it('normalizes the deprecated pagetable spelling to page-table', () => {
    expect(resolveSplatFoveationMode('page-table')).toBe('page-table');
    expect(resolveSplatFoveationMode('pagetable')).toBe('page-table');
    expect(isPageTableFoveation('page-table')).toBe(true);
    expect(isPageTableFoveation('pagetable')).toBe(true);
    expect(isPageTableFoveation('frontier')).toBe(false);
  });
});
