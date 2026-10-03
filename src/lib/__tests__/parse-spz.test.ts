import { describe, expect, it } from 'vitest';
import { parseSpz } from '../formats/spz/parse-spz';

const SPZ_MAGIC = 0x5053474e;
/** Header `flags` bit 0: trained with Mip-Splatting antialiasing. */
const FLAG_ANTIALIASED = 0x01;

async function makeLegacySpz(flags = 0): Promise<ArrayBuffer> {
  const raw = new ArrayBuffer(16 + 9 + 1 + 3 + 3 + 3);
  const view = new DataView(raw);
  view.setUint32(0, SPZ_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, 1, true);
  view.setUint8(12, 0);
  view.setUint8(13, 0);
  view.setUint8(14, flags);
  new Uint8Array(raw, 16, 9).set([1, 0, 0, 0xfe, 0xff, 0xff, 3, 0, 0]);
  view.setUint8(25, 200);
  new Uint8Array(raw, 26, 3).set([128, 128, 128]);
  new Uint8Array(raw, 29, 3).set([160, 160, 160]);
  new Uint8Array(raw, 32, 3).set([128, 128, 128]);

  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/**
 * Wraps `payload` in a single-segment Zstandard frame holding one raw (stored)
 * block, so a v4 fixture needs no encoder: magic, frame header descriptor
 * (single segment, 1-byte content size), content size, then the 3-byte block
 * header (`last | raw << 1 | size << 3`) and the bytes themselves.
 */
function rawZstdFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > 255) throw new Error('fixture payload too large for a 1-byte FCS');
  const frame = new Uint8Array(4 + 1 + 1 + 3 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, 0xfd2fb528, true);
  frame[4] = 0x20;
  frame[5] = payload.byteLength;
  const block = 1 | (payload.byteLength << 3);
  frame[6] = block & 0xff;
  frame[7] = (block >>> 8) & 0xff;
  frame[8] = (block >>> 16) & 0xff;
  frame.set(payload, 9);
  return frame;
}

/** One-splat SPZ v4 (Zstandard streams) with the given header `flags`. */
function makeVersion4Spz(flags = 0): ArrayBuffer {
  const streams = [
    new Uint8Array([1, 0, 0, 0xfe, 0xff, 0xff, 3, 0, 0]), // positions (24.0 fixed)
    new Uint8Array([200]), // alphas
    new Uint8Array([128, 128, 128]), // colors
    new Uint8Array([160, 160, 160]), // scales
    new Uint8Array([0, 0, 0, 0]), // rotations (smallest-three)
  ].map(rawZstdFrame);
  const tocOffset = 32;
  const dataOffset = tocOffset + streams.length * 16;
  const total = dataOffset + streams.reduce((sum, s) => sum + s.byteLength, 0);
  const raw = new ArrayBuffer(total);
  const view = new DataView(raw);
  const bytes = new Uint8Array(raw);
  view.setUint32(0, SPZ_MAGIC, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, 1, true);
  view.setUint8(12, 0);
  view.setUint8(13, 0);
  view.setUint8(14, flags);
  view.setUint8(15, streams.length);
  view.setUint32(16, tocOffset, true);
  const uncompressed = [9, 1, 3, 3, 4];
  let offset = dataOffset;
  streams.forEach((stream, i) => {
    view.setBigUint64(tocOffset + i * 16, BigInt(stream.byteLength), true);
    view.setBigUint64(tocOffset + i * 16 + 8, BigInt(uncompressed[i] as number), true);
    bytes.set(stream, offset);
    offset += stream.byteLength;
  });
  return raw;
}

describe('parseSpz', () => {
  it('decodes legacy gzip SPZ data', async () => {
    const data = await parseSpz(await makeLegacySpz());

    expect(data.count).toBe(1);
    expect(Array.from(data.positions)).toEqual([1, -2, 3]);
    expect(Array.from(data.colors)).toEqual([128, 128, 128, 200]);
    expect(data.covariances[0]).toBeCloseTo(1, 3);
    expect(data.covariances[3]).toBeCloseTo(1, 3);
    expect(data.covariances[5]).toBeCloseTo(1, 3);
    // Flag bit 0 clear: the field stays absent, so unflagged files keep the
    // classic 3DGS dilation path they always had.
    expect(data.antialias).toBeUndefined();
  });

  it('reports a legacy header with the antialiased flag bit set', async () => {
    const data = await parseSpz(await makeLegacySpz(FLAG_ANTIALIASED));

    expect(data.count).toBe(1);
    expect(data.antialias).toBe(true);
  });

  it('decodes a v4 Zstandard SPZ and reports the antialiased flag bit', async () => {
    const flagged = await parseSpz(makeVersion4Spz(FLAG_ANTIALIASED));
    expect(flagged.count).toBe(1);
    expect(Array.from(flagged.positions)).toEqual([1, -2, 3]);
    expect(Array.from(flagged.colors)).toEqual([128, 128, 128, 200]);
    expect(flagged.antialias).toBe(true);

    const plain = await parseSpz(makeVersion4Spz());
    expect(plain.count).toBe(1);
    expect(plain.antialias).toBeUndefined();
  });

  it('rejects uncompressed non-SPZ data', async () => {
    await expect(parseSpz(new ArrayBuffer(32))).rejects.toThrow(/Not an SPZ/);
  });

  it('rejects a legacy point count above the renderer maximum up front', async () => {
    // A tiny gzip stream declaring 2³¹−1 points must fail on the count, not
    // balloon into gigabyte allocations while sizing the payload.
    const raw = new ArrayBuffer(16);
    const view = new DataView(raw);
    view.setUint32(0, SPZ_MAGIC, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, 0x7fffffff, true);
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = await new Response(stream).arrayBuffer();
    await expect(parseSpz(compressed)).rejects.toThrow(/Invalid SPZ point count/);
  });

  it('rejects a v4 point count above the renderer maximum', async () => {
    const raw = new ArrayBuffer(32);
    const view = new DataView(raw);
    view.setUint32(0, SPZ_MAGIC, true);
    view.setUint32(4, 4, true);
    view.setUint32(8, (1 << 24) + 1, true);
    await expect(parseSpz(raw)).rejects.toThrow(/Invalid SPZ point count/);
  });
});
