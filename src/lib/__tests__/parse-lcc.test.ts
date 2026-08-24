import { describe, expect, it } from 'vitest';
import {
  LCC_RECORD_BYTES,
  decodeLccRotation,
  decodeLccShWord,
  parseLccChunk,
  parseLccIndex,
  parseLccManifest,
  type LccChunkParams,
  type LccRange,
} from '../formats/lcc/parse-lcc';
import { writeCovariance } from '../splat-data';

/**
 * Ground truth from a real capture: the first records of
 * `bentleywarlcc/oldtimers_blackcar` (`fileType: "Quality"`), paired with the
 * matching vertices of its sibling `.ply` export of the same training run.
 *
 * The PLY's vertices are index-aligned with `data.bin`'s level-0 records, so
 * these pairs pin the decoders to XGRIDS' actual encoder rather than to this
 * implementation's own output. The PLY is Y-up where LCC is Z-up
 * (`lcc = (x, z, −y)`), which is why `position` is permuted here.
 *
 * The captures themselves are XGRIDS data and are not redistributable, so a
 * handful of records are baked in rather than read from disk.
 */
const SCALE_RANGE: LccRange = {
  min: [0.00004539994915830903, 0.00004539994915830903, 0.00004539994915830903],
  max: [4.8052544593811035, 5.51528787612915, 4.346125602722168],
};
const SH_RANGE: LccRange = {
  min: [-3.2373242378234863, -3.2197370529174805, -3.168766498565674],
  max: [3.249899387359619, 3.234738349914551, 3.181415319442749],
};

const CAPTURE = [
  {
    bytes: [
      137, 126, 46, 194, 144, 144, 133, 194, 49, 195, 3, 65, 184, 191, 183, 72, 37, 17, 201, 16,
      206, 0, 230, 85, 72, 231, 0, 0, 0, 0, 0, 0,
    ],
    position: [-43.62356948852539, -66.7823486328125, 8.235154151916504],
    scale: [0.32185911437173864, 0.3616689216276038, 0.013706690388582517],
    color: [184, 191, 183, 72],
  },
  {
    bytes: [
      236, 72, 48, 194, 54, 201, 133, 194, 53, 249, 4, 65, 184, 191, 183, 185, 120, 16, 70, 14, 141,
      1, 238, 181, 23, 234, 0, 0, 0, 0, 0, 0,
    ],
    position: [-44.07121276855469, -66.89299011230469, 8.31084156036377],
    scale: [0.3091742705443256, 0.307555842649936, 0.026373224227931487],
    color: [184, 191, 183, 185],
  },
  {
    bytes: [
      59, 79, 47, 194, 132, 187, 131, 194, 133, 59, 176, 64, 13, 10, 6, 55, 198, 9, 240, 9, 47, 3,
      226, 105, 136, 223, 0, 0, 0, 0, 0, 0,
    ],
    // The middle value is written to its last digit (…125, an exact tie) rather
    // than the shortest round-tripping form (…12): both parse to the same
    // double, but no-loss-of-precision compares against `toPrecision`, which
    // breaks that tie upwards where `String` breaks it to even.
    position: [-43.82737350463867, -65.866241455078125, 5.507265567779541],
    scale: [0.18349902739726545, 0.21414132201636138, 0.05409370345643899],
    color: [13, 10, 6, 55],
  },
] as const;

function captureChunk(): ArrayBuffer {
  const bytes = new Uint8Array(CAPTURE.length * LCC_RECORD_BYTES);
  CAPTURE.forEach((record, i) => bytes.set(record.bytes, i * LCC_RECORD_BYTES));
  return bytes.buffer;
}

const CHUNK_PARAMS: LccChunkParams = {
  kind: 'splats',
  start: 0,
  length: CAPTURE.length * LCC_RECORD_BYTES,
  stride: LCC_RECORD_BYTES,
  scale: SCALE_RANGE,
};

