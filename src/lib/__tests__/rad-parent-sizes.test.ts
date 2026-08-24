import { describe, expect, it } from 'vitest';
import { RadParentSizes } from '../formats/rad/rad-parent-sizes';

/**
 * A 3-chunk tree (chunkSize 4): g0→[4,6), g1→[6,8), g6→[8,10) are internal,
 * the rest leaves. Node sizes chosen distinct so parent sizes are checkable.
 */
const CHUNKS = [
  { count: [2, 2, 0, 0], start: [4, 6, 0, 0], size: [10, 11, 5, 5] },
  { count: [0, 0, 2, 0], start: [0, 0, 8, 0], size: [4, 4, 6, 4] },
  { count: [0, 0, 0, 0], start: [0, 0, 0, 0], size: [2, 2, 2, 2] },
];

function resolve(p: RadParentSizes, chunk: number): number[] {
  const c = CHUNKS[chunk]!;
  return Array.from(
    p.resolve(
      chunk,
      Uint16Array.from(c.count),
      Uint32Array.from(c.start),
      Float32Array.from(c.size),
    ),
  );
}

describe('RadParentSizes', () => {
  it('propagates parent sizes to children decoded after their parent', () => {
    const p = new RadParentSizes(4);
    expect(resolve(p, 0)).toEqual([Infinity, Infinity, Infinity, Infinity]);
    // g4,g5 are g0's children (size 10); g6,g7 are g1's children (size 11).
    expect(resolve(p, 1)).toEqual([10, 10, 11, 11]);
    // g8,g9 are g6's children (size 6); g10,g11 have no parent here.
    expect(resolve(p, 2)).toEqual([6, 6, Infinity, Infinity]);
  });

  it('falls back to Infinity when a child decodes before its parent', () => {
    const p = new RadParentSizes(4);
    // Chunk 2 before chunk 1: g6 (g8/g9's parent) is not known yet.
    expect(resolve(p, 2)).toEqual([Infinity, Infinity, Infinity, Infinity]);
    // Chunk 1 now decodes; its own parents (chunk 0) are still unknown.
    expect(resolve(p, 1)).toEqual([Infinity, Infinity, Infinity, Infinity]);
    // Chunk 0 last: its ranges for the already-resolved chunk 1 are dropped,
    // not leaked, and it has no parents itself.
    expect(resolve(p, 0)).toEqual([Infinity, Infinity, Infinity, Infinity]);
  });

  it('handles a child range that straddles a chunk boundary', () => {
    const p = new RadParentSizes(4);
    // One internal node whose 2 children are g3 (chunk 0) and g4 (chunk 1).
    p.resolve(
      0,
      Uint16Array.from([2, 0, 0, 0]),
      Uint32Array.from([3, 0, 0, 0]),
      Float32Array.from([9, 0, 0, 0]),
    );
    // Chunk 1's g4 (local 0) inherits parent size 9; the rest are unknown.
    const parents = Array.from(
      p.resolve(
        1,
        Uint16Array.from([0, 0, 0, 0]),
        Uint32Array.from([0, 0, 0, 0]),
        Float32Array.from([1, 1, 1, 1]),
      ),
    );
    expect(parents[0]).toBe(9);
    expect(parents.slice(1)).toEqual([Infinity, Infinity, Infinity]);
  });
});
