import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSog, parseSogDirectory } from '../formats/sog/parse-sog';

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
    for (const bands of [0, 4, 2.5, '3']) {
      const meta = makeMeta(1, {
        shN: { count: 1, bands, codebook, files: ['shN_centroids.webp', 'shN_labels.webp'] },
      });
      await expect(parseSog(buildZip({ 'meta.json': JSON.stringify(meta) }))).rejects.toThrow(
        /invalid shN band count/,
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

describe('parseSogDirectory', () => {
  it('rejects file names that resolve outside the directory', async () => {
    vi.stubGlobal('ImageDecoder', StubImageDecoder);
    const hostileNames = [
      'https://evil.example/means_l.webp',
      '//evil.example/means_l.webp',
      '/means_l.webp',
      '../means_l.webp',
      'nested/../../means_l.webp',
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
