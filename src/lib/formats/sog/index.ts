/**
 * `@voluma/vlam/formats/sog` - PlayCanvas SOG (v2) decoder, for both the
 * bundled `.sog` ZIP and the unbundled directory form Streamed SOG chunks use.
 *
 * Loading through {@link loadSplatData} / {@link StreamedSplatMesh.load} does not
 * require this import; the loading worker already knows this format. Use this
 * subpath for direct decode outside the default loaders.
 */
export { parseSog, parseSogDirectory } from './parse-sog';
