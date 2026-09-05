import type { RadTreeData, SplatData, SplatPackedShData, SplatShData } from '../core/splat-data';
import { shCoefficientCount } from '../core/sh-pack';

/** Progress emitted while a static scene is spatially ordered and merged. */
/** @experimental Excluded from the v1.0 compatibility guarantee. */
export interface StaticLodBuildProgress {
  readonly completed: number;
  readonly total: number;
}

/** Result consumed by {@link StaticLodSplatMesh}. */
/** @experimental Excluded from the v1.0 compatibility guarantee. */
export interface StaticLodBuildResult {
  readonly data: SplatData;
  readonly contentSplatCount: number;
  readonly finestSplatCount: number;
  readonly roots: Uint32Array;
}

type MutableLevel = {
  count: number;
  positions: Float32Array;
  colors: Uint8Array;
  covariances: Float32Array;
  masses: Float64Array;
  sizes: Float32Array;
  childCount: Uint16Array;
  /** Child index relative to the immediately finer level. */
  childStart: Uint32Array;
  shLabels?: Uint32Array;
  shPacked?: Uint32Array;
  packedStride?: number;
  dominant: Uint32Array;
};

type Pairing = {
  readonly left: number;
  readonly right?: number;
};

const MORTON_BITS = 10;
const MORTON_BUCKETS = 1 << MORTON_BITS;
const COVARIANCE_EPSILON = 1e-18;
const PAIR_SEARCH_NEIGHBORS = 16;
const PAIRING_GROUP_SIZE = 256;
const SOURCE_REDUCTION_GROUP_SIZE = 64;

const determinant = (covariances: Float32Array, index: number): number => {
  const base = index * 6;
  const xx = covariances[base] as number;
  const xy = covariances[base + 1] as number;
  const xz = covariances[base + 2] as number;
  const yy = covariances[base + 3] as number;
  const yz = covariances[base + 4] as number;
  const zz = covariances[base + 5] as number;
  return xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz);
};

const splatMass = (colors: Uint8Array, covariances: Float32Array, index: number): number => {
  const opacity = (colors[index * 4 + 3] as number) / 255;
  const volume = Math.sqrt(Math.max(COVARIANCE_EPSILON, determinant(covariances, index)));
  return Math.max(COVARIANCE_EPSILON, opacity * volume);
};

const splatSize = (covariances: Float32Array, index: number): number => {
  const base = index * 6;
  const trace =
    (covariances[base] as number) +
    (covariances[base + 3] as number) +
    (covariances[base + 5] as number);
  return 2 * Math.sqrt(Math.max(COVARIANCE_EPSILON, trace));
};

const expandBits = (value: number): number => {
  let result = value & 0x3ff;
  result = (result | (result << 16)) & 0x030000ff;
  result = (result | (result << 8)) & 0x0300f00f;
  result = (result | (result << 4)) & 0x030c30c3;
  result = (result | (result << 2)) & 0x09249249;
  return result >>> 0;
};

const mortonCode = (x: number, y: number, z: number): number =>
  (expandBits(x) | (expandBits(y) << 1) | (expandBits(z) << 2)) >>> 0;

const spatialOrder = (positions: Float32Array, count: number): Uint32Array => {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let index = 0; index < count; index++) {
    const base = index * 3;
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[base + axis] as number;
      min[axis] = Math.min(min[axis] as number, value);
      max[axis] = Math.max(max[axis] as number, value);
    }
  }

  let indices = new Uint32Array(count);
  let scratchIndices = new Uint32Array(count);
  let keys = new Uint32Array(count);
  let scratchKeys = new Uint32Array(count);
  const scale = min.map(
    (value, axis) => (MORTON_BUCKETS - 1) / Math.max(1e-12, (max[axis] as number) - value),
  );
  for (let index = 0; index < count; index++) {
    const base = index * 3;
    const x = Math.max(
      0,
      Math.min(
        MORTON_BUCKETS - 1,
        Math.floor(((positions[base] as number) - (min[0] as number)) * (scale[0] as number)),
      ),
    );
    const y = Math.max(
      0,
      Math.min(
        MORTON_BUCKETS - 1,
        Math.floor(((positions[base + 1] as number) - (min[1] as number)) * (scale[1] as number)),
      ),
    );
    const z = Math.max(
      0,
      Math.min(
        MORTON_BUCKETS - 1,
        Math.floor(((positions[base + 2] as number) - (min[2] as number)) * (scale[2] as number)),
      ),
    );
    indices[index] = index;
    keys[index] = mortonCode(x, y, z);
  }

  for (let shift = 0; shift < 30; shift += MORTON_BITS) {
    const counts = new Uint32Array(MORTON_BUCKETS);
    for (let index = 0; index < count; index++) {
      const bucket = ((keys[index] as number) >>> shift) & (MORTON_BUCKETS - 1);
      counts[bucket] = (counts[bucket] as number) + 1;
    }
    let offset = 0;
    for (let bucket = 0; bucket < counts.length; bucket++) {
      const size = counts[bucket] as number;
      counts[bucket] = offset;
      offset += size;
    }
    for (let index = 0; index < count; index++) {
      const key = keys[index] as number;
      const bucket = (key >>> shift) & (MORTON_BUCKETS - 1);
      const destination = counts[bucket] as number;
      counts[bucket] = destination + 1;
      scratchKeys[destination] = key;
      scratchIndices[destination] = indices[index] as number;
    }
    [keys, scratchKeys] = [scratchKeys, keys];
    [indices, scratchIndices] = [scratchIndices, indices];
  }
  return indices;
};

