import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRadScene } from '../formats/rad/rad';
import { httpDatasetSource } from '../dataset-source';
import { RAD_CHUNK_MAGIC, RAD_MAGIC } from '../formats/rad/parse-rad';

function roundup8(n: number): number {
  return (n + 7) & ~7;
}

function f32(...values: number[]): number[] {
  const buf = new ArrayBuffer(values.length * 4);
  const view = new DataView(buf);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return [...new Uint8Array(buf)];
}
function u16(...values: number[]): number[] {
  const buf = new ArrayBuffer(values.length * 2);
  const view = new DataView(buf);
  values.forEach((v, i) => view.setUint16(i * 2, v, true));
  return [...new Uint8Array(buf)];
}
function u32(...values: number[]): number[] {
  const buf = new ArrayBuffer(values.length * 4);
  const view = new DataView(buf);
  values.forEach((v, i) => view.setUint32(i * 4, v, true));
  return [...new Uint8Array(buf)];
}

/** A minimal `RADC` chunk of `count` splats, LOD tree present, plain f32. */
function radcChunk(count: number, childCount: number[], childStart: number[]): Uint8Array {
  const props = [
    { name: 'center', enc: 'f32', bytes: f32(...Array(count * 3).fill(0)) },
    { name: 'alpha', enc: 'f32', bytes: f32(...Array(count).fill(1)) },
    { name: 'rgb', enc: 'f32', bytes: f32(...Array(count * 3).fill(1)) },
    { name: 'scales', enc: 'f32', bytes: f32(...Array(count * 3).fill(1)) },
    { name: 'orientation', enc: 'f32', bytes: f32(...Array(count * 3).fill(0)) },
    { name: 'child_count', enc: 'u16', bytes: u16(...childCount) },
    { name: 'child_start', enc: 'u32', bytes: u32(...childStart) },
  ];
  let offset = 0;
  const propMeta = props.map((p) => {
    const m = { offset, bytes: p.bytes.length, property: p.name, encoding: p.enc };
    offset += p.bytes.length;
    return m;
  });
  const payload = props.flatMap((p) => p.bytes);
  const meta = { version: 1, base: 0, count, lodTree: true, properties: propMeta };
  const metaJson = [...new TextEncoder().encode(JSON.stringify(meta))];
  const metaPad = [...metaJson, ...Array(roundup8(metaJson.length) - metaJson.length).fill(0)];
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, RAD_CHUNK_MAGIC, true);
  new DataView(header.buffer).setUint32(4, metaJson.length, true);
  const sizeBytes = new Uint8Array(8);
  new DataView(sizeBytes.buffer).setBigUint64(0, BigInt(payload.length), true);
  return Uint8Array.from([...header, ...metaPad, ...sizeBytes, ...payload]);
}

/** A `--rad-chunked` header: chunks reference external `.radc` files. */
function chunkedHeader(filenames: readonly string[], count: number): Uint8Array {
  const meta = {
    version: 1,
    type: 'gsplat',
    count,
    chunkSize: 4,
    lodTree: true,
    allChunkBytes: 0,
    chunks: filenames.map((filename) => ({ offset: 0, bytes: 0, filename })),
  };
  const metaJson = [...new TextEncoder().encode(JSON.stringify(meta))];
  const metaPad = [...metaJson, ...Array(roundup8(metaJson.length) - metaJson.length).fill(0)];
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, RAD_MAGIC, true);
  new DataView(header.buffer).setUint32(4, metaJson.length, true);
  return Uint8Array.from([...header, ...metaPad]);
}

