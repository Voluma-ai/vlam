// Guide sample: docs/guide/loading-scenes.md - auto-detection, explicit
// format, and direct parsing through a format subpath.
import { SplatMesh } from '@voluma/vlam';
import { loadScene } from '@voluma/vlam/loaders';
import { parseSog } from '@voluma/vlam/formats/sog';
import { parseSpz } from '@voluma/vlam/formats/spz';

// Auto-detection: the URL pathname's extension picks the parser
// (query strings are fine).
const auto = new SplatMesh(await loadScene('/captures/garden.ply?v=3'));

// Explicit format: when the URL carries no useful extension.
const explicit = new SplatMesh(await loadScene('/api/scene/42', { format: 'sog' }));

// Direct parsing: hand bytes you already have to a parser. Every parser lives
// on a subpath, so none of them enter your bundle unless you import them.
const sogData = await parseSog(await (await fetch('/scene.sog')).arrayBuffer());
const spzData = await parseSpz(await (await fetch('/scene.spz')).arrayBuffer());

export { auto, explicit, sogData, spzData };