/** Validates the worker-owned shape before a hierarchy copies its typed arrays. */
/** @experimental Excluded from the v1.0 compatibility guarantee. */
export function validateStaticLodSource(data: SplatData): void {
  if (!Number.isSafeInteger(data.count) || data.count < 0)
    throw new RangeError(
      `Static LOD source count must be a non-negative safe integer; received ${data.count}.`,
    );

  const arrays: [string, number, number][] = [
    ['positions', data.positions.length, data.count * 3],
    ['colors', data.colors.length, data.count * 4],
    ['covariances', data.covariances.length, data.count * 6],
  ];
  if (data.sh) arrays.push(['sh.labels', data.sh.labels.length, data.count]);
  for (const [name, actual, expected] of arrays) {
    if (actual !== expected)
      throw new RangeError(
        `Static LOD source is structurally inconsistent: ${name} has ${actual} entries; expected ${expected} for ${data.count} splats.`,
      );
  }

  if (!data.shPacked) return;
  const stride = shCoefficientCount(data.shPacked.bands);
  const expected = data.count * stride;
  if (data.shPacked.packed.length !== expected)
    throw new RangeError(
      `Static LOD source is structurally inconsistent: shPacked.packed has ${data.shPacked.packed.length} words; expected ${expected} (${data.count} splats × ${stride} coefficients for ${data.shPacked.bands} SH bands).`,
    );
}

const packedCoefficientCount = (data: SplatData): number =>
  data.shPacked ? shCoefficientCount(data.shPacked.bands) : 0;

const allocateLevel = (count: number, data: SplatData): MutableLevel => ({
  count,
  positions: new Float32Array(count * 3),
  colors: new Uint8Array(count * 4),
  covariances: new Float32Array(count * 6),
  masses: new Float64Array(count),
  sizes: new Float32Array(count),
  childCount: new Uint16Array(count),
  childStart: new Uint32Array(count),
  ...(data.sh ? { shLabels: new Uint32Array(count) } : {}),
  ...(data.shPacked
    ? {
        shPacked: new Uint32Array(count * packedCoefficientCount(data)),
        packedStride: packedCoefficientCount(data),
      }
    : {}),
  dominant: new Uint32Array(count),
});

const allocateLikeLevel = (count: number, source: MutableLevel): MutableLevel => ({
  count,
  positions: new Float32Array(count * 3),
  colors: new Uint8Array(count * 4),
  covariances: new Float32Array(count * 6),
  masses: new Float64Array(count),
  sizes: new Float32Array(count),
  childCount: new Uint16Array(count),
  childStart: new Uint32Array(count),
  ...(source.shLabels ? { shLabels: new Uint32Array(count) } : {}),
  ...(source.shPacked && source.packedStride
    ? { shPacked: new Uint32Array(count * source.packedStride), packedStride: source.packedStride }
    : {}),
  dominant: new Uint32Array(count),
});

const copySourceSplat = (
  source: SplatData,
  sourceIndex: number,
  target: MutableLevel,
  targetIndex: number,
): void => {
  target.positions.set(
    source.positions.subarray(sourceIndex * 3, sourceIndex * 3 + 3),
    targetIndex * 3,
  );
  target.colors.set(source.colors.subarray(sourceIndex * 4, sourceIndex * 4 + 4), targetIndex * 4);
  target.covariances.set(
    source.covariances.subarray(sourceIndex * 6, sourceIndex * 6 + 6),
    targetIndex * 6,
  );
  target.masses[targetIndex] = splatMass(source.colors, source.covariances, sourceIndex);
  target.sizes[targetIndex] = splatSize(source.covariances, sourceIndex);
  target.dominant[targetIndex] = sourceIndex;
  if (target.shLabels && source.sh)
    target.shLabels[targetIndex] = source.sh.labels[sourceIndex] as number;
  if (target.shPacked && source.shPacked) {
    const coefficients = packedCoefficientCount(source);
    target.shPacked.set(
      source.shPacked.packed.subarray(sourceIndex * coefficients, (sourceIndex + 1) * coefficients),
      targetIndex * coefficients,
    );
  }
};

