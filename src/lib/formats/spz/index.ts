/**
 * `@voluma/vlam/formats/spz` - Niantic `.spz` parser.
 *
 * Loading through {@link loadScene} / {@link loadSceneFile} does not require
 * this import; the loading worker already knows this format. Use this subpath
 * for direct decode outside the default loaders.
 */
export { parseSpz } from './parse-spz';
