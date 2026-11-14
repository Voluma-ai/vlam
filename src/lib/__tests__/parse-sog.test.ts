import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSog, parseSogDirectory } from '../formats/sog/parse-sog';
import { limitSplatCount } from '../loaders/limit-splat-count';

/**
 * These tests exercise the decoder's defenses against hostile inputs
 * through its public entry points. Real WebP decoding is unavailable in
 * Node, so a stub `ImageDecoder` serves "images" from a trivial byte
 * format: uint16le width, uint16le height, then raw RGBA bytes.
 */

/** Encodes a fake attribute image for the stub decoder below. */
function fakeImage(width: number, height: number, rgba: number[] = []): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4 + width * height * 4);
  new DataView(bytes.buffer).setUint16(0, width, true);
  new DataView(bytes.buffer).setUint16(2, height, true);
  bytes.set(rgba, 4);
  return bytes;
}

class StubImageDecoder {
  private readonly bytes: Uint8Array;
  /** Last constructor init - tests assert lossless decode options. */
  static lastInit: { colorSpaceConversion?: string; type?: string } | null = null;

  constructor(init: { data: Uint8Array; colorSpaceConversion?: string; type?: string }) {
    this.bytes = init.data;
    StubImageDecoder.lastInit = {
      colorSpaceConversion: init.colorSpaceConversion,
      type: init.type,
    };
  }

  async decode(): Promise<{ image: VideoFrame }> {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const width = view.getUint16(0, true);
    const height = view.getUint16(2, true);
    const pixels = this.bytes.subarray(4, 4 + width * height * 4);
    return {
      image: {
        codedWidth: width,
        codedHeight: height,
        copyTo: async (dest: Uint8Array) => dest.set(pixels),
        close: () => undefined,
      } as unknown as VideoFrame,
    };
  }

  close(): void {}
}

interface StubBitmap extends ImageBitmap {
  readonly pixels: Uint8Array;
}

class StubWebGl2Context {
  readonly TEXTURE_2D = 1;
  readonly UNPACK_FLIP_Y_WEBGL = 2;
  readonly UNPACK_PREMULTIPLY_ALPHA_WEBGL = 3;
  readonly UNPACK_COLORSPACE_CONVERSION_WEBGL = 4;
  readonly NONE = 0;
  readonly TEXTURE_MIN_FILTER = 5;
  readonly TEXTURE_MAG_FILTER = 6;
  readonly NEAREST = 7;
  readonly TEXTURE_WRAP_S = 8;
  readonly TEXTURE_WRAP_T = 9;
  readonly CLAMP_TO_EDGE = 10;
  readonly RGBA = 11;
  readonly UNSIGNED_BYTE = 12;
  readonly FRAMEBUFFER = 13;
  readonly COLOR_ATTACHMENT0 = 14;
  readonly FRAMEBUFFER_COMPLETE = 15;
  readonly pixelStoreCalls: Array<[number, number | boolean]> = [];
  private bitmap: StubBitmap | undefined;

  isContextLost(): boolean {
    return false;
  }

  createTexture(): WebGLTexture {
    return {};
  }

  createFramebuffer(): WebGLFramebuffer {
    return {};
  }

  bindTexture(): void {}

  pixelStorei(parameter: number, value: number | boolean): void {
    this.pixelStoreCalls.push([parameter, value]);
  }

  texParameteri(): void {}

  texImage2D(...args: unknown[]): void {
    this.bitmap = args.at(-1) as StubBitmap;
  }

  bindFramebuffer(): void {}

  framebufferTexture2D(): void {}

  checkFramebufferStatus(): number {
    return this.FRAMEBUFFER_COMPLETE;
  }

  readPixels(
    _x: number,
    _y: number,
    _width: number,
    _height: number,
    _format: number,
    _type: number,
    destination: Uint8Array,
  ): void {
    if (!this.bitmap) throw new Error('No bitmap was uploaded.');
    destination.set(this.bitmap.pixels);
  }

