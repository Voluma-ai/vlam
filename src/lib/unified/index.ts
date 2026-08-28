/**
 * `@voluma/vlam/unified` - one WebGPU draw over several splat sources.
 *
 * {@link UnifiedSplatMesh} concatenates static and streamed meshes into a
 * shared work buffer so overlapping clouds inter-sort. WebGL2 is unsupported;
 * {@link supportsUnifiedSplatMesh} reports that after renderer init.
 *
 * @module unified
 */
export {
  UnifiedSplatMesh,
  supportsUnifiedSplatMesh,
  type UnifiedSplatPickResult,
  type UnifiedSplatMeshOptions,
  type UnifiedSplatSourceOptions,
} from './unified-splat-mesh';
export {
  estimateLargestStorageBufferBytes,
  estimateUnifiedWorkBufferBytes,
  estimateUnifiedWorkBufferPeakBytes,
  WORK_BUFFER_CENTERS_BYTES_PER_SPLAT,
  WORK_BUFFER_BYTES_PER_SLOT,
} from './unified-work-buffer';
