import type { SplatData } from '../core/splat-data';

/** Histogram resolution for the importance threshold (log2-spaced). */
const IMPORTANCE_BINS = 1 << 16;

/** Options for {@link limitSplatCount}. */
export interface LimitSplatCountOptions {
  /**
   * Attach {@link SplatData.drawOrder}, the kept splats ranked by importance,
   * even when nothing had to be thinned. Set for loads under a scene budget,
   * which may later shrink the mesh to a prefix of that order.
   */
  drawOrder?: boolean;
}

/**
 * Thins a decoded whole-file scene to at most `maxCount` splats, keeping the
 * ones that contribute most to the image and dropping the rest.
 *
 * Importance is opacity × covariance trace (the sum of the squared axis
 * scales), a cheap proxy for how much color a splat lays down on screen; the
 * faint and tiny splats it drops are the ones a viewer least notices. The
 * cut-off is found with a log-spaced histogram in O(n), not a sort, and the
 * survivors keep their file order, so a Morton-ordered SOG stays spatially
 * coherent. Ties at the threshold are thinned evenly across the file rather
 * than taken first-come, which would empty one region of the scene.
 *
 * Runs in the load workers. It compacts the input's arrays **in place** and
 * shrinks them, so the caller must not use `data` afterwards.
 *
 * @returns `data` unchanged when it already fits and no draw order was asked
 * for; otherwise the thinned scene with `sourceCount` set to the original
 * count, and `drawOrder` when `options.drawOrder` is set.
 */
export function limitSplatCount(
  data: SplatData,
  maxCount: number,
  options: LimitSplatCountOptions = {},
): SplatData {
  const { count } = data;
  const thin = count > maxCount;
  if (!thin && !options.drawOrder) return data;
  if (data.radTree) {
    if (!thin) return data;
    throw new Error(
      `A streamed RAD chunk holds ${count} splats, above the drawable maximum of ${maxCount}.`,
    );
  }
  const bins = importanceBins(splatImportanceScores(data));
  if (!thin) return { ...data, drawOrder: drawOrderFromBins(bins, null, count) };

  const kept = Math.max(0, Math.floor(maxCount));
  const keep = keepMostImportant(bins, kept);
  const positions = compact(data.positions, keep, 3, kept);
  const colors = compact(data.colors, keep, 4, kept);
  const covariances = compact(data.covariances, keep, 6, kept);
  const sh = data.sh ? { ...data.sh, labels: compact(data.sh.labels, keep, 1, kept) } : undefined;
  const shPacked = data.shPacked
    ? {
        ...data.shPacked,
        packed: compact(data.shPacked.packed, keep, data.shPacked.packed.length / count, kept),
      }
    : undefined;
  const frontierParent = data.frontierParent
    ? compact(data.frontierParent, keep, 1, kept)
    : undefined;
  return {
    ...data,
    count: kept,
    positions,
    colors,
    covariances,
    ...(sh ? { sh } : {}),
    ...(shPacked ? { shPacked } : {}),
    ...(frontierParent ? { frontierParent } : {}),
    ...(options.drawOrder ? { drawOrder: drawOrderFromBins(bins, keep, kept) } : {}),
    sourceCount: data.sourceCount ?? count,
  };
}

/**
 * The importance score of one splat: `log2(opacity × covariance trace)`, or
 * `-Infinity` for a splat that lays down no color. Shared by every path that
 * thins, so a parser scoring from its quantized inputs ranks exactly as
 * {@link limitSplatCount} would on the decoded scene.
 *
 * @param opacity - Linear opacity in [0, 1].
 * @param trace - Sum of the covariance diagonal (the squared axis scales).
 */
export function importanceScore(opacity: number, trace: number): number {
  const importance = opacity * trace;
  // Zero, negative or NaN importance sorts below every real score.
  return importance > 0 ? Math.log2(importance) : -Infinity;
}

/** Scores every splat of decoded data with {@link importanceScore}. */
function splatImportanceScores(data: SplatData): Float32Array {
  const { count, colors, covariances } = data;
  const scores = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const c = i * 6;
    scores[i] = importanceScore(
      (colors[i * 4 + 3] as number) / 255,
      (covariances[c] as number) + (covariances[c + 3] as number) + (covariances[c + 5] as number),
    );
  }
  return scores;
}

/**
 * Buckets importance scores into a log-spaced histogram's bins: bin 0 holds
 * the non-contributing splats, real scores span 1..65535 between the scene's
 * own minimum and maximum.
 */
export function importanceBins(scores: Float32Array): Uint16Array {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i] as number;
    if (score === -Infinity) continue;
    if (score < min) min = score;
    if (score > max) max = score;
  }
  const span = max > min ? max - min : 1;
  const scale = (IMPORTANCE_BINS - 2) / span;
  const bins = new Uint16Array(scores.length);
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i] as number;
    bins[i] = score === -Infinity ? 0 : 1 + Math.floor((score - min) * scale);
  }
  return bins;
}