const copyLevelSplat = (
  source: MutableLevel,
  sourceIndex: number,
  target: MutableLevel,
  targetIndex: number,
): void => {
  target.positions.set(
    source.positions.subarray(sourceIndex * 3, sourceIndex * 3 + 3),
    targetIndex * 3,
  );
  target.colors.set(source.colors.subarray(sourceIndex * 4, sourceIndex * 4 + 4), targetIndex * 4);
  target.covariances.set(
    source.covariances.subarray(sourceIndex * 6, sourceIndex * 6 + 6),
    targetIndex * 6,
  );
  target.masses[targetIndex] = source.masses[sourceIndex] as number;
  target.sizes[targetIndex] = source.sizes[sourceIndex] as number;
  target.childCount[targetIndex] = source.childCount[sourceIndex] as number;
  target.childStart[targetIndex] = source.childStart[sourceIndex] as number;
  target.dominant[targetIndex] = source.dominant[sourceIndex] as number;
  if (target.shLabels && source.shLabels)
    target.shLabels[targetIndex] = source.shLabels[sourceIndex] as number;
  if (target.shPacked && source.shPacked) {
    const coefficients = source.packedStride;
    if (coefficients === undefined) throw new Error('Static LOD packed-SH stride is unavailable.');
    target.shPacked.set(
      source.shPacked.subarray(sourceIndex * coefficients, (sourceIndex + 1) * coefficients),
      targetIndex * coefficients,
    );
  }
};

const repairCovariance = (target: MutableLevel, targetIndex: number): void => {
  const base = targetIndex * 6;
  const xx = target.covariances[base] as number;
  const xy = target.covariances[base + 1] as number;
  const xz = target.covariances[base + 2] as number;
  const yy = target.covariances[base + 3] as number;
  const yz = target.covariances[base + 4] as number;
  const zz = target.covariances[base + 5] as number;
  const finite = [xx, xy, xz, yy, yz, zz].every(Number.isFinite);
  const scale = Math.max(1, Math.abs(xx), Math.abs(yy), Math.abs(zz));
  const tolerance = scale * scale * scale * 1e-6;
  const positiveSemidefinite =
    xx >= 0 &&
    yy >= 0 &&
    zz >= 0 &&
    xx * yy - xy * xy >= -tolerance &&
    xx * zz - xz * xz >= -tolerance &&
    yy * zz - yz * yz >= -tolerance &&
    determinant(target.covariances, targetIndex) >= -tolerance;
  if (finite && positiveSemidefinite) return;

  // Moment matching preserves PSD inputs mathematically. This is solely a
  // float32 guard for malformed inputs or a numerically negative near-zero mode;
  // a diagonal fallback is finite and PSD rather than letting one bad node poison
  // a complete frontier.
  target.covariances[base] = Number.isFinite(xx) ? Math.max(COVARIANCE_EPSILON, xx) : 1;
  target.covariances[base + 1] = 0;
  target.covariances[base + 2] = 0;
  target.covariances[base + 3] = Number.isFinite(yy) ? Math.max(COVARIANCE_EPSILON, yy) : 1;
  target.covariances[base + 4] = 0;
  target.covariances[base + 5] = Number.isFinite(zz) ? Math.max(COVARIANCE_EPSILON, zz) : 1;
};