  deleteFramebuffer(): void {}

  deleteTexture(): void {}
}

/** Builds a minimal STORE-method ZIP archive readable by parseSog. */
function buildZip(entries: Record<string, Uint8Array | string>): ArrayBuffer {
  const encoder = new TextEncoder();
  const files = Object.entries(entries).map(([name, content]) => ({
    name: encoder.encode(name),
    data: typeof content === 'string' ? encoder.encode(content) : content,
  }));

  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const local = new Uint8Array(30 + file.name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, 0, true); // method: STORE
    localView.setUint32(18, file.data.length, true);
    localView.setUint32(22, file.data.length, true);
    localView.setUint16(26, file.name.length, true);
    local.set(file.name, 30);
    chunks.push(local, file.data);

    const record = new Uint8Array(46 + file.name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(10, 0, true); // method: STORE
    recordView.setUint32(20, file.data.length, true);
    recordView.setUint32(24, file.data.length, true);
    recordView.setUint16(28, file.name.length, true);
    recordView.setUint32(42, offset, true);
    record.set(file.name, 46);
    central.push(record);
    offset += local.length + file.data.length;
  }

  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const parts = [...chunks, ...central, eocd];
  const archive = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return archive.buffer;
}

const codebook = Array.from({ length: 256 }, (_, i) => i / 255);

function makeMeta(count: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    count,
    means: { mins: [0, 0, 0], maxs: [1, 1, 1], files: ['means_l.webp', 'means_u.webp'] },
    scales: { codebook, files: ['scales.webp'] },
    quats: { files: ['quats.webp'] },
    sh0: { codebook, files: ['sh0.webp'] },
    ...overrides,
  };
}

