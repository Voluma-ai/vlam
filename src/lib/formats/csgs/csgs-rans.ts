/**
 * rANS entropy decoder with adaptive frequency models, the entropy stage of
 * the Faltwerk `.csgs` container (`docs/format-csgs.md` §3 in that
 * repository). Ported from Faltwerk's TypeScript decoder (MIT, see
 * `THIRD_PARTY_NOTICES.md`); the arithmetic must stay bit-exact with the
 * Python reference encoder, so every step mirrors it.
 *
 * The decoder state `x` is kept in `[2^23, 2^31)`, which makes every
 * operation exact in a JS double and lets the hot path stay in int32 ops.
 */

/** Probability resolution of a model's cumulative table. */
const PROB_BITS = 15;
const PROB_SCALE = 1 << PROB_BITS;
/** Lower renormalization bound of the decoder state. */
const RANS_L = 1 << 23;
/** Raw bits read per chunk by {@link CsgsRansDecoder.getBits}. */
const RAW_CHUNK = 15;
/** First escape token of the universal integer code. */
const ESC = 16;
/** Alphabet size of the universal integer models (16 literals + 33 escapes). */
export const CSGS_RANS_TOKENS = ESC + 33;
/** Default count increment of an adaptive model. */
const INC = 24;
const COUNT_LIMIT = 1 << 16;
const REBUILD_FIRST = 16;
const REBUILD_MAX = 1024;
/** Larger alphabets locate their symbol by bisection instead of a linear scan. */
const FIND_LINEAR_MAX = 64;
/** The slot lookup table holds 128 buckets of the probability range. */
const LUT_SHIFT = PROB_BITS - 7;

/**
 * An adaptive frequency model over `n` symbols. Counts start at one, grow by
 * `inc` per coded symbol, halve past a limit, and are folded into a
 * cumulative table on a doubling rebuild schedule.
 */
export class CsgsAdaptiveModel {
  readonly n: number;
  readonly counts: Uint32Array;
  readonly cdf: Uint32Array;
  /** First symbol whose interval reaches into each slot bucket. */
  readonly lut = new Uint16Array(1 << (PROB_BITS - LUT_SHIFT));
  private total: number;
  private interval = REBUILD_FIRST;
  private until = REBUILD_FIRST;
  private readonly inc: number;

  constructor(n: number, inc = INC) {
    if (n < 1 || n > PROB_SCALE / 2) throw new Error('CSGS: model alphabet size out of range.');
    this.n = n;
    this.inc = inc;
    this.counts = new Uint32Array(n).fill(1);
    this.total = n;
    this.cdf = new Uint32Array(n + 1);
    this.rebuild();
  }

  private rebuild(): void {
    const { n, counts, total, cdf } = this;
    const spare = PROB_SCALE - n;
    let sum = 0;
    let best = 0;
    // Frequencies are staged in cdf[i + 1] before the prefix sum.
    for (let i = 0; i < n; i++) {
      const frequency = 1 + Math.floor(((counts[i] as number) * spare) / total);
      cdf[i + 1] = frequency;
      sum += frequency;
      if ((counts[i] as number) > (counts[best] as number)) best = i;
    }
    cdf[best + 1] = (cdf[best + 1] as number) + (PROB_SCALE - sum);
    let acc = 0;
    cdf[0] = 0;
    for (let i = 0; i < n; i++) {
      acc += cdf[i + 1] as number;
      cdf[i + 1] = acc;
    }
    const lut = this.lut;
    let symbol = 0;
    for (let bucket = 0; bucket < lut.length; bucket++) {
      const low = bucket << LUT_SHIFT;
      while ((cdf[symbol + 1] as number) <= low) symbol++;
      lut[bucket] = symbol;
    }
  }