/** A `Quality` environment chunk: 96-byte records, base + inline SH block. */
function environmentChunk(count: number): ArrayBuffer {
  const stride = 96;
  const bytes = new Uint8Array(count * stride);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    bytes.set(record({ position: [i, i * 2, i * 3], color: [1, 2, 3, 4] }), i * stride);
    for (let c = 0; c < 15; c++) view.setUint32(i * stride + 32 + c * 4, i * 100 + c, true);
  }
  return bytes.buffer;
}

/** A record built field-by-field, for exercising a specific encoding. */
function record(fields: {
  position?: [number, number, number];
  color?: [number, number, number, number];
  scale?: [number, number, number];
  rotation?: number;
}): Uint8Array {
  const bytes = new Uint8Array(LCC_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  const [x, y, z] = fields.position ?? [0, 0, 0];
  view.setFloat32(0, x, true);
  view.setFloat32(4, y, true);
  view.setFloat32(8, z, true);
  bytes.set(fields.color ?? [0, 0, 0, 255], 12);
  const scale = fields.scale ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) view.setUint16(16 + i * 2, scale[i] as number, true);
  view.setUint32(22, fields.rotation ?? 0, true);
  return bytes;
}

function manifestJson(overrides: Record<string, unknown> = {}) {
  return {
    version: '5.0',
    totalSplats: 30,
    totalLevel: 2,
    cellLengthX: 30,
    cellLengthY: 30,
    indexDataSize: 4 + 2 * 16,
    offset: [0, 0, 0],
    shift: [0, 0, 0],
    scale: [1, 1, 1],
    splats: [20, 10],
    boundingBox: { min: [-1, -2, -3], max: [1, 2, 3] },
    encoding: 'COMPRESS',
    fileType: 'Portable',
    attributes: [
      { name: 'scale', min: [0.1, 0.2, 0.3], max: [1, 2, 3] },
      { name: 'opacity', min: [0.005], max: [1] },
      { name: 'envscale', min: [1, 1, 1], max: [9, 9, 9] },
    ],
    ...overrides,
  };
}

