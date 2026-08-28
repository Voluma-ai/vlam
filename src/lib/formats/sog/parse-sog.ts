import { SH_C0, writeCovariance, type SplatData, type SplatShData } from '../../core/splat-data';
import {
  isAbortError,
  toRequestInit,
  toSplatLoadError,
  type SplatRequestOptions,
} from '../../loaders/loading';

/**
 * Decoder for PlayCanvas's SOG format (v2), Voluma's canonical delivery
 * format: `meta.json` plus WebP-encoded attribute images, delivered either
 * as a ZIP bundle (`.sog` file) or as an unbundled directory (the form
 * Streamed SOG chunks use).
 *
 * Spec: https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/
 * (an open specification; PlayCanvas explicitly invites third-party
 * implementations). The decoder below is an original implementation of that
 * spec. Splat i lives at pixel (i % width, ⌊i / width⌋) in every image.
 *
 * Note: this prototype decodes on the CPU for simplicity. SOG is designed
 * to be GPU-ready - a later optimization is uploading the WebP images as
 * textures and dequantizing in the shader, as PlayCanvas does.
 */

/** meta.json schema (the subset this decoder needs). */
interface SogMeta {
  version: number;
  count: number;
  /** Optional: the scene was exported with antialiasing (Mip-Splatting). */
  antialias?: boolean;
  means: { mins: [number, number, number]; maxs: [number, number, number]; files: string[] };
  scales: { codebook: number[]; files: string[] };
  quats: { files: string[] };
  sh0: { codebook: number[]; files: string[] };
  shN?: { count: number; bands: number; codebook: number[]; files: string[] };
}

interface DecodedImage {
  width: number;
  height: number;
  /** RGBA bytes, row-major. */
  data: Uint8Array;
}

/**
 * Upper bound on `meta.count` before any allocation happens. The renderer
 * cannot draw more anyway: 2048-wide pool textures cap at ~16.7M splats
 * (ROADMAP M4.2) and the float32 `splatIndex` is exact only up to 2²⁴, so
 * anything larger in an untrusted meta.json is rejected rather than
 * ballooning into a multi-gigabyte allocation.
 */
const MAX_SPLAT_COUNT = 1 << 24;

/**
 * Parses a bundled `.sog` file into flat, GPU-friendly arrays, including
 * the palette-compressed higher-order SH coefficients (`shN`) if present.
 *
 * @param options.signal - Optional abort signal; the decode stages check it
 * between steps and inside the dequantization loop.
 * @throws {Error} if the archive or its `meta.json` is malformed;
 * a `DOMException` named `AbortError` when cancelled.
 *
 * A direct parser call sits outside the `SplatLoadError`-or-`AbortError`
 * contract of the worker-mediated loaders ({@link loadSplatData},
 * {@link loadSplatDataFile}, `ChunkLoader`, `StreamedSplatMesh`): malformed input
 * surfaces here as a plain `Error`.
 */
export async function parseSog(
  buffer: ArrayBuffer,
  options: { signal?: AbortSignal } = {},
): Promise<SplatData> {
  const archive = readZip(buffer);
  return parseSogFromEntries(async (name) => {
    const entry = archive.get(name);
    if (!entry) throw new Error(`SOG bundle is missing "${name}".`);
    return entry();
  }, options.signal);
}

/**
 * Parses an unbundled SOG directory (`meta.json` + WebP files fetched
 * individually) into flat, GPU-friendly arrays - the layout Streamed SOG
 * chunks use.
 *
 * @param baseUrl - Absolute URL of the directory containing `meta.json`.
 * @param options.signal - Optional abort signal; in-flight fetches are
 * cancelled when it fires, and the decode stages check it between steps.
 * @throws {Error} on fetch failures or a malformed `meta.json`;
 * a `DOMException` named `AbortError` when cancelled.
 *
 * A direct parser call sits outside the `SplatLoadError`-or-`AbortError`
 * contract of the worker-mediated loaders ({@link loadSplatData},
 * {@link loadSplatDataFile}, `ChunkLoader`, `StreamedSplatMesh`): malformed input
 * surfaces here as a plain `Error`.
 */
