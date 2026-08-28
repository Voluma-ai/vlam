import { describe, expect, it } from 'vitest';
import {
  parseRad,
  parseRadChunkStreaming,
  parseRadHeaderMeta,
  RAD_CHUNK_MAGIC,
  RAD_MAGIC,
} from '../formats/rad/parse-rad';

interface Property {
  readonly name: string;
  readonly encoding: string;
  readonly bytes: number[];
  readonly min?: number;
  readonly max?: number;
}

function roundup8(size: number): number {
  return (size + 7) & ~7;
}

function padTo(bytes: number[], length: number): number[] {
  const padded = bytes.slice();
  while (padded.length < length) padded.push(0);
  return padded;
}

/** Assembles a `RADC`-magic chunk (header + tightly-packed properties). */
function buildChunk(count: number, lodTree: boolean, properties: readonly Property[]): number[] {
  let offset = 0;
  const propMeta = properties.map((prop) => {
    const meta = {
      offset,
      bytes: prop.bytes.length,
      property: prop.name,
      encoding: prop.encoding,
      ...(prop.min !== undefined ? { min: prop.min } : {}),
      ...(prop.max !== undefined ? { max: prop.max } : {}),
    };
    offset += prop.bytes.length;
    return meta;
  });
  const payload = properties.flatMap((prop) => prop.bytes);
  const payloadBytes = payload.length;

  const chunkMeta = {
    version: 1,
    base: 0,
    count,
    payloadBytes,
    ...(lodTree ? { lodTree: true } : {}),
    properties: propMeta,
  };
  const metaJson = Array.from(new TextEncoder().encode(JSON.stringify(chunkMeta)));
  const metaPadded = padTo(metaJson, roundup8(metaJson.length));

  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, RAD_CHUNK_MAGIC, true);
  new DataView(header.buffer).setUint32(4, metaJson.length, true);

  const payloadSizeBytes = new Uint8Array(8);
  new DataView(payloadSizeBytes.buffer).setBigUint64(0, BigInt(payloadBytes), true);

  return [...header, ...metaPadded, ...payloadSizeBytes, ...payload];
}

/** Assembles a bare `RAD0` header (no chunk payload) from arbitrary metadata. */
function buildRadHeader(meta: unknown): ArrayBuffer {
  const metaJson = Array.from(new TextEncoder().encode(JSON.stringify(meta)));
  const metaPadded = padTo(metaJson, roundup8(metaJson.length));
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, RAD_MAGIC, true);
  new DataView(header.buffer).setUint32(4, metaJson.length, true);
  return new Uint8Array([...header, ...metaPadded]).buffer;
}

function buildRadFile(chunkBytes: readonly number[]): ArrayBuffer {
  return buildRadFileChunks([chunkBytes]);
}

function buildRadFileChunks(chunkByteArrays: readonly (readonly number[])[]): ArrayBuffer {
  let offset = 0;
  const chunks = chunkByteArrays.map((bytes) => {
    const entry = { offset, bytes: bytes.length };
    offset += bytes.length;
    return entry;
  });
  const chunkBytes = chunkByteArrays.flat();
  const meta = {
    version: 1,
    type: 'gsplat',
    count: chunkByteArrays.length,
    allChunkBytes: chunkBytes.length,
    chunks,
  };
  const metaJson = Array.from(new TextEncoder().encode(JSON.stringify(meta)));
  const metaPadded = padTo(metaJson, roundup8(metaJson.length));

  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, RAD_MAGIC, true);
  new DataView(header.buffer).setUint32(4, metaJson.length, true);

  const bytes = new Uint8Array([...header, ...metaPadded, ...chunkBytes]);
  return bytes.buffer;
}

function f32Bytes(...values: number[]): number[] {
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  values.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return Array.from(new Uint8Array(buffer));
}

function u16Bytes(...values: number[]): number[] {
  const buffer = new ArrayBuffer(values.length * 2);
  const view = new DataView(buffer);
  values.forEach((value, i) => view.setUint16(i * 2, value, true));
  return Array.from(new Uint8Array(buffer));
}

