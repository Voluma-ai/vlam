/**
 * `@voluma/vlam/formats/csgs` - Faltwerk `.csgs` (CurveStream-GS) 4D Gaussian
 * splat sections.
 *
 * A proof of concept: {@link CsgsDecoder} decodes version-1 sections,
 * {@link prepareCsgsSection} dequantizes one for playback, and
 * {@link evaluateCsgsFrame} evaluates it at a frame time into `SplatData` for
 * a dynamic-capacity `SplatMesh`. The default loaders do not know this format;
 * hosts drive section fetching and frame timing themselves.
 *
 * @experimental The API may change in a minor release.
 * @module formats/csgs
 */
export {
  CsgsDecoder,
  decodeCsgsSection,
  parseCsgsHeader,
  csgsStateAfter,
  csgsCrc32,
  type CsgsGroup,
  type CsgsParams,
  type CsgsSection,
  type CsgsState,
} from './parse-csgs';
export {
  prepareCsgsSection,
  evaluateCsgsFrame,
  createCsgsFrameBuffers,
  csgsShExtent,
  type CsgsPlaybackSection,
  type CsgsFrameBuffers,
  type CsgsFrameOptions,
} from './csgs-frame';
