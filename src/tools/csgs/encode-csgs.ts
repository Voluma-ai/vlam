/**
 * A `.csgs` (Faltwerk CurveStream-GS) version-1 section **encoder**: the exact
 * mirror of `src/lib/formats/csgs/parse-csgs.ts`, stream by stream.
 *
 * A dev tool, not library code: VLAM only needs it to write its own
 * license-clear demo clip (`goose-walk.ts`) and test fixtures. It supports
 * what the decoder supports: key and delta sections, with or without the
 * shared-knot flag. It makes no attempt to choose knots or quantization;
 * the caller hands it the integers to code.
 *
 * rANS codes in reverse: the forward pass below walks the section in decode
 * order, adapting the same models the decoder will, and records each coded
 * symbol's interval; `finish` then folds the recorded intervals into the
 * state back to front, so the decoder pops them front to back.
 */
import { CSGS_RANS_TOKENS, CsgsAdaptiveModel } from '../../lib/formats/csgs/csgs-rans';
import {
  csgsCrc32,
  type CsgsParams,
  type CsgsSection,
  type CsgsState,
} from '../../lib/formats/csgs';

const PROB_BITS = 15;
const RANS_L = 1 << 23;
const RAW_CHUNK = 15;
const ESC = 16;
const FLAG_KEY = 1;
const FLAG_SHARED_KNOT = 2;
const SN_CHANNELS = 3;

/** One rANS stream, recorded forward and written backward. */
class RansEncoder {
  /** Interleaved `[start, frequency]`; a raw-bit op stores `[value, -bits]`. */
  private readonly ops: number[] = [];

  put(model: CsgsAdaptiveModel, symbol: number): void {
    if (!(symbol >= 0 && symbol < model.n)) {
      throw new RangeError(`CSGS encode: symbol ${symbol} outside an alphabet of ${model.n}.`);
    }
    const start = model.cdf[symbol]!;
    this.ops.push(start, model.cdf[symbol + 1]! - start);
    model.update(symbol);
  }

  private raw(bits: number, value: number): void {
    this.ops.push(value, -bits);
  }

  /** Mirrors `CsgsRansDecoder.getUint`: a literal below 16, else an escape plus raw bits. */
  putUint(model: CsgsAdaptiveModel, value: number): void {
    if (!(value >= 0 && value < 2 ** 33) || !Number.isInteger(value)) {
      throw new RangeError(`CSGS encode: ${value} is not a codable unsigned integer.`);
    }
    if (value < ESC) {
      this.put(model, value);
      return;
    }
    const above = value - (ESC - 1);
    const bits = Math.floor(Math.log2(above));
    this.put(model, ESC + bits);
    if (bits === 0) return;
    const rest = above - 2 ** bits;
    if (bits <= RAW_CHUNK) {
      this.raw(bits, rest);
      return;
    }
    // Most significant chunk first, 15 bits at a time, as `getBits` reads them.
    let count = bits;
    while (count > 0) {
      const chunk = count > RAW_CHUNK ? RAW_CHUNK : count;
      count -= chunk;
      this.raw(chunk, Math.floor(rest / 2 ** count) % 2 ** chunk);
    }
  }

  /** Zigzag, as `getSint` undoes it. */
  putSint(model: CsgsAdaptiveModel, value: number): void {
    this.putUint(model, value >= 0 ? 2 * value : -2 * value - 1);
  }

  finish(): Uint8Array {
    const { ops } = this;
    // The reference encoder writes a stream that codes nothing as no bytes.
    if (ops.length === 0) return new Uint8Array(0);
    const reversed: number[] = [];
    let x = RANS_L;
    for (let i = ops.length - 2; i >= 0; i -= 2) {
      const a = ops[i]!;
      const b = ops[i + 1]!;
      if (b < 0) {
        const bits = -b;
        const limit = 2 ** (31 - bits);
        while (x >= limit) {
          reversed.push(x & 0xff);
          x = Math.floor(x / 256);
        }
        x = x * 2 ** bits + a;
      } else {
        const limit = (RANS_L >>> PROB_BITS) * 256 * b;
        while (x >= limit) {
          reversed.push(x & 0xff);
          x = Math.floor(x / 256);
        }
        x = Math.floor(x / b) * (1 << PROB_BITS) + (x % b) + a;
      }
    }
    const out = new Uint8Array(4 + reversed.length);
    out[0] = x & 0xff;
    out[1] = (x >>> 8) & 0xff;
    out[2] = (x >>> 16) & 0xff;
    out[3] = (x >>> 24) & 0xff;
    for (let i = 0; i < reversed.length; i++) out[4 + i] = reversed[reversed.length - 1 - i]!;
    return out;
  }
}