function u32Bytes(...values: number[]): number[] {
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value, true));
  return Array.from(new Uint8Array(buffer));
}

/** One splat's worth of plain-f32 properties (identity orientation). */
function splatProperties(
  center: [number, number, number],
  alpha: number,
  rgb: [number, number, number],
  scale: [number, number, number],
): Property[] {
  return [
    { name: 'center', encoding: 'f32', bytes: f32Bytes(...center) },
    { name: 'alpha', encoding: 'f32', bytes: f32Bytes(alpha) },
    { name: 'rgb', encoding: 'f32', bytes: f32Bytes(...rgb) },
    { name: 'scales', encoding: 'f32', bytes: f32Bytes(...scale) },
    { name: 'orientation', encoding: 'f32', bytes: f32Bytes(0, 0, 0) },
  ];
}

/**
 * Column-major ("planar") f32 bytes for `dims` dimensions across multiple
 * splats - column `d` holds every splat's value before column `d + 1` starts,
 * matching Spark's per-property encoding (see `decodeF32` in `parse-rad.ts`).
 */
function planarF32(dims: number, rows: readonly number[][]): number[] {
  const bytes: number[] = [];
  for (let d = 0; d < dims; d++) {
    for (const row of rows) bytes.push(...f32Bytes(row[d] as number));
  }
  return bytes;
}

/** Column-major single-byte values (for `r8`/`s8` encodings). */
function planarBytes(dims: number, rows: readonly number[][]): number[] {
  const bytes: number[] = [];
  for (let d = 0; d < dims; d++) {
    for (const row of rows) bytes.push(row[d] as number);
  }
  return bytes;
}

/** Dequantizes one packed 11/10/11 SH word (the shader's decode). */
function unpackShWord(
  word: number,
  range: { min: readonly [number, number, number]; max: readonly [number, number, number] },
): [number, number, number] {
  const channel = (code: number, maxCode: number, lo: number, hi: number): number =>
    lo + (code / maxCode) * (hi - lo);
  return [
    channel(word & 0x7ff, 2047, range.min[0], range.max[0]),
    channel((word >>> 11) & 0x3ff, 1023, range.min[1], range.max[1]),
    channel((word >>> 21) & 0x7ff, 2047, range.min[2], range.max[2]),
  ];
}

/** The value an `s8` byte decodes to under a column `max`. */
function s8Value(byte: number, max: number): number {
  return ((byte >= 128 ? byte - 256 : byte) / 127) * max;
}

