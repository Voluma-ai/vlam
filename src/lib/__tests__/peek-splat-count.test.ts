import { afterEach, describe, expect, it, vi } from 'vitest';
import { peekSplatCount } from '../loaders/peek-splat-count';
import { peekSogMeta } from '../formats/sog/peek-sog-sh';
import { buildZip } from './helpers/store-zip';

afterEach(() => {
  vi.unstubAllGlobals();
});

function header(bytes: number, fill: (view: DataView) => void): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  fill(new DataView(out.buffer));
  return out;
}

const spz: Uint8Array<ArrayBuffer> = header(16, (view) => {
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, 123_456, true);
});

/** Serves `bytes` with `Range` support, as object storage does. */
function rangeServer(bytes: Uint8Array<ArrayBuffer>) {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    requests.push(init?.method === 'HEAD' ? 'HEAD' : (range ?? 'GET'));
    if (init?.method === 'HEAD') {
      return new Response(null, { headers: { 'content-length': String(bytes.byteLength) } });
    }
    if (!range) return new Response(bytes);
    const suffix = /^bytes=-(\d+)$/.exec(range);
    const span = /^bytes=(\d+)-(\d+)$/.exec(range);
    const start = suffix
      ? Math.max(0, bytes.byteLength - Number(suffix[1]))
      : Number(span?.[1] ?? 0);
    const end = suffix ? bytes.byteLength - 1 : Math.min(bytes.byteLength - 1, Number(span?.[2]));
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${bytes.byteLength}` },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return requests;
}

describe('peekSplatCount on local files', () => {
  it('reads PLY, SPZ, KSPLAT, SPLAT and SOG headers', async () => {
    const ply = new File(
      ['ply\nformat binary_little_endian 1.0\nelement vertex 42\nproperty float x\nend_header\n'],
      'a.ply',
    );
    const ksplat = header(64, (view) => {
      view.setUint8(1, 1);
      view.setUint32(16, 777, true);
    });
    const sog = buildZip({ 'meta.json': JSON.stringify({ version: 2, count: 9_000_000 }) });
    expect(await peekSplatCount(ply)).toBe(42);
    expect(await peekSplatCount(new File([spz], 'a.spz'))).toBe(123_456);
    expect(await peekSplatCount(new File([ksplat], 'a.ksplat'))).toBe(777);
    expect(await peekSplatCount(new File([new Uint8Array(32 * 5)], 'a.splat'))).toBe(5);
    expect(await peekSplatCount(new File([sog], 'a.sog'))).toBe(9_000_000);
  });

  it('gives up on what it cannot read cheaply', async () => {
    const gzip = Uint8Array.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await peekSplatCount(new File([gzip], 'legacy.spz'))).toBeUndefined();
    expect(await peekSplatCount(new File([new Uint8Array(8)], 'a.rad'))).toBeUndefined();
    expect(await peekSplatCount(new File(['not a ply'], 'a.ply'))).toBeUndefined();
    expect(await peekSplatCount(new File([new Uint8Array(4)], 'a.unknown'))).toBeUndefined();
  });
});

describe('peekSplatCount over HTTP', () => {
  it('reads a bundled SOG count through tail and entry ranges only', async () => {
    const sog = buildZip({
      'meta.json': JSON.stringify({ version: 2, count: 2_500_000 }),
      'means_l.webp': new Uint8Array(200_000),
    });
    const requests = rangeServer(sog);
    expect(await peekSplatCount('https://cdn.test/scene.sog')).toBe(2_500_000);
    expect(requests.every((request) => request.startsWith('bytes='))).toBe(true);
  });

  it('reads an SPZ header with one range request and a SPLAT size with HEAD', async () => {
    const requests = rangeServer(spz);
    expect(await peekSplatCount('https://cdn.test/scene.spz')).toBe(123_456);
    expect(requests).toEqual(['bytes=0-15']);
    rangeServer(new Uint8Array(32 * 7));
    expect(await peekSplatCount('/scene.splat', { baseUrl: 'https://cdn.test/' })).toBe(7);
  });

  it('does not download a scene from a server that ignores Range', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true, body: { cancel }, headers: new Headers() })),
    );
    expect(await peekSplatCount('https://cdn.test/scene.spz')).toBeUndefined();
    expect(cancel).toHaveBeenCalled();
  });

  it('propagates an abort', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      peekSplatCount('https://cdn.test/scene.spz', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('peekSogMeta', () => {
  it('returns the parsed meta.json, or null without one', async () => {
    const bytes = buildZip({ 'meta.json': JSON.stringify({ count: 5, shN: { bands: 1 } }) });
    const read = async (start: number, length: number) => bytes.slice(start, start + length);
    expect(await peekSogMeta(read, bytes.byteLength)).toEqual({ count: 5, shN: { bands: 1 } });
    const empty = buildZip({ 'other.json': '{}' });
    const readEmpty = async (start: number, length: number) => empty.slice(start, start + length);
    expect(await peekSogMeta(readEmpty, empty.byteLength)).toBeNull();
  });
});