describe('buildRadScene with an external .radc chunk set', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resolves each chunk to its .radc sibling and fetches it whole', async () => {
    // Two chunks of 4 splats. Chunk 0: g0 internal → [4,6), rest leaves.
    const c0 = radcChunk(4, [2, 0, 0, 0], [4, 0, 0, 0]);
    const c1 = radcChunk(4, [0, 0, 0, 0], [0, 0, 0, 0]);
    const header = chunkedHeader(['scene-0.radc', 'scene-1.radc'], 8);
    const files: Record<string, Uint8Array> = {
      'http://host/scene.rad': header,
      'http://host/scene-0.radc': c0,
      'http://host/scene-1.radc': c1,
    };
    const seen: string[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      seen.push(url);
      const data = files[url];
      if (!data) throw new Error(`unexpected fetch ${url}`);
      const range = (init?.headers as Record<string, string>)?.Range;
      // The header probe sends a Range; a range-less server answers 200 whole.
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return Promise.resolve({
        ok: true,
        status: range ? 200 : 200,
        arrayBuffer: () => Promise.resolve(ab),
      } as Response);
    });

    const source = httpDatasetSource('http://host/scene.rad');
    const scene = await buildRadScene(source, {
      budget: 1000,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });

    expect(scene.chunkUrls).toEqual(['http://host/scene-0.radc', 'http://host/scene-1.radc']);
    // External chunks carry no byte range - the worker fetches them whole.
    expect(scene.chunkOptions?.[0]?.rad?.start).toBeUndefined();
    expect(scene.chunkOptions?.[0]?.rad?.length).toBeUndefined();
    expect(scene.chunkOptions?.[0]?.format).toBe('rad-chunk');
    // Chunk 0 (the .radc, not a range of the header) was fetched for bounds.
    expect(seen).toContain('http://host/scene-0.radc');
    expect(scene.bounds.isEmpty()).toBe(false);
    expect(scene.overviewPositions?.length).toBe(12);
  });

  it('reports the capture size as contentSplatCount, independent of the budget', async () => {
    const c0 = radcChunk(4, [2, 0, 0, 0], [4, 0, 0, 0]);
    const c1 = radcChunk(4, [0, 0, 0, 0], [0, 0, 0, 0]);
    const header = chunkedHeader(['scene-0.radc', 'scene-1.radc'], 8);
    const files: Record<string, Uint8Array> = {
      'http://host/scene.rad': header,
      'http://host/scene-0.radc': c0,
      'http://host/scene-1.radc': c1,
    };
    vi.stubGlobal('fetch', (url: string) => {
      const data = files[url];
      if (!data) throw new Error(`unexpected fetch ${url}`);
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(ab),
      } as Response);
    });

    const source = httpDatasetSource('http://host/scene.rad');
    // Two very different budgets: the content size must not move with them.
    // A host splitting one budget across several meshes clamps each share to
    // this, so it has to describe the capture rather than the request.
    const small = await buildRadScene(source, {
      budget: 10,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });
    const large = await buildRadScene(source, {
      budget: 10_000_000,
      lodBaseDistance: 10,
      lodMultiplier: 2,
    });

    expect(small.contentSplatCount).toBe(8);
    expect(large.contentSplatCount).toBe(8);
  });

  it('throws when a referenced .radc file is missing from the dataset', async () => {
    const header = chunkedHeader(['scene-0.radc'], 4);
    vi.stubGlobal('fetch', (url: string) => {
      if (url === 'http://host/scene.rad') {
        const ab = header.buffer.slice(header.byteOffset, header.byteOffset + header.byteLength);
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(ab),
        } as Response);
      }
      // The .radc fetch 404s.
      return Promise.resolve({ ok: false, status: 404 } as Response);
    });
    const source = httpDatasetSource('http://host/scene.rad');
    await expect(
      buildRadScene(source, { budget: 1000, lodBaseDistance: 10, lodMultiplier: 2 }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe('buildRadScene prefix-vs-foveated choice', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Serves a two-chunk dataset of `count` splats with no `input_splat_count`. */
  function stubScene(): void {
    const files: Record<string, Uint8Array> = {
      'http://host/scene.rad': chunkedHeader(['scene-0.radc', 'scene-1.radc'], 8),
      'http://host/scene-0.radc': radcChunk(4, [2, 0, 0, 0], [4, 0, 0, 0]),
      'http://host/scene-1.radc': radcChunk(4, [0, 0, 0, 0], [0, 0, 0, 0]),
    };
    vi.stubGlobal('fetch', (url: string) => {
      const data = files[url];
      if (!data) throw new Error(`unexpected fetch ${url}`);
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(ab),
      } as Response);
    });
  }

  function stubMobile(): void {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      platform: '',
      maxTouchPoints: 5,
    });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('coarse') }));
  }

  const options = { lodBaseDistance: 10, lodMultiplier: 2 };

  it('takes the prefix reader when the lifted budget holds every leaf', async () => {
    // Desktop: `liftBudgetToFinestLevel` raises a moderate capture's budget to
    // its leaf count, so the prefix reader reaches full resolution everywhere -
    // strictly better than a foveated cut, and this must not regress.
    stubScene();
    const scene = await buildRadScene(httpDatasetSource('http://host/scene.rad'), {
      ...options,
      budget: 4,
    });
    expect(scene.foveation).toBeUndefined();
  });

  it('foveates when the budget cannot hold the leaves', async () => {
    // Mobile is exempt from the finest-level lift, so its budget stays put. The
    // prefix reader would then spread it uniformly over the whole capture and
    // nothing would sharpen as the camera approaches - the case that left an
    // iPhone drawing a 5.9M-leaf scene at ~1/6 resolution everywhere.
    stubScene();
    stubMobile();
    const scene = await buildRadScene(httpDatasetSource('http://host/scene.rad'), {
      ...options,
      budget: 4,
    });
    expect(scene.foveation).toBeDefined();
  });

  it('still takes the prefix reader on mobile when the budget does hold the leaves', async () => {
    // The budget test is about *fit*, not about being mobile: a capture small
    // enough for the device budget is taken whole on a phone too.
    stubScene();
    stubMobile();
    const scene = await buildRadScene(httpDatasetSource('http://host/scene.rad'), {
      ...options,
      budget: 100,
    });
    expect(scene.foveation).toBeUndefined();
  });

  it('foveates for a pinned budget that cannot hold the leaves, on any device', async () => {
    // A host sizing additional meshes explicitly (`maxBudget: pool / N`) gets that number
    // - the lift never runs for it. Judging the path as if the lift *had* run
    // would put every such mesh back on the camera-independent prefix reader,
    // which is the multi-mesh version of the same blur.
    stubScene();
    const scene = await buildRadScene(
      httpDatasetSource('http://host/scene.rad'),
      { ...options, budget: 4 },
      undefined,
      3,
      false,
    );
    expect(scene.foveation).toBeDefined();
  });
});
