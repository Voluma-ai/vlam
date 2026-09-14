import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSplatPly } from '../formats/ply/parse-splat-ply';
import {
  APPROXIMATE_SH_SAMPLE_LIMIT,
  parseSplatPlyRemote,
} from '../formats/ply/parse-splat-ply-remote';

const CORE = [
  'x',
  'y',
  'z',
  'f_dc_0',
  'f_dc_1',
  'f_dc_2',
  'opacity',
  'scale_0',
  'scale_1',
  'scale_2',
  'rot_0',
  'rot_1',
  'rot_2',
  'rot_3',
];

function fixture(
  count: number,
  bands: 0 | 1 | 2 | 3,
  reorder = false,
  lateOutlier = false,
): ArrayBuffer {
  const coefficients = [0, 3, 8, 15][bands]!;
  const names = [...CORE, ...Array.from({ length: coefficients * 3 }, (_, i) => `f_rest_${i}`)];
  if (reorder) names.reverse();
  const header = new TextEncoder().encode(
    [
      'ply',
      'format binary_little_endian 1.0',
      'element vertex ' + count,
      ...names.map((name) => `property float ${name}`),
      'end_header',
      '',
    ].join('\n'),
  );
  const output = new Uint8Array(header.length + count * names.length * 4);
  output.set(header);
  const view = new DataView(output.buffer);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < names.length; j++) {
      const name = names[j]!;
      const value =
        lateOutlier && i === count - 1 && name === 'f_rest_0'
          ? 1000
          : name === 'rot_0'
            ? 1
            : name.startsWith('scale_')
              ? -1
              : name.startsWith('f_rest_')
                ? (((i % 7) - 3) * (j + 1)) / 17
                : name === 'x'
                  ? i / 10
                  : name === 'y'
                    ? i / 20
                    : 0;
      view.setFloat32(header.length + (i * names.length + j) * 4, value, true);
    }
  }
  return output.buffer;
}

function response(bytes: ArrayBuffer, split: number, length = true): Response {
  const input = new Uint8Array(bytes);
  let at = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at === input.length) return controller.close();
        const end = Math.min(input.length, at + split);
        controller.enqueue(input.subarray(at, end));
        at = end;
      },
    }),
    { headers: length ? { 'Content-Length': String(input.length) } : {} },
  );
}

function fakeOpfs(quotaFailure = false): { removed: string[] } {
  const removed: string[] = [];
  let chunks: Uint8Array[] = [];
  const dir = {
    getFileHandle: async () => ({
      createWritable: async () => ({
        write: async (value: Uint8Array) => {
          if (quotaFailure) throw new DOMException('Full', 'QuotaExceededError');
          chunks.push(value.slice());
        },
        close: async () => undefined,
        abort: async () => undefined,
      }),
      getFile: async () => new Blob(chunks.map((chunk) => chunk.buffer.slice(0) as ArrayBuffer)),
    }),
    removeEntry: async (id: string) => {
      removed.push(id);
      chunks = [];
    },
  };
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) },
    locks: {
      request: async (_name: string, _options: unknown, callback: () => Promise<unknown>) =>
        callback(),
    },
  });
  return { removed };
}

afterEach(() => vi.unstubAllGlobals());