function diffBucket(value: number): number {
  const magnitude = value < 0 ? -value : value;
  return magnitude >= 2 ? 3 : magnitude + 1;
}

function snBucket(value: number): number {
  const magnitude = value < 0 ? -value : value;
  if (magnitude <= 2) return magnitude;
  if (magnitude <= 4) return 3;
  return magnitude <= 8 ? 4 : 5;
}

export interface EncodeCsgsOptions {
  /**
   * State left by the previous section; required for a delta section
   * (`section.key === false`), whose first `nCont` splats continue it.
   */
  readonly state?: CsgsState | null;
  /** Prediction baseline of each SH scalar (`nSn` bytes); default all zero. */
  readonly snPred?: Uint8Array;
  /** First id of the newborn splats; default `section.ids[nCont]`, or 0. */
  readonly idBase?: number;
}

/**
 * Encodes one section to `.csgs` bytes. The inverse of `decodeCsgsSection`:
 * decoding the result yields `section` and `params` again, bit for bit.
 */
export function encodeCsgsSection(
  section: CsgsSection,
  params: CsgsParams,
  options: EncodeCsgsOptions = {},
): Uint8Array {
  const { key, n, nCont, nframes } = section;
  const nNew = n - nCont;
  const state = options.state ?? null;
  if (!key && (state === null || state.ids.length !== nCont)) {
    throw new Error('CSGS encode: a delta section needs the state it continues.');
  }
  const groupCount = params.groups.length;
  const knotCounts = params.ks.length;
  const nSn = params.nSn;
  const snPred = options.snPred ?? new Uint8Array(nSn);
  const idBase = options.idBase ?? (nNew > 0 ? section.ids[nCont]! : 0);
  const kIndexOf = new Map(params.ks.map((count, index) => [count, index]));
  const universal = () => new CsgsAdaptiveModel(CSGS_RANS_TOKENS);
  const streams: Uint8Array[] = [];

  // Birth: each newborn's frame, in the context of the one before.
  let encoder = new RansEncoder();
  const birthModels = Array.from({ length: nframes }, () => new CsgsAdaptiveModel(nframes));
  let previousBirth = 0;
  for (let i = 0; i < nNew; i++) {
    encoder.put(birthModels[previousBirth]!, section.birth[i]!);
    previousBirth = section.birth[i]!;
  }
  streams.push(encoder.finish());

  // Death codes, continuing and newborn splats in separate models.
  encoder = new RansEncoder();
  const deathModels = [new CsgsAdaptiveModel(params.L + 2), new CsgsAdaptiveModel(params.L + 2)];
  for (let i = 0; i < n; i++) encoder.put(deathModels[i < nCont ? 0 : 1]!, section.death[i]!);
  streams.push(encoder.finish());

  // Ids of a key section's continuing splats, as ascending differences.
  encoder = new RansEncoder();
  if (key) {
    const ids = universal();
    let previous = 0;
    for (let i = 0; i < nCont; i++) {
      encoder.putUint(ids, section.ids[i]! - previous);
      previous = section.ids[i]!;
    }
  }
  streams.push(encoder.finish());

  // Knot counts: group 0 in the context of the splat's previous count, the
  // other groups in the context of group 0.
  encoder = new RansEncoder();
  const kModels = params.groups.map(() =>
    Array.from({ length: knotCounts + 1 }, () => new CsgsAdaptiveModel(knotCounts)),
  );
  const kIndex = params.groups.map((_, g) =>
    Uint8Array.from(section.k[g]!, (count) => {
      const index = kIndexOf.get(count);
      if (index === undefined) throw new Error(`CSGS encode: knot count ${count} is not in ks.`);
      return index;
    }),
  );
  for (let i = 0; i < n; i++) {
    const context = !key && i < nCont ? state!.k0[i]! : knotCounts;
    const first = kIndex[0]![i]!;
    encoder.put(kModels[0]![context]!, first);
    for (let g = 1; g < groupCount; g++) encoder.put(kModels[g]![first]!, kIndex[g]![i]!);
  }
  streams.push(encoder.finish());

  // Knots per group: knot 0 against the previous section or the previous
  // splat, then each curve's knot-to-knot differences.
  for (let g = 0; g < groupCount; g++) {
    const dims = params.groups[g]![1];
    encoder = new RansEncoder();
    const firstModels = [0, 1].map(() => Array.from({ length: dims }, universal));
    const diffModels = Array.from({ length: knotCounts }, () =>
      Array.from({ length: dims }, () => Array.from({ length: 4 }, universal)),
    );
    const row = section.knots[g]!;
    const off = section.knotOff[g]!;
    const kg = section.k[g]!;
    const previousAbsolute = new Int32Array(dims);
    const last = state ? state.last[g]! : null;
    for (let i = 0; i < n; i++) {
      const K = kg[i]!;
      const base = off[i]!;
      if (!key && i < nCont) {
        for (let c = 0; c < dims; c++) {
          const residual = row[base + c]! - last![i * dims + c]!;
          if (params.sharedKnot) {
            if (residual !== 0) {
              throw new Error('CSGS encode: a shared knot must repeat the previous last knot.');
            }
          } else {
            encoder.putSint(firstModels[0]![c]!, residual);
          }
        }
      } else {
        for (let c = 0; c < dims; c++) {
          const value = row[base + c]!;
          encoder.putSint(firstModels[1]![c]!, value - previousAbsolute[c]!);
          previousAbsolute[c] = value;
        }
      }
      const splatModels = diffModels[kIndex[g]![i]!]!;
      for (let c = 0; c < dims; c++) {
        const dimModels = splatModels[c]!;
        let previousDiff = 0;
        for (let j = 1; j < K; j++) {
          const diff = row[base + j * dims + c]! - row[base + (j - 1) * dims + c]!;
          encoder.putSint(dimModels[j > 1 ? diffBucket(previousDiff) : 0]!, diff);
          previousDiff = diff;
        }
      }
    }
    streams.push(encoder.finish());
  }

  // Static SH of the splats this section introduces, as residuals.
  encoder = new RansEncoder();
  const snModels = Array.from({ length: nSn }, () => Array.from({ length: 6 }, universal));
  const residuals = new Int32Array(nSn);
  for (let i = key ? 0 : nCont; i < n; i++) {
    for (let c = 0; c < nSn; c++) {
      const context = c >= SN_CHANNELS ? snBucket(residuals[c - SN_CHANNELS]!) : 0;
      const residual = section.sn[i * nSn + c]! - snPred[c]!;
      encoder.putSint(snModels[c]![context]!, residual);
      residuals[c] = residual;
    }
  }
  streams.push(encoder.finish());

  // Header, stream table, streams, CRC.
  const scalarCount = params.offsets.length;
  const headerLength = 4 + 2 + 26 + groupCount * 2 + 1 + knotCounts + 2 + nSn + scalarCount * 8 + 1;
  const streamBytes = streams.reduce((sum, stream) => sum + stream.length, 0);
  const bytes = new Uint8Array(headerLength + streams.length * 4 + streamBytes + 4);
  const view = new DataView(bytes.buffer);
  bytes.set([
    0x43,
    0x53,
    0x47,
    0x53,
    1,
    (key ? FLAG_KEY : 0) | (params.sharedKnot ? FLAG_SHARED_KNOT : 0),
  ]);
  let o = 6;
  view.setUint32(o, section.index, true);
  view.setUint32(o + 4, section.g0, true);
  view.setUint16(o + 8, params.L, true);
  view.setUint16(o + 10, nframes, true);
  view.setUint32(o + 12, nCont, true);
  view.setUint32(o + 16, nNew, true);
  view.setUint32(o + 20, idBase, true);
  bytes[o + 24] = params.keyInterval;
  bytes[o + 25] = groupCount;
  o += 26;
  for (const [tag, dims] of params.groups) {
    bytes[o++] = tag.charCodeAt(0);
    bytes[o++] = dims;
  }
  bytes[o++] = knotCounts;
  for (const count of params.ks) bytes[o++] = count;
  view.setUint16(o, nSn, true);
  o += 2;
  bytes.set(snPred, o);
  o += nSn;
  for (let i = 0; i < scalarCount; i++, o += 4) view.setFloat32(o, params.offsets[i]!, true);
  for (let i = 0; i < scalarCount; i++, o += 4) view.setFloat32(o, params.scales[i]!, true);
  bytes[o++] = streams.length;
  for (const stream of streams) {
    view.setUint32(o, stream.length, true);
    o += 4;
  }
  for (const stream of streams) {
    bytes.set(stream, o);
    o += stream.length;
  }
  view.setUint32(o, csgsCrc32(bytes, 0, o), true);
  return bytes;
}