export async function parseSogDirectory(
  baseUrl: string,
  options: {
    signal?: AbortSignal;
    request?: SplatRequestOptions;
    /**
     * The directory's files as `name → URL`, for a chunk that has no
     * directory URL to resolve against - a folder dropped into the page,
     * whose files are reached through `blob:` URLs.
     */
    files?: Readonly<Record<string, string>>;
  } = {},
): Promise<SplatData> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return parseSogFromEntries(async (name) => {
    assertPlainRelativeName(name);
    const mapped = options.files?.[name];
    if (options.files && mapped === undefined) {
      throw new Error(`SOG chunk is missing "${name}".`);
    }
    const url = mapped === undefined ? new URL(name, base) : new URL(mapped);
    let response: Response;
    try {
      response = await fetch(url, toRequestInit(options.request, options.signal));
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw toSplatLoadError(error, { phase: 'fetch', url: url.href });
    }
    if (!response.ok) {
      throw toSplatLoadError(new Error(`Failed to load ${url.href}: HTTP ${response.status}`), {
        phase: 'fetch',
        url: url.href,
        status: response.status,
      });
    }
    return new Uint8Array(await response.arrayBuffer());
  }, options.signal);
}

/**
 * Shared decode core; `readEntry` supplies file contents by name. The
 * abort signal is checked between decode stages so a cancellation skips
 * the expensive dequantization even when all fetches already finished.
 */
async function parseSogFromEntries(
  readEntry: (name: string) => Promise<Uint8Array>,
  signal?: AbortSignal,
): Promise<SplatData> {
  const meta = JSON.parse(new TextDecoder().decode(await readEntry('meta.json'))) as SogMeta;
  validateMeta(meta);
  signal?.throwIfAborted();

  const [meansL, meansU, quats, scales, sh0] = await Promise.all([
    readEntry(meta.means.files[0] ?? 'means_l.webp').then(decodeWebp),
    readEntry(meta.means.files[1] ?? 'means_u.webp').then(decodeWebp),
    readEntry(meta.quats.files[0] ?? 'quats.webp').then(decodeWebp),
    readEntry(meta.scales.files[0] ?? 'scales.webp').then(decodeWebp),
    readEntry(meta.sh0.files[0] ?? 'sh0.webp').then(decodeWebp),
  ]);
  signal?.throwIfAborted();

  const count = meta.count;
  assertImageHoldsCount(meansL, 'means_l', count);
  assertImageHoldsCount(meansU, 'means_u', count);
  assertImageHoldsCount(quats, 'quats', count);
  assertImageHoldsCount(scales, 'scales', count);
  assertImageHoldsCount(sh0, 'sh0', count);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);

  // Positions: 16 bit per axis, normalized over [mins, maxs] in a
  // symmetric-log domain: unlog(n) = sign(n)·(eⁿ − 1).
  const { mins, maxs } = meta.means;
  const unlog = (n: number): number => Math.sign(n) * (Math.exp(Math.abs(n)) - 1);

  // Quaternions: "smallest three" encoding. RGB hold three components in
  // [-√½, +√½]; alpha − 252 says which component was omitted (the largest,
  // reconstructed from unit length). Component order is (w, x, y, z).
  const quatComponent = (byte: number): number => (byte / 255 - 0.5) * Math.SQRT2;

  const toColorByte = (sh: number): number =>
    Math.max(0, Math.min(255, Math.round((0.5 + sh * SH_C0) * 255)));

  for (let i = 0; i < count; i++) {
    // The dequantization loop dominates decode time. With a signal, yield
    // to the event loop every 65,536 splats so a pending cancel message
    // can be processed at all (the worker is single-threaded), then honor
    // it. Without a signal this branch never runs - no overhead.
    if (signal && (i & 0xffff) === 0 && i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
    }
    const p = i * 4; // Every attribute image shares the same pixel layout.

    for (let axis = 0; axis < 3; axis++) {
      const quantized =
        (((meansU.data[p + axis] as number) << 8) | (meansL.data[p + axis] as number)) / 65535;
      const lo = mins[axis] as number;
      const hi = maxs[axis] as number;
      positions[i * 3 + axis] = unlog(lo + (hi - lo) * quantized);
    }

    // SH0: RGB are codebook indices for the DC term; alpha is the opacity,
    // stored already activated (no sigmoid, unlike PLY).
    colors[p + 0] = toColorByte(meta.sh0.codebook[sh0.data[p + 0] as number] as number);
    colors[p + 1] = toColorByte(meta.sh0.codebook[sh0.data[p + 1] as number] as number);
    colors[p + 2] = toColorByte(meta.sh0.codebook[sh0.data[p + 2] as number] as number);
    colors[p + 3] = sh0.data[p + 3] as number;

    const a = quatComponent(quats.data[p + 0] as number);
    const b = quatComponent(quats.data[p + 1] as number);
    const c = quatComponent(quats.data[p + 2] as number);
    const d = Math.sqrt(Math.max(0, 1 - (a * a + b * b + c * c)));
    const mode = (quats.data[p + 3] as number) - 252;
    const [qw, qx, qy, qz] =
      mode === 0
        ? [d, a, b, c]
        : mode === 1
          ? [a, d, b, c]
          : mode === 2
            ? [a, b, d, c]
            : [a, b, c, d];

    writeCovariance(
      covariances,
      i,
      Math.exp(meta.scales.codebook[scales.data[p + 0] as number] as number),
      Math.exp(meta.scales.codebook[scales.data[p + 1] as number] as number),
      Math.exp(meta.scales.codebook[scales.data[p + 2] as number] as number),
      qw,
      qx,
      qy,
      qz,
    );
  }

  signal?.throwIfAborted();
  const sh = meta.shN ? await decodeShN(meta.shN, count, readEntry) : undefined;
  return { count, positions, colors, covariances, sh, antialias: meta.antialias === true };
}

