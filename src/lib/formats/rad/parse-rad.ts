import {
  assertColumnHoldsCount,
  decodeU16,
  decodeU32,
  decodeChildCount,
  decodeChildStart,
  decodeFloatColumn,
  decodeOrientation,
} from './rad-column-decoders';
import {
  writeCovariance,
  type RadShCodebook,
  type SplatData,
  type SplatPackedShData,
} from '../../splat-data';
import { neutralShWord, packShCoefficients, shCoefficientCount } from '../../sh-pack';

/**
 * Parser for World Labs' Spark `.rad`/`.radc` format (a precomputed LOD splat
 * tree with per-column, gzip/deflate-compressed properties). Ported from the
 * MIT-licensed Rust reference (`sparkjsdev/spark`, `rust/spark-lib/src/rad.rs`
 * and `splat_encode.rs`) since this project's worker has no Rust/WASM
 * toolchain - Spark's own decoder runs as WASM and writes into Spark's own
 * GPU texture layout, not this package's `SplatData`.
 *
 * Two entry points:
 * - {@link parseRad} flattens a whole file into leaf splats only (the original
 *   capture), for a small `.rad` loaded in one piece by `loadScene`.
 * - {@link parseRadChunkStreaming} decodes one chunk keeping *every* splat -
 *   the merged coarse LOD-tree nodes included - plus the per-splat tree
 *   columns, for the streamed reader (see `rad.ts`), which chooses the
 *   rendered cut across chunks at runtime.
 *
 * SH columns are repacked into the renderer's per-splat packed representation.
 */

export const RAD_MAGIC = 0x30444152; // 'RAD0' (LE)
export const RAD_CHUNK_MAGIC = 0x43444152; // 'RADC' (LE)

/**
 * Upper bound on an untrusted splat count that will size **one** buffer - a
 * whole-file decode or a single chunk. Mirrors `parse-sog.ts` MAX_SPLAT_COUNT:
 * the renderer cannot draw more than 2²⁴ splats from one pool texture anyway
 * (2048 wide × 8192 max height), so a hostile count is rejected rather than
 * ballooning into multi-gigabyte allocations.
 *
 * It deliberately does **not** bound a `.rad` header's `count`, which is the
 * whole LOD-tree node total of a capture meant to stream (53M nodes for a 37M-
 * leaf scene) and sizes nothing - see {@link parseRadHeaderMeta}.
 */
const MAX_RAD_SPLAT_COUNT = 1 << 24;

