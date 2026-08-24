import { describe, expect, it, vi } from 'vitest';
import { SplatMesh } from '../splat-mesh';
import { requantizeShWord } from '../sh-pack';
import { writeCovariance, type SplatData } from '../splat-data';

/**
 * Tests for per-splat (non-palette) SH storage in the dynamic pool - the
 * form LCC `Quality` captures deliver, and the only kind that survives
 * being appended into a shared pool.
 *
 * The backing arrays are reached directly (as in splat-mesh.pool.test.ts):
 * the GPU-side upload needs a live renderer, but everything that decides what
 * *reaches* the GPU is plain array arithmetic.
 */

const WIDTH = 2048; // SplatMesh.DATA_TEXTURE_WIDTH
const RANGE = { min: [-2, -4, -8] as const, max: [2, 4, 8] as const };

function makeData(
  count: number,
  options: { bands?: 1 | 2 | 3; word?: (i: number, c: number) => number } = {},
): SplatData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i;
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  const data: SplatData = { count, positions, colors, covariances };
  if (!options.bands) return data;
  const coefficients = [0, 3, 8, 15][options.bands] as number;
  const packed = new Uint32Array(count * coefficients);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < coefficients; c++)
      packed[i * coefficients + c] = options.word?.(i, c) ?? i * 100 + c;
  }
  return {
    ...data,
    shPacked: { bands: options.bands, packed, range: { min: RANGE.min, max: RANGE.max } },
  };
}

/** The pool's packed-SH backing arrays, one per group of four coefficients. */
function shBacking(mesh: SplatMesh): Uint32Array[] {
  return (mesh as unknown as { backing: { shPacked: Uint32Array[] } }).backing.shPacked;
}

/** Coefficient `c` of pool splat `index`, as stored. */
function storedWord(mesh: SplatMesh, index: number, c: number): number {
  return shBacking(mesh)[c >> 2]![index * 4 + (c & 3)] as number;
}