describe('parseLccManifest', () => {
  it('extracts the fields the loader needs', () => {
    const manifest = parseLccManifest(manifestJson());
    expect(manifest.totalLevel).toBe(2);
    expect(manifest.fileType).toBe('Portable');
    expect(manifest.splats).toEqual([20, 10]);
    expect(manifest.scale).toEqual({ min: [0.1, 0.2, 0.3], max: [1, 2, 3] });
    expect(manifest.bounds).toEqual({ min: [-1, -2, -3], max: [1, 2, 3] });
  });

  it('rejects a version it has not been verified against', () => {
    expect(() => parseLccManifest(manifestJson({ version: '6.0' }))).toThrow(
      /Unsupported LCC manifest version/,
    );
  });

  it('rejects a v1.x manifest, which predates the verified layout', () => {
    expect(() => parseLccManifest(manifestJson({ version: '1.0' }))).toThrow(
      /Unsupported LCC manifest version/,
    );
  });

  // Shape taken from a real v2.0 capture (trainmuseum): no `fileType`, no
  // environment attributes, and a trained shcoef range like a v3 Quality set.
  it('accepts a v2.0 manifest, which omits fileType and environment attributes', () => {
    const { fileType: _omit, ...withoutFileType } = manifestJson({
      version: '2.0',
      attributes: [
        { name: 'scale', min: [0.1, 0.2, 0.3], max: [1, 2, 3] },
        { name: 'shcoef', min: [-2.31, -2.36, -2.37], max: [2.13, 2.12, 2.19] },
        { name: 'opacity', min: [0.005], max: [1] },
      ],
    });
    const manifest = parseLccManifest(withoutFileType);
    expect(manifest.fileType).toBe('Quality');
    expect(manifest.splats).toEqual([20, 10]);
    expect(manifest.shcoef).toEqual({ min: [-2.31, -2.36, -2.37], max: [2.13, 2.12, 2.19] });
  });

  it('accepts a v4.0 manifest, which writes fileType explicitly like v5', () => {
    const manifest = parseLccManifest(manifestJson({ version: '4.0' }));
    expect(manifest.fileType).toBe('Portable');
    expect(manifest.splats).toEqual([20, 10]);
  });

  it('accepts a v3.0 manifest and infers Quality from trained shcoef ranges', () => {
    const { fileType: _omit, ...withoutFileType } = manifestJson({
      version: '3.0',
      attributes: [
        { name: 'scale', min: [0.1, 0.2, 0.3], max: [1, 2, 3] },
        { name: 'shcoef', min: [-2.2, -2.1, -2.0], max: [2.5, 2.4, 2.3] },
        { name: 'envscale', min: [1, 1, 1], max: [9, 9, 9] },
        { name: 'envshcoef', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      ],
    });
    const manifest = parseLccManifest(withoutFileType);
    expect(manifest.fileType).toBe('Quality');
    expect(manifest.shcoef).toEqual({ min: [-2.2, -2.1, -2.0], max: [2.5, 2.4, 2.3] });
  });

  it('infers Portable when a v3.0 manifest omits fileType and shcoef is a stub', () => {
    const { fileType: _omit, ...withoutFileType } = manifestJson({
      version: '3.0',
      attributes: [
        { name: 'scale', min: [0.1, 0.2, 0.3], max: [1, 2, 3] },
        { name: 'shcoef', min: [0, 0, 0], max: [1, 1, 1] },
      ],
    });
    expect(parseLccManifest(withoutFileType).fileType).toBe('Portable');
  });

  it('infers Portable when a v3.0 manifest has no shcoef range', () => {
    const { fileType: _omit, ...withoutFileType } = manifestJson({ version: '3.0' });
    expect(parseLccManifest(withoutFileType).fileType).toBe('Portable');
  });

  it('rejects an indexDataSize that contradicts the level count', () => {
    expect(() => parseLccManifest(manifestJson({ indexDataSize: 84 }))).toThrow(/imply 36/);
  });

  it('rejects a non-identity global transform rather than placing the scene wrong', () => {
    expect(() => parseLccManifest(manifestJson({ shift: [1, 0, 0] }))).toThrow(
      /"shift" is non-zero/,
    );
    expect(() => parseLccManifest(manifestJson({ scale: [2, 2, 2] }))).toThrow(
      /"scale" is non-identity/,
    );
  });

  // Shape taken from a real georeferenced capture (info/scene/TEST): a UTM 32N
  // anchor alongside a local, origin-centred boundingBox.
  it('keeps a georeferenced capture local, carrying the anchor as metadata', () => {
    const offset = [689605.682767426, 5338780.532847924, 565.620544003];
    const manifest = parseLccManifest(manifestJson({ offset, epsg: 32632 }));
    expect(manifest.georeference).toEqual({ origin: offset, epsg: 32632 });
    // The anchor never reaches the geometry: bounds match an unanchored capture.
    expect(manifest.bounds).toEqual(parseLccManifest(manifestJson({})).bounds);
  });

  it('reports no georeference for a capture with no anchor', () => {
    expect(parseLccManifest(manifestJson({})).georeference).toBeUndefined();
  });

  it('carries an anchor with no usable projection as an epsg-less georeference', () => {
    expect(parseLccManifest(manifestJson({ offset: [1, 2, 3], epsg: 0 })).georeference).toEqual({
      origin: [1, 2, 3],
      epsg: undefined,
    });
  });

  it('rejects an unknown fileType and encoding', () => {
    expect(() => parseLccManifest(manifestJson({ fileType: 'Fast' }))).toThrow(
      /Unsupported LCC fileType/,
    );
    expect(() => parseLccManifest(manifestJson({ encoding: 'RAW' }))).toThrow(
      /Unsupported LCC encoding/,
    );
  });

  it('requires the scale dequantization range', () => {
    expect(() => parseLccManifest(manifestJson({ attributes: [] }))).toThrow(
      /missing the "scale" attribute/,
    );
  });
});

describe('parseLccIndex', () => {
  const manifest = parseLccManifest(manifestJson());

  function indexBytes(entries: { count: number; offset: bigint; size?: number }[][]): ArrayBuffer {
    const size = 4 + manifest.totalLevel * 16;
    const buffer = new ArrayBuffer(entries.length * size);
    const view = new DataView(buffer);
    entries.forEach((levels, cell) => {
      view.setUint16(cell * size, cell, true);
      view.setUint16(cell * size + 2, 7, true);
      levels.forEach((level, l) => {
        const at = cell * size + 4 + l * 16;
        view.setUint32(at, level.count, true);
        view.setBigUint64(at + 4, level.offset, true);
        view.setUint32(at + 12, level.size ?? level.count * 32, true);
      });
    });
    return buffer;
  }

  it('reads cell coordinates and every level’s range', () => {
    const cells = parseLccIndex(
      indexBytes([
        [
          { count: 20, offset: 0n },
          { count: 10, offset: 640n },
        ],
      ]),
      manifest,
    );
    expect(cells).toEqual([
      {
        cellX: 0,
        cellY: 7,
        levels: [
          { count: 20, byteOffset: 0, byteSize: 640 },
          { count: 10, byteOffset: 640, byteSize: 320 },
        ],
      },
    ]);
  });

  it('reads a 64-bit offset beyond 2^32', () => {
    const offset = 5_000_000_000n;
    const cells = parseLccIndex(
      indexBytes([
        [
          { count: 1, offset },
          { count: 1, offset: offset + 32n },
        ],
      ]),
      manifest,
    );
    expect(cells[0]!.levels[0]!.byteOffset).toBe(5_000_000_000);
  });

  it('rejects an offset that cannot round-trip through a JS number', () => {
    expect(() =>
      parseLccIndex(
        indexBytes([
          [
            { count: 1, offset: 2n ** 60n },
            { count: 1, offset: 0n },
          ],
        ]),
        manifest,
      ),
    ).toThrow(/beyond Number.MAX_SAFE_INTEGER/);
  });

  it('rejects a record whose size contradicts its count', () => {
    expect(() =>
      parseLccIndex(
        indexBytes([
          [
            { count: 20, offset: 0n, size: 999 },
            { count: 1, offset: 0n },
          ],
        ]),
        manifest,
      ),
    ).toThrow(/declares 20 splats but 999 bytes/);
  });

  it('rejects a file that is not a whole number of records', () => {
    expect(() => parseLccIndex(new ArrayBuffer(37), manifest)).toThrow(
      /not a multiple of indexDataSize/,
    );
  });
});

describe('decodeLccRotation', () => {
  /** Encodes `(x, y, z, w)` the way the format does, for round-trip tests. */
  function encode(q: [number, number, number, number], largest: number): number {
    let word = largest << 30;
    let next = 0;
    for (let i = 0; i < 4; i++) {
      if (i === largest) continue;
      const block = Math.round((q[i] as number) * 511 * Math.SQRT2 + 511);
      word |= block << (10 * next);
      next++;
    }
    return word >>> 0;
  }

  it('round-trips a quaternion through every omitted-component branch', () => {
    // A quaternion whose four components are all distinct, rotated through
    // each "largest" slot so all four code paths are covered.
    const base = [0.1, -0.2, 0.3, 0.9273618] as [number, number, number, number];
    for (let largest = 0; largest < 4; largest++) {
      const q: [number, number, number, number] = [...base];
      // Make `largest` the biggest component, keeping the quaternion unit.
      const rest = q.filter((_, i) => i !== largest).map((v) => v * 0.3);
      let k = 0;
      for (let i = 0; i < 4; i++) if (i !== largest) q[i] = rest[k++] as number;
      q[largest] = Math.sqrt(1 - (rest[0]! ** 2 + rest[1]! ** 2 + rest[2]! ** 2));

      const [w, x, y, z] = decodeLccRotation(encode(q, largest));
      // Within one quantization step (1/(511·√2) ≈ 1.4e-3).
      expect(x).toBeCloseTo(q[0], 2);
      expect(y).toBeCloseTo(q[1], 2);
      expect(z).toBeCloseTo(q[2], 2);
      expect(w).toBeCloseTo(q[3], 2);
    }
  });

  it('stays finite on a corrupt word', () => {
    // A corrupt word's three stored components can exceed unit length, which
    // no real encoder produces. The reconstructed component then clamps to 0
    // and the result is merely non-unit, never NaN - `writeCovariance`
    // normalizes, so a garbage record degrades to a rotation, not to a hole
    // of NaN geometry that would poison the whole pool.
    for (const word of [0, 0xffffffff, 0x7fffffff, 0xdeadbeef, 0x40000000]) {
      const q = decodeLccRotation(word >>> 0);
      expect(q.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...q)).toBeGreaterThan(0);
    }
  });

  it('reads the omitted component from the top two bits, in xyzw order', () => {
    // All three blocks at the 511 bias → the other components are 0, so the
    // named component must carry the whole unit length.
    const centered = 511 | (511 << 10) | (511 << 20);
    expect(decodeLccRotation((centered | (3 << 30)) >>> 0)).toEqual([1, 0, 0, 0]); // w
    expect(decodeLccRotation(centered >>> 0)).toEqual([0, 1, 0, 0]); // x
  });
});