/**
 * Marks exactly `target` splats to keep: every splat above the threshold bin,
 * plus an evenly spaced share of the bin itself.
 */
export function keepMostImportant(bins: Uint16Array, target: number): Uint8Array {
  const count = bins.length;
  const keep = new Uint8Array(count);
  if (target <= 0) return keep;
  const histogram = new Uint32Array(IMPORTANCE_BINS);
  for (let i = 0; i < count; i++) {
    const bin = bins[i] as number;
    histogram[bin] = (histogram[bin] as number) + 1;
  }

  let threshold = IMPORTANCE_BINS - 1;
  let above = 0;
  while (threshold > 0 && above + (histogram[threshold] as number) < target) {
    above += histogram[threshold] as number;
    threshold--;
  }
  const inBin = histogram[threshold] as number;
  const fromBin = target - above;

  let rank = 0;
  for (let i = 0; i < count; i++) {
    const bin = bins[i] as number;
    if (bin > threshold) {
      keep[i] = 1;
    } else if (bin === threshold) {
      // Keep the rank-th of `inBin` tied splats when the even spacing of
      // `fromBin` picks steps past it.
      if (Math.floor(((rank + 1) * fromBin) / inBin) > Math.floor((rank * fromBin) / inBin)) {
        keep[i] = 1;
      }
      rank++;
    }
  }
  return keep;
}

/**
 * Ranks the kept splats by importance bin, highest first, file order within a
 * bin: a counting sort, O(n). Indices address the compacted (kept-only)
 * arrays. Bucketing rather than an exact sort keeps runs of neighbouring
 * splats together, and any prefix of the result is itself a most-visible
 * selection, which is what a later shrink relies on.
 *
 * @param keep - Keep mask over `bins`, or `null` when every splat was kept.
 * @param kept - The number of set entries in `keep` (or `bins.length`).
 */
export function drawOrderFromBins(
  bins: Uint16Array,
  keep: Uint8Array | null,
  kept: number,
): Uint32Array {
  const offsets = new Uint32Array(IMPORTANCE_BINS);
  for (let i = 0; i < bins.length; i++) {
    if (keep && !keep[i]) continue;
    const bin = bins[i] as number;
    offsets[bin] = (offsets[bin] as number) + 1;
  }
  // Exclusive prefix sum from the top bin down, so bin 65535 starts at 0.
  let cursor = 0;
  for (let bin = IMPORTANCE_BINS - 1; bin >= 0; bin--) {
    const size = offsets[bin] as number;
    offsets[bin] = cursor;
    cursor += size;
  }
  const order = new Uint32Array(kept);
  let row = 0;
  for (let i = 0; i < bins.length; i++) {
    if (keep && !keep[i]) continue;
    const bin = bins[i] as number;
    order[offsets[bin] as number] = row++;
    offsets[bin] = (offsets[bin] as number) + 1;
  }
  return order;
}

type PerSplatArray = Float32Array | Uint8Array | Uint32Array;

/**
 * Moves the kept splats' `stride`-wide records to the front of `array`, in
 * order, then shrinks it to `kept` records. Forward compaction never
 * overwrites a record it has yet to read, so no scratch copy is needed.
 */
function compact<T extends PerSplatArray>(
  array: T,
  keep: Uint8Array,
  stride: number,
  kept: number,
): T {
  let out = 0;
  for (let i = 0; i < keep.length; i++) {
    if (!keep[i]) continue;
    if (out !== i) {
      const from = i * stride;
      const to = out * stride;
      for (let k = 0; k < stride; k++) array[to + k] = array[from + k] as number;
    }
    out++;
  }
  return shrink(array, kept * stride);
}

/**
 * Returns `array`'s first `length` elements in a buffer of exactly that size,
 * so the dropped tail is not transferred to the main thread. Uses
 * `ArrayBuffer.prototype.transfer` (which can resize without a second copy)
 * where available and the array owns its whole buffer; otherwise copies.
 */
function shrink<T extends PerSplatArray>(array: T, length: number): T {
  const Ctor = array.constructor as new (buffer: ArrayBuffer) => T;
  const bytes = length * array.BYTES_PER_ELEMENT;
  const buffer = array.buffer as ArrayBuffer & { transfer?: (length: number) => ArrayBuffer };
  if (
    typeof buffer.transfer === 'function' &&
    array.byteOffset === 0 &&
    array.byteLength === buffer.byteLength
  ) {
    return new Ctor(buffer.transfer(bytes));
  }
  return new Ctor(buffer.slice(array.byteOffset, array.byteOffset + bytes));
}
