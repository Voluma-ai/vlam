/**
 * The CPU depth-sort kernel shared by the worker scripts (`sort-worker.ts`
 * for standalone meshes, `unified/pooled/pooled-sort-worker.ts` for the
 * WebGL2 pooled draw). Each worker bundles its own copy; nothing here runs on
 * the main thread.
 */

const RADIX = 65536; // 16-bit digit
/** Spark-compatible unsigned 32-bit depth key. Two stable 16-bit passes keep
 * the active-list first-touch order for equal keys. */
const KEY_MAX = 0xffffffff;

const counts = new Uint32Array(RADIX);
let scratchCapacity = 0;
let keys = new Uint32Array(0);
let srcScratch = new Uint32Array(0);
let dstScratch = new Uint32Array(0);

/**
 * Sorts the first `count` entries of `depths` back-to-front (ascending
 * view-space z, so the most negative - farthest - first) and returns their
 * positions. The returned view is scratch, valid until the next call.
 *
 * Two-pass 16-bit LSD radix sort on a 32-bit key quantized over
 * `[rangeMin, rangeMax]`; a single 16-bit pass tied thousands of near splats
 * together, which popped as the camera moved.
 */
export function radixOrderByDepth(
  depths: Float32Array,
  count: number,
  rangeMin: number,
  rangeMax: number,
): Uint32Array {
  if (count > scratchCapacity) {
    scratchCapacity = count;
    keys = new Uint32Array(count);
    srcScratch = new Uint32Array(count);
    dstScratch = new Uint32Array(count);
  }
  const depthScale = KEY_MAX / (rangeMax - rangeMin || 1);
  let src = srcScratch;
  for (let i = 0; i < count; i++) {
    // Clamp before uint conversion: distant RAD outliers used to overflow and
    // wrap their 24-bit key back into visible depth buckets.
    keys[i] = Math.floor(
      Math.min(Math.max(((depths[i] as number) - rangeMin) * depthScale, 0), KEY_MAX),
    );
    src[i] = i;
  }

  let dst = dstScratch;
  for (let shift = 0; shift < 32; shift += 16) {
    counts.fill(0);
    for (let i = 0; i < count; i++) {
      const digit = ((keys[src[i] as number] as number) >>> shift) & 0xffff;
      counts[digit] = (counts[digit] as number) + 1;
    }
    let runningTotal = 0;
    for (let b = 0; b < RADIX; b++) {
      const c = counts[b] as number;
      counts[b] = runningTotal;
      runningTotal += c;
    }
    for (let i = 0; i < count; i++) {
      const position = src[i] as number;
      const digit = ((keys[position] as number) >>> shift) & 0xffff;
      const target = counts[digit] as number;
      dst[target] = position;
      counts[digit] = target + 1;
    }
    [src, dst] = [dst, src];
  }
  // Two 16-bit passes swap twice, so src/dst end on their original scratch;
  // keep the module references in step regardless of the pass count.
  srcScratch = src;
  dstScratch = dst;
  return src.subarray(0, count);
}
