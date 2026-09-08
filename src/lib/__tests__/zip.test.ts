import { describe, expect, it } from 'vitest';
import { findZipEndOfCentralDirectory } from '../formats/sog/zip';

describe('ZIP footer search', () => {
  it('accepts the maximum-length archive comment', () => {
    const bytes = new Uint8Array(22 + 0xffff);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(20, 0xffff, true);
    expect(findZipEndOfCentralDirectory(bytes)).toEqual({
      entryCount: 0,
      centralDirectoryOffset: 0,
      centralDirectorySize: 0,
    });
  });

  it('never reads payload bytes before the maximum footer window', () => {
    const length = 128 * 1024 * 1024;
    const firstAllowed = length - 22 - 0xffff;
    // Guard reads instead of asserting wall time or allocating a large scene.
    const bytes = new Proxy(
      { byteLength: length },
      {
        get(target, key) {
          if (key === 'byteLength') return target.byteLength;
          const index = Number(key);
          if (index < firstAllowed) throw new Error('Scanned ZIP payload');
          return 0;
        },
      },
    ) as unknown as Uint8Array;
    expect(findZipEndOfCentralDirectory(bytes)).toBeNull();
  });
});
