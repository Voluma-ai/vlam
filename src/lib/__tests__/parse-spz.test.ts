import { describe, expect, it } from 'vitest';
import { parseSpz } from '../formats/spz/parse-spz';

const SPZ_MAGIC = 0x5053474e;

async function makeLegacySpz(): Promise<ArrayBuffer> {
  const raw = new ArrayBuffer(16 + 9 + 1 + 3 + 3 + 3);
  const view = new DataView(raw);
  view.setUint32(0, SPZ_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, 1, true);
  view.setUint8(12, 0);
  view.setUint8(13, 0);
  new Uint8Array(raw, 16, 9).set([1, 0, 0, 0xfe, 0xff, 0xff, 3, 0, 0]);
  view.setUint8(25, 200);
  new Uint8Array(raw, 26, 3).set([128, 128, 128]);
  new Uint8Array(raw, 29, 3).set([160, 160, 160]);
  new Uint8Array(raw, 32, 3).set([128, 128, 128]);

  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
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
