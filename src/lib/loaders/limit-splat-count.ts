import type { SplatData } from '../core/splat-data';

/** Histogram resolution for the importance threshold (log2-spaced). */
const IMPORTANCE_BINS = 1 << 16;

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
 * @returns `data` unchanged when it already fits; otherwise the thinned scene
 * with `sourceCount` set to the original count.
 */
export function limitSplatCount(data: SplatData, maxCount: number): SplatData {
  const { count } = data;
  if (count <= maxCount) return data;
  if (data.radTree) {
    throw new Error(
      `A streamed RAD chunk holds ${count} splats, above the drawable maximum of ${maxCount}.`,
    );
  }
  const keep = selectImportant(data, maxCount);
  const kept = maxCount;
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
    sourceCount: data.sourceCount ?? count,
  };
}

/**
 * Marks exactly `target` splats to keep: every splat above the threshold bin,
 * plus an evenly spaced share of the bin itself.
 */
function selectImportant(data: SplatData, target: number): Uint8Array {
  const { count, colors, covariances } = data;
  const scores = new Float32Array(count);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const c = i * 6;
    const importance =
      ((colors[i * 4 + 3] as number) / 255) *
      ((covariances[c] as number) +
        (covariances[c + 3] as number) +
        (covariances[c + 5] as number));
    // Zero, negative or NaN importance sorts below every real score.
    const score = importance > 0 ? Math.log2(importance) : -Infinity;
    scores[i] = score;
    if (score === -Infinity) continue;
    if (score < min) min = score;
    if (score > max) max = score;
  }

  // Bin 0 holds the non-contributing splats; real scores span 1..BINS-1.
  const span = max > min ? max - min : 1;
  const scale = (IMPORTANCE_BINS - 2) / span;
  const binOf = (score: number): number =>
    score === -Infinity ? 0 : 1 + Math.floor((score - min) * scale);
  const histogram = new Uint32Array(IMPORTANCE_BINS);
  for (let i = 0; i < count; i++) {
    const bin = binOf(scores[i] as number);
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

  const keep = new Uint8Array(count);
  let rank = 0;
  for (let i = 0; i < count; i++) {
    const bin = binOf(scores[i] as number);
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
