import type { RadTreeData, SplatData, SplatPackedShData, SplatShData } from './splat-data';
import { shCoefficientCount } from './sh-pack';

/** Progress emitted while a static scene is spatially ordered and merged. */
export interface StaticLodBuildProgress {
  readonly completed: number;
  readonly total: number;
}

/** Result consumed by {@link StaticLodSplatMesh}. */
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
  shLabels?: Uint32Array;
  shPacked?: Uint32Array;
  packedStride?: number;
  dominant: Uint32Array;
};

const MORTON_BITS = 10;
const MORTON_BUCKETS = 1 << MORTON_BITS;
const COVARIANCE_EPSILON = 1e-18;

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
  ...(data.sh ? { shLabels: new Uint32Array(count) } : {}),
  ...(data.shPacked
    ? {
        shPacked: new Uint32Array(count * packedCoefficientCount(data)),
        packedStride: packedCoefficientCount(data),
      }
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

const mergeRange = (
  source: MutableLevel,
  from: number,
  to: number,
  target: MutableLevel,
  targetIndex: number,
): void => {
  let totalMass = 0;
  let dominant = from;
  let dominantMass = -1;
  const mean = [0, 0, 0];
  const color = [0, 0, 0];
  for (let index = from; index < to; index++) {
    const mass = source.masses[index] as number;
    totalMass += mass;
    if (mass > dominantMass) {
      dominantMass = mass;
      dominant = index;
    }
    for (let axis = 0; axis < 3; axis++) {
      mean[axis] = (mean[axis] as number) + (source.positions[index * 3 + axis] as number) * mass;
      color[axis] = (color[axis] as number) + (source.colors[index * 4 + axis] as number) * mass;
    }
  }
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
  for (let index = from; index < to; index++) {
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
  }
  for (let component = 0; component < 6; component++) {
    target.covariances[targetIndex * 6 + component] = (covariance[component] as number) / safeMass;
  }
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

const populateFinestLevel = (source: SplatData, order: Uint32Array, finest: MutableLevel): void => {
  if (finest.count === source.count) {
    for (let index = 0; index < source.count; index++) {
      copySourceSplat(source, order[index] as number, finest, index);
    }
    return;
  }

  // Reuse a group-sized scratch level rather than materializing a second full,
  // spatially sorted copy of a capture. That peak allocation matters for the
  // 16M+ scenes this hierarchy is intended to make practical.
  const largestGroup = Math.ceil(source.count / finest.count);
  const group = allocateLevel(largestGroup, source);
  for (let index = 0; index < finest.count; index++) {
    const from = Math.floor((index * source.count) / finest.count);
    const to = Math.max(from + 1, Math.floor(((index + 1) * source.count) / finest.count));
    group.count = to - from;
    for (let groupIndex = 0; groupIndex < group.count; groupIndex++) {
      copySourceSplat(source, order[from + groupIndex] as number, group, groupIndex);
    }
    mergeRange(group, 0, group.count, finest, index);
  }
};

const populateParentLevel = (child: MutableLevel, parent: MutableLevel): void => {
  for (let index = 0; index < parent.count; index++)
    mergeRange(child, index * 2, Math.min(child.count, index * 2 + 2), parent, index);
};

/**
 * Builds a deterministic, coverage-preserving binary splat hierarchy.
 *
 * Parents use Gaussian-mixture moment matching. The finest retained level is
 * capped before the hierarchy is materialized. The resident pool holds the
 * full tree (~2× that ceiling: finest + parents) so camera cuts can remap
 * active indices without rewriting splat attributes.
 */
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
    const child = levels[levelIndex - 1] as MutableLevel;
    const parentOffset = offsets[levelIndex] as number;
    const childOffset = offsets[levelIndex - 1] as number;
    for (let index = 0; index < parent.count; index++) {
      const count = Math.min(2, child.count - index * 2);
      childCount[parentOffset + index] = count;
      childStart[parentOffset + index] = childOffset + index * 2;
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
