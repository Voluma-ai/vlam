/**
 * `@voluma/vlam/formats/ply` - 3DGS `.ply` parser, raw and compressed
 * (SuperSplat / PlayCanvas) flavors alike.
 *
 * Loading through {@link loadSplatData} / {@link loadSplatDataFile} does not require
 * this import; the loading worker already knows this format. Use this subpath
 * for direct decode outside the default loaders.
 *
 * `parseSplatPlyFile` - the streamed local-file reader - stays internal: it is
 * the worker's path for a dropped `.ply` and was never part of the main entry.
 */
export { parseSplatPly } from './parse-splat-ply';
