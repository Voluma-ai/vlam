import { describe, expect, it } from 'vitest';
import { parseSplatPly } from '../formats/ply/parse-splat-ply';

/**
 * Builders for the compressed (SuperSplat) PLY flavor. These mirror the
 * writer side of the format, so a decode bug shows up as a value mismatch
 * rather than as a plausible-but-wrong image.
 *
 * Verified once against `@playcanvas/splat-transform` decompressing a real
 * 1.9M-splat capture: positions, colors and opacity came back bit-identical,
 * covariances to float32 rounding, SH to the 8→11-bit requantization step.
 */

const CHUNK_BOUNDS = [
  'min_x',
  'min_y',
  'min_z',
  'max_x',
  'max_y',
  'max_z',
  'min_scale_x',
  'min_scale_y',
  'min_scale_z',
  'max_scale_x',
  'max_scale_y',
  'max_scale_z',
] as const;
const CHUNK_COLOR_BOUNDS = ['min_r', 'min_g', 'min_b', 'max_r', 'max_g', 'max_b'] as const;

/** Packs three unit fractions into 11-10-11 bits, as the format does. */
function pack111011(x: number, y: number, z: number): number {
  return ((Math.round(x * 2047) << 21) | (Math.round(y * 1023) << 11) | Math.round(z * 2047)) >>> 0;
}

/** Packs four 0..1 channels into RGBA8. */
function pack8888(r: number, g: number, b: number, a: number): number {
  return (
    ((Math.round(r * 255) << 24) |
      (Math.round(g * 255) << 16) |
      (Math.round(b * 255) << 8) |
      Math.round(a * 255)) >>>
    0
  );
}

/**
 * Packs a "smallest three" rotation: `largest` says which component was
 * dropped, and the other three are unorm10 over [-√½, +√½].
 */
function packRot(largest: number, a: number, b: number, c: number): number {
  const encode = (v: number): number => Math.round((v / Math.SQRT2 + 0.5) * 1023);
  return (((largest << 30) | (encode(a) << 20) | (encode(b) << 10) | encode(c)) >>> 0) >>> 0;
}

interface CompressedSplat {
  position: number;
  scale: number;
  rotation: number;
  color: number;
}

interface BuildOptions {
  chunks: number[][];
  splats: CompressedSplat[];
  /** Omit the per-chunk color bounds (the format's earliest writers did). */
  noColorBounds?: boolean;
  /** One uchar per (channel, coefficient), channel-major, per splat. */
  sh?: number[][];
  /** Overrides the declared chunk count. */
  chunkCountText?: string;
}

function buildCompressedPly(options: BuildOptions): ArrayBuffer {
  const chunkProperties = options.noColorBounds
    ? CHUNK_BOUNDS
    : [...CHUNK_BOUNDS, ...CHUNK_COLOR_BOUNDS];
  const shCount = options.sh?.[0]?.length ?? 0;
  const lines = [
    'ply',
    'format binary_little_endian 1.0',
    `element chunk ${options.chunkCountText ?? options.chunks.length}`,
    ...chunkProperties.map((name) => `property float ${name}`),
    `element vertex ${options.splats.length}`,
    'property uint packed_position',
    'property uint packed_rotation',
    'property uint packed_scale',
    'property uint packed_color',
    ...(options.sh
      ? [
          `element sh ${options.sh.length}`,
          ...Array.from({ length: shCount }, (_, i) => `property uchar f_rest_${i}`),
        ]
      : []),
    'end_header',
  ];
  const header = new TextEncoder().encode(`${lines.join('\n')}\n`);

  const chunkBytes = options.chunks.length * chunkProperties.length * 4;
  const vertexBytes = options.splats.length * 16;
  const shBytes = (options.sh?.length ?? 0) * shCount;
  const file = new Uint8Array(header.length + chunkBytes + vertexBytes + shBytes);
  file.set(header, 0);
  const view = new DataView(file.buffer);

  let at = header.length;
  for (const chunk of options.chunks) {
    for (let i = 0; i < chunkProperties.length; i++) {
      view.setFloat32(at, chunk[i] ?? 0, true);
      at += 4;
    }
  }
  for (const splat of options.splats) {
    view.setUint32(at + 0, splat.position, true);
    view.setUint32(at + 4, splat.rotation, true);
    view.setUint32(at + 8, splat.scale, true);
    view.setUint32(at + 12, splat.color, true);
    at += 16;
  }
  for (const record of options.sh ?? []) {
    for (const byte of record) file[at++] = byte;
  }
  return file.buffer;
}

/** A chunk whose scale bounds pin scale to (2, 1, 1) whatever the packing. */
function chunkWithScale(): number[] {
  return [
    0,
    0,
    0,
    10,
    20,
    30, // position bounds
    Math.log(2),
    0,
    0,
    Math.log(2),
    0,
    0, // scale bounds: min == max
    0,
    0,
    0,
    1,
    1,
    1, // color bounds
  ];
}