describe('decodeLccShWord', () => {
  it('unpacks R/G/B from bits 0-10, 11-20 and 21-31', () => {
    const range: LccRange = { min: [-1, -2, -4], max: [1, 2, 4] };
    const out = new Float32Array(3);
    // Each channel at its field maximum → the range maximum.
    decodeLccShWord((2047 | (1023 << 11) | (2047 << 21)) >>> 0, range, out, 0);
    expect([...out]).toEqual([1, 2, 4]);
    // Each channel at zero → the range minimum.
    decodeLccShWord(0, range, out, 0);
    expect([...out]).toEqual([-1, -2, -4]);
    // Mid-scale, per channel, at that channel's own divisor.
    decodeLccShWord((1024 | (512 << 11) | (1024 << 21)) >>> 0, range, out, 0);
    expect(out[0]).toBeCloseTo(0.0005, 3);
    expect(out[1]).toBeCloseTo(0.002, 3);
    expect(out[2]).toBeCloseTo(0.002, 3);
  });

  it('writes at the given offset without touching its neighbours', () => {
    const out = new Float32Array(6).fill(9);
    decodeLccShWord(0, { min: [-1, -1, -1], max: [1, 1, 1] }, out, 3);
    expect([...out]).toEqual([9, 9, 9, -1, -1, -1]);
  });
});