/** Asserts an untrusted RAD splat count is a safe non-negative integer. */
function assertRadCountInteger(count: number, what: string): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid RAD ${what} splat count: ${count}.`);
  }
}

/** Asserts a count that will size one buffer stays under the pool ceiling. */
function assertSaneRadCount(count: number, what: string): void {
  assertRadCountInteger(count, what);
  if (count > MAX_RAD_SPLAT_COUNT) {
    throw new Error(
      `RAD ${what} declares ${count} splats, above the supported maximum of ${MAX_RAD_SPLAT_COUNT}.`,
    );
  }
}

/** One chunk's location within a `.rad` file (or its external `.radc` name). */
export interface RadChunkRange {
  readonly offset: number;
  readonly bytes: number;
  readonly filename?: string;
}

/** The file-level `RAD0` metadata (a subset - only the fields we consume). */
export interface RadMeta {
  readonly version: number;
  readonly type: string;
  /** Total splats in the LOD tree (merged nodes + leaves). */
  readonly count: number;
  readonly maxSh?: number;
  readonly lodTree?: boolean;
  readonly chunkSize?: number;
  readonly chunks: readonly RadChunkRange[];
  /** Spark's free-form build-info JSON; carries `input_splat_count` (the leaf
   * count) among other fields. Parsed best-effort by the reader. */
  readonly comment?: string;
}

/** Per-splat LOD-tree links: an internal node's children are the contiguous
 * global-index range `[childStart, childStart + childCount)`. Leaves have
 * `childCount === 0`. */
export interface RadTree {
  readonly childCount: Uint16Array;
  readonly childStart: Uint32Array;
}

export interface RadChunkProperty {
  readonly offset: number;
  readonly bytes: number;
  readonly property: string;
  readonly encoding: string;
  readonly compression?: string;
  readonly min?: number;
  readonly max?: number;
}

interface RadChunkMeta {
  readonly version: number;
  readonly count: number;
  readonly lodTree?: boolean;
  readonly properties: readonly RadChunkProperty[];
}

interface DecodedChunk {
  readonly count: number;
  readonly lodTree: boolean;
  /** xyz, splat-major. */
  readonly center: Float32Array;
  readonly alpha: Float32Array;
  readonly rgb: Float32Array;
  readonly scale: Float32Array;
  /** xyzw, splat-major. */
  readonly quat: Float32Array;
  readonly childCount?: Uint16Array;
  readonly childStart?: Uint32Array;
  readonly shPacked?: SplatPackedShData;
  readonly shCodebook?: RadShCodebook;
}

/**
 * Decodes a `.rad` file, or a lone `.radc` chunk, into a flat `SplatData`
 * of leaf splats only (the original capture). Merged coarse LOD-tree nodes
 * are dropped - they exist for streamed reading, and are meaningless once
 * everything is already decoded into one buffer.
 *
 * @throws {Error} if the file is malformed, an unsupported version, carries
 * an external `.radc` chunk reference (one-shot loading needs every chunk in
 * the same buffer), or uses a property encoding this parser does not
 * recognize.
 */
export async function parseRad(buffer: ArrayBuffer): Promise<SplatData> {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 8) throw new Error('Truncated RAD file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);

  if (magic === RAD_CHUNK_MAGIC) {
    return mergeChunks([await decodeChunk(bytes, 0, true)]);
  }
  const { meta, chunksStart } = parseRadHeaderMeta(buffer);
  // One-shot folds the whole file into a single `SplatData` (one pool texture),
  // so the pool ceiling binds here - and only here. The streamed reader keeps a
  // budget-bounded resident set and has no such limit (see `buildRadScene`).
  if (meta.count > MAX_RAD_SPLAT_COUNT) {
    throw new Error(
      `RAD header declares ${meta.count} splats, above the supported maximum of ` +
        `${MAX_RAD_SPLAT_COUNT} for a one-shot decode; load this file as a streamed scene instead.`,
    );
  }
  const chunks: DecodedChunk[] = [];
  let shCodebook: RadShCodebook | undefined;
  let shExtent: number | undefined;
  for (const [index, range] of meta.chunks.entries()) {
    if (range.filename !== undefined) {
      throw new Error(
        `RAD chunk ${index} is an external .radc file ("${range.filename}"); one-shot ` +
          'loading only supports a single self-contained .rad file.',
      );
    }
    const start = chunksStart + range.offset;
    if (start + range.bytes > bytes.byteLength) {
      throw new Error(`RAD chunk ${index} extends past the file.`);
    }
    const chunk = await decodeChunk(bytes, start, true, shCodebook, shExtent);
    shCodebook ??= chunk.shCodebook;
    // Later chunks pack against the first SH chunk's range, so every chunk's
    // packed words share one scene range (see `decodeRadSh`).
    shExtent ??= chunk.shPacked?.range.max[0];
    chunks.push(chunk);
  }
  return mergeChunks(chunks);
}

/**
 * Parses just the `RAD0` header: the typed metadata and the byte offset where
 * the chunk stream begins. `buffer` need only be long enough to hold the
 * header - a ranged prefix of a large single-file `.rad` is enough.
 */
export function parseRadHeaderMeta(buffer: ArrayBuffer): { meta: RadMeta; chunksStart: number } {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 8) throw new Error('Truncated RAD file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== RAD_MAGIC) {
    throw new Error(`Not a RAD file (magic 0x${magic.toString(16).padStart(8, '0')}).`);
  }
  const length = view.getUint32(4, true);
  if (bytes.byteLength < 8 + length) throw new Error('Truncated RAD header.');
  const meta = JSON.parse(decodeUtf8(bytes, 8, length)) as RadMeta;
  if (meta.version !== 1) throw new Error(`Unsupported RAD version ${meta.version}.`);
  if (meta.type !== 'gsplat') throw new Error(`Unsupported RAD type "${meta.type}".`);
  assertRadCountInteger(meta.count, 'header');
  if (!Array.isArray(meta.chunks)) throw new Error('RAD header is missing its chunk list.');
  // `Array.isArray` narrows a `readonly T[]` to `any[]`; restore the declared
  // element type before touching members.
  const chunkRanges: readonly RadChunkRange[] = meta.chunks;
  for (const [index, range] of chunkRanges.entries()) {
    if (
      !Number.isSafeInteger(range?.offset) ||
      range.offset < 0 ||
      !Number.isSafeInteger(range?.bytes) ||
      range.bytes < 0
    ) {
      throw new Error(`RAD chunk ${index} declares an invalid byte range.`);
    }
  }
  // `count` is the whole LOD-tree node total and sizes nothing here (every
  // buffer downstream is per-chunk), so the pool ceiling would wrongly reject a
  // large streamed capture. Bound it structurally instead: no more splats than
  // the declared chunk table can physically hold.
  if (meta.chunkSize !== undefined) {
    if (
      !Number.isSafeInteger(meta.chunkSize) ||
      meta.chunkSize <= 0 ||
      meta.chunkSize > MAX_RAD_SPLAT_COUNT
    ) {
      throw new Error(`Invalid RAD chunk size: ${meta.chunkSize}.`);
    }
    if (meta.count > meta.chunkSize * chunkRanges.length) {
      throw new Error(
        `RAD header declares ${meta.count} splats, more than its ${chunkRanges.length} chunks of ` +
          `${meta.chunkSize} can hold.`,
      );
    }
  }
  return { meta, chunksStart: 8 + roundup8(length) };
}

/**
 * Decodes one chunk (a `RADC`-magic byte range) into a `SplatData` holding
 * **every** splat in the chunk - internal LOD-tree nodes and leaves alike -
 * plus the per-splat tree columns when the file carries a LOD tree. The
 * streamed reader keeps all splats resident and chooses the rendered cut
 * itself from {@link SplatData.radTree}.
 *
 * @throws {Error} on a malformed chunk or an unrecognized property encoding.
 */
export async function parseRadChunkStreaming(
  buffer: ArrayBuffer,
  shCodebook?: RadShCodebook,
  shExtent?: number,
  reorder = true,
): Promise<SplatData> {
  const chunk = await decodeChunk(new Uint8Array(buffer), 0, true, shCodebook, shExtent);
  return chunkToSplatData(chunk, reorder);
}

/**
 * Builds a `SplatData` for every splat of a decoded chunk.
 *
 * For a LOD chunk the splats are reordered by descending "frontier key" -
 * leaves first, then internal nodes by `child_start` descending. The streamed
 * reader draws a splat when it is a leaf or its children are beyond the
 * resident prefix (`child_start ≥ residentCount`); with this order the drawn
 * splats of any chunk are always a contiguous **prefix**, so the frontier
 * coalesces into one run per chunk instead of thousands of fragments. The
 * reorder is safe because it never moves a splat's children out of their
 * chunk, and the reader only threshold-tests `child_start`, never follows it.
 */
function chunkToSplatData(chunk: DecodedChunk, reorder: boolean): SplatData {
  const { count } = chunk;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);

  if (!chunk.childCount || !chunk.childStart) {
    for (let i = 0; i < count; i++) writeSplat(chunk, i, i, positions, colors, covariances);
    return {
      count,
      positions,
      colors,
      covariances,
      ...(chunk.shPacked ? { shPacked: chunk.shPacked } : {}),
      ...(chunk.shCodebook ? { radShCodebook: chunk.shCodebook } : {}),
    };
  }

  const childCount = chunk.childCount;
  const childStart = chunk.childStart;
  // The prefix reader needs leaves-first ordering to coalesce its frontier into
  // one run per chunk; the foveation reader keeps file order so `child_start`
  // stays valid for parent-size propagation (it renders whole chunks and lets
  // the GPU cull pick the cut per splat).
  const order = reorder ? frontierOrder(childCount, childStart, count) : identityOrder(count);
  const reorderedSh = reorderPackedSh(chunk.shPacked, order);
  const outCount = new Uint16Array(count);
  const outStart = new Uint32Array(count);
  const outSize = new Float32Array(count);
  for (let j = 0; j < count; j++) {
    const src = order[j] as number;
    writeSplat(chunk, src, j, positions, colors, covariances);
    outCount[j] = childCount[src] as number;
    outStart[j] = childStart[src] as number;
    outSize[j] = radNodeSize(chunk.alpha[src] as number, chunk.scale, src);
  }
  return {
    count,
    positions,
    colors,
    covariances,
    radTree: { childCount: outCount, childStart: outStart, size: outSize },
    ...(reorderedSh ? { shPacked: reorderedSh } : {}),
    ...(chunk.shCodebook ? { radShCodebook: chunk.shCodebook } : {}),
  };
}

/**
 * Spark's merged-node size-expansion factor: 1 for leaves (`alpha ≤ 1`), up to
 * 3.8 at `alpha = 2`. A merged node's `alpha ∈ (1,2]` encodes coverage
 * expansion - how much to enlarge the node so it covers its subtree - not
 * opacity. Spark's renderer applies it to the rendered gaussian; so do we (in
 * `writeSplat`). The LOD cut uses a steeper authored size - see
 * {@link radNodeSize}.
 */
function radExpansion(alpha: number): number {
  return alpha <= 1 ? 1 : 1 + 0.7 * (alpha * 4 - 4);
}

/**
 * A LOD node's world-space size, matching Spark's `encode_lod_tree`
 * (`splat_encode.rs`): `2 · (max(alpha,1)·4 − 3) · avg(scale)`. This is the
 * size Spark's traversal compares against `pixel_scale_limit`, and it is
 * **steeper** than the rendered covariance expansion ({@link radExpansion}'s
 * `1 + 0.7·(4α−4)`, ≤3.8): at `alpha = 2` the traversal size factor is 5.
 * Using the render curve here made every merged node look 24–32% smaller to
 * the cut than to Spark's, so the descent stopped ~one LOD level early -
 * large-scale scenes rendered visibly coarser (streaky merged nodes) than
 * Spark at the same limit and budget.
 */
function radNodeSize(alpha: number, scale: Float32Array, i: number): number {
  const avg =
    ((scale[i * 3] as number) + (scale[i * 3 + 1] as number) + (scale[i * 3 + 2] as number)) / 3;
  return 2 * (Math.max(alpha, 1) * 4 - 3) * avg;
}

/** The trivial permutation - splats stay in file order (foveation path). */
function identityOrder(count: number): Uint32Array {
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  return order;
}

/** Splat indices sorted by descending frontier key (leaves before internal
 * nodes; internal nodes by `child_start` descending). */
function frontierOrder(
  childCount: Uint16Array,
  childStart: Uint32Array,
  count: number,
): Uint32Array {
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  // Leaves sort ahead of every internal node; among internal nodes, the ones
  // whose children lie deepest (largest child_start) survive in the frontier
  // longest, so they come first.
  const key = (i: number): number =>
    childCount[i] === 0 ? Number.MAX_SAFE_INTEGER : (childStart[i] as number);
  return order.sort((a, b) => key(b) - key(a));
}

/** Decodes one `RADC`-magic chunk starting at `chunkStart` within `bytes`. */
async function decodeChunk(
  bytes: Uint8Array,
  chunkStart: number,
  withTree: boolean,
  knownShCodebook?: RadShCodebook,
  knownShExtent?: number,
): Promise<DecodedChunk> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(chunkStart, true);
  if (magic !== RAD_CHUNK_MAGIC) {
    throw new Error(`Not a RAD chunk (magic 0x${magic.toString(16).padStart(8, '0')}).`);
  }
  const length = view.getUint32(chunkStart + 4, true);
  const metaEnd = chunkStart + 8 + roundup8(length);
  const chunkMeta = JSON.parse(decodeUtf8(bytes, chunkStart + 8, length)) as RadChunkMeta;
  if (chunkMeta.version !== 1) {
    throw new Error(`Unsupported RAD chunk version ${chunkMeta.version}.`);
  }
  const payloadBytes = Number(view.getBigUint64(metaEnd, true));
  const payloadStart = metaEnd + 8;
  if (payloadStart + payloadBytes > bytes.byteLength) {
    throw new Error('RAD chunk payload extends past the file.');
  }
  const { count } = chunkMeta;
  assertSaneRadCount(count, 'chunk');
  const lodTree = chunkMeta.lodTree ?? false;

  if (!Array.isArray(chunkMeta.properties)) {
    throw new Error('RAD chunk metadata is missing its property list.');
  }
  // `Array.isArray` narrows a `readonly T[]` to `any[]`; restore the declared
  // element type before touching members.
  const properties: readonly RadChunkProperty[] = chunkMeta.properties;
  const byName = new Map(properties.map((prop) => [prop.property, prop]));
  const readProp = async (name: string): Promise<Uint8Array | undefined> => {
    const prop = byName.get(name);
    if (!prop) return undefined;
    if (
      !Number.isSafeInteger(prop.offset) ||
      prop.offset < 0 ||
      !Number.isSafeInteger(prop.bytes) ||
      prop.bytes < 0
    ) {
      throw new Error(`RAD property "${name}" declares an invalid byte range.`);
    }
    const start = payloadStart + prop.offset;
    if (prop.offset + prop.bytes > payloadBytes || start + prop.bytes > bytes.byteLength) {
      throw new Error(`RAD property "${name}" extends past its chunk.`);
    }
    const raw = bytes.subarray(start, start + prop.bytes);
    return prop.compression === undefined ? raw : decompressColumn(raw);
  };

  const wantTree = withTree && lodTree;
  const propertyNames: readonly (string | undefined)[] = [
    'center',
    'alpha',
    'rgb',
    'scales',
    'orientation',
    ...(wantTree ? ['child_count', 'child_start'] : [undefined, undefined]),
    'sh1',
    'sh2',
    'sh3',
    'sh_label',
    'sh1_code',
    'sh2_code',
    'sh3_code',
  ];
  const [
    centerRaw,
    alphaRaw,
    rgbRaw,
    scaleRaw,
    orientationRaw,
    childCountRaw,
    childStartRaw,
    sh1Raw,
    sh2Raw,
    sh3Raw,
    shLabelRaw,
    sh1CodeRaw,
    sh2CodeRaw,
    sh3CodeRaw,
  ] = await Promise.all(
    propertyNames.map((name) => (name === undefined ? Promise.resolve(undefined) : readProp(name))),
  );
  if (!centerRaw) throw new Error('RAD chunk is missing its "center" property.');
  if (!alphaRaw) throw new Error('RAD chunk is missing its "alpha" property.');
  if (!rgbRaw) throw new Error('RAD chunk is missing its "rgb" property.');
  if (!scaleRaw) throw new Error('RAD chunk is missing its "scales" property.');
  if (!orientationRaw) throw new Error('RAD chunk is missing its "orientation" property.');

  return {
    count,
    lodTree,
    center: decodeFloatColumn(centerRaw, byName.get('center')!, 3, count),
    alpha: decodeFloatColumn(alphaRaw, byName.get('alpha')!, 1, count),
    rgb: decodeFloatColumn(rgbRaw, byName.get('rgb')!, 3, count),
    scale: decodeFloatColumn(scaleRaw, byName.get('scales')!, 3, count),
    quat: decodeOrientation(orientationRaw, byName.get('orientation')!, count),
    ...(wantTree && childCountRaw
      ? { childCount: decodeChildCount(childCountRaw, byName.get('child_count')!, count) }
      : {}),
    ...(wantTree && childStartRaw
      ? { childStart: decodeChildStart(childStartRaw, byName.get('child_start')!, count) }
      : {}),
    ...decodeRadSh({
      count,
      byName,
      sh1Raw,
      sh2Raw,
      sh3Raw,
      shLabelRaw,
      sh1CodeRaw,
      sh2CodeRaw,
      sh3CodeRaw,
      knownShCodebook,
      knownShExtent,
    }),
  };
}

/**
 * Flattens decoded chunks into leaf splats only: internal LOD-tree nodes
 * (`childCount > 0`) are merged approximations of their children and are
 * dropped, same as loading only the finest level of any other LOD format.
 */
function mergeChunks(chunks: readonly DecodedChunk[]): SplatData {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.childCount ? countLeaves(chunk.childCount) : chunk.count;
  }
  if (total === 0) throw new Error('RAD file has no leaf splats.');

  const positions = new Float32Array(total * 3);
  const colors = new Uint8Array(total * 4);
  const covariances = new Float32Array(total * 6);
  const sourceSh = chunks.find((chunk) => chunk.shPacked)?.shPacked;
  const packed = sourceSh ? new Uint32Array(total * shCoefficientCount(sourceSh.bands)) : undefined;
  // A splat from an SH-less chunk must encode "0.0", not word 0 (which
  // decodes to the range minimum). In practice Spark writes SH columns to
  // every chunk when the scene has SH, so this is belt-and-braces.
  if (packed && sourceSh) packed.fill(neutralShWord(sourceSh.range));

  let out = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.count; i++) {
      if (chunk.childCount && chunk.childCount[i] !== 0) continue; // internal node
      writeSplat(chunk, i, out, positions, colors, covariances);
      if (packed && chunk.shPacked) {
        const words = shCoefficientCount(sourceSh!.bands);
        packed.set(chunk.shPacked.packed.subarray(i * words, (i + 1) * words), out * words);
      }
      out++;
    }
  }

  return {
    count: total,
    positions,
    colors,
    covariances,
    ...(sourceSh && packed ? { shPacked: { ...sourceSh, packed } } : {}),
  };
}

function reorderPackedSh(
  sh: SplatPackedShData | undefined,
  order: Uint32Array,
): SplatPackedShData | undefined {
  if (!sh) return undefined;
  const words = shCoefficientCount(sh.bands);
  const packed = new Uint32Array(sh.packed.length);
  for (let dst = 0; dst < order.length; dst++) {
    const src = order[dst] as number;
    packed.set(sh.packed.subarray(src * words, (src + 1) * words), dst * words);
  }
  return { ...sh, packed };
}

interface RadShInputs {
  readonly count: number;
  readonly byName: ReadonlyMap<string, RadChunkProperty>;
  readonly sh1Raw?: Uint8Array;
  readonly sh2Raw?: Uint8Array;
  readonly sh3Raw?: Uint8Array;
  readonly shLabelRaw?: Uint8Array;
  readonly sh1CodeRaw?: Uint8Array;
  readonly sh2CodeRaw?: Uint8Array;
  readonly sh3CodeRaw?: Uint8Array;
  readonly knownShCodebook?: RadShCodebook;
  readonly knownShExtent?: number;
}

/**
 * Decodes Spark's direct columns or its chunk-zero codebook and labels.
 *
 * The quantization range must be the same for every chunk of a file - the
 * shared pool decodes all chunks against one scene range - so the extent is
 * never measured from a lone chunk's values if a chunk-invariant source
 * exists: the column metadata range (Spark encodes every chunk against
 * scene-global per-band maxima), the codebook (stored once, in chunk zero),
 * or the extent already established by an earlier chunk (`knownShExtent`).
 */
function decodeRadSh(input: RadShInputs): Pick<DecodedChunk, 'shPacked' | 'shCodebook'> {
  const direct = [input.sh1Raw, input.sh2Raw, input.sh3Raw];
  const code = [input.sh1CodeRaw, input.sh2CodeRaw, input.sh3CodeRaw];
  const directBands = direct.reduce((bands, raw, index) => (raw ? index + 1 : bands), 0);
  const codeBands = code.reduce((bands, raw, index) => (raw ? index + 1 : bands), 0);
  if (directBands === 0 && codeBands === 0 && !input.shLabelRaw) return {};
  if (directBands > 0 && codeBands > 0)
    throw new Error('RAD chunk mixes direct and codebook SH columns.');

  let coefficients: Float32Array;
  let bands: 1 | 2 | 3;
  let codebook: RadShCodebook | undefined;
  let extent: number | undefined;
  if (directBands > 0) {
    bands = directBands as 1 | 2 | 3;
    coefficients = combineShColumns(direct, input.byName, input.count, bands);
    extent = metadataShExtent(input.byName, bands) ?? input.knownShExtent;
  } else {
    codebook = input.knownShCodebook;
    if (!codebook && codeBands > 0) {
      bands = codeBands as 1 | 2 | 3;
      const codeCount = shColumnCount(
        code[codeBands - 1]!,
        input.byName.get(`sh${codeBands}_code`)!,
      );
      codebook = {
        bands,
        count: codeCount,
        coefficients: combineShColumns(code, input.byName, codeCount, bands, '_code'),
      };
    }
    if (!codebook) throw new Error('RAD SH labels require the codebook stored in chunk zero.');
    if (!input.shLabelRaw)
      throw new Error('RAD SH codebook chunk is missing its "sh_label" property.');
    bands = codebook.bands;
    const labels = decodeShLabels(input.shLabelRaw, input.byName.get('sh_label')!, input.count);
    coefficients = new Float32Array(input.count * shCoefficientCount(bands) * 3);
    const words = shCoefficientCount(bands) * 3;
    for (let i = 0; i < input.count; i++) {
      const label = labels[i] as number;
      if (label >= codebook.count)
        throw new Error(`RAD SH label ${label} exceeds its ${codebook.count}-entry codebook.`);
      coefficients.set(
        codebook.coefficients.subarray(label * words, (label + 1) * words),
        i * words,
      );
    }
    // The codebook is whole-scene, so its extent is the same whichever chunk
    // computes it - unlike the extent of one chunk's referenced entries.
    extent = 0;
    for (const value of codebook.coefficients) extent = Math.max(extent, Math.abs(value));
  }
  return {
    shPacked: packShCoefficients(coefficients, input.count, bands, extent),
    ...(codebook ? { shCodebook: codebook } : {}),
  };
}

/**
 * The scene-global SH extent recorded in the column metadata, when every band
 * is stored quantized. Spark computes one `shN_max` per band over the whole
 * scene and encodes every chunk against it (`rad.rs`), so these ranges are
 * chunk-invariant. Raw-float columns (`f32`/`f16`/`*_lebytes`) carry no range
 * - returns undefined and the caller falls back to a measured extent.
 */
function metadataShExtent(
  byName: ReadonlyMap<string, RadChunkProperty>,
  bands: 1 | 2 | 3,
  suffix = '',
): number | undefined {
  let extent = 0;
  for (let band = 1; band <= bands; band++) {
    const prop = byName.get(`sh${band}${suffix}`);
    if (!prop) return undefined;
    let bandExtent: number;
    switch (prop.encoding) {
      case 's8':
      case 's8_delta':
        if (prop.max === undefined) return undefined;
        bandExtent = Math.abs(prop.max);
        break;
      case 'r8':
      case 'r8_delta':
        if (prop.min === undefined || prop.max === undefined) return undefined;
        bandExtent = Math.max(Math.abs(prop.min), Math.abs(prop.max));
        break;
      default:
        return undefined;
    }
    extent = Math.max(extent, bandExtent);
  }
  return extent;
}

/** Interleaves the per-band columns into one splat-major array: splat `i`
 * holds its band-1, band-2, band-3 coefficient triples contiguously, the
 * order `packSh` and the codebook expansion consume. */
function combineShColumns(
  raws: readonly (Uint8Array | undefined)[],
  byName: ReadonlyMap<string, RadChunkProperty>,
  count: number,
  bands: 1 | 2 | 3,
  suffix = '',
): Float32Array {
  const totalCoefficients = shCoefficientCount(bands);
  const result = new Float32Array(count * totalCoefficients * 3);
  let coefficientOffset = 0;
  for (let band = 1; band <= bands; band++) {
    const raw = raws[band - 1];
    const prop = byName.get(`sh${band}${suffix}`);
    if (!raw || !prop) throw new Error(`RAD SH is missing its "sh${band}${suffix}" column.`);
    const dims = band === 1 ? 9 : band === 2 ? 15 : 21;
    const values = decodeFloatColumn(raw, prop, dims, count);
    for (let i = 0; i < count; i++) {
      const base = (i * totalCoefficients + coefficientOffset) * 3;
      for (let k = 0; k < dims; k++) result[base + k] = values[i * dims + k] as number;
    }
    coefficientOffset += dims / 3;
  }
  return result;
}

function shColumnCount(raw: Uint8Array, prop: RadChunkProperty): number {
  const dimensions = prop.property.startsWith('sh1')
    ? 9
    : prop.property.startsWith('sh2')
      ? 15
      : 21;
  const bytesPerValue = shEncodingBytes(prop);
  if (raw.byteLength % (dimensions * bytesPerValue) !== 0)
    throw new Error(`RAD "${prop.property}" has an invalid SH column length.`);
  return raw.byteLength / (dimensions * bytesPerValue);
}

/** Bytes per decoded value of an SH column's encoding. */
function shEncodingBytes(prop: RadChunkProperty): number {
  switch (prop.encoding) {
    case 'f32':
    case 'f32_lebytes':
      return 4;
    case 'f16':
    case 'f16_lebytes':
    case 'ln_f16':
      return 2;
    case 'r8':
    case 'r8_delta':
    case 's8':
    case 's8_delta':
    case 'ln_0r8':
      return 1;
    default:
      throw new Error(`Unsupported RAD "${prop.property}" encoding "${prop.encoding}".`);
  }
}

function decodeShLabels(raw: Uint8Array, prop: RadChunkProperty, count: number): Uint32Array {
  if (prop.encoding === 'u16') {
    assertColumnHoldsCount(raw, prop, 1, count, 2);
    return Uint32Array.from(decodeU16(raw, count));
  }
  if (prop.encoding === 'u32') {
    assertColumnHoldsCount(raw, prop, 1, count, 4);
    return decodeU32(raw, count);
  }
  throw new Error(`Unsupported RAD sh_label encoding "${prop.encoding}".`);
}

/** Writes splat `src` of a decoded chunk into slot `dst` of the output arrays. */
function writeSplat(
  chunk: DecodedChunk,
  src: number,
  dst: number,
  positions: Float32Array,
  colors: Uint8Array,
  covariances: Float32Array,
): void {
  // Spark's LOD alpha encoding: store `alpha / 2` in the 8-bit channel so the
  // shader (`×2`) recovers `alpha ∈ [0, 2]`. A leaf's opacity is `≤ 1`; a merged
  // node's `alpha ∈ (1, 2]` is a size marker (not opacity) - the material grows
  // that splat's σ-cutoff and reshapes its falloff to cover its subtree, rather
  // than scaling the covariance (which over-inflates and blurs). The covariance
  // is therefore the raw fitted shape for every splat.
  const alpha = chunk.alpha[src] as number;
  positions[dst * 3 + 0] = chunk.center[src * 3 + 0] as number;
  positions[dst * 3 + 1] = chunk.center[src * 3 + 1] as number;
  positions[dst * 3 + 2] = chunk.center[src * 3 + 2] as number;
  colors[dst * 4 + 0] = clampByte((chunk.rgb[src * 3 + 0] as number) * 255);
  colors[dst * 4 + 1] = clampByte((chunk.rgb[src * 3 + 1] as number) * 255);
  colors[dst * 4 + 2] = clampByte((chunk.rgb[src * 3 + 2] as number) * 255);
  colors[dst * 4 + 3] = clampByte(alpha * 0.5 * 255);
  writeCovariance(
    covariances,
    dst,
    chunk.scale[src * 3 + 0] as number,
    chunk.scale[src * 3 + 1] as number,
    chunk.scale[src * 3 + 2] as number,
    chunk.quat[src * 4 + 3] as number, // w
    chunk.quat[src * 4 + 0] as number, // x
    chunk.quat[src * 4 + 1] as number, // y
    chunk.quat[src * 4 + 2] as number, // z
  );
}

function countLeaves(childCount: Uint16Array): number {
  let leaves = 0;
  for (const value of childCount) if (value === 0) leaves++;
  return leaves;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function roundup8(size: number): number {
  return (size + 7) & ~7;
}

function decodeUtf8(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder().decode(bytes.subarray(offset, offset + length));
}

/**
 * Spark compresses each property column with `miniz_oxide::deflate`, which
 * produces a raw DEFLATE stream (no zlib/gzip wrapper) despite the format
 * metadata calling it `"gz"`. Bytes are sniffed rather than trusted, so a
 * future Spark version that switches to a real gzip/zlib wrapper still decodes.
 */
async function decompressColumn(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This runtime does not provide decompression required for RAD files.');
  }
  const format: CompressionFormat =
    bytes[0] === 0x1f && bytes[1] === 0x8b ? 'gzip' : bytes[0] === 0x78 ? 'deflate' : 'deflate-raw';
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