/**
 * Validates the untrusted `meta.json` before anything is allocated or
 * fetched based on it: the splat count must be a sane non-negative integer
 * and every codebook must resolve all 256 possible byte indices to finite
 * numbers (image bytes index them unchecked in the hot loop).
 */
function validateMeta(meta: SogMeta): void {
  if (meta.version !== 2) throw new Error(`Unsupported SOG version: ${meta.version}.`);
  if (!Number.isSafeInteger(meta.count) || meta.count < 0) {
    throw new Error(`SOG meta.json declares an invalid splat count: ${meta.count}.`);
  }
  if (meta.count > MAX_SPLAT_COUNT) {
    throw new Error(
      `SOG meta.json declares ${meta.count} splats, above the supported maximum of ${MAX_SPLAT_COUNT}.`,
    );
  }
  validateVector3(meta.means?.mins, 'means.mins');
  validateVector3(meta.means?.maxs, 'means.maxs');
  validateCodebook(meta.scales?.codebook, 'scales');
  validateCodebook(meta.sh0?.codebook, 'sh0');
  if (meta.shN) {
    validateCodebook(meta.shN.codebook, 'shN');
    const bands = meta.shN.bands;
    if (!Number.isInteger(bands) || bands < 1 || bands > 3) {
      throw new Error(`SOG meta.json declares an invalid shN band count: ${bands}.`);
    }
  }
}

/** Asserts a meta.json vector is three finite numbers. */
function validateVector3(vector: unknown, label: string): void {
  if (
    !Array.isArray(vector) ||
    vector.length !== 3 ||
    vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new Error(`SOG meta.json: "${label}" must be an array of 3 finite numbers.`);
  }
}

/** Asserts a codebook covers every byte index with a finite number. */
function validateCodebook(codebook: number[] | undefined, label: string): void {
  if (!Array.isArray(codebook) || codebook.length < 256) {
    throw new Error(`SOG meta.json: the "${label}" codebook must contain at least 256 entries.`);
  }
  for (const value of codebook) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`SOG meta.json: the "${label}" codebook contains a non-finite entry.`);
    }
  }
}

/** Asserts an attribute image has at least one pixel per declared splat. */
function assertImageHoldsCount(image: DecodedImage, label: string, count: number): void {
  if (count > image.width * image.height) {
    throw new Error(
      `SOG "${label}" image (${image.width}×${image.height}) holds fewer than the declared ${count} splats.`,
    );
  }
}

/**
 * Rejects file names from `meta.json` that would resolve outside the SOG
 * directory - absolute URLs, scheme-relative or root-relative paths, and
 * `..` traversal - so a hostile manifest cannot redirect worker fetches.
 */
