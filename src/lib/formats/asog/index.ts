/**
 * `@voluma/vlam/formats/asog` - Animated SOG (`.asog`) 4D Gaussian splat
 * clips: SOG v2 static attributes plus a TRiGS rigid-body motion per splat,
 * in one file ([format v1](https://github.com/arrival-space/animated-sog/blob/main/docs/format.md)).
 *
 * {@link parseAsog} decodes a whole file into flat arrays,
 * {@link evaluateAsogFrame} evaluates them at a time into `SplatData`-shaped
 * buffers. Three-free and worker-safe. To play a clip, use
 * `loadSplatClip` from `@voluma/vlam/dynamic`.
 *
 * @experimental The API may change in a minor release.
 * @module formats/asog
 */
export {
  ASOG_HEADER_SIZE,
  ASOG_MAGIC,
  asogShBands,
  isAsogFile,
  parseAsogHeader,
  parseAsogManifest,
  type AsogClipDesc,
  type AsogHeader,
  type AsogManifest,
  type AsogMotionParams,
  type AsogStreamDesc,
} from './asog-container';
export {
  ASOG_CLIP_FLOATS,
  ASOG_MOTION,
  ASOG_MOTION_FLOATS,
  parseAsog,
  type AsogData,
} from './parse-asog';
export {
  ASOG_LIFE_SIGMAS,
  ASOG_TEMPORAL_THRESHOLD,
  asogClipLocalTime,
  asogClipWeight,
  asogMotionBounds,
  asogTemporalWeight,
  createAsogFrameBuffers,
  evaluateAsogFrame,
  evaluateAsogSplat,
  writeAsogCanonical,
  type AsogFrameBuffers,
} from './asog-motion';