/** A complete single-splat bundle with all-zero attribute pixels. */
function makeBundle(meta: Record<string, unknown>): ArrayBuffer {
  return buildZip({
    'meta.json': JSON.stringify(meta),
    'means_l.webp': fakeImage(1, 1),
    'means_u.webp': fakeImage(1, 1),
    'quats.webp': fakeImage(1, 1, [128, 128, 128, 255]),
    'scales.webp': fakeImage(1, 1),
    'sh0.webp': fakeImage(1, 1, [10, 10, 10, 200]),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('parseSog', () => {
  it('decodes a minimal bundle through the stub image decoder', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    StubImageDecoder.lastInit = null;
    const data = await parseSog(makeBundle(makeMeta(1)));

    expect(StubImageDecoder.lastInit).toEqual({
      colorSpaceConversion: 'none',
      type: 'image/webp',
    });
    expect(data.count).toBe(1);
    // Quantized 0 over mins/maxs [0, 1] → unlog(0) = 0 on every axis.
    expect(Array.from(data.positions)).toEqual([0, 0, 0]);
    // sh0 index 10 → codebook 10/255; opacity 200 passes through linearly.
    const expectedByte = Math.round((0.5 + (10 / 255) * 0.28209479177387814) * 255);
    expect(Array.from(data.colors)).toEqual([expectedByte, expectedByte, expectedByte, 200]);
    // Scale index 0 → e⁰ = 1 on every axis → identity covariance.
    const expected = [1, 0, 0, 1, 0, 1];
    Array.from(data.covariances).forEach((value, i) =>
      expect(value).toBeCloseTo(expected[i] as number, 5),
    );
  });

  it('uses an unpremultiplied, color-neutral WebGL upload when available', async () => {
    const context = new StubWebGl2Context();
    const bitmapOptions: ImageBitmapOptions[] = [];
    vi.stubGlobal(
      'createImageBitmap',
      async (blob: Blob, options: ImageBitmapOptions): Promise<ImageBitmap> => {
        bitmapOptions.push(options);
        const encoded = new Uint8Array(await blob.arrayBuffer());
        const width = new DataView(encoded.buffer).getUint16(0, true);
        const height = new DataView(encoded.buffer).getUint16(2, true);
        return {
          width,
          height,
          pixels: encoded.subarray(4),
          close: () => undefined,
        } as StubBitmap;
      },
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext(): WebGL2RenderingContext {
          return context as unknown as WebGL2RenderingContext;
        }
      },
    );

    const data = await parseSog(makeBundle(makeMeta(1)));

    expect(bitmapOptions).toHaveLength(5);
    expect(bitmapOptions[0]).toMatchObject({
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    expect(context.pixelStoreCalls).toContainEqual([context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false]);
    expect(context.pixelStoreCalls).toContainEqual([
      context.UNPACK_COLORSPACE_CONVERSION_WEBGL,
      context.NONE,
    ]);
    expect(data.colors[3]).toBe(200);
  });

  it('takes its abort signal in an options object, matching parseSogDirectory', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await parseSog(makeBundle(makeMeta(1)), { signal: controller.signal }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
  });

  it('rejects splat counts above the supported maximum', async () => {
    const bundle = buildZip({ 'meta.json': JSON.stringify(makeMeta(1e9)) });
    await expect(parseSog(bundle)).rejects.toThrow(/above the supported maximum/);
  });

  it('rejects non-integer and negative splat counts', async () => {
    for (const countText of ['-1', '2.5', '1e999', 'null']) {
      const json = JSON.stringify(makeMeta(0)).replace('"count":0', `"count":${countText}`);
      await expect(parseSog(buildZip({ 'meta.json': json }))).rejects.toThrow(
        /invalid splat count/,
      );
    }
  });

  it('rejects a count larger than the attribute images', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    // Images hold 1 pixel; meta claims 4 splats.
    const bundle = makeBundle(makeMeta(4));
    await expect(parseSog(bundle)).rejects.toThrow(/holds fewer than the declared 4 splats/);
  });

  it('rejects non-finite or malformed means mins/maxs', async () => {
    const hostiles = [
      { mins: [0, 0], maxs: [1, 1, 1] },
      { mins: [0, 0, 0], maxs: [1, 1, 'big'] },
      { mins: [0, 0, 0], maxs: null },
    ];
    for (const means of hostiles) {
      const meta = makeMeta(1, {
        means: { ...means, files: ['means_l.webp', 'means_u.webp'] },
      });
      await expect(parseSog(buildZip({ 'meta.json': JSON.stringify(meta) }))).rejects.toThrow(
        /"means\.(mins|maxs)" must be an array of 3 finite numbers/,
      );
    }
    // JSON `1e999` parses to Infinity - non-finite must be rejected too.
    const json = JSON.stringify(makeMeta(1)).replace('"maxs":[1,1,1]', '"maxs":[1,1,1e999]');
    await expect(parseSog(buildZip({ 'meta.json': json }))).rejects.toThrow(
      /must be an array of 3 finite numbers/,
    );
  });

  it('rejects an invalid shN band count', async () => {
    const cases: Array<[number, unknown]> = [
      [2, 0],
      [2, 4],
      [2, 2.5],
      [2, '3'],
      [3, 0],
      [3, 5],
    ];
    for (const [version, bands] of cases) {
      const meta = makeMeta(1, {
        version,
        shN: { count: 1, bands, codebook, files: ['shN_centroids.webp', 'shN_labels.webp'] },
      });
      await expect(parseSog(buildZip({ 'meta.json': JSON.stringify(meta) }))).rejects.toThrow(
        /invalid shN band count/,
      );
    }
  });

  it('rejects SOG versions other than 2 and 3', async () => {
    for (const version of [1, 4, '3']) {
      const meta = makeMeta(1, { version });
      await expect(parseSog(buildZip({ 'meta.json': JSON.stringify(meta) }))).rejects.toThrow(
        /Unsupported SOG version/,
      );
    }
  });

  it('rejects shN labels that address texels outside the centroids palette', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    const meta = makeMeta(1, {
      shN: { count: 1, bands: 1, codebook, files: ['shN_centroids.webp', 'shN_labels.webp'] },
    });
    const bundle = buildZip({
      'meta.json': JSON.stringify(meta),
      'means_l.webp': fakeImage(1, 1),
      'means_u.webp': fakeImage(1, 1),
      'quats.webp': fakeImage(1, 1, [128, 128, 128, 255]),
      'scales.webp': fakeImage(1, 1),
      'sh0.webp': fakeImage(1, 1, [10, 10, 10, 200]),
      // Palette holds one 3-texel entry; the label bytes decode to 500.
      'shN_centroids.webp': fakeImage(3, 1),
      'shN_labels.webp': fakeImage(1, 1, [500 & 0xff, 500 >> 8, 0, 255]),
    });
    await expect(parseSog(bundle)).rejects.toThrow(/lies outside the 3×1 centroids palette/);
  });

  it('reports a hostile central-directory offset as a corrupt ZIP', async () => {
    const archive = new Uint8Array(buildZip({ 'meta.json': '{}' }).slice(0));
    const view = new DataView(archive.buffer);
    // The EOCD's central-directory offset points far past the archive.
    view.setUint32(archive.byteLength - 22 + 16, 0x7fffffff, true);
    await expect(parseSog(archive.buffer)).rejects.toThrow(/Corrupt ZIP central directory/);
  });

  it('reports a truncated ZIP entry instead of silently clamping', async () => {
    const bundle = makeBundle(makeMeta(1));
    const archive = new Uint8Array(bundle.slice(0));
    // Inflate one entry's central-directory compressed size so its data
    // extends past the archive.
    let record = -1;
    const view = new DataView(archive.buffer);
    for (let i = archive.byteLength - 46; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x02014b50) {
        record = i;
        break;
      }
    }
    expect(record).toBeGreaterThanOrEqual(0);
    view.setUint32(record + 20, 0x0fffffff, true);
    await expect(parseSog(archive.buffer)).rejects.toThrow(/data extends past the archive/);
  });

  it('rejects ZIP64 records instead of interpreting sentinel offsets as data', async () => {
    const archive = new Uint8Array(buildZip({ 'meta.json': '{}' }).slice(0));
    const view = new DataView(archive.buffer);
    view.setUint16(archive.byteLength - 22 + 10, 0xffff, true);
    await expect(parseSog(archive.buffer)).rejects.toThrow(/Unsupported or corrupt ZIP/);
  });

  it('validates the local header against the central-directory entry', async () => {
    const archive = new Uint8Array(buildZip({ 'meta.json': '{}' }).slice(0));
    const view = new DataView(archive.buffer);
    view.setUint16(8, 8, true); // local method differs from the central STORE method
    await expect(parseSog(archive.buffer)).rejects.toThrow(/local header mismatch/);
  });

  it('rejects a codebook shorter than 256 entries', async () => {
    const meta = makeMeta(0, { scales: { codebook: [0, 1, 2], files: ['scales.webp'] } });
    await expect(parseSog(buildZip({ 'meta.json': JSON.stringify(meta) }))).rejects.toThrow(
      /"scales" codebook must contain at least 256 entries/,
    );
  });

  it('rejects a codebook with non-numeric entries', async () => {
    const hostile = [...codebook.slice(0, 255), 'boom'];
    const meta = makeMeta(0, { sh0: { codebook: hostile, files: ['sh0.webp'] } });
    await expect(parseSog(buildZip({ 'meta.json': JSON.stringify(meta) }))).rejects.toThrow(
      /"sh0" codebook contains a non-finite entry/,
    );
  });
});