const mergePair = (
  source: MutableLevel,
  left: number,
  right: number,
  target: MutableLevel,
  targetIndex: number,
): void => {
  let totalMass = 0;
  let dominant = left;
  let dominantMass = -1;
  const mean = [0, 0, 0];
  const color = [0, 0, 0];
  const accumulate = (index: number): void => {
    const mass = source.masses[index] as number;
    totalMass += mass;
    if (
      mass > dominantMass ||
      (mass === dominantMass &&
        (source.dominant[index] as number) < (source.dominant[dominant] as number))
    ) {
      dominantMass = mass;
      dominant = index;
    }
    for (let axis = 0; axis < 3; axis++) {
      mean[axis] = (mean[axis] as number) + (source.positions[index * 3 + axis] as number) * mass;
      color[axis] = (color[axis] as number) + (source.colors[index * 4 + axis] as number) * mass;
    }
  };
  accumulate(left);
  accumulate(right);
  const safeMass = Math.max(totalMass, COVARIANCE_EPSILON);
  for (let axis = 0; axis < 3; axis++) {
    mean[axis] = (mean[axis] as number) / safeMass;
    target.positions[targetIndex * 3 + axis] = mean[axis] as number;
    target.colors[targetIndex * 4 + axis] = Math.max(
      0,
      Math.min(255, Math.round((color[axis] as number) / safeMass)),
    );
  }

  const covariance = [0, 0, 0, 0, 0, 0];
  const accumulateCovariance = (index: number): void => {
    const mass = source.masses[index] as number;
    const dx = (source.positions[index * 3] as number) - (mean[0] as number);
    const dy = (source.positions[index * 3 + 1] as number) - (mean[1] as number);
    const dz = (source.positions[index * 3 + 2] as number) - (mean[2] as number);
    const base = index * 6;
    covariance[0] =
      (covariance[0] as number) + ((source.covariances[base] as number) + dx * dx) * mass;
    covariance[1] =
      (covariance[1] as number) + ((source.covariances[base + 1] as number) + dx * dy) * mass;
    covariance[2] =
      (covariance[2] as number) + ((source.covariances[base + 2] as number) + dx * dz) * mass;
    covariance[3] =
      (covariance[3] as number) + ((source.covariances[base + 3] as number) + dy * dy) * mass;
    covariance[4] =
      (covariance[4] as number) + ((source.covariances[base + 4] as number) + dy * dz) * mass;
    covariance[5] =
      (covariance[5] as number) + ((source.covariances[base + 5] as number) + dz * dz) * mass;
  };
  accumulateCovariance(left);
  accumulateCovariance(right);
  for (let component = 0; component < 6; component++) {
    target.covariances[targetIndex * 6 + component] = (covariance[component] as number) / safeMass;
  }
  repairCovariance(target, targetIndex);
  target.masses[targetIndex] = totalMass;
  const mergedVolume = Math.sqrt(
    Math.max(COVARIANCE_EPSILON, determinant(target.covariances, targetIndex)),
  );
  target.colors[targetIndex * 4 + 3] = Math.max(
    0,
    Math.min(255, Math.round((totalMass / mergedVolume) * 255)),
  );
  target.sizes[targetIndex] = splatSize(target.covariances, targetIndex);
  target.dominant[targetIndex] = source.dominant[dominant] as number;
  if (target.shLabels && source.shLabels)
    target.shLabels[targetIndex] = source.shLabels[dominant] as number;
  if (target.shPacked && source.shPacked) {
    const coefficients = source.packedStride;
    if (coefficients === undefined) throw new Error('Static LOD packed-SH stride is unavailable.');
    target.shPacked.set(
      source.shPacked.subarray(dominant * coefficients, (dominant + 1) * coefficients),
      targetIndex * coefficients,
    );
  }
};

const pairCost = (source: MutableLevel, left: number, right: number): number => {
  const leftBase = left * 6;
  const rightBase = right * 6;
  const xx =
    ((source.covariances[leftBase] as number) + (source.covariances[rightBase] as number)) * 0.5 +
    1e-12;
  const xy =
    ((source.covariances[leftBase + 1] as number) + (source.covariances[rightBase + 1] as number)) *
    0.5;
  const xz =
    ((source.covariances[leftBase + 2] as number) + (source.covariances[rightBase + 2] as number)) *
    0.5;
  const yy =
    ((source.covariances[leftBase + 3] as number) + (source.covariances[rightBase + 3] as number)) *
      0.5 +
    1e-12;
  const yz =
    ((source.covariances[leftBase + 4] as number) + (source.covariances[rightBase + 4] as number)) *
    0.5;
  const zz =
    ((source.covariances[leftBase + 5] as number) + (source.covariances[rightBase + 5] as number)) *
      0.5 +
    1e-12;
  const determinantMean =
    xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz);
  if (!Number.isFinite(determinantMean) || determinantMean <= 0) return Number.POSITIVE_INFINITY;
  const inverse = [
    (yy * zz - yz * yz) / determinantMean,
    (xz * yz - xy * zz) / determinantMean,
    (xy * yz - xz * yy) / determinantMean,
    (xx * zz - xz * xz) / determinantMean,
    (xy * xz - xx * yz) / determinantMean,
    (xx * yy - xy * xy) / determinantMean,
  ];
  const dx = (source.positions[left * 3] as number) - (source.positions[right * 3] as number);
  const dy =
    (source.positions[left * 3 + 1] as number) - (source.positions[right * 3 + 1] as number);
  const dz =
    (source.positions[left * 3 + 2] as number) - (source.positions[right * 3 + 2] as number);
  const quadratic =
    dx * (inverse[0] as number) * dx +
    2 * dx * (inverse[1] as number) * dy +
    2 * dx * (inverse[2] as number) * dz +
    dy * (inverse[3] as number) * dy +
    2 * dy * (inverse[4] as number) * dz +
    dz * (inverse[5] as number) * dz;
  const leftDeterminant = Math.max(COVARIANCE_EPSILON, determinant(source.covariances, left));
  const rightDeterminant = Math.max(COVARIANCE_EPSILON, determinant(source.covariances, right));
  const gaussian =
    0.125 * Math.max(0, quadratic) +
    0.5 * Math.log(determinantMean / Math.sqrt(leftDeterminant * rightDeterminant));
  const color =
    (Math.abs((source.colors[left * 4] as number) - (source.colors[right * 4] as number)) +
      Math.abs((source.colors[left * 4 + 1] as number) - (source.colors[right * 4 + 1] as number)) +
      Math.abs(
        (source.colors[left * 4 + 2] as number) - (source.colors[right * 4 + 2] as number),
      )) /
    (3 * 255);
  const opacity =
    Math.abs((source.colors[left * 4 + 3] as number) - (source.colors[right * 4 + 3] as number)) /
    255;
  const cost = gaussian + color + opacity;
  return Number.isFinite(cost) ? cost : Number.POSITIVE_INFINITY;
};