function assertPlainRelativeName(name: string): void {
  const escapes =
    typeof name !== 'string' ||
    name.length === 0 ||
    /^[a-z][a-z0-9+.-]*:/i.test(name) ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.split('/').some((segment) => segment === '..');
  if (escapes) {
    throw new Error(`SOG meta.json references a file outside its directory: "${name}".`);
  }
}

/**
 * Decodes the palette-compressed higher-order SH data: per-splat 16-bit
 * labels plus a centroids image whose bytes are codebook indices. The
 * centroids keep their SOG grid layout so they can be uploaded as-is.
 */
async function decodeShN(
  meta: NonNullable<SogMeta['shN']>,
  count: number,
  readEntry: (name: string) => Promise<Uint8Array>,
): Promise<SplatShData> {
  const [centroids, labelsImage] = await Promise.all([
    readEntry(meta.files[0] ?? 'shN_centroids.webp').then(decodeWebp),
    readEntry(meta.files[1] ?? 'shN_labels.webp').then(decodeWebp),
  ]);
  assertImageHoldsCount(labelsImage, 'shN labels', count);

  // A label indexes a palette entry laid out 64 entries per row, each entry
  // `coeffs` texels wide. Bound every decoded label against the centroids
  // image so a hostile labels image cannot address texels outside it.
  const coeffs = meta.bands === 1 ? 3 : meta.bands === 2 ? 8 : 15;
  const labels = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const label =
      (labelsImage.data[i * 4] as number) | ((labelsImage.data[i * 4 + 1] as number) << 8);
    const row = Math.floor(label / 64);
    const column0 = (label % 64) * coeffs;
    if (row >= centroids.height || column0 + coeffs > centroids.width) {
      throw new Error(
        `SOG shN label ${label} (splat ${i}) lies outside the ` +
          `${centroids.width}×${centroids.height} centroids palette.`,
      );
    }
    labels[i] = label;
  }

  const palette = new Float32Array(centroids.width * centroids.height * 4);
  for (let i = 0; i < centroids.width * centroids.height; i++) {
    palette[i * 4 + 0] = meta.codebook[centroids.data[i * 4 + 0] as number] as number;
    palette[i * 4 + 1] = meta.codebook[centroids.data[i * 4 + 1] as number] as number;
    palette[i * 4 + 2] = meta.codebook[centroids.data[i * 4 + 2] as number] as number;
  }

  return {
    bands: meta.bands,
    labels,
    palette,
    paletteWidth: centroids.width,
    paletteHeight: centroids.height,
  };
}

/**
 * Minimal ZIP reader: returns a map from entry name to a function that
 * produces the entry's bytes. Supports the two methods that occur in
 * practice - STORE (SOG bundles are stored; WebP is already compressed)
 * and DEFLATE via the browser's native DecompressionStream.
 */
function readZip(buffer: ArrayBuffer): Map<string, () => Promise<Uint8Array>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Find the End Of Central Directory record (its signature, scanned
  // backwards past the variable-length archive comment).
  let eocd = -1;
  const scanEnd = Math.max(0, buffer.byteLength - 65557);
  for (let offset = buffer.byteLength - 22; offset >= scanEnd; offset--) {
    if (offset < 0) break;
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');

  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true); // Central directory offset.

  const entries = new Map<string, () => Promise<Uint8Array>>();
  for (let i = 0; i < entryCount; i++) {
    // Range-check the untrusted cursor before every DataView read, so a
    // hostile central-directory offset fails as the corrupt ZIP it is
    // instead of surfacing a bare RangeError.
    if (cursor < 0 || cursor + 46 > buffer.byteLength) {
      throw new Error('Corrupt ZIP central directory.');
    }
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('Corrupt ZIP central directory.');
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    if (cursor + 46 + nameLength > buffer.byteLength) {
      throw new Error('Corrupt ZIP central directory.');
    }
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    entries.set(name, async () => {
      // The local header repeats name/extra with possibly different sizes.
      if (localHeaderOffset + 30 > buffer.byteLength) {
        throw new Error(`Corrupt ZIP entry "${name}": local header extends past the archive.`);
      }
      const localNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > buffer.byteLength) {
        throw new Error(`Corrupt ZIP entry "${name}": data extends past the archive.`);
      }
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

      if (method === 0) return compressed; // STORE
      if (method === 8) {
        // DEFLATE
        // Blob copies the viewed byte range itself; no defensive slice needed.
        const stream = new Blob([compressed])
          .stream()
          .pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      throw new Error(`Unsupported ZIP compression method ${method} for "${name}".`);
    });
  }
  return entries;
}

