import { describe, expect, it } from 'vitest';
import { parseKsplat } from '../formats/ksplat/parse-ksplat';

const HEADER_BYTES = 4096;
const SECTION_HEADER_BYTES = 1024;

function makeKsplat(compressionLevel: 0 | 1, shDegree = 0): ArrayBuffer {
  const shComponents = shDegree === 0 ? 0 : shDegree === 1 ? 9 : 24;
  const shScalarBytes = compressionLevel === 0 ? 4 : compressionLevel === 1 ? 2 : 1;
  const recordBytes = (compressionLevel === 0 ? 44 : 24) + shComponents * shScalarBytes;
  const bucketBytes = compressionLevel === 0 ? 0 : 12;
  const buffer = new ArrayBuffer(HEADER_BYTES + SECTION_HEADER_BYTES + bucketBytes + recordBytes);
  const view = new DataView(buffer);
  view.setUint8(0, 0);
  view.setUint8(1, 1);
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, 1, true);
  view.setUint32(16, 1, true);
  view.setUint16(20, compressionLevel, true);

  const section = HEADER_BYTES;
  view.setUint32(section + 0, 1, true);
  view.setUint32(section + 4, 1, true);
  view.setUint16(section + 40, shDegree, true);
  const data = HEADER_BYTES + SECTION_HEADER_BYTES;
  if (compressionLevel === 0) {
    view.setFloat32(data + 0, 1, true);
    view.setFloat32(data + 4, 2, true);
    view.setFloat32(data + 8, 3, true);
    view.setFloat32(data + 12, 2, true);
    view.setFloat32(data + 16, 3, true);
    view.setFloat32(data + 20, 4, true);
    view.setFloat32(data + 24, 1, true);
    view.setFloat32(data + 28, 0, true);
    view.setFloat32(data + 32, 0, true);
    view.setFloat32(data + 36, 0, true);
    new Uint8Array(buffer, data + 40, 4).set([10, 20, 30, 40]);
    if (shDegree > 0) {
      const shBase = data + (compressionLevel === 0 ? 44 : 24);
      view.setFloat32(shBase + 0, 0.5, true);
      view.setFloat32(shBase + 4, -0.25, true);
      view.setFloat32(shBase + 8, 0.1, true);
    }
  } else {
    view.setUint32(section + 8, 1, true);
    view.setUint32(section + 12, 1, true);
    view.setFloat32(section + 16, 2, true);
    view.setUint16(section + 20, 12, true);
    view.setUint32(section + 24, 32767, true);
    view.setUint32(section + 32, 1, true);
    view.setFloat32(data + 0, 1, true);
    view.setFloat32(data + 4, 2, true);
    view.setFloat32(data + 8, 3, true);
    const record = data + 12;
    view.setUint16(record + 0, 32767, true);
    view.setUint16(record + 2, 32767, true);
    view.setUint16(record + 4, 32767, true);
    view.setUint16(record + 6, 0x4000, true);
    view.setUint16(record + 8, 0x4200, true);
    view.setUint16(record + 10, 0x4400, true);
    view.setUint16(record + 12, 0x3c00, true);
    view.setUint16(record + 14, 0, true);
    view.setUint16(record + 16, 0, true);
    view.setUint16(record + 18, 0, true);
    new Uint8Array(buffer, record + 20, 4).set([10, 20, 30, 40]);
  }
  return buffer;
}

describe('parseKsplat', () => {
  it.each([0, 1] as const)('decodes compression level %i', (compressionLevel) => {
    const data = parseKsplat(makeKsplat(compressionLevel));

    expect(data.count).toBe(1);
    expect(Array.from(data.positions)).toEqual([1, 2, 3]);
    expect(Array.from(data.colors)).toEqual([10, 20, 30, 40]);
    expect(Array.from(data.covariances)).toEqual([4, 0, 0, 9, 0, 16]);
  });

  it('decodes degree-1 spherical harmonics', () => {
    const data = parseKsplat(makeKsplat(0, 1));
    expect(data.shPacked?.bands).toBe(1);
    expect(data.shPacked?.packed.length).toBe(3);
  });

  it('rejects full + partial bucket counts exceeding the declared bucket count', () => {
    const buffer = makeKsplat(1);
    const view = new DataView(buffer);
    const section = 4096; // HEADER_BYTES
    // bucketCount is 1; declare 2 full and 1 partial buckets. Unchecked, the
    // bucket lookup would read centers out of the section's storage.
    view.setUint32(section + 32, 2, true); // fullBucketCount
    view.setUint32(section + 36, 1, true); // partialBucketCount
    expect(() => parseKsplat(buffer)).toThrow(/exceed the 1 declared/);
  });
});
