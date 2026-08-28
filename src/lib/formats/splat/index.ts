/**
 * `@voluma/vlam/formats/splat` - antimatter15 `.splat` parser.
 *
 * Loading through {@link loadSplatData} / {@link loadSplatDataFile} does not require
 * this import; the loading worker already knows this format. Use this subpath
 * for direct decode outside the default loaders.
 */
export { parseSplat } from './parse-splat';
