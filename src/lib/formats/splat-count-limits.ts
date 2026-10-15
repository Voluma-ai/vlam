/**
 * Splat-count ceilings shared by the whole-file parsers and the loaders.
 *
 * Two limits, for two different reasons:
 *
 * - {@link MAX_DRAWABLE_SPLATS} is what one `SplatMesh` can draw: its pool
 *   textures are 2048 wide × 8192 rows on a default WebGPU device, and the
 *   float32 `splatIndex` attribute is exact only up to 2²⁴. A whole-file scene
 *   above it is thinned by the loaders (`limitSplatCount`), not rejected.
 * - {@link MAX_DECODED_SPLATS} bounds an untrusted header's count before a
 *   parser sizes any allocation from it. It is twice the drawable ceiling: past
 *   that, thinning would drop more than half the scene and the file belongs in
 *   a streamed format instead.
 */

/** The most splats one `SplatMesh` can draw (2²⁴). */
export const MAX_DRAWABLE_SPLATS = 1 << 24;

/** The most splats a whole-file parser will decode before thinning (2²⁵). */
export const MAX_DECODED_SPLATS = 1 << 25;
