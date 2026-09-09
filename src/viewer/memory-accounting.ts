import {
  estimateSplatPoolBytes,
  type SplatData,
  type SplatSortStrategy,
  type SplatStorageMode,
} from '../lib/core';

/** Byte counts for the arrays owned by one decoded {@link SplatData}. */
export interface DecodedSplatMemory {
  readonly coreBytes: number;
  readonly sphericalHarmonicsBytes: number;
  readonly lodBytes: number;
  readonly totalBytes: number;
}

/** Estimated persistent allocations attached to one rendered splat mesh. */
export interface MeshMemoryEstimate {
  readonly cpuBackingBytes: number;
  readonly releasedCpuBackingBytes: number;
  readonly gpuBytes: number;
  readonly totalBytes: number;
  readonly paletteBytesPerSide: number;
}

/** Counts every typed-array view retained by decoded splat data. */
export function decodedSplatMemory(data: SplatData): DecodedSplatMemory {
  const coreBytes =
    data.positions.byteLength + data.colors.byteLength + data.covariances.byteLength;
  const sphericalHarmonicsBytes =
    (data.sh?.labels.byteLength ?? 0) +
    (data.sh?.palette.byteLength ?? 0) +
    (data.shPacked?.packed.byteLength ?? 0) +
    (data.radShCodebook?.coefficients.byteLength ?? 0);
  const lodBytes =
    (data.radTree?.childCount.byteLength ?? 0) +
    (data.radTree?.childStart.byteLength ?? 0) +
    (data.radTree?.size.byteLength ?? 0) +
    (data.frontierParent?.byteLength ?? 0);
  return {
    coreBytes,
    sphericalHarmonicsBytes,
    lodBytes,
    totalBytes: coreBytes + sphericalHarmonicsBytes + lodBytes,
  };
}

/**
 * Splits the existing pool estimator into CPU and GPU figures for benchmark
 * reports. Palette SH is outside the packed pool, so its image is added once
 * on each side when the mesh actually renders it.
 */
export function estimateMeshMemory(
  capacity: number,
  options: {
    readonly floatTextures: 'float32' | 'float16';
    readonly packedShBands: 0 | 1 | 2 | 3;
    readonly sortStrategy: SplatSortStrategy;
    readonly storageMode?: SplatStorageMode;
    readonly paletteBytes?: number;
  },
): MeshMemoryEstimate {
  const estimateOptions = {
    capacityFactor: 1,
    floatTextures: options.floatTextures,
    shBands: options.packedShBands,
    sortStrategy: options.sortStrategy,
  } as const;
  const poolGpuBytes = estimateSplatPoolBytes(capacity, {
    ...estimateOptions,
    includeCpuBacking: false,
  });
  const poolTotalBytes = estimateSplatPoolBytes(capacity, estimateOptions);
  const paletteBytesPerSide = options.paletteBytes ?? 0;
  const gpuBytes = poolGpuBytes + paletteBytesPerSide;
  const editableCpuBackingBytes = poolTotalBytes - poolGpuBytes + paletteBytesPerSide;
  const releasedCpuBackingBytes =
    options.storageMode === 'render-only' ? editableCpuBackingBytes : 0;
  const cpuBackingBytes = editableCpuBackingBytes - releasedCpuBackingBytes;
  return {
    cpuBackingBytes,
    releasedCpuBackingBytes,
    gpuBytes,
    totalBytes: cpuBackingBytes + gpuBytes,
    paletteBytesPerSide,
  };
}
