import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectPaletteShBands,
  paletteShPeekTarget,
  resolvePaletteShBands,
  sogShBandsFromMeta,
  sogShBandsFromZip,
} from '../formats/sog/peek-sog-sh';
import type { SplatDatasetSource } from '../streaming/dataset-source';
import { buildZip } from './helpers/store-zip';

afterEach(() => {
  vi.unstubAllGlobals();
});

function dataset(overrides: Partial<SplatDatasetSource> = {}): SplatDatasetSource {
  return {
    manifestUrl: 'https://host/scene.lcc2',
    resolve: (path) => `https://host/${path}`,
    size: () => Promise.resolve(null),
    directoryFiles: () => null,
    dispose: () => {},
    ...overrides,
  };
}

function zipReader(bytes: Uint8Array) {
  const reads: Array<[number, number]> = [];
  const read = async (start: number, length: number): Promise<Uint8Array> => {
    reads.push([start, length]);
    return bytes.subarray(start, start + length);
  };
  return { read, reads };
}

describe('sogShBandsFromMeta', () => {
  it('returns 0 when shN is missing or malformed', () => {
    expect(sogShBandsFromMeta(null)).toBe(0);
    expect(sogShBandsFromMeta({})).toBe(0);
    expect(sogShBandsFromMeta({ shN: { bands: 0 } })).toBe(0);
    expect(sogShBandsFromMeta({ shN: { bands: 4 } })).toBe(0);
    expect(sogShBandsFromMeta({ shN: { bands: '3' } })).toBe(0);
  });

  it('returns the declared band count', () => {
    expect(sogShBandsFromMeta({ shN: { bands: 1 } })).toBe(1);
    expect(sogShBandsFromMeta({ shN: { bands: 2 } })).toBe(2);
    expect(sogShBandsFromMeta({ shN: { bands: 3 } })).toBe(3);
  });
});

describe('paletteShPeekTarget', () => {
  it('points at the first Streamed SOG chunk meta.json', () => {
    const target = paletteShPeekTarget(
      'streamed-sog',
      { filenames: ['0_0/meta.json', '0_1/meta.json'] },
      dataset({ manifestUrl: 'https://host/lod-meta.json' }),
    );
    expect(target).toEqual({
      kind: 'json',
      url: 'https://host/0_0/meta.json',
      path: '0_0/meta.json',
    });
  });

  it('skips an .lcc2 environment tile at index 0', () => {
    const target = paletteShPeekTarget(
      'lcc2',
      {
        root: {
          splatFiles: ['env.sog', 'data/3dgs/0.sog'],
          data: { env: { name: 0 } },
        },
      },
      dataset(),
    );
    expect(target).toEqual({
      kind: 'zip',
      url: 'https://host/data/3dgs/0.sog',
      path: 'data/3dgs/0.sog',
    });
  });
});

describe('sogShBandsFromZip', () => {
  it('reads shN from a small STORE archive in one tail fetch', async () => {
    const bytes = buildZip({ 'meta.json': JSON.stringify({ shN: { bands: 3 } }) });
    const { read } = zipReader(bytes);
    expect(await sogShBandsFromZip(read, bytes.byteLength)).toBe(3);
  });

  it('returns 0 for a DC-only tile', async () => {
    const bytes = buildZip({ 'meta.json': JSON.stringify({ version: 2, count: 1 }) });
    const { read } = zipReader(bytes);
    expect(await sogShBandsFromZip(read, bytes.byteLength)).toBe(0);
  });

  it('range-reads meta.json when it sits before a large dummy entry', async () => {
    const bytes = buildZip({
      'meta.json': JSON.stringify({ shN: { bands: 2 } }),
      'padding.bin': new Uint8Array(200_000),
    });
    const { read, reads } = zipReader(bytes);
    expect(await sogShBandsFromZip(read, bytes.byteLength)).toBe(2);
    // Tail (CD + EOCD) plus local header plus payload — never the 200 kB pad.
    expect(reads.some(([, length]) => length > 70_000)).toBe(false);
    expect(reads.some(([start]) => start === 0)).toBe(true);
  });

  it('keeps its fallback when the archive declares ZIP64 sentinel values', async () => {
    const bytes = buildZip({ 'meta.json': JSON.stringify({ shN: { bands: 3 } }) });
    new DataView(bytes.buffer).setUint16(bytes.byteLength - 22 + 10, 0xffff, true);
    const { read } = zipReader(bytes);
    await expect(sogShBandsFromZip(read, bytes.byteLength)).resolves.toBe(0);
  });
});

describe('resolvePaletteShBands', () => {
  it('honours an explicit request without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await resolvePaletteShBands(
        'lcc2',
        { root: { splatFiles: ['tile.sog'] } },
        dataset(),
        0,
        true,
      ),
    ).toBe(0);
    expect(
      await resolvePaletteShBands(
        'lcc2',
        { root: { splatFiles: ['tile.sog'] } },
        dataset(),
        3,
        true,
      ),
    ).toBe(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not peek when the performance profile declined SH', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await resolvePaletteShBands(
        'streamed-sog',
        { filenames: ['0_0/meta.json'] },
        dataset(),
        undefined,
        false,
      ),
    ).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('detectPaletteShBands', () => {
  it('fetches a Streamed SOG meta.json', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ shN: { bands: 1 } }), { status: 200 })),
    );
    const bands = await detectPaletteShBands(
      'streamed-sog',
      { filenames: ['0_0/meta.json'] },
      dataset({ manifestUrl: 'https://host/lod-meta.json' }),
    );
    expect(bands).toBe(1);
  });

  it('range-reads an .lcc2 tile when the size is known', async () => {
    const bytes = buildZip({ 'meta.json': JSON.stringify({ shN: { bands: 3 } }) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const range = (init?.headers as Record<string, string> | undefined)?.Range;
        const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
        if (match === null) return new Response('nope', { status: 200 });
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(bytes.subarray(start, end + 1), {
          status: 206,
          headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}` },
        });
      }),
    );
    const bands = await detectPaletteShBands(
      'lcc2',
      { root: { splatFiles: ['tile.sog'] } },
      dataset({ size: async () => bytes.byteLength }),
    );
    expect(bands).toBe(3);
  });

  it('leaves SH off when the server ignores Range', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { 'Content-Length': '1024' },
          }),
      ),
    );
    const bands = await detectPaletteShBands(
      'lcc2',
      { root: { splatFiles: ['tile.sog'] } },
      dataset({ size: async () => 1024 }),
    );
    expect(bands).toBe(0);
    expect(cancelled).toBe(true);
  });

  it('propagates AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      detectPaletteShBands('streamed-sog', { filenames: ['0_0/meta.json'] }, dataset(), {
        signal: controller.signal,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
  });
});
