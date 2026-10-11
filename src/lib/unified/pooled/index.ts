/**
 * `@voluma/vlam/unified/pooled` - one CPU-sorted draw over several splat
 * sources that share a {@link SplatPool}; the WebGL2-capable counterpart of
 * `@voluma/vlam/unified`.
 *
 * {@link PooledUnifiedSplatMesh} concatenates the sources' active lists into
 * one worker sort keyed by each source's world matrix and draws the pool rows
 * directly, so overlapping clouds inter-sort without compute passes. Load it
 * only where the compute path is unavailable ({@link supportsUnifiedSplatMesh}
 * answers `false`); hosts on WebGPU keep `UnifiedSplatMesh`.
 *
 * @module unified/pooled
 */
export {
  PooledUnifiedSplatMesh,
  supportsPooledUnifiedSplatMesh,
  type PooledUnifiedSplatMeshOptions,
  type PooledUnifiedSourceOptions,
  type PooledUnifiedPerformanceTimings,
} from './pooled-unified-splat-mesh';
