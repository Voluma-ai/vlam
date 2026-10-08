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
  readonly relocations: { from: number; to: number; movedOnGpu?: boolean }[] = [];
  /** Rows this tenant reports as already current on the GPU; null = hook absent. */
  gpuResident: ((startRow: number, rowCount: number) => boolean) | null = null;

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
  relocatePoolRange(range: SplatPoolRange, targetRow: number, movedOnGpu?: boolean): void {
    this.relocations.push({
      from: range.startRow,
      to: targetRow,
      ...(movedOnGpu === undefined ? {} : { movedOnGpu }),
    });
    range.startRow = targetRow;
  }
  poolRowsResidentOnGpu(startRow: number, rowCount: number): boolean {
    return this.gpuResident?.(startRow, rowCount) ?? false;
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
      { from: 2, to: 0, movedOnGpu: false },
      { from: 6, to: 2, movedOnGpu: false },
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

/** A WebGPU renderer stand-in whose device records copy commands. */
function fakeWebGpuRenderer(pool: SplatPool, format = 'rgba32float') {
  const copies: { kind: 'toBuffer' | 'toTexture'; texture: string; y: number; rows: number }[] = [];
  const submits: unknown[] = [];
  const gpuTextures = new Map<object, { label: string; format: string }>();
  [...pool.coreTextures, ...pool.shPackedTextures].forEach((texture, i) =>
    gpuTextures.set(texture, { label: `t${i}`, format: i === 1 ? 'rgba8unorm' : format }),
  );
  const device = {
    createBuffer: (descriptor: { size: number }) => ({ size: descriptor.size, destroy: () => {} }),
    createCommandEncoder: () => ({
      copyTextureToBuffer: (
        src: { texture: { label: string }; origin: { y: number } },
        _l: unknown,
        size: { height: number },
      ) =>
        copies.push({
          kind: 'toBuffer',
          texture: src.texture.label,
          y: src.origin.y,
          rows: size.height,
        }),
      copyBufferToTexture: (
        _l: unknown,
        dst: { texture: { label: string }; origin: { y: number } },
        size: { height: number },
      ) =>
        copies.push({
          kind: 'toTexture',
          texture: dst.texture.label,
          y: dst.origin.y,
          rows: size.height,
        }),
      finish: () => ({}),
    }),
    queue: { submit: (buffers: unknown[]) => submits.push(...buffers) },
  };
  const renderer = {
    backend: {
      isWebGPUBackend: true,
      device,
      has: (texture: object) => gpuTextures.has(texture),
      get: (texture: object) => ({ texture: gpuTextures.get(texture) }),
    },
    initTexture: () => {},
  };
  return { renderer: renderer as never, copies, submits };
}

describe('SplatPool.compact GPU relocation', () => {
  const W = SPLAT_DATA_TEXTURE_WIDTH;

  /** Rows 0-1 freed, B at rows 2-3 and 6-7 (A's 4-5 freed too). */
  const fragmented = () => {
    const pool = new SplatPool({ capacity: 10 * W });
    const a = new FakeTenant(pool);
    const b = new FakeTenant(pool);
    const a0 = a.take(2);
    const b0 = b.take(2);
    const a1 = a.take(2);
    const b1 = b.take(2);
    for (const range of [a0, a1]) {
      pool.releaseRows(range.startRow, range.rowCount);
      a.ranges.splice(a.ranges.indexOf(range), 1);
    }
    return { pool, a, b, b0, b1 };
  };

  it('moves GPU-resident rows on the GPU in one submission instead of re-uploading them', () => {
    const { pool, b, b0, b1 } = fragmented();
    b.gpuResident = () => true;
    const gpu = fakeWebGpuRenderer(pool);

    pool.compact(gpu.renderer);

    expect([b0.startRow, b1.startRow]).toEqual([0, 2]);
    expect(b.relocations).toEqual([
      { from: 2, to: 0, movedOnGpu: true },
      { from: 6, to: 2, movedOnGpu: true },
    ]);
    expect(gpu.submits).toHaveLength(1);
    // Each move stages every core texture through the scratch buffer, front to back.
    const centers = gpu.copies.filter((copy) => copy.texture === 't0');
    expect(centers).toEqual([
      { kind: 'toBuffer', texture: 't0', y: 2, rows: 2 },
      { kind: 'toTexture', texture: 't0', y: 0, rows: 2 },
      { kind: 'toBuffer', texture: 't0', y: 6, rows: 2 },
      { kind: 'toTexture', texture: 't0', y: 2, rows: 2 },
    ]);
    expect(new Set(gpu.copies.map((copy) => copy.texture))).toEqual(
      new Set(['t0', 't1', 't2', 't3']),
    );
  });

  it('keeps the CPU re-upload for rows whose latest writes have not reached the GPU', () => {
    const { pool, b } = fragmented();
    // The range at row 6 has a pending upload; the one at row 2 is current.
    b.gpuResident = (startRow) => startRow !== 6;
    const gpu = fakeWebGpuRenderer(pool);

    pool.compact(gpu.renderer);

    expect(b.relocations).toEqual([
      { from: 2, to: 0, movedOnGpu: true },
      { from: 6, to: 2, movedOnGpu: false },
    ]);
    expect(gpu.copies.every((copy) => copy.y === 0 || copy.y === 2)).toBe(true);
  });

  it('falls back to the CPU re-upload when a pool texture has no copyable GPU format', () => {
    const { pool, b } = fragmented();
    b.gpuResident = () => true;
    const gpu = fakeWebGpuRenderer(pool, 'r32float');

    pool.compact(gpu.renderer);

    expect(b.relocations.every((move) => move.movedOnGpu === false)).toBe(true);
    expect(gpu.submits).toHaveLength(0);
  });

  it('splits large ranges into scratch-sized hops that never read an overwritten row', () => {
    const pool = new SplatPool({ capacity: 200 * W });
    const a = new FakeTenant(pool);
    const b = new FakeTenant(pool);
    const a0 = a.take(10);
    b.take(150);
    pool.releaseRows(a0.startRow, a0.rowCount);
    a.ranges.splice(0, 1);
    b.gpuResident = () => true;
    const gpu = fakeWebGpuRenderer(pool);

    pool.compact(gpu.renderer);

    const centers = gpu.copies.filter((copy) => copy.texture === 't0');
    expect(centers).toEqual([
      { kind: 'toBuffer', texture: 't0', y: 10, rows: 64 },
      { kind: 'toTexture', texture: 't0', y: 0, rows: 64 },
      { kind: 'toBuffer', texture: 't0', y: 74, rows: 64 },
      { kind: 'toTexture', texture: 't0', y: 64, rows: 64 },
      { kind: 'toBuffer', texture: 't0', y: 138, rows: 22 },
      { kind: 'toTexture', texture: 't0', y: 128, rows: 22 },
    ]);
  });
});

describe('SplatPool.reclaimRows', () => {
  it('asks sibling tenants, never the requester, to shed until enough rows are free', () => {
    const pool = new SplatPool({ capacity: 4 * SPLAT_DATA_TEXTURE_WIDTH });
    const asked: string[] = [];
    const tenant = (name: string, held: SplatPoolRange[]): SplatPoolTenant => ({
      poolRanges: () => held,
      relocatePoolRange: () => {},
      onPoolCompacted: () => {},
      shedPoolRows: (rows: number) => {
        asked.push(name);
        let freed = 0;
        while (freed < rows && held.length > 0) {
          const range = held.pop() as SplatPoolRange;
          pool.releaseRows(range.startRow, range.rowCount);
          freed += range.rowCount;
        }
        return freed;
      },
    });
    const requesterRanges = [{ startRow: pool.allocateRows(2), rowCount: 2 }];
    const siblingRanges = [
      { startRow: pool.allocateRows(1), rowCount: 1 },
      { startRow: pool.allocateRows(1), rowCount: 1 },
    ];
    const requester = tenant('requester', requesterRanges);
    pool.register(requester);
    pool.register(tenant('sibling', siblingRanges));
    expect(pool.freeRows).toBe(0);

    expect(pool.reclaimRows(requester, 1)).toBe(1);
    expect(asked).toEqual(['sibling']);
    expect(siblingRanges).toHaveLength(1);
    expect(requesterRanges).toHaveLength(1);
  });
});
