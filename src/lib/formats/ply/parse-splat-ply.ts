import { packShCoefficients } from '../../core/sh-pack';
import { SH_C0, writeCovariance, type SplatData } from '../../core/splat-data';
import { isCompressedPly, parseCompressedPly } from './parse-compressed-ply';
import { readWholeFile, type SplatProgressCallback } from '../../loaders/loading';
import {
  assertPlyElementFits,
  assertPlyPropertyTypes,
  parsePlyHeader,
  plyPropertyOffset,
  type PlyElement,
} from '../../loaders/ply-header';

/**
 * Parser for the "INRIA flavor" Gaussian splat PLY format: a binary
 * little-endian PLY whose vertices carry position, spherical-harmonics
 * color (f_dc_*), opacity, scale and rotation properties.
 *
 * `.ply` is a container rather than one format, so {@link parseSplatPly} also
 * dispatches to the compressed flavor (see `parse-compressed-ply.ts`), which
 * SuperSplat and `@playcanvas/splat-transform -c` write.
 *
 * Only the math from the 3DGS paper (Kerbl et al., SIGGRAPH 2023) is used
 * here; the implementation is original.
 */

/** Property names this parser requires, in no particular order. */
const REQUIRED_PROPERTIES = [
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
] as const;

/** Higher-order SH coefficient counts per band (channel-major `f_rest_*`). */
const REST_COEFFICIENTS: Record<number, 1 | 2 | 3> = { 3: 1, 8: 2, 15: 3 };

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Parses a binary Gaussian splat PLY file into flat, GPU-friendly arrays -
 * either the uncompressed 3DGS flavor or the compressed SuperSplat one, which
 * is detected from the header.
 *
 * For the uncompressed flavor the spherical harmonics DC term is baked into an
 * 8-bit RGB color; optional `f_rest_*` higher-order coefficients are packed
 * into per-splat `shPacked`. Opacity is passed through a sigmoid, and per-splat
 * (log-space) + rotation (quaternion) are folded into a 3D covariance matrix -
 * all per the 3DGS paper's parameterization.
 *
 * @throws {Error} if the file is not a binary little-endian splat PLY.
 *
 * A direct parser call sits outside the `SplatLoadError`-or-`AbortError`
 * contract of the worker-mediated loaders ({@link loadSplatData},
 * {@link loadSplatDataFile}, `ChunkLoader`, `StreamedSplatMesh`): malformed input
 * surfaces here as a plain `Error`.
 */
export function parseSplatPly(buffer: ArrayBuffer): SplatData {
  const header = parsePlyHeader(buffer);
  if (isCompressedPly(header)) return parseCompressedPly(buffer, header);

  const vertices = requireSplatVertexElement(header);
  assertPlyElementFits(vertices, buffer.byteLength);

  const out = allocate(vertices.count);
  const rest = restLayout(vertices);
  const coefficients = rest ? new Float32Array(vertices.count * rest.coefficients * 3) : null;
  decodeRecords(
    new DataView(buffer, vertices.offset),
    vertexOffsets(vertices),
    vertices.stride,
    0,
    0,
    vertices.count,
    out,
  );
  if (rest && coefficients) {
    decodeRestRecords(
      new DataView(buffer, vertices.offset),
      vertices.stride,
      0,
      0,
      vertices.count,
      rest,
      coefficients,
    );
  }
  return finalizePlyDecode(vertices.count, out, rest, coefficients);
}

/**
 * Bytes read per slice while streaming. Large enough that a multi-gigabyte
 * file costs tens of reads rather than thousands, small enough to stay far
 * below the 2 GiB an ArrayBuffer can hold.
 */
const STREAM_WINDOW_BYTES = 64 * 1024 * 1024;

/** Bytes of a PLY that the header is assumed to fit inside. */
const HEADER_WINDOW_BYTES = 64 * 1024;

