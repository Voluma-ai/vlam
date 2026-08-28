import { describe, expect, it } from 'vitest';

import {
  SPLAT_DATA_TEXTURE_WIDTH,
  SplatPool,
  type SplatPoolRange,
  type SplatPoolTenant,
} from '../core/splat-mesh-pool';

/** A tenant that records what the pool told it, standing in for a mesh. */
class FakeTenant implements SplatPoolTenant {
  readonly ranges: SplatPoolRange[] = [];
  compactedCount = 0;
  readonly relocations: { from: number; to: number }[] = [];

  constructor(private readonly pool: SplatPool) {
    pool.register(this);
  }

  /** Allocates and remembers a range, as a mesh's appendRange would. */
  take(rowCount: number): SplatPoolRange {
    const range = { startRow: this.pool.allocateRows(rowCount), rowCount };
    this.ranges.push(range);
    return range;
  }

  poolRanges(): Iterable<SplatPoolRange> {
    return this.ranges;
  }
  relocatePoolRange(range: SplatPoolRange, targetRow: number): void {
    this.relocations.push({ from: range.startRow, to: targetRow });
    range.startRow = targetRow;
  }
  onPoolCompacted(): void {
    this.compactedCount++;
  }
}

/**
 * `SplatPool` is the storage a mesh draws from, split out of `SplatMesh` so it
 * can eventually back more than one. These tests pin the contract the sharing
 * work depends on: row-aligned capacity, an allocator that never hands the same
 * row out twice, and textures whose geometry matches the backing arrays.
 */
