/**
 * `@voluma/vlam/unified` - one WebGPU draw over several splat sources.
 *
 * {@link UnifiedSplatRenderer} concatenates static and streamed meshes into a
 * shared work buffer so overlapping clouds inter-sort. WebGL2 is unsupported;
 * {@link supportsUnifiedSplatRenderer} reports that after renderer init.
 *
 * @module unified
 */
export {
  UnifiedSplatRenderer,
  supportsUnifiedSplatRenderer,
  type UnifiedSplatPickResult,
  type UnifiedSplatRendererOptions,
  type UnifiedSplatSourceOptions,
} from './unified-splat-renderer';
export {
  estimateLargestStorageBufferBytes,
  estimateUnifiedWorkBufferBytes,
  estimateUnifiedWorkBufferPeakBytes,
  WORK_BUFFER_CENTERS_BYTES_PER_SPLAT,
  WORK_BUFFER_BYTES_PER_SLOT,
} from './unified-work-buffer';