/** A pseudo-random N-splat bundle (deterministic), with palette shN. */
function makeRandomBundle(count: number): ArrayBuffer {
  let seed = 12345;
  const byte = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed & 0xff;
  };
  const image = (pixel: () => number[]) =>
    fakeImage(count, 1, Array.from({ length: count }, pixel).flat());
  const shCodebook = Array.from({ length: 256 }, (_, i) => (i - 128) / 128);
  return buildZip({
    'meta.json': JSON.stringify(
      makeMeta(count, {
        // Log-scale codebook: e^-6 .. e^1, so traces spread over decades.
        scales: { codebook: codebook.map((v) => -6 + 7 * v), files: ['scales.webp'] },
        shN: {
          count: 4,
          bands: 1,
          codebook: shCodebook,
          files: ['shN_centroids.webp', 'shN_labels.webp'],
        },
      }),
    ),
    'means_l.webp': image(() => [byte(), byte(), byte(), 255]),
    'means_u.webp': image(() => [byte(), byte(), byte(), 255]),
    'quats.webp': image(() => [byte(), byte(), byte(), 252 + (byte() & 3)]),
    'scales.webp': image(() => [byte(), byte(), byte(), 255]),
    // A few repeated opacities, so the cut lands inside a tied bucket.
    'sh0.webp': image(() => [byte(), byte(), byte(), [0, 40, 200, 255][byte() & 3] as number]),
    'shN_centroids.webp': fakeImage(12, 1, Array.from({ length: 48 }, byte)),
    'shN_labels.webp': image(() => [byte() & 3, 0, 0, 255]),
  });
}