describe('SplatPool', () => {
  const W = SPLAT_DATA_TEXTURE_WIDTH;

  it('rounds capacity up to whole rows and sizes every backing array to match', () => {
    const pool = new SplatPool({ capacity: W + 1 });
    expect(pool.rows).toBe(2);
    expect(pool.capacity).toBe(2 * W);

    const texels = pool.capacity * 4;
    expect(pool.backing.centers).toHaveLength(texels);
    expect(pool.backing.colors).toHaveLength(texels);
    expect(pool.backing.covarianceA).toHaveLength(texels);
    expect(pool.backing.covarianceB).toHaveLength(texels);
    // Every core texture spans the same rows, so one row index addresses them all.
    for (const texture of pool.coreTextures) {
      expect(texture.image.width).toBe(W);
      expect(texture.image.height).toBe(pool.rows);
    }
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new SplatPool({ capacity: 0 })).toThrow(/positive/);
    expect(() => new SplatPool({ capacity: -1 })).toThrow(/positive/);
  });

  /**
   * A pool taller than `maxTextureDimension2D` cannot create a single one of its
   * data textures, and every bind group built from them stays invalid for the
   * rest of the session - a black canvas behind an unreadable cascade of WebGPU
   * "invalid due to a previous error" messages. `SplatMesh.update` checks this
   * too, but only once and only if it is ever reached, so a caller that knows
   * the limit gets to fail here instead: before the allocation, and unskippably.
   */
  it('rejects a pool taller than the device texture limit', () => {
    expect(() => new SplatPool({ capacity: W * 3, maxTextureSize: 2 })).toThrow(
      /needs a 2048×3 data texture/,
    );
    // Exactly at the limit is legal - the check is on rows, not capacity.
    expect(() => new SplatPool({ capacity: W * 2, maxTextureSize: 2 })).not.toThrow();
  });

  it('skips the texture-limit check when the limit is unknown', () => {
    // 0 or omitted means "could not be read"; rejecting then would fail a load
    // the device would have rendered perfectly well.
    expect(() => new SplatPool({ capacity: W * 3, maxTextureSize: 0 })).not.toThrow();
    expect(() => new SplatPool({ capacity: W * 3 })).not.toThrow();
  });

  it('allocates disjoint rows and reclaims them on release', () => {
    const pool = new SplatPool({ capacity: 10 * W });
    expect(pool.freeRows).toBe(10);

    const a = pool.allocateRows(4);
    const b = pool.allocateRows(3);
    expect(a).toBe(0);
    expect(b).toBe(4);
    // Disjoint: b starts where a ends, so no row is handed out twice.
    expect(b).toBeGreaterThanOrEqual(a + 4);
    expect(pool.freeRows).toBe(3);

    pool.releaseRows(a, 4);
    expect(pool.freeRows).toBe(7);
    // The freed span coalesces with the tail, so a request larger than either
    // fragment alone still succeeds - the property compaction exists to protect.
    expect(() => pool.allocateRows(4)).not.toThrow();
  });

  it('throws when no contiguous span is left, which is the caller cue to compact', () => {
    const pool = new SplatPool({ capacity: 4 * W });
    pool.allocateRows(2);
    const middle = pool.allocateRows(1);
    pool.allocateRows(1);
    pool.releaseRows(middle, 1);
    // One free row exists, but not two contiguous ones.
    expect(pool.freeRows).toBe(1);
    expect(() => pool.allocateRows(2)).toThrow(/capacity exceeded/);
  });

  it('resets the free list to a single span, optionally from a row', () => {
    const pool = new SplatPool({ capacity: 8 * W });
    pool.allocateRows(5);
    pool.resetFreeRows(3);
    expect(pool.freeRowSpans).toEqual([{ start: 3, count: 5 }]);
    // Resetting past the end leaves nothing free rather than a negative span.
    pool.resetFreeRows(8);
    expect(pool.freeRowSpans).toEqual([]);
    expect(pool.freeRows).toBe(0);
  });

  it('allocates float16 images without dropping the float32 backing', () => {
    const pool = new SplatPool({ capacity: W, floatTextures: 'float16' });
    expect(pool.floatTextures).toBe('float16');
    // The backing stays authoritative and full precision; only the texture
    // images are half, which is why float16 saves GPU bytes and not CPU ones.
    expect(pool.backing.centers).toBeInstanceOf(Float32Array);
    expect(pool.backing.covarianceA).toBeInstanceOf(Float32Array);
    expect(pool.centersTexture.image.data).toBeInstanceOf(Uint16Array);
    expect(pool.covarianceATexture.image.data).toBeInstanceOf(Uint16Array);
    // covarianceB packs integer IDs, so it stays float32 either way.
    expect(pool.covarianceBTexture.image.data).toBeInstanceOf(Float32Array);
  });

  it('compacts across every tenant, not just the one that ran out of room', () => {
    const pool = new SplatPool({ capacity: 10 * W });
    const a = new FakeTenant(pool);
    const b = new FakeTenant(pool);
    expect(pool.tenantCount).toBe(2);

    // Interleave two tenants in one address space, then free a middle range of
    // each so the pool is fragmented but not full.
    const a0 = a.take(2); // rows 0-1
    const b0 = b.take(2); // rows 2-3
    const a1 = a.take(2); // rows 4-5
    const b1 = b.take(2); // rows 6-7
    expect([a0.startRow, b0.startRow, a1.startRow, b1.startRow]).toEqual([0, 2, 4, 6]);

    pool.releaseRows(a0.startRow, a0.rowCount);
    a.ranges.splice(a.ranges.indexOf(a0), 1);
    pool.releaseRows(a1.startRow, a1.rowCount);
    a.ranges.splice(a.ranges.indexOf(a1), 1);

    pool.compact();

    // B's rows moved even though A is the one that fragmented the pool - the
    // whole-pool stall that a shared pool has to accept.
    expect(b0.startRow).toBe(0);
    expect(b1.startRow).toBe(2);
    expect(b.relocations).toEqual([
      { from: 2, to: 0 },
      { from: 6, to: 2 },
    ]);
    // Every tenant rebuilds, including the one that moved nothing.
    expect(a.compactedCount).toBe(1);
    expect(b.compactedCount).toBe(1);
    // Free space is contiguous again, so a request the fragmented pool could
    // not satisfy now succeeds.
    expect(pool.freeRowSpans).toEqual([{ start: 4, count: 6 }]);
    expect(() => pool.allocateRows(6)).not.toThrow();
  });

  it('preserves each tenant’s splat data through a compaction', () => {
    const pool = new SplatPool({ capacity: 4 * W });
    const a = new FakeTenant(pool);
    const b = new FakeTenant(pool);
    const a0 = a.take(1);
    const b0 = b.take(1);

    // Tag the first splat of each range so we can follow it across the move.
    pool.backing.centers[a0.startRow * W * 4] = 11;
    pool.backing.centers[b0.startRow * W * 4] = 22;
    pool.backing.colors[b0.startRow * W * 4] = 200;

    pool.releaseRows(a0.startRow, a0.rowCount);
    a.ranges.splice(0, 1);
    pool.compact();

    // B's data followed B's range to row 0 - the pool moves the splats, the
    // tenant only adopts the new start.
    expect(b0.startRow).toBe(0);
    expect(pool.backing.centers[0]).toBe(22);
    expect(pool.backing.colors[0]).toBe(200);
  });

  it('refuses to compact when a tenant left rows behind', () => {
    const pool = new SplatPool({ capacity: 4 * W });
    const a = new FakeTenant(pool);
    const b = new FakeTenant(pool);
    a.take(1);
    b.take(1);

    // Unregistering without releasing hides B's rows from the pool. Packing
    // now would move A on top of them and then report them free, handing the
    // same rows out twice - so it throws instead.
    pool.unregister(b);
    expect(pool.tenantCount).toBe(1);
    expect(() => pool.compact()).toThrow(/unaccounted row/);

    // Releasing them first is the correct teardown, and compaction resumes.
    pool.releaseRows(1, 1);
    expect(() => pool.compact()).not.toThrow();
    expect(a.compactedCount).toBe(1);
  });

  it('allocates one packed-SH texture per requested texture slot', () => {
    const none = new SplatPool({ capacity: W });
    expect(none.shPackedTextures).toHaveLength(0);
    expect(none.backing.shPacked).toHaveLength(0);

    const three = new SplatPool({ capacity: W, packedShBands: 3, packedShTextureCount: 4 });
    expect(three.packedShBands).toBe(3);
    expect(three.shPackedTextures).toHaveLength(4);
    expect(three.backing.shPacked).toHaveLength(4);
    for (const data of three.backing.shPacked) expect(data).toHaveLength(three.capacity * 4);
  });
});