let webpReadbackContext: WebGL2RenderingContext | undefined;

/** Returns one worker-local WebGL2 context for consistent WebP readback. */
function getWebpReadbackContext(): WebGL2RenderingContext | undefined {
  if (!('OffscreenCanvas' in globalThis) || !('createImageBitmap' in globalThis)) return undefined;
  if (webpReadbackContext && !webpReadbackContext.isContextLost()) return webpReadbackContext;

  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    stencil: false,
  });
  if (!context) return undefined;
  webpReadbackContext = context;
  return context;
}

/**
 * Decodes through the same path PlayCanvas uses for SOG data textures.
 * Firefox's ImageDecoder premultiplies RGB by alpha even when conversion is
 * disabled. ImageBitmap -> WebGL keeps RGB unassociated with alpha.
 */
async function decodeWebpViaGpu(
  bytes: Uint8Array,
  context: WebGL2RenderingContext,
): Promise<DecodedImage> {
  const blobBytes = bytes as Uint8Array<ArrayBuffer>;
  const bitmap = await createImageBitmap(new Blob([blobBytes], { type: 'image/webp' }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const texture = context.createTexture();
  const framebuffer = context.createFramebuffer();
  if (!texture || !framebuffer) {
    bitmap.close();
    throw new Error('Could not allocate a WebGL texture for SOG WebP decoding.');
  }

  try {
    context.bindTexture(context.TEXTURE_2D, texture);
    context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);
    context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    context.texImage2D(
      context.TEXTURE_2D,
      0,
      context.RGBA,
      context.RGBA,
      context.UNSIGNED_BYTE,
      bitmap,
    );

    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(
      context.FRAMEBUFFER,
      context.COLOR_ATTACHMENT0,
      context.TEXTURE_2D,
      texture,
      0,
    );
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
      throw new Error('Could not read the decoded SOG WebP texture.');
    }

    const data = new Uint8Array(bitmap.width * bitmap.height * 4);
    context.readPixels(
      0,
      0,
      bitmap.width,
      bitmap.height,
      context.RGBA,
      context.UNSIGNED_BYTE,
      data,
    );
    return { width: bitmap.width, height: bitmap.height, data };
  } finally {
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    context.bindTexture(context.TEXTURE_2D, null);
    context.deleteFramebuffer(framebuffer);
    context.deleteTexture(texture);
    bitmap.close();
  }
}

/** Decodes a WebP image to raw RGBA bytes. */
async function decodeWebp(bytes: Uint8Array): Promise<DecodedImage> {
  const gpuContext = getWebpReadbackContext();
  if (gpuContext) return decodeWebpViaGpu(bytes, gpuContext);

  // WebCodecs fallback for environments without worker WebGL2. Chromium
  // preserves these data bytes; Firefox uses the GPU path above because its
  // VideoFrame copy currently premultiplies low-alpha RGB values.
  if ('ImageDecoder' in globalThis) {
    const decoder = new ImageDecoder({
      data: bytes,
      type: 'image/webp',
      colorSpaceConversion: 'none',
    });
    const { image } = await decoder.decode();
    const width = image.codedWidth;
    const height = image.codedHeight;
    const data = new Uint8Array(width * height * 4);
    await image.copyTo(data, { format: 'RGBA' });
    image.close();
    decoder.close();
    return { width, height, data };
  }

  // Fallback: canvas readback. The premultiply round-trip can cost ±1 bit
  // of RGB precision on low-alpha pixels; acceptable for a fallback path.
  // Blob copies the viewed byte range itself, so no defensive `.slice()` is
  // needed; the cast only bridges lib.dom's BlobPart rejecting the
  // ArrayBufferLike-generic view (these bytes never sit in a SharedArrayBuffer).
  const blobBytes = bytes as Uint8Array<ArrayBuffer>;
  const bitmap = await createImageBitmap(new Blob([blobBytes], { type: 'image/webp' }), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a 2D canvas context.');
  context.drawImage(bitmap, 0, 0);
  const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return {
    width: imageData.width,
    height: imageData.height,
    data: new Uint8Array(imageData.data.buffer),
  };
}