/** A one-splat bundle with the given quats / sh0 pixels and extra entries. */
function makeV3Bundle(
  meta: Record<string, unknown>,
  quats: number[],
  sh0: number[],
  extra: Record<string, Uint8Array> = {},
): ArrayBuffer {
  return buildZip({
    'meta.json': JSON.stringify(meta),
    'means_l.webp': fakeImage(1, 1),
    'means_u.webp': fakeImage(1, 1),
    'quats.webp': fakeImage(1, 1, quats),
    'scales.webp': fakeImage(1, 1, [0, 0, 255, 255]),
    'sh0.webp': fakeImage(1, 1, sh0),
    ...extra,
  });
}

describe('parseSog version 3', () => {
  // Distinct scales (e⁰, e⁰, e¹) make the rotation visible in Σ.
  const v3Codebook = Array.from({ length: 256 }, (_, i) => i / 255);

  it('decodes the exponential-map rotation: identity at 128, ~90° about x at 192', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    const meta = makeMeta(1, {
      version: 3,
      scales: { codebook: v3Codebook, files: ['scales.webp'] },
    });
    const e2 = Math.exp(2);

    const identity = await parseSog(makeV3Bundle(meta, [128, 128, 128, 0], [0, 0, 0, 204]));
    [1, 0, 0, 1, 0, e2].forEach((value, i) =>
      expect(identity.covariances[i]).toBeCloseTo(value, 5),
    );

    // p = (64/127, 0, 0) → half-angle θ = (π/2)·|p|, a rotation by φ = 2θ
    // (≈ 90.7°) about x: the z scale moves (almost entirely) onto y.
    const phi = Math.PI * (64 / 127);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const rotated = await parseSog(makeV3Bundle(meta, [192, 128, 128, 0], [0, 0, 0, 204]));
    [1, 0, 0, c * c + s * s * e2, c * s * (1 - e2), s * s + c * c * e2].forEach((value, i) =>
      expect(rotated.covariances[i]).toBeCloseTo(value, 4),
    );
    expect(rotated.covariances[3]).toBeGreaterThan(7);

    // |p| = 1 is a half turn, which leaves this axis-aligned Σ unchanged.
    const halfTurn = await parseSog(makeV3Bundle(meta, [255, 128, 128, 0], [0, 0, 0, 204]));
    [1, 0, 0, 1, 0, e2].forEach((value, i) =>
      expect(halfTurn.covariances[i]).toBeCloseTo(value, 4),
    );
  });

  it('decodes opacity as (a / 204)² and clamps values above 1', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    const meta = makeMeta(1, { version: 3, opacity: { max: 1.5625 } });
    const alpha = async (a: number): Promise<number> =>
      (await parseSog(makeV3Bundle(meta, [128, 128, 128, 0], [0, 0, 0, a]))).colors[3] as number;
    expect(await alpha(204)).toBe(255);
    expect(await alpha(255)).toBe(255);
    expect(await alpha(102)).toBe(Math.round(0.25 * 255));
    expect(await alpha(0)).toBe(0);
  });

  it('reads model "antialiased" and ignores blind, extras and comments', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    const meta = makeMeta(1, {
      version: 3,
      model: 'antialiased',
      blind: [{ files: ['blind_0.webp'], fields: [{ name: 'id', type: 'u8' }] }],
      extras: { app: true },
      comments: ['made by a test'],
    });
    const data = await parseSog(makeV3Bundle(meta, [128, 128, 128, 0], [0, 0, 0, 204]));
    expect(data.antialias).toBe(true);
  });

  it('reads 24-bit labels and keeps the first 3 of 4 SH bands', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    // 65,537 palette entries → label 65,536 sits at row 1024, column 0.
    const rows = 1025;
    const width = 64 * 24;
    const centroids = new Array<number>(width * rows * 4).fill(0);
    for (let c = 0; c < 24; c++) {
      const texel = (1024 * width + c) * 4;
      centroids[texel] = c; // R channel: codebook index c → c / 255.
      centroids[texel + 1] = 100;
      centroids[texel + 2] = 200;
    }
    const meta = makeMeta(1, {
      version: 3,
      shN: {
        count: 65537,
        bands: 4,
        codebook: v3Codebook,
        files: ['shN_centroids.webp', 'shN_labels.webp'],
      },
    });
    const data = await parseSog(
      makeV3Bundle(meta, [128, 128, 128, 0], [0, 0, 0, 204], {
        'shN_centroids.webp': fakeImage(width, rows, centroids),
        'shN_labels.webp': fakeImage(1, 1, [0, 0, 1, 255]),
      }),
    );

    const sh = data.sh!;
    expect(sh.bands).toBe(3);
    expect(Array.from(sh.labels)).toEqual([65536]);
    expect(sh.paletteWidth).toBe(64 * 15);
    expect(sh.paletteHeight).toBe(rows);
    for (let c = 0; c < 15; c++) {
      const texel = (1024 * sh.paletteWidth + c) * 4;
      expect(sh.palette[texel]).toBeCloseTo(c / 255, 6);
      expect(sh.palette[texel + 1]).toBeCloseTo(100 / 255, 6);
      expect(sh.palette[texel + 2]).toBeCloseTo(200 / 255, 6);
    }
  });

  it('keeps reading v2 labels as 16-bit', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    const meta = makeMeta(1, {
      shN: { count: 1, bands: 1, codebook, files: ['shN_centroids.webp', 'shN_labels.webp'] },
    });
    const data = await parseSog(
      makeV3Bundle(meta, [128, 128, 128, 255], [0, 0, 0, 200], {
        'shN_centroids.webp': fakeImage(3, 1),
        'shN_labels.webp': fakeImage(1, 1, [0, 0, 7, 255]),
      }),
    );
    expect(Array.from(data.sh!.labels)).toEqual([0]);
  });
});