const comparePairRank = (
  leftCost: number,
  leftFirstOriginal: number,
  leftSecondOriginal: number,
  left: number,
  leftRight: number,
  rightCost: number,
  rightFirstOriginal: number,
  rightSecondOriginal: number,
  right: number,
  rightRight: number,
): number =>
  leftCost - rightCost ||
  leftFirstOriginal - rightFirstOriginal ||
  leftSecondOriginal - rightSecondOriginal ||
  left - right ||
  leftRight - rightRight;

/**
 * Chooses pairs from a Morton-local window without materializing the roughly
 * 32N possible edges. Each round retains only one best candidate per available
 * splat, then recomputes after conflicts have been removed.
 */
const selectPairingSmall = (source: MutableLevel, targetCount: number): Pairing[] => {
  const pairsNeeded = source.count - targetCount;
  const available = new Uint8Array(source.count).fill(1);
  // One candidate per available splat is enough for each greedy round. Keep
  // those records in packed arrays: millions of `{ left, right, cost, ... }`
  // objects create several hundred MiB of GC pressure at the 2M mobile ceiling
  // and can strand the worker after its final progress tick.
  const candidateLeft = new Uint32Array(source.count);
  const candidateRight = new Uint32Array(source.count);
  const candidateCost = new Float64Array(source.count);
  const candidateIndexByLeft = new Int32Array(source.count);
  const bestRightByLeft = new Int32Array(source.count);
  const bestCostByLeft = new Float64Array(source.count);
  const pairs: Pairing[] = [];
  while (pairs.length < pairsNeeded) {
    const order = spatialOrder(source.positions, source.count);
    candidateIndexByLeft.fill(-1);
    bestRightByLeft.fill(-1);
    let candidateCount = 0;
    for (let position = 0; position < order.length; position++) {
      const left = order[position] as number;
      if (available[left] === 0) continue;
      let availableNeighbors = 0;
      for (
        let neighborPosition = position + 1;
        neighborPosition < order.length && availableNeighbors < PAIR_SEARCH_NEIGHBORS;
        neighborPosition++
      ) {
        const right = order[neighborPosition] as number;
        if (available[right] === 0) continue;
        availableNeighbors++;
        const leftOriginal = source.dominant[left] as number;
        const rightOriginal = source.dominant[right] as number;
        const firstOriginal = Math.min(leftOriginal, rightOriginal);
        const secondOriginal = Math.max(leftOriginal, rightOriginal);
        const cost = pairCost(source, left, right);

        const previousLeftRight = bestRightByLeft[left] as number;
        const previousLeftRightOriginal =
          previousLeftRight < 0 ? 0 : (source.dominant[previousLeftRight] as number);
        if (
          previousLeftRight < 0 ||
          comparePairRank(
            cost,
            firstOriginal,
            secondOriginal,
            left,
            right,
            bestCostByLeft[left] as number,
            Math.min(leftOriginal, previousLeftRightOriginal),
            Math.max(leftOriginal, previousLeftRightOriginal),
            left,
            previousLeftRight,
          ) < 0
        ) {
          bestRightByLeft[left] = right;
          bestCostByLeft[left] = cost;
        }

        const previousRightLeft = bestRightByLeft[right] as number;
        const previousRightLeftOriginal =
          previousRightLeft < 0 ? 0 : (source.dominant[previousRightLeft] as number);
        if (
          previousRightLeft < 0 ||
          comparePairRank(
            cost,
            firstOriginal,
            secondOriginal,
            right,
            left,
            bestCostByLeft[right] as number,
            Math.min(rightOriginal, previousRightLeftOriginal),
            Math.max(rightOriginal, previousRightLeftOriginal),
            right,
            previousRightLeft,
          ) < 0
        ) {
          bestRightByLeft[right] = left;
          bestCostByLeft[right] = cost;
        }
      }
    }
    for (const left of order) {
      if (available[left] === 0) continue;
      const bestRight = bestRightByLeft[left] as number;
      if (bestRight >= 0) {
        candidateLeft[candidateCount] = left;
        candidateRight[candidateCount] = bestRight;
        candidateCost[candidateCount] = bestCostByLeft[left] as number;
        candidateIndexByLeft[left] = candidateCount;
        candidateCount++;
      }
    }
    const compareCandidateIndices = (leftIndex: number, rightIndex: number): number => {
      const left = candidateLeft[leftIndex] as number;
      const leftRight = candidateRight[leftIndex] as number;
      const right = candidateLeft[rightIndex] as number;
      const rightRight = candidateRight[rightIndex] as number;
      const leftOriginal = source.dominant[left] as number;
      const leftRightOriginal = source.dominant[leftRight] as number;
      const rightOriginal = source.dominant[right] as number;
      const rightRightOriginal = source.dominant[rightRight] as number;
      return comparePairRank(
        candidateCost[leftIndex] as number,
        Math.min(leftOriginal, leftRightOriginal),
        Math.max(leftOriginal, leftRightOriginal),
        left,
        leftRight,
        candidateCost[rightIndex] as number,
        Math.min(rightOriginal, rightRightOriginal),
        Math.max(rightOriginal, rightRightOriginal),
        right,
        rightRight,
      );
    };
    const mutualCandidates: number[] = [];
    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
      const left = candidateLeft[candidateIndex] as number;
      const right = candidateRight[candidateIndex] as number;
      const reverseIndex = candidateIndexByLeft[right] as number;
      if (left < right && reverseIndex >= 0 && (candidateRight[reverseIndex] as number) === left) {
        mutualCandidates.push(candidateIndex);
      }
    }

    const remainingPairs = pairsNeeded - pairs.length;
    // A half-reduction consumes every mutual pair, so no global millions-entry
    // sort is needed. Only a final partial round (normally a <=64-splat source
    // reduction group) ranks the excess mutual pairs before truncating.
    if (mutualCandidates.length > remainingPairs) {
      mutualCandidates.sort(compareCandidateIndices);
      mutualCandidates.length = remainingPairs;
    }
    let added = 0;
    for (const candidateIndex of mutualCandidates) {
      const left = candidateLeft[candidateIndex] as number;
      const right = candidateRight[candidateIndex] as number;
      available[left] = 0;
      available[right] = 0;
      pairs.push({ left, right });
      added++;
    }
    if (added > 0) continue;
    // Symmetric ranked costs normally guarantee a mutual-nearest pair. A
    // deterministic minimum fallback keeps malformed/tied numeric input making
    // progress without materializing or sorting the full candidate set.
    let bestCandidate = -1;
    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
      if (bestCandidate < 0 || compareCandidateIndices(candidateIndex, bestCandidate) < 0) {
        bestCandidate = candidateIndex;
      }
    }
    if (bestCandidate < 0)
      throw new Error('Static LOD pairing could not reach the requested count.');
    const left = candidateLeft[bestCandidate] as number;
    const right = candidateRight[bestCandidate] as number;
    available[left] = 0;
    available[right] = 0;
    pairs.push({ left, right });
  }
  const currentOrder = spatialOrder(source.positions, source.count);
  for (const index of currentOrder) {
    if (available[index] !== 0) pairs.push({ left: index });
  }
  return pairs;
};