describe('incremental remote PLY', () => {
  it.each([0, 1, 2, 3] as const)(
    'matches buffered SH%d exactly across one-byte chunks',
    async (bands) => {
      const bytes = fixture(3, bands, true);
      const opfs = fakeOpfs();
      const result = await parseSplatPlyRemote(response(bytes, 1, false), {
        mode: 'exact-stream',
        signal: new AbortController().signal,
        resourceId: 'one-byte-test',
        windowBytes: 512,
      });
      const expected = parseSplatPly(bytes);
      expect(result.data.positions).toEqual(expected.positions);
      expect(result.data.colors).toEqual(expected.colors);
      expect(result.data.covariances).toEqual(expected.covariances);
      expect(result.data.shPacked).toEqual(expected.shPacked);
      expect(result.metrics.inputAccountingVersion).toBe(2);
      expect(result.metrics.peakInputBytes).toBeLessThan(70 * 1024);
      expect(result.metrics.temporaryDiskBytes).toBe(
        bands ? 3 * (14 + [0, 3, 8, 15][bands]! * 3) * 4 : 0,
      );
      expect(opfs.removed).toEqual(bands ? ['one-byte-test'] : []);
    },
  );

  it('counts the second-pass read alongside retained source buffers', async () => {
    fakeOpfs();
    const bytes = fixture(3, 3);
    const headerBytes = bytes.byteLength - 3 * 236;
    const result = await parseSplatPlyRemote(response(bytes, 1), {
      mode: 'exact-stream',
      signal: new AbortController().signal,
      resourceId: 'memory-second-pass',
      windowBytes: 512,
    });
    // The one-byte views retain their complete source buffer. Two SH3 records
    // fit in both the reusable input window and the separate disk-read slice.
    expect(result.metrics.peakInputBytes).toBe(
      64 * 1024 + headerBytes + bytes.byteLength + 472 * 2,
    );
    expect(result.data.shPacked).toEqual(parseSplatPly(bytes).shPacked);
  });

  it('counts retained compressed chunks and their joined copy', async () => {
    const bounds = [
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
    ];
    const header = new TextEncoder().encode(
      [
        'ply',
        'format binary_little_endian 1.0',
        'element chunk 1',
        ...bounds.map((name) => `property float ${name}`),
        'element vertex 1',
        ...['position', 'rotation', 'scale', 'color'].map((name) => `property uint packed_${name}`),
        'end_header',
        '',
      ].join('\n'),
    );
    const bytes = new Uint8Array(header.length + 48 + 16);
    bytes.set(header);
    const result = await parseSplatPlyRemote(response(bytes.buffer, 1), {
      mode: 'exact-stream',
      signal: new AbortController().signal,
    });
    // All network views alias one buffer; it is counted once. The two header
    // copies and the joined buffer are separate allocations.
    expect(result.metrics.peakInputBytes).toBe(
      64 * 1024 + header.length * 2 + bytes.byteLength * 2,
    );
    expect(result.metrics.bufferedFallback).toBe(true);
    expect(result.data).toEqual(parseSplatPly(bytes.buffer));
  });

  it('handles split records and unknown length without higher-order SH', async () => {
    const bytes = fixture(11, 0);
    const result = await parseSplatPlyRemote(response(bytes, 17, false), {
      mode: 'approximate-sh-stream',
      signal: new AbortController().signal,
      windowBytes: 224,
    });
    expect(result.data.positions).toEqual(parseSplatPly(bytes).positions);
    expect(result.metrics.inputBytes).toBe(bytes.byteLength);
    expect(result.metrics.bufferedFallback).toBe(false);
  });

  it('rejects a truncated record', async () => {
    const bytes = fixture(2, 0).slice(0, -1);
    await expect(
      parseSplatPlyRemote(response(bytes, 7), {
        mode: 'exact-stream',
        signal: new AbortController().signal,
        windowBytes: 224,
      }),
    ).rejects.toThrow(/Truncated PLY/);
  });

  it.each([true, false])(
    'does not eagerly allocate an inflated vertex count with length=%s',
    async (length) => {
      const header = new TextEncoder().encode(
        [
          'ply',
          'format binary_little_endian 1.0',
          'element vertex 1000000',
          ...CORE.map((name) => `property float ${name}`),
          'end_header',
          '',
        ].join('\n'),
      );
      const bytes = new Uint8Array(header.length + 2 * CORE.length * 4);
      bytes.set(header);
      const NativeFloat32Array = Float32Array;
      vi.stubGlobal(
        'Float32Array',
        class extends NativeFloat32Array {
          constructor(count: number) {
            if (count > 1024) throw new Error('Eager decoded-array allocation');
            super(count);
          }
        },
      );
      await expect(
        parseSplatPlyRemote(response(bytes.buffer, 512, length), {
          mode: 'exact-stream',
          signal: new AbortController().signal,
          windowBytes: 224,
        }),
      ).rejects.toThrow(/Truncated PLY vertex records/);
    },
  );

  it('samples 65,536 vertices before locking approximate SH range', () => {
    expect(APPROXIMATE_SH_SAMPLE_LIMIT).toBe(65_536);
  });

  it('holds approximate SH range after the sample and counts a late outlier', async () => {
    const sampleLimit = 32;
    const bytes = fixture(sampleLimit + 1, 1, false, true);
    const result = await parseSplatPlyRemote(response(bytes, 256, false), {
      mode: 'approximate-sh-stream',
      signal: new AbortController().signal,
      windowBytes: 8 * 1024,
      sampleLimit,
    });
    const exact = parseSplatPly(bytes);
    expect(result.data.positions).toEqual(exact.positions);
    expect(result.data.colors).toEqual(exact.colors);
    expect(result.data.covariances).toEqual(exact.covariances);
    expect(result.metrics.clippedCoefficients).toBeGreaterThan(0);
    expect(result.metrics.clippedSplats).toBe(1);
    expect(result.metrics.shExtent).toBeLessThan(exact.shPacked!.range.max[0]);
  });

  it('grows approximate packed SH after the sample when length is unknown', async () => {
    const sampleLimit = 8;
    const count = 40;
    const bytes = fixture(count, 1);
    const result = await parseSplatPlyRemote(response(bytes, 64, false), {
      mode: 'approximate-sh-stream',
      signal: new AbortController().signal,
      windowBytes: 256,
      sampleLimit,
    });
    expect(result.data.positions).toEqual(parseSplatPly(bytes).positions);
    expect(result.data.shPacked?.packed).toHaveLength(count * 3);
    expect(result.data.shPacked?.packed.at(-1)).not.toBe(0);
  });

  it('does not trust encoded Content-Length for a decoded response body', async () => {
    const bytes = fixture(2, 0);
    const stream = response(bytes, 5).body!;
    const wrapped = new Response(stream, {
      headers: { 'Content-Length': '12', 'Content-Encoding': 'gzip' },
    });
    const result = await parseSplatPlyRemote(wrapped, {
      mode: 'exact-stream',
      signal: new AbortController().signal,
      windowBytes: 224,
    });
    expect(result.data.positions).toEqual(parseSplatPly(bytes).positions);
    expect(result.metrics.inputBytes).toBe(bytes.byteLength);
  });

  it('accepts decoded records when an intermediary hides the content encoding', async () => {
    const bytes = fixture(2, 0);
    const wrapped = new Response(response(bytes, 5, false).body, {
      headers: { 'Content-Length': '12' },
    });
    const result = await parseSplatPlyRemote(wrapped, {
      mode: 'exact-stream',
      signal: new AbortController().signal,
      windowBytes: 224,
    });
    expect(result.data.positions).toEqual(parseSplatPly(bytes).positions);
  });

  it('keeps source-buffer memory bounded past 2 GiB with a small decoded scene', async () => {
    const base = new Uint8Array(fixture(1, 0));
    const text = new TextDecoder().decode(base.subarray(0, 1024));
    const headerEnd = text.indexOf('end_header\n') + 'end_header\n'.length;
    const first = new TextEncoder().encode(
      text
        .slice(0, headerEnd)
        .replace(
          'element vertex 1',
          'element padding 536870913\nproperty float pad\nelement vertex 1',
        ),
    );
    const vertex = base.subarray(headerEnd);
    const paddingSize = 8 * 1024 * 1024;
    let paddingRemaining = 2 * 1024 * 1024 * 1024 + 4;
    let phase = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (phase++ === 0) return controller.enqueue(first);
        if (paddingRemaining > 0) {
          const length = Math.min(paddingSize, paddingRemaining);
          paddingRemaining -= length;
          return controller.enqueue(new Uint8Array(length));
        }
        if (phase === 259) return controller.enqueue(vertex);
        controller.close();
      },
    });
    const result = await parseSplatPlyRemote(new Response(body), {
      mode: 'exact-stream',
      signal: new AbortController().signal,
      windowBytes: 224,
    });
    expect(result.data.count).toBe(1);
    expect(result.data.positions).toEqual(parseSplatPly(base.buffer).positions);
    expect(result.metrics.inputBytes).toBeGreaterThan(2 * 1024 * 1024 * 1024);
    expect(result.metrics.peakInputBytes).toBeLessThan(9 * 1024 * 1024);
  }, 30_000);

  it('cleans its exact SH spool after a cancelled read', async () => {
    const opfs = fakeOpfs();
    const controller = new AbortController();
    const bytes = fixture(100, 1);
    await expect(
      parseSplatPlyRemote(response(bytes, 200, false), {
        mode: 'exact-stream',
        signal: controller.signal,
        resourceId: 'cancelled-spool',
        windowBytes: 256,
        onProgress(loaded) {
          if (loaded > 2000) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(opfs.removed).toEqual(['cancelled-spool']);
  });

  it('reports OPFS quota failure without restarting a buffered download', async () => {
    const opfs = fakeOpfs(true);
    await expect(
      parseSplatPlyRemote(response(fixture(2, 1), 32), {
        mode: 'exact-stream',
        signal: new AbortController().signal,
        resourceId: 'quota-spool',
        windowBytes: 256,
      }),
    ).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(opfs.removed).toEqual(['quota-spool']);
  });
});