/**
 * Parses a local splat PLY without ever holding the whole file.
 *
 * A browser cannot allocate an ArrayBuffer over 2 GiB, so `file.arrayBuffer()`
 * fails outright on a raw 3DGS export of a few million splats (a full-SH
 * `point_cloud.ply` runs ~248 bytes per splat). The uncompressed flavor has
 * fixed-stride records, so it is read a window at a time. Higher-order
 * `f_rest_*` coefficients ride in the same stride and are decoded per window.
 *
 * The compressed flavor is read whole: it is ~10× smaller, and its chunked
 * layout would need a second pass to stream for no practical gain.
 *
 * @param options.windowBytes - Bytes read per slice; defaults to 64 MiB. Lower
 * trades read count for peak memory.
 * @param options.onProgress - Called after each window with the vertex bytes
 * decoded so far and the total. A multi-gigabyte decode takes tens of seconds,
 * which needs a determinate indicator rather than a spinner.
 * @throws {Error} if the file is not a binary little-endian splat PLY;
 * a `DOMException` named `AbortError` when cancelled.
 */
export async function parseSplatPlyFile(
  file: File,
  options: { signal?: AbortSignal; windowBytes?: number; onProgress?: SplatProgressCallback } = {},
): Promise<SplatData> {
  const { signal, onProgress } = options;
  const windowBytes = options.windowBytes ?? STREAM_WINDOW_BYTES;
  const head = await file.slice(0, Math.min(file.size, HEADER_WINDOW_BYTES)).arrayBuffer();
  const header = parsePlyHeader(head);
  if (isCompressedPly(header)) return parseCompressedPly(await readWholeFile(file), header);

  const vertices = requireSplatVertexElement(header);
  assertPlyElementFits(vertices, file.size);
  signal?.throwIfAborted();

  const count = vertices.count;
  const stride = vertices.stride;
  const out = allocate(count);
  const offsets = vertexOffsets(vertices);
  const rest = restLayout(vertices);
  const coefficients = rest ? new Float32Array(count * rest.coefficients * 3) : null;
  // At least one whole record per read: a window never splits a record, so
  // the decoder always sees complete ones.
  const perWindow = Math.max(1, Math.floor(windowBytes / stride));

  const totalBytes = count * stride;
  onProgress?.(0, totalBytes);
  for (let first = 0; first < count; first += perWindow) {
    signal?.throwIfAborted();
    const last = Math.min(first + perWindow, count);
    const slice = file.slice(vertices.offset + first * stride, vertices.offset + last * stride);
    const view = new DataView(await slice.arrayBuffer());
    // The window's byte 0 is record `first`, so the decoder rebases onto it.
    decodeRecords(view, offsets, stride, first, first, last, out);
    if (rest && coefficients)
      decodeRestRecords(view, stride, first, first, last, rest, coefficients);
    onProgress?.(last * stride, totalBytes);
  }
  return finalizePlyDecode(count, out, rest, coefficients);
}

/** The vertex element of a splat PLY, with its required properties checked. */
function requireSplatVertexElement(header: ReturnType<typeof parsePlyHeader>): PlyElement {
  const vertices = header.element('vertex');
  if (!vertices) throw new Error('PLY file is not a Gaussian splat file: no "vertex" element.');
  assertPlyPropertyTypes(
    vertices,
    REQUIRED_PROPERTIES,
    ['float', 'float32'],
    'PLY file is not a Gaussian splat file',
  );
  return vertices;
}

interface RestLayout {
  bands: 1 | 2 | 3;
  coefficients: number;
  offsets: readonly number[];
}

/** Resolves optional `f_rest_*` higher-order SH in a 3DGS vertex element. */
function restLayout(vertices: PlyElement): RestLayout | null {
  const restNames = vertices.propertyNames.filter((name) => name.startsWith('f_rest_'));
  if (restNames.length === 0) return null;
  if (restNames.length % 3 !== 0) {
    throw new Error(
      `PLY vertex has ${restNames.length} f_rest_* properties, which is not divisible by three.`,
    );
  }
  const coefficients = restNames.length / 3;
  const bands = REST_COEFFICIENTS[coefficients];
  if (!bands) {
    throw new Error(
      `PLY vertex has ${coefficients} SH coefficients per channel; expected 3, 8 or 15.`,
    );
  }
  const names = Array.from({ length: coefficients * 3 }, (_, i) => `f_rest_${i}`);
  assertPlyPropertyTypes(vertices, names, ['float', 'float32'], 'PLY f_rest');
  const offsets = names.map((name) => plyPropertyOffset(vertices, name));
  return { bands, coefficients, offsets };
}