describe('parseSog in-decode thinning', () => {
  it('keeps exactly the set limitSplatCount would keep from the full decode', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    const bundle = makeRandomBundle(3000);
    const full = await parseSog(bundle);
    const reference = limitSplatCount(await parseSog(bundle), 1100);
    const thinned = await parseSog(bundle, { maxSplats: 1100 });

    expect(full.count).toBe(3000);
    expect(thinned.count).toBe(1100);
    expect(thinned.sourceCount).toBe(3000);
    expect(Array.from(thinned.positions)).toEqual(Array.from(reference.positions));
    expect(Array.from(thinned.colors)).toEqual(Array.from(reference.colors));
    expect(Array.from(thinned.covariances)).toEqual(Array.from(reference.covariances));
    expect(Array.from(thinned.sh?.labels ?? [])).toEqual(Array.from(reference.sh?.labels ?? []));
    expect(thinned.positions.buffer.byteLength).toBe(1100 * 3 * 4);
  });

  it('decodes byte-for-byte as before when nothing has to be dropped', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    const bundle = makeRandomBundle(500);
    const plain = await parseSog(bundle);
    const roomy = await parseSog(bundle, { maxSplats: 500 });
    expect(roomy.sourceCount).toBeUndefined();
    expect(roomy).toEqual(plain);
  });

  it('asks a function for the limit once, with the file count', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    const maxSplats = vi.fn(async (count: number) => count / 5);
    const data = await parseSog(makeRandomBundle(500), { maxSplats });
    expect(maxSplats).toHaveBeenCalledTimes(1);
    expect(maxSplats).toHaveBeenCalledWith(500);
    expect(data.count).toBe(100);
  });
});

