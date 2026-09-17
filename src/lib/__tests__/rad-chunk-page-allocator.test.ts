import { describe, expect, it } from 'vitest';
import { RadChunkPageAllocator } from '../formats/rad/rad-chunk-page-allocator';

describe('RAD chunk page allocator', () => {
  it('keeps a chunk contiguous and stable until it is released', () => {
    const pages = new RadChunkPageAllocator(2, 4);

    expect(pages.allocate(3, 4)).toBe(0);
    expect(pages.poolSlot(3 * 4 + 2)).toBe(2);
    expect(pages.allocate(3, 4)).toBe(0);
    expect(pages.poolSlots(Uint32Array.from([12, 15]))).toEqual(Uint32Array.from([0, 3]));
  });

  it('reuses only released pages and rejects nodes outside a chunk', () => {
    const pages = new RadChunkPageAllocator(1, 4);

    expect(pages.allocate(0, 3)).toBe(0);
    expect(pages.allocate(1, 4)).toBeUndefined();
    expect(pages.poolSlot(3)).toBeUndefined();
    expect(pages.release(0)).toBe(true);
    expect(pages.allocate(1, 4)).toBe(0);
    expect(pages.residentFiles).toEqual([1]);
  });

  it('fails a selection atomically when one referenced page is absent', () => {
    const pages = new RadChunkPageAllocator(2, 4);
    pages.allocate(0, 4);

    expect(pages.poolSlots(Uint32Array.from([0, 4]))).toBeNull();
  });
});