function finalizePlyDecode(
  count: number,
  out: SplatArrays,
  rest: RestLayout | null,
  coefficients: Float32Array | null,
): SplatData {
  const shPacked =
    rest && coefficients ? packShCoefficients(coefficients, count, rest.bands) : undefined;
  return { count, ...out, ...(shPacked ? { shPacked } : {}) };
}

interface SplatArrays {
  positions: Float32Array;
  colors: Uint8Array;
  covariances: Float32Array;
}

function allocate(count: number): SplatArrays {
  return {
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4),
    covariances: new Float32Array(count * 6),
  };
}

/** Byte offsets of the properties the decoder reads, within one record. */
interface VertexOffsets {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  s0: number;
  s1: number;
  s2: number;
  q0: number;
  q1: number;
  q2: number;
  q3: number;
}

function vertexOffsets(vertices: PlyElement): VertexOffsets {
  const at = (name: string): number => plyPropertyOffset(vertices, name);
  return {
    x: at('x'),
    y: at('y'),
    z: at('z'),
    r: at('f_dc_0'),
    g: at('f_dc_1'),
    b: at('f_dc_2'),
    alpha: at('opacity'),
    s0: at('scale_0'),
    s1: at('scale_1'),
    s2: at('scale_2'),
    q0: at('rot_0'),
    q1: at('rot_1'),
    q2: at('rot_2'),
    q3: at('rot_3'),
  };
}

/**
 * Decodes records `[from, to)` into `out`, reading from a view whose byte 0
 * holds record `viewFirst`. Shared by the whole-buffer and streamed paths, so
 * both produce identical arrays.
 */
function decodeRecords(
  view: DataView,
  o: VertexOffsets,
  stride: number,
  viewFirst: number,
  from: number,
  to: number,
  out: SplatArrays,
): void {
  const { positions, colors, covariances } = out;
  for (let i = from; i < to; i++) {
    const base = (i - viewFirst) * stride;
    const readFloat = (offset: number): number => view.getFloat32(base + offset, true);

    positions[i * 3 + 0] = readFloat(o.x);
    positions[i * 3 + 1] = readFloat(o.y);
    positions[i * 3 + 2] = readFloat(o.z);

    // Degree-0 SH to linear color: c = 0.5 + Y₀₀ · f_dc.
    const toByte = (sh: number): number =>
      Math.max(0, Math.min(255, Math.round((0.5 + SH_C0 * sh) * 255)));
    colors[i * 4 + 0] = toByte(readFloat(o.r));
    colors[i * 4 + 1] = toByte(readFloat(o.g));
    colors[i * 4 + 2] = toByte(readFloat(o.b));
    colors[i * 4 + 3] = Math.round(sigmoid(readFloat(o.alpha)) * 255);

    // Scale is stored in log-space; rotation as a (w, x, y, z) quaternion.
    writeCovariance(
      covariances,
      i,
      Math.exp(readFloat(o.s0)),
      Math.exp(readFloat(o.s1)),
      Math.exp(readFloat(o.s2)),
      readFloat(o.q0),
      readFloat(o.q1),
      readFloat(o.q2),
      readFloat(o.q3),
    );
  }
}

/**
 * Decodes channel-major `f_rest_*` floats into coefficient-major RGB triples.
 */
function decodeRestRecords(
  view: DataView,
  stride: number,
  viewFirst: number,
  from: number,
  to: number,
  rest: RestLayout,
  out: Float32Array,
): void {
  const { coefficients, offsets } = rest;
  for (let i = from; i < to; i++) {
    const base = (i - viewFirst) * stride;
    const dest = i * coefficients * 3;
    for (let c = 0; c < coefficients; c++) {
      out[dest + c * 3 + 0] = view.getFloat32(base + (offsets[c] as number), true);
      out[dest + c * 3 + 1] = view.getFloat32(base + (offsets[coefficients + c] as number), true);
      out[dest + c * 3 + 2] = view.getFloat32(
        base + (offsets[2 * coefficients + c] as number),
        true,
      );
    }
  }
}