/**
 * Bounds candidate storage and conflict rounds to Morton-local work groups.
 * A 2M level otherwise retains millions of candidate records and can need many
 * whole-level nearest-neighbor rounds before the last unmatched splats pair.
 */
const selectPairing = (source: MutableLevel, targetCount: number): Pairing[] => {
  if (source.count <= PAIRING_GROUP_SIZE) return selectPairingSmall(source, targetCount);

  const order = spatialOrder(source.positions, source.count);
  const groupCount = Math.ceil(source.count / PAIRING_GROUP_SIZE);
  const scratch = allocateLikeLevel(PAIRING_GROUP_SIZE, source);
  const baseTargetCount = Math.ceil(source.count / 2);
  const extraTargets = targetCount - baseTargetCount;
  const totalExtraCapacity = Math.floor(source.count / 2);
  let cumulativeExtraCapacity = 0;
  let assignedExtras = 0;
  const pairs: Pairing[] = [];
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const from = groupIndex * PAIRING_GROUP_SIZE;
    const to = Math.min(source.count, from + PAIRING_GROUP_SIZE);
    scratch.count = to - from;
    cumulativeExtraCapacity += Math.floor(scratch.count / 2);
    const nextAssignedExtras =
      totalExtraCapacity === 0
        ? 0
        : Math.floor((cumulativeExtraCapacity * extraTargets) / totalExtraCapacity);
    const groupTarget = Math.ceil(scratch.count / 2) + nextAssignedExtras - assignedExtras;
    assignedExtras = nextAssignedExtras;
    for (let index = 0; index < scratch.count; index++) {
      copyLevelSplat(source, order[from + index] as number, scratch, index);
    }
    for (const pair of selectPairingSmall(scratch, groupTarget)) {
      pairs.push({
        left: order[from + pair.left] as number,
        ...(pair.right === undefined ? {} : { right: order[from + pair.right] }),
      });
    }
  }
  if (pairs.length !== targetCount)
    throw new Error('Static LOD grouped pairing count is inconsistent.');
  return pairs;
};