describe('parseSogDirectory', () => {
  it('rejects file names that resolve outside the directory', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    const hostileNames = [
      'https://evil.example/means_l.webp',
      '//evil.example/means_l.webp',
      '/means_l.webp',
      '../means_l.webp',
      'nested/../../means_l.webp',
      ' https://evil.example/a',
      '\thttps://evil.example/a',
      'h\nttps://evil.example/a',
      '%2e%2e/means_l.webp',
      '%2E%2E/scene-other/means_l.webp',
    ];
    for (const name of hostileNames) {
      const meta = makeMeta(1, {
        means: { mins: [0, 0, 0], maxs: [1, 1, 1], files: [name, 'means_u.webp'] },
      });
      const fetched: string[] = [];
      vi.stubGlobal('fetch', async (url: URL) => {
        fetched.push(url.toString());
        if (url.toString().endsWith('meta.json')) {
          return new Response(JSON.stringify(meta));
        }
        return new Response(fakeImage(1, 1));
      });

      await expect(parseSogDirectory('https://host.example/scene/')).rejects.toThrow(
        /outside its directory/,
      );
      expect(fetched.every((url) => url.startsWith('https://host.example/scene/'))).toBe(true);
    }
  });
});

it('resolves nested files and queries against the directory pathname', async () => {
  vi.stubGlobal('ImageDecoder', StubImageDecoder);
  const meta = makeMeta(1, {
    means: { mins: [0, 0, 0], maxs: [1, 1, 1], files: ['nested/means_l.webp?q=1', 'means_u.webp'] },
  });
  const fetched: string[] = [];
  vi.stubGlobal('fetch', async (url: URL) => {
    fetched.push(url.href);
    return new Response(
      url.pathname.endsWith('meta.json') ? JSON.stringify(meta) : fakeImage(1, 1),
    );
  });
  await parseSogDirectory('https://host.example/scene?token=abc');
  expect(fetched[0]).toBe('https://host.example/scene/meta.json');
  expect(fetched).toContain('https://host.example/scene/nested/means_l.webp?q=1');
});

it('uses only own-property mapped files as the local folder allowlist', async () => {
  vi.stubGlobal('ImageDecoder', StubImageDecoder);
  const files = Object.assign(Object.create({ meta: 'blob:https://host.example/inherited' }), {
    'meta.json': 'blob:https://host.example/meta',
  }) as Record<string, string>;
  vi.stubGlobal(
    'fetch',
    async (url: URL) =>
      new Response(url.href.endsWith('/meta') ? JSON.stringify(makeMeta(1)) : fakeImage(1, 1)),
  );
  await expect(parseSogDirectory('local-folder', { files })).rejects.toThrow(/missing/);
  for (const name of ['means_l.webp', 'means_u.webp', 'scales.webp', 'quats.webp', 'sh0.webp'])
    files[name] = `blob:https://host.example/${name}`;
  expect((await parseSogDirectory('local-folder', { files })).count).toBe(1);
});

