import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRadScene } from '../formats/rad/rad';
import { httpDatasetSource } from '../streaming/dataset-source';
import { RAD_CHUNK_MAGIC, RAD_MAGIC } from '../formats/rad/parse-rad';

/**
 * A `.rad` declares its own `maxSh`, and for a long time `buildRadScene` adopted
 * it wholesale: the band count never reached the builder, so a `smooth`
 * performance profile (the mobile default) and even an explicit `shBands: 0`
 * were both silently overridden. On a 3-band capture that is four RGBA32UI pool
 * textures, 128 B/splat of GPU + CPU memory, and a texture fetch plus a
 * 15-coefficient evaluation per splat per frame that nobody asked for.
 *
 * These pin the cap, in both directions.
 */

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

/**
 * A minimal `RADC` chunk. With `withSh` it carries a band-1 `sh1` column (9
 * floats per splat - three coefficients across three channels), which is what
 * makes `decodeRadSh` report `bands: 1`.
 */
function radcChunk(
  count: number,
  childCount: number[],
  childStart: number[],
  withSh: boolean,
): Uint8Array {
  const props = [
    { name: 'center', enc: 'f32', bytes: f32(...Array(count * 3).fill(0)) },
    { name: 'alpha', enc: 'f32', bytes: f32(...Array(count).fill(1)) },
    { name: 'rgb', enc: 'f32', bytes: f32(...Array(count * 3).fill(1)) },
    { name: 'scales', enc: 'f32', bytes: f32(...Array(count * 3).fill(1)) },
    { name: 'orientation', enc: 'f32', bytes: f32(...Array(count * 3).fill(0)) },
    { name: 'child_count', enc: 'u16', bytes: u16(...childCount) },
    { name: 'child_start', enc: 'u32', bytes: u32(...childStart) },
    ...(withSh ? [{ name: 'sh1', enc: 'f32', bytes: f32(...Array(count * 9).fill(0.25)) }] : []),
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

/** Serves a two-chunk `.radc` dataset whose chunks may or may not carry SH. */
function stubDataset(withSh: boolean): void {
  const c0 = radcChunk(4, [2, 0, 0, 0], [4, 0, 0, 0], withSh);
  const c1 = radcChunk(4, [0, 0, 0, 0], [0, 0, 0, 0], withSh);
  const files: Record<string, Uint8Array> = {
    'http://host/scene.rad': chunkedHeader(['scene-0.radc', 'scene-1.radc'], 8),
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
}

const SOURCE_OPTIONS = { budget: 1000, lodBaseDistance: 10, lodMultiplier: 2 } as const;

describe('buildRadScene spherical-harmonics cap', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the bands the file carries when no cap is given', async () => {
    stubDataset(true);
    const scene = await buildRadScene(httpDatasetSource('http://host/scene.rad'), SOURCE_OPTIONS);
    expect(scene.shBands).toBe(1);
  });

  it('declines SH entirely when the caller asks for zero bands', async () => {
    stubDataset(true);
    // The regression: the file has SH, the caller does not want it. Before the
    // fix this reported the file's bands and allocated the pool textures anyway.
    const scene = await buildRadScene(
      httpDatasetSource('http://host/scene.rad'),
      SOURCE_OPTIONS,
      undefined,
      0,
    );
    expect(scene.shBands).toBe(0);
  });

  it('reports no bands for a capture without SH, whatever the cap', async () => {
    stubDataset(false);
    const source = httpDatasetSource('http://host/scene.rad');
    expect((await buildRadScene(source, SOURCE_OPTIONS, undefined, 3)).shBands).toBe(0);
    expect((await buildRadScene(source, SOURCE_OPTIONS, undefined, 0)).shBands).toBe(0);
  });

  it('treats a non-zero cap as all-or-nothing rather than truncating', async () => {
    stubDataset(true);
    // A partial cap cannot be honoured: the decoder emits the file's full band
    // count and `SplatMesh.writePackedSh` only copies packed words when the
    // counts match exactly, so a truncated request would allocate the smaller
    // set of textures and then fill them with neutral words - paying for SH and
    // rendering flat. Keeping the file's bands is the safe reading, and this
    // pins it so a future "clamp" cannot reintroduce the silent-neutral path.
    const scene = await buildRadScene(
      httpDatasetSource('http://host/scene.rad'),
      SOURCE_OPTIONS,
      undefined,
      3,
    );
    expect(scene.shBands).toBe(1);
  });
});
