import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = new URL('../.tmp/benchmark-assets/', import.meta.url);
const source = 'https://assets.voluma.ai/jack/v/Langenthal-Manola4A.sog';
await mkdir(root, { recursive: true });

function metadata(bytes) {
  for (let i = Math.max(0, bytes.length - 65557); i < bytes.length - 46; i++) {
    if (bytes.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLength = bytes.readUInt16LE(i + 28);
    if (bytes.toString('utf8', i + 46, i + 46 + nameLength) !== 'meta.json') continue;
    const offset = bytes.readUInt32LE(i + 42);
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const data = bytes.subarray(start, start + bytes.readUInt32LE(i + 20));
    const method = bytes.readUInt16LE(i + 10);
    if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression');
    return JSON.parse((method === 8 ? inflateRawSync(data) : data).toString('utf8'));
  }
  throw new Error('SOG meta.json not found');
}

for (const name of ['Langenthal-Manola4A', 'goose']) {
  const file = new URL(`${name}.sog`, root);
  const cached = await readFile(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  let bytes = cached;
  if (!bytes) {
    if (name === 'goose') {
      bytes = await readFile(new URL('../assets/goose.sog', import.meta.url));
    } else {
      console.log(`Downloading ${source}`);
      const response = await fetch(source);
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
  }
  const meta = metadata(bytes);
  if (meta.version !== 2) throw new Error('Expected a SOG v2 capture');
  const unlog = (n) => Math.sign(n) * Math.expm1(Math.abs(n));
  const min = meta.means.mins.map(unlog);
  const max = meta.means.maxs.map(unlog);
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  // Both viewers use the same source bounds, independent of decoder packing.
  const radius = Math.max(0.1, Math.hypot(...max.map((value, axis) => value - min[axis])) / 2);
  const target = [center[0], -center[1], -center[2]];
  const manifest = {
    source: name === 'goose' ? 'assets/goose.sog' : source,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    count: meta.count,
    shBands: meta.shN?.bands ?? 0,
    // This capture's origin is a verified interior view. Its exterior bounds include floaters.
    camera:
      name === 'Langenthal-Manola4A'
        ? { position: [0, 0, 0], target: [0, 0, -1] }
        : { target, position: [target[0], target[1], target[2] + radius * 2.5] },
  };
  if (!cached) {
    await writeFile(new URL(`${name}.sog.partial`, root), bytes);
    await rename(new URL(`${name}.sog.partial`, root), file);
  }
  await writeFile(new URL(`${name}.json`, root), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${name}: ${manifest.count} splats, SHA-256 ${manifest.sha256}`);
  console.log(`Camera: ${JSON.stringify(manifest.camera)}`);
}
console.log(`Cache: ${fileURLToPath(root)}`);
