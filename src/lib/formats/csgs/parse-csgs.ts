/**
 * Faltwerk `.csgs` (CurveStream-GS) section decoder, version 1.
 *
 * A `.csgs` stream is a sequence of keyed sections of `nframes` frames (32 in
 * practice). Every splat alive in a section carries one piecewise-linear
 * ("hat") curve per attribute group - position `P`, rotation `R`, log-scale
 * `S`, opacity logit `O` and DC color `D` - with 1 to `max(ks)` knots, plus 45
 * static higher-order SH scalars (`sn`). Key sections stand alone; delta
 * sections continue the splats the previous section left alive, so decoding
 * must start at a key section.
 *
 * This is a port of the version-1 path of Faltwerk's TypeScript decoder (MIT,
 * `web/src/csgs.ts` in that repository, see `THIRD_PARTY_NOTICES.md`). Later
 * container versions (SH codebooks, motion prediction, follow masks, per-section
 * requantization, B-spline knots) are rejected with a clear error. All knot and
 * SH values stay the integers the encoder produced, so the arrays can be checked
 * bit-for-bit against the reference decoder; dequantization happens in
 * `csgs-frame.ts`.
 */
import { CSGS_RANS_TOKENS, CsgsAdaptiveModel, CsgsRansDecoder } from './csgs-rans';

const MAGIC = [0x43, 0x53, 0x47, 0x53] as const; // "CSGS"
const VERSION_1 = 1;
const FLAG_KEY = 1;
const FLAG_SHARED_KNOT = 2;
/** Flags that need a container version this decoder does not implement. */
const UNSUPPORTED_FLAGS = 4 | 8 | 16 | 32 | 64;
/** Fixed stream slots before the per-group knot streams. */
const STREAM_BIRTH = 0;
const STREAM_DEATH = 1;
const STREAM_IDS = 2;
const STREAM_K = 3;
/** SH scalars are coded in RGB triples; the context of a scalar is its predecessor one triple back. */
const SN_CHANNELS = 3;
/** Upper bound on the splat count a header may declare before any allocation. */
const MAX_SECTION_SPLATS = 1 << 25;

/** Attribute group tag and its dimensionality, in coding order. */
export type CsgsGroup = readonly [tag: string, dims: number];

/** Quantization table and coding parameters shared by the sections of a stream. */
export interface CsgsParams {
  /** Frames per full section. */
  readonly L: number;
  /** Allowed knot counts per curve, ascending. */
  readonly ks: readonly number[];
  readonly groups: readonly CsgsGroup[];
  /** Static SH scalars per splat (45 for degree 3). */
  readonly nSn: number;
  /** Dequantization offset per scalar: groups in order, then the SH scalars. */
  readonly offsets: Float32Array;
  /** Dequantization step per scalar, same layout as {@link offsets}. */
  readonly scales: Float32Array;
  /** Continuing splats reuse the previous section's last knot as knot 0 verbatim. */
  readonly sharedKnot: boolean;
  readonly keyInterval: number;
}

/** One decoded section, integer-valued as coded. */
export interface CsgsSection {
  readonly index: number;
  /** First absolute frame of the section. */
  readonly g0: number;
  readonly nframes: number;
  readonly key: boolean;
  /** Splats coded in this section: the continuing ones first, then the newborn. */
  readonly n: number;
  readonly nCont: number;
  readonly ids: Uint32Array;
  /** Birth frame of each newborn splat, relative to `g0` (`n - nCont` entries). */
  readonly birth: Uint16Array;
  /** Death code per splat: the relative frame it disappears, or `nframes + 1` when it continues. */
  readonly death: Uint16Array;
  /** Knot count per splat, per group. */
  readonly k: readonly Uint8Array[];
  /** Start of each splat's knots in {@link knots}, per group (`n + 1` entries). */
  readonly knotOff: readonly Uint32Array[];
  /** Quantized knots per group, knot-major per splat (`K × dims` integers each). */
  readonly knots: readonly Int32Array[];
  /** Quantized SH scalars, `n × nSn` bytes. */
  readonly sn: Uint8Array;
}