describe('parseRad', () => {
  it('decodes a single-chunk RAD file with plain float encodings', async () => {
    const chunk = buildChunk(
      1,
      false,
      splatProperties([1, -2, 3], 0.75, [0.5, 0.25, 0.75], [0.5, 0.25, 0.125]),
    );
    const data = await parseRad(buildRadFile(chunk));

    expect(data.count).toBe(1);
    expect(data.positions[0]).toBeCloseTo(1, 5);
    expect(data.positions[1]).toBeCloseTo(-2, 5);
    expect(data.positions[2]).toBeCloseTo(3, 5);
    expect(data.colors[0]).toBe(Math.round(0.5 * 255));
    expect(data.colors[1]).toBe(Math.round(0.25 * 255));
    expect(data.colors[2]).toBe(Math.round(0.75 * 255));
    // Spark LOD alpha encoding: stored opacity is `alpha / 2` (shader recovers ×2).
    expect(data.colors[3]).toBe(Math.round(0.75 * 0.5 * 255));
    // Identity rotation: covariance is just the squared scales on the diagonal.
    expect(data.covariances[0]).toBeCloseTo(0.5 * 0.5, 4);
    expect(data.covariances[3]).toBeCloseTo(0.25 * 0.25, 4);
    expect(data.covariances[5]).toBeCloseTo(0.125 * 0.125, 4);
  });

  it('decodes a lone .radc chunk with no RAD0 header', async () => {
    const chunk = buildChunk(1, false, splatProperties([0, 0, 0], 1, [1, 1, 1], [1, 1, 1]));
    const data = await parseRad(new Uint8Array(chunk).buffer);
    expect(data.count).toBe(1);
  });

  it('drops internal LOD-tree nodes and keeps only leaves', async () => {
    // Splat 0 is a leaf, splat 1 an internal (merged) node - properties are
    // column-major across splats, not concatenated splat-by-splat.
    const properties: Property[] = [
      {
        name: 'center',
        encoding: 'f32',
        bytes: planarF32(3, [
          [1, 1, 1],
          [9, 9, 9],
        ]),
      },
      { name: 'alpha', encoding: 'f32', bytes: planarF32(1, [[1], [1.5]]) },
      {
        name: 'rgb',
        encoding: 'f32',
        bytes: planarF32(3, [
          [1, 0, 0],
          [0, 1, 0],
        ]),
      },
      {
        name: 'scales',
        encoding: 'f32',
        bytes: planarF32(3, [
          [1, 1, 1],
          [2, 2, 2],
        ]),
      },
      {
        name: 'orientation',
        encoding: 'f32',
        bytes: planarF32(3, [
          [0, 0, 0],
          [0, 0, 0],
        ]),
      },
      { name: 'child_count', encoding: 'u16', bytes: u16Bytes(0, 1) },
    ];

    const chunk = buildChunk(2, true, properties);
    const data = await parseRad(buildRadFile(chunk));

    expect(data.count).toBe(1);
    expect(data.positions[0]).toBeCloseTo(1, 5);
    expect(data.colors[0]).toBe(255); // the leaf's red channel, not the internal node's
  });

  it('computes per-splat LOD node size (streamed chunk)', async () => {
    // Spark's `encode_lod_tree` traversal size: `2 · (max(α,1)·4 − 3) · avg(scale)`.
    // Splat 0 leaf (alpha 1, scale 2) → factor 1, size 2·1·2 = 4.
    // Splat 1 merged (alpha 1.5, scale 1) → factor 1.5·4−3 = 3, size 2·3·1 = 6.
    // (NOT the rendered-covariance expansion 1+0.7·(4α−4)=2.4 - the cut uses the
    // steeper authored size; using the render curve stopped the descent early.)
    const properties: Property[] = [
      {
        name: 'center',
        encoding: 'f32',
        bytes: planarF32(3, [
          [0, 0, 0],
          [0, 0, 0],
        ]),
      },
      { name: 'alpha', encoding: 'f32', bytes: planarF32(1, [[1], [1.5]]) },
      {
        name: 'rgb',
        encoding: 'f32',
        bytes: planarF32(3, [
          [1, 1, 1],
          [1, 1, 1],
        ]),
      },
      {
        name: 'scales',
        encoding: 'f32',
        bytes: planarF32(3, [
          [2, 2, 2],
          [1, 1, 1],
        ]),
      },
      {
        name: 'orientation',
        encoding: 'f32',
        bytes: planarF32(3, [
          [0, 0, 0],
          [0, 0, 0],
        ]),
      },
      { name: 'child_count', encoding: 'u16', bytes: u16Bytes(0, 1) },
      { name: 'child_start', encoding: 'u32', bytes: u32Bytes(0, 5) },
    ];
    const chunk = buildChunk(2, true, properties);
    const data = await parseRadChunkStreaming(new Uint8Array(chunk).buffer);

    // Leaves sort first, so the leaf is slot 0 and the merged node slot 1.
    expect(data.radTree?.size[0]).toBeCloseTo(4, 5);
    expect(data.radTree?.size[1]).toBeCloseTo(6, 5);
  });

  it('stores raw covariance and alpha/2 opacity for merged nodes (streamed chunk)', async () => {
    // Slot 0 is the leaf (alpha 1, scale 2), slot 1 the merged node (alpha 1.5,
    // scale 1). Spark's LOD alpha encoding stores `alpha / 2` in the opacity byte
    // and leaves the covariance at its raw fitted shape - the merged node's
    // coverage expansion happens in the material (grown σ-cutoff + super-Gaussian),
    // not by inflating the covariance here.
    const properties: Property[] = [
      {
        name: 'center',
        encoding: 'f32',
        bytes: planarF32(3, [
          [0, 0, 0],
          [0, 0, 0],
        ]),
      },
      { name: 'alpha', encoding: 'f32', bytes: planarF32(1, [[1], [1.5]]) },
      {
        name: 'rgb',
        encoding: 'f32',
        bytes: planarF32(3, [
          [1, 1, 1],
          [1, 1, 1],
        ]),
      },
      {
        name: 'scales',
        encoding: 'f32',
        bytes: planarF32(3, [
          [2, 2, 2],
          [1, 1, 1],
        ]),
      },
      {
        name: 'orientation',
        encoding: 'f32',
        bytes: planarF32(3, [
          [0, 0, 0],
          [0, 0, 0],
        ]),
      },
      { name: 'child_count', encoding: 'u16', bytes: u16Bytes(0, 1) },
      { name: 'child_start', encoding: 'u32', bytes: u32Bytes(0, 5) },
    ];
    const chunk = buildChunk(2, true, properties);
    const data = await parseRadChunkStreaming(new Uint8Array(chunk).buffer);

    // Leaf (slot 0): alpha 1 → opacity 0.5·255, identity rotation → covariance 2².
    expect(data.colors[3]).toBe(Math.round(0.5 * 255));
    expect(data.covariances[0]).toBeCloseTo(4, 4);
    // Merged node (slot 1): alpha 1.5 → opacity 0.75·255 (the shader ×2 recovers
    // 1.5 as a size tag), covariance stays the raw fitted 1² - not inflated.
    expect(data.colors[7]).toBe(Math.round(0.75 * 255));
    expect(data.covariances[6]).toBeCloseTo(1, 4);
    expect(data.covariances[9]).toBeCloseTo(1, 4);
    expect(data.covariances[11]).toBeCloseTo(1, 4);
  });

  it('stores raw covariance for merged nodes', async () => {
    // Merged-node coverage expansion is done in the material (σ-cutoff +
    // super-Gaussian), so covariance is always the raw fitted shape.
    const properties: Property[] = [
      {
        name: 'center',
        encoding: 'f32',
        bytes: planarF32(3, [
          [0, 0, 0],
          [0, 0, 0],
        ]),
      },
      { name: 'alpha', encoding: 'f32', bytes: planarF32(1, [[1], [1.5]]) },
      {
        name: 'rgb',
        encoding: 'f32',
        bytes: planarF32(3, [
          [1, 1, 1],
          [1, 1, 1],
        ]),
      },
      {
        name: 'scales',
        encoding: 'f32',
        bytes: planarF32(3, [
          [2, 2, 2],
          [1, 1, 1],
        ]),
      },
      {
        name: 'orientation',
        encoding: 'f32',
        bytes: planarF32(3, [
          [0, 0, 0],
          [0, 0, 0],
        ]),
      },
      { name: 'child_count', encoding: 'u16', bytes: u16Bytes(0, 1) },
      { name: 'child_start', encoding: 'u32', bytes: u32Bytes(0, 5) },
    ];
    const decoded = await parseRadChunkStreaming(
      new Uint8Array(buildChunk(2, true, properties)).buffer,
      undefined,
      undefined,
      false,
    );

    // The merged node's covariance is the raw fitted 1², never expanded.
    expect(decoded.covariances[6]).toBeCloseTo(1, 4); // merged node is slot 1 in file order
    // Leaf (slot 0, scale 2) covariance is likewise raw 2².
    expect(decoded.covariances[0]).toBeCloseTo(4, 4);
  });

  it('repacks direct SH columns into per-splat packed SH', async () => {
    const sh1 = [0.1, -0.2, 0.3, 0, 0, 0, 0, 0, 0];
    const chunk = buildChunk(1, false, [
      ...splatProperties([0, 0, 0], 1, [1, 1, 1], [1, 1, 1]),
      { name: 'sh1', encoding: 'f32', bytes: planarF32(9, [sh1]) },
    ]);
    const data = await parseRad(buildRadFile(chunk));

    expect(data.shPacked?.bands).toBe(1);
    expect(data.shPacked?.range.min[0]).toBeCloseTo(-0.3, 6);
    expect(data.shPacked?.range.max[0]).toBeCloseTo(0.3, 6);
    // First coefficient's RGB triple is preserved in Spark's coefficient-major layout.
    expect(data.shPacked?.packed[0]).toBe((1365 | (171 << 11) | (2047 << 21)) >>> 0);
  });

  it('expands clustered SH labels and passes the chunk-zero codebook onward', async () => {
    const code0 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const code1 = [0.25, 0, 0, 0, 0, 0, 0, 0, 0];
    const first = buildChunk(1, false, [
      ...splatProperties([0, 0, 0], 1, [1, 1, 1], [1, 1, 1]),
      { name: 'sh1_code', encoding: 'f32', bytes: planarF32(9, [code0, code1]) },
      { name: 'sh_label', encoding: 'u16', bytes: u16Bytes(1) },
    ]);
    const firstData = await parseRadChunkStreaming(new Uint8Array(first).buffer);
    expect(firstData.radShCodebook?.count).toBe(2);
    expect(firstData.shPacked?.bands).toBe(1);

    const later = buildChunk(1, false, [
      ...splatProperties([1, 0, 0], 1, [1, 1, 1], [1, 1, 1]),
      { name: 'sh_label', encoding: 'u16', bytes: u16Bytes(1) },
    ]);
    const laterData = await parseRadChunkStreaming(
      new Uint8Array(later).buffer,
      firstData.radShCodebook,
    );
    expect(laterData.shPacked?.packed).toEqual(firstData.shPacked?.packed);
  });

  it("keeps each splat's own coefficients across bands (multi-splat, bands 2)", async () => {
    // Two splats with distinct sh1 and sh2 values. Splat s, coefficient c,
    // channel k must round-trip to its own value - a band-block (rather than
    // splat-major) intermediate layout scrambles these across splats.
    const sh1 = [
      [0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18],
      [-0.2, -0.21, -0.22, -0.23, -0.24, -0.25, -0.26, -0.27, -0.28],
    ];
    const sh2 = [
      Array.from({ length: 15 }, (_, i) => 0.3 + i * 0.01),
      Array.from({ length: 15 }, (_, i) => -(0.5 + i * 0.01)),
    ];
    const chunk = buildChunk(2, false, [
      {
        name: 'center',
        encoding: 'f32',
        bytes: planarF32(3, [
          [0, 0, 0],
          [1, 0, 0],
        ]),
      },
      { name: 'alpha', encoding: 'f32', bytes: planarF32(1, [[1], [1]]) },
      {
        name: 'rgb',
        encoding: 'f32',
        bytes: planarF32(3, [
          [1, 1, 1],
          [1, 1, 1],
        ]),
      },
      {
        name: 'scales',
        encoding: 'f32',
        bytes: planarF32(3, [
          [1, 1, 1],
          [1, 1, 1],
        ]),
      },
      {
        name: 'orientation',
        encoding: 'f32',
        bytes: planarF32(3, [
          [0, 0, 0],
          [0, 0, 0],
        ]),
      },
      { name: 'sh1', encoding: 'f32', bytes: planarF32(9, sh1) },
      { name: 'sh2', encoding: 'f32', bytes: planarF32(15, sh2) },
    ]);
    const data = await parseRad(buildRadFile(chunk));

    expect(data.shPacked?.bands).toBe(2);
    const sh = data.shPacked!;
    // Per splat: coefficients 0-2 are the sh1 triples, 3-7 the sh2 triples.
    for (let s = 0; s < 2; s++) {
      const expected = [...(sh1[s] as number[]), ...(sh2[s] as number[])];
      for (let c = 0; c < 8; c++) {
        const [r, g, b] = unpackShWord(sh.packed[s * 8 + c] as number, sh.range);
        expect(r).toBeCloseTo(expected[c * 3] as number, 2);
        expect(g).toBeCloseTo(expected[c * 3 + 1] as number, 2);
        expect(b).toBeCloseTo(expected[c * 3 + 2] as number, 2);
      }
    }
  });

  it('packs every chunk against the shared scene SH range', async () => {
    // Two chunks whose SH values differ in magnitude, stored `s8` against the
    // same scene-global column max (as Spark writes it). Per-chunk measured
    // extents would disagree - the packed ranges must not.
    const max = 0.5;
    const shChunk = (bytes: number[], x: number): number[] =>
      buildChunk(1, false, [
        ...splatProperties([x, 0, 0], 1, [1, 1, 1], [1, 1, 1]),
        { name: 'sh1', encoding: 's8', max, bytes: planarBytes(9, [bytes]) },
      ]);
    const smallBytes = [10, 20, 30, 0, 0, 0, 0, 0, 0];
    const largeBytes = [120, 246, 90, 0, 0, 0, 0, 0, 0]; // 246 ≡ −10
    const data = await parseRad(
      buildRadFileChunks([shChunk(smallBytes, 0), shChunk(largeBytes, 1)]),
    );

    expect(data.count).toBe(2);
    const sh = data.shPacked!;
    expect(sh.range.max[0]).toBeCloseTo(max, 6);
    for (const [s, bytes] of [smallBytes, largeBytes].entries()) {
      for (let c = 0; c < 3; c++) {
        const [r, g, b] = unpackShWord(sh.packed[s * 3 + c] as number, sh.range);
        expect(r).toBeCloseTo(s8Value(bytes[c * 3] as number, max), 2);
        expect(g).toBeCloseTo(s8Value(bytes[c * 3 + 1] as number, max), 2);
        expect(b).toBeCloseTo(s8Value(bytes[c * 3 + 2] as number, max), 2);
      }
    }

    // The streamed path decodes chunks independently; the metadata range keeps
    // them consistent without threading.
    const a = await parseRadChunkStreaming(new Uint8Array(shChunk(smallBytes, 0)).buffer);
    const b = await parseRadChunkStreaming(new Uint8Array(shChunk(largeBytes, 1)).buffer);
    expect(a.shPacked?.range).toEqual(b.shPacked?.range);
  });

  it('expands a multi-entry, multi-band codebook per label', async () => {
    const entry = (base: number): { sh1: number[]; sh2: number[] } => ({
      sh1: Array.from({ length: 9 }, (_, i) => base + i * 0.01),
      sh2: Array.from({ length: 15 }, (_, i) => -(base + i * 0.01)),
    });
    const entries = [entry(0.1), entry(0.3)];
    const chunk = buildChunk(2, false, [
      {
        name: 'center',
        encoding: 'f32',
        bytes: planarF32(3, [
          [0, 0, 0],
          [1, 0, 0],
        ]),
      },
      { name: 'alpha', encoding: 'f32', bytes: planarF32(1, [[1], [1]]) },
      {
        name: 'rgb',
        encoding: 'f32',
        bytes: planarF32(3, [
          [1, 1, 1],
          [1, 1, 1],
        ]),
      },
      {
        name: 'scales',
        encoding: 'f32',
        bytes: planarF32(3, [
          [1, 1, 1],
          [1, 1, 1],
        ]),
      },
      {
        name: 'orientation',
        encoding: 'f32',
        bytes: planarF32(3, [
          [0, 0, 0],
          [0, 0, 0],
        ]),
      },
      {
        name: 'sh1_code',
        encoding: 'f32',
        bytes: planarF32(
          9,
          entries.map((e) => e.sh1),
        ),
      },
      {
        name: 'sh2_code',
        encoding: 'f32',
        bytes: planarF32(
          15,
          entries.map((e) => e.sh2),
        ),
      },
      { name: 'sh_label', encoding: 'u16', bytes: u16Bytes(1, 0) }, // splat 0 → entry 1
    ]);
    const data = await parseRadChunkStreaming(new Uint8Array(chunk).buffer);

    expect(data.radShCodebook?.count).toBe(2);
    expect(data.shPacked?.bands).toBe(2);
    const sh = data.shPacked!;
    for (const [s, e] of [entries[1]!, entries[0]!].entries()) {
      const expected = [...e.sh1, ...e.sh2];
      for (let c = 0; c < 8; c++) {
        const [r, g, b] = unpackShWord(sh.packed[s * 8 + c] as number, sh.range);
        expect(r).toBeCloseTo(expected[c * 3] as number, 2);
        expect(g).toBeCloseTo(expected[c * 3 + 1] as number, 2);
        expect(b).toBeCloseTo(expected[c * 3 + 2] as number, 2);
      }
    }
  });

  it('rejects a RAD file referencing an external .radc chunk', async () => {
    const meta = {
      version: 1,
      type: 'gsplat',
      count: 1,
      allChunkBytes: 0,
      chunks: [{ offset: 0, bytes: 0, filename: 'scene-0.radc' }],
    };
    const metaJson = Array.from(new TextEncoder().encode(JSON.stringify(meta)));
    const metaPadded = padTo(metaJson, roundup8(metaJson.length));
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, RAD_MAGIC, true);
    new DataView(header.buffer).setUint32(4, metaJson.length, true);
    const bytes = new Uint8Array([...header, ...metaPadded]);

    await expect(parseRad(bytes.buffer)).rejects.toThrow(/external \.radc/);
  });

  it('rejects a buffer with no RAD magic', async () => {
    await expect(parseRad(new ArrayBuffer(32))).rejects.toThrow(/Not a RAD/);
  });

  it('rejects a chunk count above the supported maximum before allocating', async () => {
    const chunk = buildChunk(1, false, splatProperties([0, 0, 0], 1, [1, 1, 1], [1, 1, 1]));
    // Rebuild the chunk with the hostile count spliced into its JSON meta.
    const metaJson = JSON.parse(
      new TextDecoder().decode(new Uint8Array(chunk).subarray(8, 8 + jsonLength(chunk))),
    ) as { count: number };
    metaJson.count = (1 << 24) + 1;
    const hostile = rebuildChunkMeta(chunk, metaJson);
    await expect(parseRadChunkStreaming(hostile)).rejects.toThrow(/above the supported maximum/);
  });

  it('rejects non-integer and negative chunk counts', async () => {
    const chunk = buildChunk(1, false, splatProperties([0, 0, 0], 1, [1, 1, 1], [1, 1, 1]));
    for (const count of [-1, 2.5]) {
      const metaJson = JSON.parse(
        new TextDecoder().decode(new Uint8Array(chunk).subarray(8, 8 + jsonLength(chunk))),
      ) as { count: number };
      metaJson.count = count;
      await expect(parseRadChunkStreaming(rebuildChunkMeta(chunk, metaJson))).rejects.toThrow(
        /Invalid RAD chunk splat count/,
      );
    }
  });

  it('rejects a count larger than a column physically holds', async () => {
    // The chunk carries one splat's bytes but declares 1000 splats.
    const chunk = buildChunk(1, false, splatProperties([0, 0, 0], 1, [1, 1, 1], [1, 1, 1]));
    const metaJson = JSON.parse(
      new TextDecoder().decode(new Uint8Array(chunk).subarray(8, 8 + jsonLength(chunk))),
    ) as { count: number };
    metaJson.count = 1000;
    const hostile = rebuildChunkMeta(chunk, metaJson);
    await expect(parseRadChunkStreaming(hostile)).rejects.toThrow(/fewer than the/);
  });

  it('rejects a header count above the supported maximum', async () => {
    const chunk = buildChunk(1, false, splatProperties([0, 0, 0], 1, [1, 1, 1], [1, 1, 1]));
    const file = new Uint8Array(buildRadFile(chunk));
    const view = new DataView(file.buffer);
    const length = view.getUint32(4, true);
    const meta = JSON.parse(new TextDecoder().decode(file.subarray(8, 8 + length))) as {
      count: number;
    };
    meta.count = (1 << 24) + 1;
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    const padded = padTo(Array.from(metaBytes), roundup8(metaBytes.length));
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, RAD_MAGIC, true);
    new DataView(header.buffer).setUint32(4, metaBytes.length, true);
    const hostile = new Uint8Array([...header, ...padded, ...chunk]);
    await expect(parseRad(hostile.buffer)).rejects.toThrow(/above the supported maximum/);
  });
});