describe('parseSplatPly (compressed flavor)', () => {
  it('interpolates position across the chunk bounds', () => {
    const data = parseSplatPly(
      buildCompressedPly({
        chunks: [chunkWithScale()],
        splats: [
          { position: pack111011(0, 0, 0), scale: 0, rotation: packRot(0, 0, 0, 0), color: 0 },
          { position: pack111011(1, 1, 1), scale: 0, rotation: packRot(0, 0, 0, 0), color: 0 },
          {
            position: pack111011(0.5, 0.5, 0.5),
            scale: 0,
            rotation: packRot(0, 0, 0, 0),
            color: 0,
          },
        ],
      }),
    );
    expect(data.count).toBe(3);
    expect(Array.from(data.positions.subarray(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(data.positions.subarray(3, 6))).toEqual([10, 20, 30]);
    // 11-10-11 means each axis quantizes to its own field width, so the
    // midpoint lands within one step: 10/2047 in x, but 20/1023 in the
    // narrower y field, and 30/2047 in z.
    expect(data.positions[6]).toBeCloseTo(5, 2);
    expect(data.positions[7]).toBeCloseTo(10, 1);
    expect(data.positions[8]).toBeCloseTo(15, 1);
  });

  it('reads the rotation as smallest-three in (w, x, y, z) order', () => {
    // 90° about z is (w, x, y, z) = (√½, 0, 0, √½); dropping w (selector 0)
    // stores (x, y, z) = (0, 0, √½). With scale (2, 1, 1) the x/y axes swap,
    // so Σ = diag(1, 4, 1) - the same proof the uncompressed test uses.
    const data = parseSplatPly(
      buildCompressedPly({
        chunks: [chunkWithScale()],
        splats: [
          {
            position: pack111011(0, 0, 0),
            scale: pack111011(0, 0, 0),
            rotation: packRot(0, 0, 0, Math.SQRT1_2),
            color: 0,
          },
        ],
      }),
    );
    const expected = [1, 0, 0, 4, 0, 1];
    Array.from(data.covariances).forEach((value, i) =>
      expect(value).toBeCloseTo(expected[i] as number, 3),
    );
  });

  it('takes each selector to mean a different dropped component', () => {
    // Selector 3 drops z, storing (w, x, y). An identity rotation is then
    // (1, 0, 0, 0) stored as (1, 0, 0) - but 1 is outside the ±√½ range the
    // fields encode, so use a rotation whose largest component really is z.
    const data = parseSplatPly(
      buildCompressedPly({
        chunks: [chunkWithScale()],
        splats: [
          {
            position: pack111011(0, 0, 0),
            scale: pack111011(0, 0, 0),
            // (w, x, y) = (0, 0, 0) → z = 1: a 180° rotation about z, which
            // leaves Σ = diag(4, 1, 1) (the scale axes map back onto x/y).
            rotation: packRot(3, 0, 0, 0),
            color: 0,
          },
        ],
      }),
    );
    // Only 2 decimals: a stored 0 is not exactly representable in a 10-bit
    // unorm over ±√½ (it lands on 512/1023), so the off-diagonals carry a
    // little quantization noise rather than being exactly zero.
    const expected = [4, 0, 0, 1, 0, 1];
    Array.from(data.covariances).forEach((value, i) =>
      expect(value).toBeCloseTo(expected[i] as number, 2),
    );
  });

  it('interpolates color across the chunk bounds and passes opacity through', () => {
    const chunk = chunkWithScale();
    // Colors span 0.25..0.75 rather than the full range.
    chunk[12] = 0.25;
    chunk[13] = 0.25;
    chunk[14] = 0.25;
    chunk[15] = 0.75;
    chunk[16] = 0.75;
    chunk[17] = 0.75;
    const data = parseSplatPly(
      buildCompressedPly({
        chunks: [chunk],
        splats: [
          {
            position: pack111011(0, 0, 0),
            scale: pack111011(0, 0, 0),
            rotation: packRot(0, 0, 0, 0),
            color: pack8888(1, 0, 0.5, 64 / 255),
          },
        ],
      }),
    );
    // The stored color is the base color already, not an SH coefficient: no
    // 0.5 + Y₀₀·f_dc conversion, and no sigmoid on alpha.
    expect(data.colors[0]).toBe(Math.round(0.75 * 255)); // lerp(0.25, 0.75, 1)
    expect(data.colors[1]).toBe(Math.round(0.25 * 255)); // lerp(0.25, 0.75, 0)
    expect(data.colors[2]).toBeCloseTo(Math.round(0.5 * 255), -1);
    expect(data.colors[3]).toBe(64);
  });

  it('uses the packed color as-is when the chunk carries no color bounds', () => {
    const data = parseSplatPly(
      buildCompressedPly({
        noColorBounds: true,
        chunks: [chunkWithScale().slice(0, 12)],
        splats: [
          {
            position: pack111011(0, 0, 0),
            scale: pack111011(0, 0, 0),
            rotation: packRot(0, 0, 0, 0),
            color: pack8888(1, 0, 0.5, 1),
          },
        ],
      }),
    );
    expect(Array.from(data.colors)).toEqual([255, 0, 128, 255]);
  });

  it('exponentiates the log-space scale bounds', () => {
    const chunk = chunkWithScale();
    chunk[6] = Math.log(1);
    chunk[7] = Math.log(1);
    chunk[8] = Math.log(1);
    chunk[9] = Math.log(8);
    chunk[10] = Math.log(8);
    chunk[11] = Math.log(8);
    const data = parseSplatPly(
      buildCompressedPly({
        chunks: [chunk],
        splats: [
          {
            position: pack111011(0, 0, 0),
            scale: pack111011(1, 1, 1),
            rotation: packRot(0, 0, 0, 0), // identity-ish: w = 1
            color: 0,
          },
        ],
      }),
    );
    // Σ = diag(s²) for an axis-aligned splat: scale 8 → 64.
    expect(data.covariances[0]).toBeCloseTo(64, 2);
    expect(data.covariances[3]).toBeCloseTo(64, 2);
    expect(data.covariances[5]).toBeCloseTo(64, 2);
  });

  it('transposes the channel-major sh element into packed per-splat words', () => {
    const data = parseSplatPly(
      buildCompressedPly({
        chunks: [chunkWithScale()],
        splats: [
          {
            position: pack111011(0, 0, 0),
            scale: pack111011(0, 0, 0),
            rotation: packRot(0, 0, 0, 0),
            color: 0,
          },
        ],
        // Band 1 = 3 coefficients per channel, stored R0 R1 R2 G0 G1 G2 B0 B1 B2.
        sh: [[255, 0, 128, 0, 255, 128, 128, 128, 255]],
      }),
    );
    const packed = data.shPacked;
    expect(packed?.bands).toBe(1);
    expect(packed?.range).toEqual({ min: [-4, -4, -4], max: [4, 4, 4] });
    expect(packed?.packed.length).toBe(3);

    /** Dequantizes one packed word the way the LCC path does. */
    const decode = (word: number): number[] => [
      -4 + 8 * ((word & 0x7ff) / 2047),
      -4 + 8 * (((word >>> 11) & 0x3ff) / 1023),
      -4 + 8 * (((word >>> 21) & 0x7ff) / 2047),
    ];
    // Coefficient 0 takes R from f_rest_0, G from f_rest_3, B from f_rest_6.
    const c0 = decode(packed?.packed[0] as number);
    expect(c0[0]).toBeCloseTo(4, 2);
    expect(c0[1]).toBeCloseTo(-4, 2);
    expect(c0[2]).toBeCloseTo(0.02, 1);
    // Coefficient 1: f_rest_1 / f_rest_4 / f_rest_7.
    const c1 = decode(packed?.packed[1] as number);
    expect(c1[0]).toBeCloseTo(-4, 2);
    expect(c1[1]).toBeCloseTo(4, 2);
    expect(c1[2]).toBeCloseTo(0.02, 1);
  });

  it('omits sh when the file has no sh element', () => {
    const data = parseSplatPly(
      buildCompressedPly({
        chunks: [chunkWithScale()],
        splats: [
          {
            position: pack111011(0, 0, 0),
            scale: pack111011(0, 0, 0),
            rotation: packRot(0, 0, 0, 0),
            color: 0,
          },
        ],
      }),
    );
    expect(data.shPacked).toBeUndefined();
  });

  it('rejects a chunk element too small for the splat count', () => {
    // 257 splats need two chunks at 256 splats each.
    expect(() =>
      parseSplatPly(
        buildCompressedPly({
          chunks: [chunkWithScale()],
          splats: Array.from({ length: 257 }, () => ({
            position: 0,
            scale: 0,
            rotation: packRot(0, 0, 0, 0),
            color: 0,
          })),
        }),
      ),
    ).toThrow(/too few for 257 splats/);
  });

  it('rejects a truncated compressed file', () => {
    const full = buildCompressedPly({
      chunks: [chunkWithScale()],
      splats: [
        { position: 0, scale: 0, rotation: packRot(0, 0, 0, 0), color: 0 },
        { position: 0, scale: 0, rotation: packRot(0, 0, 0, 0), color: 0 },
      ],
    });
    expect(() => parseSplatPly(full.slice(0, full.byteLength - 8))).toThrow(/Truncated PLY/);
  });

  it('applies each chunk to its own 256-splat run', () => {
    const near = chunkWithScale();
    const far = chunkWithScale();
    far[0] = 100;
    far[3] = 100; // second chunk sits at x = 100
    const splats = Array.from({ length: 257 }, () => ({
      position: pack111011(0, 0, 0),
      scale: pack111011(0, 0, 0),
      rotation: packRot(0, 0, 0, 0),
      color: 0,
    }));
    const data = parseSplatPly(buildCompressedPly({ chunks: [near, far], splats }));
    expect(data.positions[0]).toBe(0); // splat 0 → chunk 0
    expect(data.positions[255 * 3]).toBe(0); // splat 255 → chunk 0
    expect(data.positions[256 * 3]).toBe(100); // splat 256 → chunk 1
  });
});