  /** Accounts one decoded symbol. */
  update(symbol: number): void {
    const counts = this.counts;
    counts[symbol] = (counts[symbol] as number) + this.inc;
    this.total += this.inc;
    if (this.total > COUNT_LIMIT) {
      let total = 0;
      for (let i = 0; i < this.n; i++) {
        const halved = ((counts[i] as number) + 1) >>> 1;
        counts[i] = halved;
        total += halved;
      }
      this.total = total;
    }
    if (--this.until === 0) {
      this.rebuild();
      if (this.interval < REBUILD_MAX) this.interval <<= 1;
      this.until = this.interval;
    }
  }
}

/** Range decoder over one byte range of a section. */
export class CsgsRansDecoder {
  private readonly buffer: Uint8Array;
  private position: number;
  private readonly end: number;
  private x: number;

  constructor(buffer: Uint8Array, position = 0, end = buffer.length) {
    this.buffer = buffer;
    this.end = end;
    if (end - position === 0) {
      this.position = position;
      this.x = 0;
      return;
    }
    if (end - position < 4) throw new Error('CSGS: rANS stream shorter than 4 bytes.');
    this.x =
      ((buffer[position] as number) |
        ((buffer[position + 1] as number) << 8) |
        ((buffer[position + 2] as number) << 16) |
        ((buffer[position + 3] as number) << 24)) >>>
      0;
    this.position = position + 4;
  }

  private renormalize(x: number): number {
    const { buffer, end } = this;
    let position = this.position;
    while (x < RANS_L) {
      if (position >= end) throw new Error('CSGS: rANS stream overrun.');
      x = (x << 8) | (buffer[position++] as number);
    }
    this.position = position;
    return x;
  }

  /** Decodes one symbol of `model` and adapts it. */
  get(model: CsgsAdaptiveModel): number {
    const x = this.x;
    const slot = x & (PROB_SCALE - 1);
    const cdf = model.cdf;
    const bucket = slot >>> LUT_SHIFT;
    let symbol = model.lut[bucket] as number;
    if (model.n <= FIND_LINEAR_MAX) {
      while ((cdf[symbol + 1] as number) <= slot) symbol++;
    } else {
      let high = bucket + 1 < model.lut.length ? (model.lut[bucket + 1] as number) + 1 : model.n;
      while (high - symbol > 1) {
        const mid = (symbol + high) >>> 1;
        if ((cdf[mid] as number) <= slot) symbol = mid;
        else high = mid;
      }
    }
    const start = cdf[symbol] as number;
    this.x = this.renormalize(
      ((cdf[symbol + 1] as number) - start) * (x >>> PROB_BITS) + slot - start,
    );
    model.update(symbol);
    return symbol;
  }

  /** Reads `count` raw bits, most significant chunk first. */
  getBits(count: number): number {
    let value = 0;
    while (count > 0) {
      const chunk = count > RAW_CHUNK ? RAW_CHUNK : count;
      count -= chunk;
      const x = this.x;
      // The accumulator may pass 2^31, so it stays in double arithmetic.
      value = value * (1 << chunk) + (x & ((1 << chunk) - 1));
      this.x = this.renormalize(x >>> chunk);
    }
    return value;
  }

  /** Decodes an unsigned integer: a literal below 16, else an escape plus raw bits. */
  getUint(model: CsgsAdaptiveModel): number {
    const token = this.get(model);
    if (token < ESC) return token;
    const bits = token - ESC;
    if (bits === 0) return ESC;
    if (bits <= RAW_CHUNK) {
      const x = this.x;
      const raw = x & ((1 << bits) - 1);
      this.x = this.renormalize(x >>> bits);
      return (1 << bits) + raw + ESC - 1;
    }
    return 2 ** bits + this.getBits(bits) + ESC - 1;
  }

  /** Decodes a zigzag-coded signed integer. */
  getSint(model: CsgsAdaptiveModel): number {
    const u = this.getUint(model);
    if (u < 0x40000000) return u & 1 ? -((u + 1) >> 1) : u >> 1;
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
  }

  /** True once the stream is consumed exactly: no bytes left and the state back at its floor. */
  get consumed(): boolean {
    return (
      (this.position === this.end && this.x === RANS_L) ||
      (this.x === 0 && this.position === this.end)
    );
  }
}