describe('SplatMesh packed SH storage', () => {
  it('allocates one RGBA32UI group per four coefficients', () => {
    // 3 bands = 15 coefficients → 4 groups; 2 bands = 8 → 2; 1 band = 3 → 1.
    for (const [bands, groups] of [
      [1, 1],
      [2, 2],
      [3, 4],
    ] as const) {
      const mesh = new SplatMesh({ capacity: WIDTH }, { shBands: bands });
      expect(shBacking(mesh)).toHaveLength(groups);
      // Pool-shaped: one RGBA texel per splat.
      expect(shBacking(mesh)[0]).toHaveLength(WIDTH * 4);
      mesh.dispose();
    }
  });

  it('allocates nothing when SH is off (the default)', () => {
    const mesh = new SplatMesh({ capacity: WIDTH });
    expect(shBacking(mesh)).toHaveLength(0);
    mesh.dispose();
  });

  it('allocates packed SH on a static mesh when the source carries shPacked', () => {
    const mesh = new SplatMesh(makeData(4, { bands: 2 }));
    expect(mesh.shBands).toBe(2);
    expect(shBacking(mesh)).toHaveLength(2);
    expect(storedWord(mesh, 0, 0)).toBe(0);
    mesh.dispose();
  });

  it('scatters a chunk’s words into the group textures, splat-major', () => {
    const mesh = new SplatMesh({ capacity: WIDTH }, { shBands: 3 });
    mesh.appendRange(makeData(3, { bands: 3 }));
    for (let i = 0; i < 3; i++) {
      for (let c = 0; c < 15; c++) expect(storedWord(mesh, i, c)).toBe(i * 100 + c);
    }
    // The 16th slot of the last group is padding - never written.
    expect(storedWord(mesh, 0, 15)).toBe(0);
    mesh.dispose();
  });

  it('adopts the first chunk’s dequantization range', () => {
    const mesh = new SplatMesh({ capacity: WIDTH }, { shBands: 1 });
    mesh.appendRange(makeData(2, { bands: 1 }));
    const range = (
      mesh as unknown as { shRange: { min: { value: THREE_Vec }; max: { value: THREE_Vec } } }
    ).shRange;
    expect([range.min.value.x, range.min.value.y, range.min.value.z]).toEqual([-2, -4, -8]);
    expect([range.max.value.x, range.max.value.y, range.max.value.z]).toEqual([2, 4, 8]);
    mesh.dispose();
  });

  it('requantizes a later chunk whose range differs into the scene range (M11)', () => {
    // Two rows: each range is row-aligned, so both need their own. The first
    // chunk sets the scene range (RANGE); the second carries a different one,
    // so its words are re-encoded into RANGE rather than ignored.
    const mesh = new SplatMesh({ capacity: WIDTH * 2 }, { shBands: 1 });
    mesh.appendRange(makeData(2, { bands: 1 }));
    const other = makeData(2, { bands: 1 });
    const from = { min: [0, 0, 0] as const, max: [1, 1, 1] as const };
    mesh.appendRange({ ...other, shPacked: { ...other.shPacked!, range: from } });
    for (let i = 0; i < 2; i++) {
      for (let c = 0; c < 3; c++) {
        const original = other.shPacked!.packed[i * 3 + c] as number;
        expect(storedWord(mesh, WIDTH + i, c)).toBe(requantizeShWord(original, from, RANGE));
      }
    }
    mesh.dispose();
  });

  it('fills reused rows with the scene’s neutral word so SH cannot ghost', () => {
    const mesh = new SplatMesh({ capacity: WIDTH }, { shBands: 1 });
    // A chunk with SH establishes the range and dirties the rows...
    const handle = mesh.appendRange(makeData(4, { bands: 1, word: () => 0xffffffff }));
    expect(storedWord(mesh, 0, 0)).toBe(0xffffffff);
    mesh.removeRange(handle);

    // ...then a chunk *without* SH reuses them. Leaving the old words would
    // give these splats the previous occupant's view-dependent color.
    mesh.appendRange(makeData(4));
    // The neutral word decodes to 0 in every channel: the range is symmetric
    // here, so each channel's code sits at its field midpoint.
    const neutral = storedWord(mesh, 0, 0);
    expect(neutral).not.toBe(0xffffffff);
    expect(neutral & 0x7ff).toBe(1024); // R: round(0.5 * 2047)
    expect((neutral >>> 11) & 0x3ff).toBe(512); // G: round(0.5 * 1023)
    expect((neutral >>> 21) & 0x7ff).toBe(1024); // B
    mesh.dispose();
  });

  it('backfills SH-less rows written before the scene range locked', () => {
    // An SH-less chunk appended *first* is neutral-filled before any range
    // exists - the only writable word then is 0, which decodes to `range.min`
    // in every channel once a range locks (not 0.0). The lock must rewrite
    // those rows with the real neutral word or the whole first chunk renders
    // with garbage view-dependent color.
    const mesh = new SplatMesh({ capacity: WIDTH * 2 }, { shBands: 1 });
    mesh.appendRange(makeData(4)); // no SH, pre-lock → word 0 for now
    expect(storedWord(mesh, 0, 0)).toBe(0);

    mesh.appendRange(makeData(2, { bands: 1 })); // locks the scene range
    // The pre-lock rows now hold the range's neutral word (midpoint codes,
    // since RANGE is symmetric), not word 0.
    const neutral = storedWord(mesh, 0, 0);
    expect(neutral & 0x7ff).toBe(1024);
    expect((neutral >>> 11) & 0x3ff).toBe(512);
    expect((neutral >>> 21) & 0x7ff).toBe(1024);
    // And the range-setting chunk's own words were not clobbered.
    expect(storedWord(mesh, WIDTH, 0)).toBe(0);
    expect(storedWord(mesh, WIDTH, 1)).toBe(1);
    mesh.dispose();
  });

  it('relocates SH with its splats during compaction', () => {
    const mesh = new SplatMesh({ capacity: WIDTH * 3 }, { shBands: 1 });
    const first = mesh.appendRange(makeData(WIDTH, { bands: 1, word: (_i, c) => 1000 + c }));
    const second = mesh.appendRange(makeData(WIDTH, { bands: 1, word: (_i, c) => 2000 + c }));
    // Freeing the first range leaves a hole; compaction slides the second down.
    mesh.removeRange(first);
    expect(storedWord(mesh, WIDTH, 0)).toBe(2000);
    mesh.compact();
    // The second range now starts at row 0, and brought its SH along.
    expect(storedWord(mesh, 0, 0)).toBe(2000);
    expect(storedWord(mesh, 0, 2)).toBe(2002);
    void second;
    mesh.dispose();
  });

  it('warns when per-splat SH arrives at a pool with none allocated', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mesh = new SplatMesh({ capacity: WIDTH });
    mesh.appendRange(makeData(2, { bands: 3 }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('per-splat SH was supplied'));
    warn.mockRestore();
    mesh.dispose();
  });

  it('uses source shPacked on a static mesh regardless of shBands option', () => {
    const mesh = new SplatMesh(makeData(4, { bands: 3 }), { shBands: 1 });
    expect(mesh.shBands).toBe(3);
    expect(shBacking(mesh)).toHaveLength(4);
    mesh.dispose();
  });
});

interface THREE_Vec {
  x: number;
  y: number;
  z: number;
}