const populatePairedLevel = (
  source: MutableLevel,
  target: MutableLevel,
  pairing: readonly Pairing[],
): void => {
  if (pairing.length !== target.count) throw new Error('Static LOD pairing count is inconsistent.');
  for (let index = 0; index < pairing.length; index++) {
    const pair = pairing[index] as Pairing;
    if (pair.right === undefined) copyLevelSplat(source, pair.left, target, index);
    else mergePair(source, pair.left, pair.right, target, index);
  }
};

const reorderLevel = (source: MutableLevel, pairing: readonly Pairing[]): void => {
  const ordered = allocateLikeLevel(source.count, source);
  let index = 0;
  for (const pair of pairing) {
    copyLevelSplat(source, pair.left, ordered, index++);
    if (pair.right !== undefined) copyLevelSplat(source, pair.right, ordered, index++);
  }
  source.positions.set(ordered.positions);
  source.colors.set(ordered.colors);
  source.covariances.set(ordered.covariances);
  source.masses.set(ordered.masses);
  source.sizes.set(ordered.sizes);
  source.childCount.set(ordered.childCount);
  source.childStart.set(ordered.childStart);
  source.dominant.set(ordered.dominant);
  if (source.shLabels && ordered.shLabels) source.shLabels.set(ordered.shLabels);
  if (source.shPacked && ordered.shPacked) source.shPacked.set(ordered.shPacked);
};

const populateFinestLevel = (source: SplatData, order: Uint32Array, finest: MutableLevel): void => {
  if (finest.count === source.count) {
    for (let index = 0; index < source.count; index++) {
      copySourceSplat(source, order[index] as number, finest, index);
    }
    return;
  }

  // Bound the temporary records instead of constructing a second source-sized
  // hierarchy. Larger scenes are reduced in Morton-local groups, while small
  // reductions (including the 2M stadium ceiling) still compare the whole set.
  const groupCount = Math.min(finest.count, Math.ceil(source.count / SOURCE_REDUCTION_GROUP_SIZE));
  const largestGroup = Math.ceil(source.count / groupCount);
  const scratchA = allocateLevel(largestGroup, source);
  const scratchB = allocateLevel(largestGroup, source);
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const from = Math.floor((groupIndex * source.count) / groupCount);
    const to = Math.floor(((groupIndex + 1) * source.count) / groupCount);
    const outputFrom = Math.floor((groupIndex * finest.count) / groupCount);
    const outputTo = Math.floor(((groupIndex + 1) * finest.count) / groupCount);
    scratchA.count = to - from;
    for (let index = 0; index < scratchA.count; index++) {
      copySourceSplat(source, order[from + index] as number, scratchA, index);
    }
    let current = scratchA;
    let next = scratchB;
    const targetCount = outputTo - outputFrom;
    while (current.count > targetCount) {
      next.count = Math.max(targetCount, Math.ceil(current.count / 2));
      populatePairedLevel(current, next, selectPairing(current, next.count));
      [current, next] = [next, current];
    }
    for (let index = 0; index < current.count; index++) {
      copyLevelSplat(current, index, finest, outputFrom + index);
    }
  }
};

const populateParentLevel = (child: MutableLevel, parent: MutableLevel): void => {
  const pairing = selectPairing(child, parent.count);
  populatePairedLevel(child, parent, pairing);
  // Traversal requires an internal node's children to occupy one contiguous
  // range. Move the selected children into their parent order after sampling.
  reorderLevel(child, pairing);
  let childCursor = 0;
  for (let index = 0; index < pairing.length; index++) {
    const count = pairing[index]?.right === undefined ? 1 : 2;
    parent.childCount[index] = count;
    parent.childStart[index] = childCursor;
    childCursor += count;
  }
};

