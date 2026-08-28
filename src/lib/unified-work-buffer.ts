/**
 * Byte costs of {@link UnifiedSplatRenderer}'s GPU work buffer.
 *
 * Kept off the core entry so hosts that never composite sources do not pay
 * for the accounting, and so the numbers cannot drift from the renderer
 * that allocates those buffers.
 */

/** Bytes per splat in the largest unified work-buffer attribute (RGBA32F centers). */
export const WORK_BUFFER_CENTERS_BYTES_PER_SPLAT = 16;

/**
 * Bytes per work-buffer slot across *all* of its attributes: centers, colors,
 * covarianceA and covarianceB at RGBA32F (16 each), plus the isotropic mix and
 * screen-radius scalars (4 each).
 */
export const WORK_BUFFER_BYTES_PER_SLOT = 16 * 4 + 4 * 2;

function assertNonNegativeCapacity(capacity: number): void {
  if (!Number.isFinite(capacity) || capacity < 0) {
    throw new RangeError('Splat capacity must be a non-negative finite number.');
  }
}

/**
 * Byte size of the largest single storage-buffer bind VLAM allocates for a
 * given splat capacity (unified work-buffer centers: `capacity × 16`).
 *
 * Use with adapter/device limits to decide whether to raise `requiredLimits`
 * or lower the budget before constructing {@link UnifiedSplatRenderer}.
 */
export function estimateLargestStorageBufferBytes(capacity: number): number {
  assertNonNegativeCapacity(capacity);
  return Math.floor(capacity) * WORK_BUFFER_CENTERS_BYTES_PER_SPLAT;
}

/**
 * Estimates what a {@link UnifiedSplatRenderer}'s work buffer costs, in bytes,
 * once the scene has rendered a frame.
 *
 * This used to be double the figure below, and the doubling was not a detail.
 * Every `THREE.StorageBufferAttribute` is constructed around a JS typed array,
 * and three's WebGPU backend never releases it: the
 * `attribute.onUploadCallback()` call that would is missing from the backend's
 * buffer upload path. So a work buffer of N slots cost
 * N × {@link WORK_BUFFER_BYTES_PER_SLOT} on the GPU *and* the same again on the
 * JS heap, permanently, even though nothing ever reads the CPU copy back - the
 * gather pass writes these buffers entirely on the GPU.
 *
 * `WorkBuffer.releaseCpuMirrors` now drops those mirrors after the first
 * dispatch that uploads them (see `storage-attribute-mirror`), so steady state
 * is the GPU side alone. The *peak* is still double - the array has to exist
 * for the upload copy - which is what
 * {@link estimateUnifiedWorkBufferPeakBytes} reports.
 *
 * Either figure is invisible to `estimateSplatPoolBytes`, which prices the
 * splat *pool* and knows nothing about the unified renderer's scratch space. A
 * host sizing a scene for a memory-constrained device wants both.
 *
 * @param capacity - Work-buffer capacity in splats.
 * @returns Estimated steady-state bytes.
 * @throws {RangeError} if `capacity` is not a non-negative finite number.
 */
export function estimateUnifiedWorkBufferBytes(capacity: number): number {
  assertNonNegativeCapacity(capacity);
  return Math.floor(capacity) * WORK_BUFFER_BYTES_PER_SLOT;
}

/**
 * Peak bytes a {@link UnifiedSplatRenderer}'s work buffer occupies: the window
 * between construction and the first dispatch, while the GPU buffer and the JS
 * array three copied it from are both alive.
 *
 * Ask this one when the question is "will allocating this scene succeed" - an
 * out-of-memory failure happens against the peak. Ask
 * {@link estimateUnifiedWorkBufferBytes} when the question is "what will this
 * scene hold once it is up".
 *
 * @param capacity - Work-buffer capacity in splats.
 * @returns Estimated bytes, GPU plus the not-yet-released CPU mirror.
 * @throws {RangeError} if `capacity` is not a non-negative finite number.
 */
export function estimateUnifiedWorkBufferPeakBytes(capacity: number): number {
  return estimateUnifiedWorkBufferBytes(capacity) * 2;
}