describe('parseLccChunk', () => {
  it('decodes real capture records to match the PLY export of the same training run', async () => {
    const data = await parseLccChunk(captureChunk(), CHUNK_PARAMS);
    expect(data.count).toBe(CAPTURE.length);

    CAPTURE.forEach((expected, i) => {
      // Positions are raw float32 - bit-exact.
      expect([...data.positions.subarray(i * 3, i * 3 + 3)]).toEqual(expected.position);
      // Colors are stored pre-activated, exactly as the pool wants them.
      expect([...data.colors.subarray(i * 4, i * 4 + 4)]).toEqual(expected.color);
    });
  });

  it('dequantizes scale to the PLY’s exp(scale) within a quantization step', async () => {
    const data = await parseLccChunk(captureChunk(), CHUNK_PARAMS);
    // The covariance folds scale and rotation together, so compare against a
    // reference built from the PLY's scale and this record's decoded rotation.
    CAPTURE.forEach((expected, i) => {
      const view = new DataView(captureChunk(), 0);
      const [w, x, y, z] = decodeLccRotation(view.getUint32(i * LCC_RECORD_BYTES + 22, true));
      const reference = new Float32Array(6);
      writeCovariance(
        reference,
        0,
        expected.scale[0],
        expected.scale[1],
        expected.scale[2],
        w,
        x,
        y,
        z,
      );
      for (let k = 0; k < 6; k++) {
        // Scale quantization is ~7e-5 of the range; covariance is quadratic in
        // it, so compare relative to each term's own magnitude.
        expect(data.covariances[i * 6 + k]).toBeCloseTo(reference[k] as number, 4);
      }
    });
  });

  it('reads each field from its own offset', async () => {
    const bytes = record({
      position: [1.5, -2.25, 3.75],
      color: [10, 20, 30, 40],
      scale: [0, 65535, 32768], // → min, max, mid of the scale range
      rotation: (511 | (511 << 10) | (511 << 20) | (3 << 30)) >>> 0, // identity
    });
    const params: LccChunkParams = {
      kind: 'splats',
      start: 0,
      length: LCC_RECORD_BYTES,
      stride: LCC_RECORD_BYTES,
      scale: { min: [1, 1, 1], max: [3, 3, 3] },
    };
    const data = await parseLccChunk(bytes.buffer as ArrayBuffer, params);
    expect([...data.positions]).toEqual([1.5, -2.25, 3.75]);
    expect([...data.colors]).toEqual([10, 20, 30, 40]);
    // Identity rotation → covariance is diag(sx², sy², sz²). The u16 codes
    // land on the range's min, max and (to within a code) its midpoint.
    const mid = 1 + 2 * (32768 / 65535);
    const expected = new Float32Array(6);
    writeCovariance(expected, 0, 1, 3, mid, 1, 0, 0, 0);
    for (let k = 0; k < 6; k++) expect(data.covariances[k]).toBeCloseTo(expected[k] as number, 4);
    expect(data.covariances[5]).toBeCloseTo(mid * mid, 4);
  });

  it('rejects a chunk that is not a whole number of records', async () => {
    await expect(parseLccChunk(new ArrayBuffer(33), CHUNK_PARAMS)).rejects.toThrow(
      /not a multiple of the 32-byte record/,
    );
  });

  it('decodes shcoef.bin words alongside the base records', async () => {
    const sh = new Uint32Array(CAPTURE.length * 16);
    // Word c of splat i, with a recognizable value per (splat, coefficient).
    for (let i = 0; i < CAPTURE.length; i++)
      for (let c = 0; c < 15; c++) sh[i * 16 + c] = i * 100 + c;
    const params: LccChunkParams = {
      ...CHUNK_PARAMS,
      sh: { bands: 3, range: SH_RANGE, source: 'sidecar', url: 'https://example.test/shcoef.bin' },
    };
    const data = await parseLccChunk(captureChunk(), params, sh.buffer);
    expect(data.shPacked?.bands).toBe(3);
    expect(data.shPacked?.range).toEqual(SH_RANGE);
    // 15 coefficients per splat: the 16th (padding) word is dropped.
    expect(data.shPacked?.packed).toHaveLength(CAPTURE.length * 15);
    expect([...data.shPacked!.packed.subarray(0, 3)]).toEqual([0, 1, 2]);
    expect([...data.shPacked!.packed.subarray(15, 18)]).toEqual([100, 101, 102]);
  });

  it('keeps only the requested bands', async () => {
    const sh = new Uint32Array(CAPTURE.length * 16);
    for (let i = 0; i < CAPTURE.length; i++)
      for (let c = 0; c < 15; c++) sh[i * 16 + c] = i * 100 + c;
    const data = await parseLccChunk(
      captureChunk(),
      {
        ...CHUNK_PARAMS,
        sh: { bands: 1, range: SH_RANGE, source: 'sidecar', url: 'x' },
      },
      sh.buffer,
    );
    // Band 1 = 3 coefficients, taken as a prefix of each record.
    expect(data.shPacked?.packed).toHaveLength(CAPTURE.length * 3);
    expect([...data.shPacked!.packed]).toEqual([0, 1, 2, 100, 101, 102, 200, 201, 202]);
  });

  it('rejects an shcoef.bin range that does not match the base chunk', async () => {
    await expect(
      parseLccChunk(
        captureChunk(),
        {
          ...CHUNK_PARAMS,
          sh: { bands: 3, range: SH_RANGE, source: 'sidecar', url: 'x' },
        },
        new ArrayBuffer(8),
      ),
    ).rejects.toThrow(/shcoef.bin range is 8 bytes; expected 192/);
  });

  it('decodes an environment chunk’s inline SH at the 96-byte stride', async () => {
    const buffer = environmentChunk(2);
    const data = await parseLccChunk(buffer, {
      kind: 'environment',
      start: 0,
      length: buffer.byteLength,
      stride: 96,
      scale: SCALE_RANGE,
      sh: { bands: 3, range: SH_RANGE, source: 'inline' },
    });
    expect(data.count).toBe(2);
    expect([...data.positions.subarray(3, 6)]).toEqual([1, 2, 3]);
    expect([...data.shPacked!.packed.subarray(0, 3)]).toEqual([0, 1, 2]);
    expect([...data.shPacked!.packed.subarray(15, 18)]).toEqual([100, 101, 102]);
  });

  it('re-encodes inline SH into the requantize-target range, preserving values', async () => {
    const buffer = environmentChunk(2);
    const from = { min: [-1, -1, -1], max: [1, 1, 1] } as const;
    const to = { min: [-3, -3, -3], max: [3, 3, 3] } as const;
    const data = await parseLccChunk(buffer, {
      kind: 'environment',
      start: 0,
      length: buffer.byteLength,
      stride: 96,
      scale: SCALE_RANGE,
      sh: { bands: 3, range: from, source: 'inline', requantizeTo: to },
    });
    // The chunk now advertises the target range, so the pool decodes it there.
    expect(data.shPacked?.range).toEqual(to);
    // Every word still decodes to the value it held under its own range, within
    // a single target quantization step (the target here is strictly wider, so
    // nothing clips).
    const view = new DataView(buffer);
    const before = new Float32Array(3);
    const after = new Float32Array(3);
    for (let i = 0; i < 2; i++) {
      for (let c = 0; c < 15; c++) {
        decodeLccShWord(view.getUint32(i * 96 + 32 + c * 4, true), from, before, 0);
        decodeLccShWord(data.shPacked!.packed[i * 15 + c] as number, to, after, 0);
        for (let ch = 0; ch < 3; ch++)
          expect(after[ch] as number).toBeCloseTo(before[ch] as number, 2);
      }
    }
  });

  it('leaves inline SH untouched when the target range equals its own', async () => {
    const buffer = environmentChunk(2);
    const data = await parseLccChunk(buffer, {
      kind: 'environment',
      start: 0,
      length: buffer.byteLength,
      stride: 96,
      scale: SCALE_RANGE,
      sh: { bands: 3, range: SH_RANGE, source: 'inline', requantizeTo: SH_RANGE },
    });
    expect(data.shPacked?.range).toEqual(SH_RANGE);
    expect([...data.shPacked!.packed.subarray(0, 3)]).toEqual([0, 1, 2]);
  });

  it('keeps a Quality environment’s 96-byte stride when SH is disabled', async () => {
    // The stride belongs to the file, not to the request: reading a 96-byte
    // environment at 32 would yield 3x the splats, decoding SH bytes as
    // positions and scales - giant garbage blobs at ~1 fps.
    const buffer = environmentChunk(2);
    const data = await parseLccChunk(buffer, {
      kind: 'environment',
      start: 0,
      length: buffer.byteLength,
      stride: 96,
      scale: SCALE_RANGE,
      // no `sh`: the caller asked for DC only
    });
    expect(data.count).toBe(2); // not 6
    expect([...data.positions.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect([...data.positions.subarray(3, 6)]).toEqual([1, 2, 3]);
    expect(data.shPacked).toBeUndefined();
  });

  it('rejects inline SH on a record with no room for it', async () => {
    await expect(
      parseLccChunk(captureChunk(), {
        ...CHUNK_PARAMS,
        sh: { bands: 3, range: SH_RANGE, source: 'inline' },
      }),
    ).rejects.toThrow(/no room for it/);
  });

  it('rejects an unsupported record stride', async () => {
    await expect(
      parseLccChunk(new ArrayBuffer(64), { ...CHUNK_PARAMS, stride: 64 }),
    ).rejects.toThrow(/unsupported 64-byte record/);
  });

  it('honors an abort signal mid-decode', async () => {
    const controller = new AbortController();
    controller.abort();
    // Enough records that the loop reaches its first yield point.
    const big = new ArrayBuffer(LCC_RECORD_BYTES * 70_000);
    await expect(
      parseLccChunk(big, { ...CHUNK_PARAMS, length: big.byteLength }, undefined, controller.signal),
    ).rejects.toThrow();
  });
});