/**
 * Builds a deterministic, coverage-preserving binary splat hierarchy.
 *
 * Parents use Gaussian-mixture moment matching. The finest retained level is
 * capped before the hierarchy is materialized. The resident pool holds the
 * full tree (~2× that ceiling: finest + parents) so camera cuts can remap
 * active indices without rewriting splat attributes.
 */
/** @experimental Excluded from the v1.0 compatibility guarantee. */
export function buildStaticLod(
  source: SplatData,
  maxBudget: number,
  onProgress?: (progress: StaticLodBuildProgress) => void,
): StaticLodBuildResult {
  if (!Number.isFinite(maxBudget) || maxBudget < 1)
    throw new RangeError('Static LOD maxBudget must be a positive finite number.');
  validateStaticLodSource(source);
  if (source.count === 0)
    return { data: source, contentSplatCount: 0, finestSplatCount: 0, roots: new Uint32Array() };
  const ceiling = Math.max(1, Math.min(source.count, Math.floor(maxBudget)));
  onProgress?.({ completed: 0, total: source.count });
  const order = spatialOrder(source.positions, source.count);
  const levelCounts = [ceiling];
  while ((levelCounts.at(-1) ?? 0) > 1) {
    levelCounts.push(Math.ceil((levelCounts.at(-1) as number) / 2));
  }
  const totalCount = levelCounts.reduce((sum, count) => sum + count, 0);
  const positions = new Float32Array(totalCount * 3);
  const colors = new Uint8Array(totalCount * 4);
  const covariances = new Float32Array(totalCount * 6);
  const masses = new Float64Array(totalCount);
  const dominant = new Uint32Array(totalCount);
  const childCount = new Uint16Array(totalCount);
  const childStart = new Uint32Array(totalCount);
  const size = new Float32Array(totalCount);
  const labels = source.sh ? new Uint32Array(totalCount) : undefined;
  const coefficients = packedCoefficientCount(source);
  const packed = source.shPacked ? new Uint32Array(totalCount * coefficients) : undefined;
  const offsets: number[] = [];
  let offset = 0;
  const levels = levelCounts.map((count): MutableLevel => {
    offsets.push(offset);
    const start = offset;
    offset += count;
    return {
      count,
      positions: positions.subarray(start * 3, offset * 3),
      colors: colors.subarray(start * 4, offset * 4),
      covariances: covariances.subarray(start * 6, offset * 6),
      masses: masses.subarray(start, offset),
      sizes: size.subarray(start, offset),
      childCount: childCount.subarray(start, offset),
      childStart: childStart.subarray(start, offset),
      ...(labels ? { shLabels: labels.subarray(start, offset) } : {}),
      ...(packed
        ? {
            shPacked: packed.subarray(start * coefficients, offset * coefficients),
            packedStride: coefficients,
          }
        : {}),
      dominant: dominant.subarray(start, offset),
    };
  });
  populateFinestLevel(source, order, levels[0] as MutableLevel);
  onProgress?.({ completed: Math.floor(source.count * 0.6), total: source.count });
  for (let levelIndex = 1; levelIndex < levels.length; levelIndex++) {
    populateParentLevel(levels[levelIndex - 1] as MutableLevel, levels[levelIndex] as MutableLevel);
  }
  for (let levelIndex = 1; levelIndex < levels.length; levelIndex++) {
    const parent = levels[levelIndex] as MutableLevel;
    const parentOffset = offsets[levelIndex] as number;
    const childOffset = offsets[levelIndex - 1] as number;
    for (let index = 0; index < parent.count; index++) {
      childStart[parentOffset + index] = childOffset + (parent.childStart[index] as number);
    }
  }
  const radTree: RadTreeData = { childCount, childStart, size };
  const sh: SplatShData | undefined = source.sh && labels ? { ...source.sh, labels } : undefined;
  const shPacked: SplatPackedShData | undefined =
    source.shPacked && packed ? { ...source.shPacked, packed } : undefined;
  const data: SplatData = {
    count: totalCount,
    positions,
    colors,
    covariances,
    ...(sh ? { sh } : {}),
    ...(shPacked ? { shPacked } : {}),
    ...(source.antialias === undefined ? {} : { antialias: source.antialias }),
    ...(source.format === undefined ? {} : { format: source.format }),
    radTree,
  };
  onProgress?.({ completed: source.count, total: source.count });
  return {
    data,
    contentSplatCount: source.count,
    finestSplatCount: levels[0]?.count ?? 0,
    roots: Uint32Array.of(totalCount - 1),
  };
}
