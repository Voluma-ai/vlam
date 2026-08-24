import { describe, expect, it } from 'vitest';
import { parseSplat } from '../formats/splat/parse-splat';

describe('parseSplat', () => {
  it('decodes the standard 32-byte record', () => {
    const buffer = new ArrayBuffer(32);
    const view = new DataView(buffer);
    view.setFloat32(0, 1, true);
    view.setFloat32(4, -2, true);
    view.setFloat32(8, 3, true);
    view.setFloat32(12, 2, true);
    view.setFloat32(16, 3, true);
    view.setFloat32(20, 4, true);
    new Uint8Array(buffer, 24).set([10, 20, 30, 40, 255, 128, 128, 128]);

    const data = parseSplat(buffer);

    expect(data.count).toBe(1);
    expect(Array.from(data.positions)).toEqual([1, -2, 3]);
    expect(Array.from(data.colors)).toEqual([10, 20, 30, 40]);
    expect(Array.from(data.covariances)).toEqual([4, 0, 0, 9, 0, 16]);
  });

  it('rejects a partial record', () => {
    expect(() => parseSplat(new ArrayBuffer(31))).toThrow(/not divisible by 32/);
  });
});
