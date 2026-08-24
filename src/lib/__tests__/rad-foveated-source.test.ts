import { describe, expect, it } from 'vitest';
import { RadFoveatedSource } from '../formats/rad/rad-foveated-source';
import type { SplatData } from '../splat-data';

/** Isotropic covariance whose trace gives `own_size = 2·√(trace/3) = size`. */
function isoCovariance(size: number): number[] {
  const variance = (size / 2) ** 2; // per-axis; trace = 3·variance ⇒ own_size = size
  return [variance, 0, 0, variance, 0, variance];
}

/** Minimal decoded `.rad` chunk `SplatData` with a LOD tree. */
function chunk(nodes: { size: number; childCount: number; childStart: number }[]): SplatData {
  const count = nodes.length;
  const covariances = new Float32Array(count * 6);
  nodes.forEach((n, i) => covariances.set(isoCovariance(n.size), i * 6));
  return {
    count,
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4),
    covariances,
    radTree: {
      childCount: Uint16Array.from(nodes.map((n) => n.childCount)),
      childStart: Uint32Array.from(nodes.map((n) => n.childStart)),
      size: new Float32Array(count), // unused by the cut (own_size comes from covariance)
    },
  };
}

describe('RadFoveatedSource frontier parent_size', () => {
  it('packs each splat parent size with a leaf sign, deriving own_size from covariance', () => {
    const source = new RadFoveatedSource(2, [2, 2], {
      budget: 100,
      lodBaseDistance: 1,
      lodMultiplier: 2,
    });

    // Chunk 0: splat 0 is internal (own_size 4), its one child is global index 2
    // (chunk 1, local 0); splat 1 is a leaf. Neither has a parent here.
    const c0 = chunk([
      { size: 4, childCount: 1, childStart: 2 },
      { size: 2, childCount: 0, childStart: 0 },
    ]);
    source.onChunkDecoded(0, c0);
    // Internal → +sentinel (root), leaf → −sentinel (the sentinel rounds under
    // Float32 storage, so bound rather than equality-check it).
    expect(c0.frontierParent?.[0]).toBeGreaterThan(1e29);
    expect(c0.frontierParent?.[1]).toBeLessThan(-1e29);

    // Chunk 1: local 0 is that child (leaf) → parent size = chunk 0 splat 0's
    // own_size (4), sign-flipped for a leaf; local 1 is an unrelated leaf.
    const c1 = chunk([
      { size: 9, childCount: 0, childStart: 0 },
      { size: 9, childCount: 0, childStart: 0 },
    ]);
    source.onChunkDecoded(1, c1);
    expect(c1.frontierParent?.[0]).toBeCloseTo(-4, 5);
    // local 1 has no known parent in a later chunk (file > 0), so it falls back
    // to own_size (9) · merge ratio 1.75 = 15.75, sign-flipped for a leaf.
    expect(c1.frontierParent?.[1]).toBeCloseTo(-15.75, 4);
  });
});