/** What a delta section needs from the section before it. */
export interface CsgsState {
  readonly ids: Uint32Array;
  /** Last knot of every continuing splat, per group. */
  readonly last: readonly Int32Array[];
  readonly sn: Uint8Array;
  /** Index into `ks` of each continuing splat's first-group knot count. */
  readonly k0: Uint8Array;
  readonly nextIndex: number;
}

interface CsgsHeader {
  readonly key: boolean;
  readonly index: number;
  readonly g0: number;
  readonly nframes: number;
  readonly nCont: number;
  readonly nNew: number;
  readonly idBase: number;
  /** Prediction baseline of each SH scalar. */
  readonly snPred: Uint8Array;
}

/** Zlib/PNG CRC-32 over `bytes[start, end)`. */
export function csgsCrc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] as number;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function unsupported(what: string): Error {
  return new Error(`CSGS: ${what} is not supported (version 1 streams only).`);
}

/**
 * Parses a section header, validating it against the version-1 layout.
 *
 * @returns The stream params and header, the byte length of each rANS stream,
 * and the offset of the first stream.
 */
export function parseCsgsHeader(bytes: Uint8Array): {
  params: CsgsParams;
  header: CsgsHeader;
  streamLengths: number[];
  streamsOffset: number;
} {
  if (bytes.length < 40 || MAGIC.some((byte, i) => bytes[i] !== byte)) {
    throw new Error('CSGS: not a .csgs section.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 4;
  const version = bytes[o++] as number;
  const flags = bytes[o++] as number;
  if (version !== VERSION_1) throw unsupported(`container version ${version}`);
  if ((flags & UNSUPPORTED_FLAGS) !== 0) throw unsupported(`flags 0x${flags.toString(16)}`);
  if ((flags & ~(FLAG_KEY | FLAG_SHARED_KNOT)) !== 0) {
    throw new Error(`CSGS: unknown flags 0x${flags.toString(16)}.`);
  }
  const index = view.getUint32(o, true);
  const g0 = view.getUint32(o + 4, true);
  const L = view.getUint16(o + 8, true);
  const nframes = view.getUint16(o + 10, true);
  const nCont = view.getUint32(o + 12, true);
  const nNew = view.getUint32(o + 16, true);
  const idBase = view.getUint32(o + 20, true);
  const keyInterval = bytes[o + 24] as number;
  const groupCount = bytes[o + 25] as number;
  o += 26;
  const groups: CsgsGroup[] = [];
  for (let g = 0; g < groupCount; g++) {
    groups.push([String.fromCharCode(bytes[o] as number), bytes[o + 1] as number]);
    o += 2;
  }
  const knotCountCount = bytes[o++] as number;
  const ks = Array.from(bytes.subarray(o, o + knotCountCount));
  o += knotCountCount;
  const nSn = view.getUint16(o, true);
  o += 2;
  const snPred = bytes.slice(o, o + nSn);
  o += nSn;
  const scalarCount = groups.reduce((sum, [, dims]) => sum + dims, 0) + nSn;
  const offsets = new Float32Array(scalarCount);
  const scales = new Float32Array(scalarCount);
  for (let i = 0; i < scalarCount; i++, o += 4) offsets[i] = view.getFloat32(o, true);
  for (let i = 0; i < scalarCount; i++, o += 4) scales[i] = view.getFloat32(o, true);
  const streamCount = bytes[o++] as number;
  const streamLengths: number[] = [];
  for (let i = 0; i < streamCount; i++, o += 4) streamLengths.push(view.getUint32(o, true));
  if (L < 1 || L > 253 || nframes < 1 || nframes > L) throw new Error('CSGS: bad section length.');
  if (ks.length === 0 || ks.some((k, i) => k < 1 || (i > 0 && k <= (ks[i - 1] as number)))) {
    throw new Error('CSGS: knot counts must be ascending and at least 1.');
  }
  if (groups.length === 0 || groups.some(([, dims]) => dims < 1)) {
    throw new Error('CSGS: every attribute group needs at least one dimension.');
  }
  if (nCont + nNew > MAX_SECTION_SPLATS) throw new Error('CSGS: section splat count too large.');
  const params: CsgsParams = {
    L,
    ks,
    groups,
    nSn,
    offsets,
    scales,
    sharedKnot: (flags & FLAG_SHARED_KNOT) !== 0,
    keyInterval,
  };
  const header: CsgsHeader = {
    key: (flags & FLAG_KEY) !== 0,
    index,
    g0,
    nframes,
    nCont,
    nNew,
    idBase,
    snPred,
  };
  return { params, header, streamLengths, streamsOffset: o };
}

/** The adaptive models of one section; every section starts from fresh counts. */
class SectionModels {
  readonly birth: CsgsAdaptiveModel[];
  readonly death: [CsgsAdaptiveModel, CsgsAdaptiveModel];
  readonly ids: CsgsAdaptiveModel;
  /** `[group][previous knot-count index]` (the extra last context = "no predecessor"). */
  readonly k: CsgsAdaptiveModel[][];
  /** `[group][residual | absolute][dim]` models of knot 0. */
  readonly first: CsgsAdaptiveModel[][][];
  /** `[group][knot-count index][dim][bucket]` models of the knot differences. */
  readonly diff: CsgsAdaptiveModel[][][][];
  /** `[scalar][bucket]` models of the SH residuals. */
  readonly sn: CsgsAdaptiveModel[][];

  constructor(params: CsgsParams, nframes: number) {
    const knotCounts = params.ks.length;
    const universal = () => new CsgsAdaptiveModel(CSGS_RANS_TOKENS);
    this.birth = Array.from({ length: nframes }, () => new CsgsAdaptiveModel(nframes));
    this.death = [new CsgsAdaptiveModel(params.L + 2), new CsgsAdaptiveModel(params.L + 2)];
    this.ids = universal();
    this.k = params.groups.map(() =>
      Array.from({ length: knotCounts + 1 }, () => new CsgsAdaptiveModel(knotCounts)),
    );
    this.first = params.groups.map(([, dims]) =>
      [0, 1].map(() => Array.from({ length: dims }, universal)),
    );
    this.diff = params.groups.map(([, dims]) =>
      Array.from({ length: knotCounts }, () =>
        Array.from({ length: dims }, () => Array.from({ length: 4 }, universal)),
      ),
    );
    this.sn = Array.from({ length: params.nSn }, () => Array.from({ length: 6 }, universal));
  }
}

/** Context bucket of a knot difference: its predecessor's magnitude. */
function diffBucket(value: number): number {
  const magnitude = value < 0 ? -value : value;
  return magnitude >= 2 ? 3 : magnitude + 1;
}

/** Context bucket of an SH residual: the magnitude of the previous coefficient's residual. */
function snBucket(value: number): number {
  const magnitude = value < 0 ? -value : value;
  if (magnitude <= 2) return magnitude;
  if (magnitude <= 4) return 3;
  return magnitude <= 8 ? 4 : 5;
}

function assertConsumed(decoder: CsgsRansDecoder, stream: string): void {
  if (!decoder.consumed) throw new Error(`CSGS: ${stream} stream was not consumed exactly.`);
}

/**
 * Decodes one section. A delta section (`key` flag clear) needs the
 * {@link CsgsState} left by the section before it.
 *
 * @throws {Error} on a CRC mismatch, a malformed or unsupported header, a stream
 * table that does not match the section size, or a delta section whose state
 * does not match.
 */
export function decodeCsgsSection(
  bytes: Uint8Array,
  state: CsgsState | null,
): { params: CsgsParams; section: CsgsSection } {
  if (bytes.length < 8) throw new Error('CSGS: section too short.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (csgsCrc32(bytes, 0, bytes.length - 4) !== view.getUint32(bytes.length - 4, true)) {
    throw new Error('CSGS: CRC mismatch.');
  }
  const { params, header, streamLengths, streamsOffset } = parseCsgsHeader(bytes);
  const { key, nCont, nNew, nframes } = header;
  const groupCount = params.groups.length;
  const streamTotal = streamLengths.reduce((sum, length) => sum + length, 0);
  if (streamLengths.length !== 5 + groupCount || streamsOffset + streamTotal + 4 !== bytes.length) {
    throw new Error('CSGS: stream table does not match the section size.');
  }
  if (!key && (state === null || nCont !== state.ids.length)) {
    throw new Error('CSGS: delta section does not continue the decoder state.');
  }
  const n = nCont + nNew;
  const models = new SectionModels(params, nframes);
  const streamStarts: number[] = [];
  let offset = streamsOffset;
  for (const length of streamLengths) {
    streamStarts.push(offset);
    offset += length;
  }
  const stream = (i: number) => {
    const start = streamStarts[i] as number;
    return new CsgsRansDecoder(bytes, start, start + (streamLengths[i] as number));
  };

  let decoder = stream(STREAM_BIRTH);
  const birth = new Uint16Array(nNew);
  let previousBirth = 0;
  for (let i = 0; i < nNew; i++) {
    previousBirth = decoder.get(models.birth[previousBirth] as CsgsAdaptiveModel);
    birth[i] = previousBirth;
  }
  assertConsumed(decoder, 'birth');

  decoder = stream(STREAM_DEATH);
  const death = new Uint16Array(n);
  for (let i = 0; i < n; i++) death[i] = decoder.get(models.death[i < nCont ? 0 : 1]);
  assertConsumed(decoder, 'death');

  decoder = stream(STREAM_IDS);
  const ids = new Uint32Array(n);
  if (key) {
    let previous = 0;
    for (let i = 0; i < nCont; i++) {
      previous += decoder.getUint(models.ids);
      ids[i] = previous;
    }
  } else {
    ids.set((state as CsgsState).ids);
  }
  assertConsumed(decoder, 'ids');
  for (let i = 0; i < nNew; i++) ids[nCont + i] = header.idBase + i;

  decoder = stream(STREAM_K);
  const knotCounts = params.ks.length;
  const kIndex = params.groups.map(() => new Uint8Array(n));
  for (let i = 0; i < n; i++) {
    const context = !key && i < nCont ? ((state as CsgsState).k0[i] as number) : knotCounts;
    const first = decoder.get((models.k[0] as CsgsAdaptiveModel[])[context] as CsgsAdaptiveModel);
    (kIndex[0] as Uint8Array)[i] = first;
    for (let g = 1; g < groupCount; g++) {
      (kIndex[g] as Uint8Array)[i] = decoder.get(
        (models.k[g] as CsgsAdaptiveModel[])[first] as CsgsAdaptiveModel,
      );
    }
  }
  assertConsumed(decoder, 'knot count');
  const k = kIndex.map((row) => row.map((index) => params.ks[index] as number));

  const knotOff: Uint32Array[] = [];
  const knots: Int32Array[] = [];
  for (let g = 0; g < groupCount; g++) {
    const dims = (params.groups[g] as CsgsGroup)[1];
    const kg = k[g] as Uint8Array;
    const off = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = (off[i] as number) + (kg[i] as number) * dims;
    const row = new Int32Array(off[n] as number);
    decoder = stream(STREAM_K + 1 + g);
    const firstResidual = (models.first[g] as CsgsAdaptiveModel[][])[0] as CsgsAdaptiveModel[];
    const firstAbsolute = (models.first[g] as CsgsAdaptiveModel[][])[1] as CsgsAdaptiveModel[];
    const diffModels = models.diff[g] as CsgsAdaptiveModel[][][];
    const previousAbsolute = new Int32Array(dims);
    const last = state ? (state.last[g] as Int32Array) : null;
    const groupKIndex = kIndex[g] as Uint8Array;
    for (let i = 0; i < n; i++) {
      const K = kg[i] as number;
      const base = off[i] as number;
      if (!key && i < nCont) {
        const lastRow = last as Int32Array;
        if (params.sharedKnot) {
          for (let c = 0; c < dims; c++) row[base + c] = lastRow[i * dims + c] as number;
        } else {
          for (let c = 0; c < dims; c++) {
            row[base + c] =
              (lastRow[i * dims + c] as number) +
              decoder.getSint(firstResidual[c] as CsgsAdaptiveModel);
          }
        }
      } else {
        for (let c = 0; c < dims; c++) {
          const value =
            (previousAbsolute[c] as number) +
            decoder.getSint(firstAbsolute[c] as CsgsAdaptiveModel);
          row[base + c] = value;
          previousAbsolute[c] = value;
        }
      }
      const splatDiffModels = diffModels[groupKIndex[i] as number] as CsgsAdaptiveModel[][];
      for (let c = 0; c < dims; c++) {
        const dimModels = splatDiffModels[c] as CsgsAdaptiveModel[];
        let previousDiff = 0;
        let hasPrevious = false;
        for (let j = 1; j < K; j++) {
          const diff = decoder.getSint(
            dimModels[hasPrevious ? diffBucket(previousDiff) : 0] as CsgsAdaptiveModel,
          );
          row[base + j * dims + c] = (row[base + (j - 1) * dims + c] as number) + diff;
          previousDiff = diff;
          hasPrevious = true;
        }
      }
    }
    assertConsumed(decoder, `${(params.groups[g] as CsgsGroup)[0]} knot`);
    knotOff.push(off);
    knots.push(row);
  }

  decoder = stream(STREAM_K + 1 + groupCount);
  const nSn = params.nSn;
  const sn = new Uint8Array(n * nSn);
  if (!key) sn.set((state as CsgsState).sn);
  const residuals = new Int32Array(nSn);
  const snPred = header.snPred;
  for (let i = key ? 0 : nCont; i < n; i++) {
    for (let c = 0; c < nSn; c++) {
      const context = c >= SN_CHANNELS ? snBucket(residuals[c - SN_CHANNELS] as number) : 0;
      const residual = decoder.getSint(
        (models.sn[c] as CsgsAdaptiveModel[])[context] as CsgsAdaptiveModel,
      );
      residuals[c] = residual;
      const value = (snPred[c] as number) + residual;
      if (value < 0 || value > 255) throw new Error('CSGS: SH value out of range.');
      sn[i * nSn + c] = value;
    }
  }
  assertConsumed(decoder, 'SH');

  const section: CsgsSection = {
    index: header.index,
    g0: header.g0,
    nframes,
    key,
    n,
    nCont,
    ids,
    birth,
    death,
    k,
    knotOff,
    knots,
    sn,
  };
  return { params, section };
}

/** The state a delta section after `section` continues from. */
export function csgsStateAfter(section: CsgsSection, params: CsgsParams): CsgsState {
  const continues = section.nframes + 1;
  let survivors = 0;
  for (let i = 0; i < section.n; i++) if (section.death[i] === continues) survivors++;
  const kIndexOf = new Map(params.ks.map((count, index) => [count, index]));
  const ids = new Uint32Array(survivors);
  const sn = new Uint8Array(survivors * params.nSn);
  const k0 = new Uint8Array(survivors);
  const last = params.groups.map(([, dims]) => new Int32Array(survivors * dims));
  let j = 0;
  for (let i = 0; i < section.n; i++) {
    if (section.death[i] !== continues) continue;
    ids[j] = section.ids[i] as number;
    sn.set(section.sn.subarray(i * params.nSn, (i + 1) * params.nSn), j * params.nSn);
    k0[j] = kIndexOf.get((section.k[0] as Uint8Array)[i] as number) as number;
    params.groups.forEach(([, dims], g) => {
      const end = (section.knotOff[g] as Uint32Array)[i + 1] as number;
      (last[g] as Int32Array).set(
        (section.knots[g] as Int32Array).subarray(end - dims, end),
        j * dims,
      );
    });
    j++;
  }
  return { ids, last, sn, k0, nextIndex: section.index + 1 };
}

/**
 * Sequential `.csgs` decoder. Feed it sections in stream order; it may start
 * at any key section (random access), and refuses a delta section whose
 * predecessor it has not seen.
 */
export class CsgsDecoder {
  private state: CsgsState | null = null;
  private paramsValue: CsgsParams | null = null;

  /** Params of the last decoded section, or null before the first. */
  get params(): CsgsParams | null {
    return this.paramsValue;
  }

  decode(bytes: Uint8Array): CsgsSection {
    const { header } = parseCsgsHeader(bytes);
    let state: CsgsState | null = null;
    if (!header.key) {
      if (this.state === null || this.state.nextIndex !== header.index) {
        throw new Error(
          'CSGS: delta section without its previous section (seek to a key section).',
        );
      }
      state = this.state;
    }
    const { params, section } = decodeCsgsSection(bytes, state);
    this.paramsValue = params;
    this.state = csgsStateAfter(section, params);
    return section;
  }
}