describe('SOG decoder failure cleanup', () => {
  it.each(['decode', 'copy'] as const)('closes resources when %s fails', async (failure) => {
    const decoders: ReturnType<typeof vi.fn>[] = [],
      frames: ReturnType<typeof vi.fn>[] = [];
    vi.stubGlobal(
      'ImageDecoder',
      class {
        close = vi.fn();
        constructor() {
          decoders.push(this.close);
        }
        async decode() {
          if (failure === 'decode') throw new Error('decode failed');
          const close = vi.fn();
          frames.push(close);
          return {
            image: {
              codedWidth: 1,
              codedHeight: 1,
              close,
              copyTo: async () => {
                throw new Error('copy failed');
              },
            },
          };
        }
      },
    );
    await expect(parseSog(makeBundle(makeMeta(1)))).rejects.toThrow(`${failure} failed`);
    expect(decoders.length).toBeGreaterThan(0);
    for (const close of [...decoders, ...frames]) expect(close).toHaveBeenCalledOnce();
  });
});

describe('SOG WebGL context loss', () => {
  it('decodes without WebGL once the worker readback context is lost', async () => {
    vi.resetModules();
    const { parseSog: parseFresh } = await import('../formats/sog/parse-sog');
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    vi.stubGlobal('createImageBitmap', async () => ({
      width: 1,
      height: 1,
      close: () => undefined,
    }));
    const gl = new StubWebGl2Context();
    // The context is live when acquired and lost by the first allocation;
    // a lost WebGL context returns null from every create call.
    let lost = false;
    vi.spyOn(gl, 'isContextLost').mockImplementation(() => lost);
    vi.spyOn(gl, 'createTexture').mockImplementation(() => {
      lost = true;
      return null!;
    });
    const getContext = vi.fn(() => gl as unknown as WebGL2RenderingContext);
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext = getContext;
      },
    );

    const data = await parseFresh(makeBundle(makeMeta(1)));
    await parseFresh(makeBundle(makeMeta(1)));

    expect(data.colors[3]).toBe(200);
    // One context attempt; later images and chunks skip WebGL entirely.
    expect(getContext).toHaveBeenCalledOnce();
  });
});

describe('SOG bitmap failure cleanup', () => {
  it.each(['texture', 'framebuffer', 'canvas', 'readback'] as const)(
    'releases acquired resources on %s failure',
    async (failure) => {
      vi.resetModules();
      const { parseSog: parseFresh } = await import('../formats/sog/parse-sog');
      const closes: ReturnType<typeof vi.fn>[] = [];
      vi.stubGlobal('ImageDecoder', undefined);
      // Remove the property: the decoder feature check uses `in`.
      delete (globalThis as { ImageDecoder?: unknown }).ImageDecoder;
      vi.stubGlobal('createImageBitmap', async () => {
        const close = vi.fn();
        closes.push(close);
        return { width: 1, height: 1, close };
      });
      const texture = {},
        framebuffer = {};
      const gl = new StubWebGl2Context();
      vi.spyOn(gl, 'createTexture').mockReturnValue(failure === 'texture' ? null! : texture);
      vi.spyOn(gl, 'createFramebuffer').mockReturnValue(
        failure === 'framebuffer' ? null! : framebuffer,
      );
      const deleteTexture = vi.spyOn(gl, 'deleteTexture'),
        deleteFramebuffer = vi.spyOn(gl, 'deleteFramebuffer');
      vi.stubGlobal(
        'OffscreenCanvas',
        class {
          getContext(kind: string) {
            if (kind === 'webgl2')
              return failure === 'texture' || failure === 'framebuffer' ? gl : null;
            if (failure === 'canvas') return null;
            return {
              drawImage() {},
              getImageData() {
                throw new Error('readback failed');
              },
            };
          }
        },
      );
      await expect(parseFresh(makeBundle(makeMeta(1)))).rejects.toThrow();
      for (const close of closes) expect(close).toHaveBeenCalledOnce();
      if (failure === 'texture') expect(deleteFramebuffer).toHaveBeenCalledWith(framebuffer);
      if (failure === 'framebuffer') expect(deleteTexture).toHaveBeenCalledWith(texture);
    },
  );
});