describe('parseRadHeaderMeta', () => {
  /** A real streamed LOD header: the Eemhart `point_cloud-lod.rad` capture. */
  function eemhartMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const chunkSize = 65536;
    const numChunks = 816;
    return {
      version: 1,
      type: 'gsplat',
      count: 53_469_952,
      maxSh: 0,
      lodTree: true,
      chunkSize,
      chunks: Array.from({ length: numChunks }, (_entry, index) => ({
        offset: index * 1_000_000,
        bytes: 1_000_000,
      })),
      ...overrides,
    };
  }

  // The header count is the whole LOD-tree node total (merged nodes + leaves)
  // of a capture that must stream; it sizes nothing, so the one-shot pool
  // ceiling must not reject it here.
  it('accepts a streamed LOD header declaring more than 2^24 tree nodes', () => {
    const { meta } = parseRadHeaderMeta(buildRadHeader(eemhartMeta()));
    expect(meta.count).toBe(53_469_952);
    expect(meta.chunkSize).toBe(65536);
    expect(meta.chunks).toHaveLength(816);
  });

  it('rejects a count larger than the declared chunk table can hold', () => {
    const meta = eemhartMeta({
      count: 1_000_000,
      chunks: [
        { offset: 0, bytes: 16 },
        { offset: 16, bytes: 16 },
      ],
    });
    expect(() => parseRadHeaderMeta(buildRadHeader(meta))).toThrow(
      /more than its 2 chunks of 65536 can hold/,
    );
  });

  it('rejects an invalid chunk size', () => {
    for (const chunkSize of [0, -1, 2.5, (1 << 24) + 1]) {
      expect(() => parseRadHeaderMeta(buildRadHeader(eemhartMeta({ chunkSize })))).toThrow(
        /Invalid RAD chunk size/,
      );
    }
  });

  it('rejects a non-integer or negative header count', () => {
    for (const count of [-1, 2.5]) {
      expect(() => parseRadHeaderMeta(buildRadHeader(eemhartMeta({ count })))).toThrow(
        /Invalid RAD header splat count/,
      );
    }
  });
});

/** Length of a built chunk's JSON metadata (its uint32 at offset 4). */
function jsonLength(chunk: readonly number[]): number {
  return new DataView(new Uint8Array(chunk.slice(0, 8)).buffer).getUint32(4, true);
}

/** Rebuilds a chunk built by `buildChunk` with replacement JSON metadata. */
function rebuildChunkMeta(chunk: readonly number[], meta: unknown): ArrayBuffer {
  const oldLength = jsonLength(chunk);
  const rest = chunk.slice(8 + roundup8(oldLength));
  const metaJson = Array.from(new TextEncoder().encode(JSON.stringify(meta)));
  const metaPadded = padTo(metaJson, roundup8(metaJson.length));
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, RAD_CHUNK_MAGIC, true);
  new DataView(header.buffer).setUint32(4, metaJson.length, true);
  return new Uint8Array([...header, ...metaPadded, ...rest]).buffer;
}
