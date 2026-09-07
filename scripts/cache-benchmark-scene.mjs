import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = new URL('../.tmp/benchmark-assets/', import.meta.url);
const tempelSource = 'https://assets.voluma.ai/voluma/cultural-heritage/Tempel/Tempel.lcc2';
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

async function cachedOrDownload(file, source, label) {
  const cached = await readFile(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (cached) return cached;
  console.log(`Downloading ${label}`);
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} (${source})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(new URL('.', file), { recursive: true });
  await writeFile(new URL(`${file.href}.partial`, file), bytes);
  await rename(new URL(`${file.href}.partial`, file), file);
  return bytes;
}

function hashFiles(entries) {
  const hash = createHash('sha256');
  for (const [name, bytes] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

{
  const file = new URL('goose.sog', root);
  const cached = await readFile(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const bytes = cached ?? (await readFile(new URL('../assets/goose.sog', import.meta.url)));
  const meta = metadata(bytes);
  if (meta.version !== 2) throw new Error('Expected a SOG v2 capture');
  const unlog = (n) => Math.sign(n) * Math.expm1(Math.abs(n));
  const min = meta.means.mins.map(unlog);
  const max = meta.means.maxs.map(unlog);
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  const radius = Math.max(0.1, Math.hypot(...max.map((value, axis) => value - min[axis])) / 2);
  const target = [center[0], -center[1], -center[2]];
  const manifest = {
    source: 'assets/goose.sog',
    file: 'goose.sog',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    count: meta.count,
    shBands: meta.shN?.bands ?? 0,
    camera: { target, position: [target[0], target[1], target[2] + radius * 2.5] },
  };
  if (!cached) {
    await writeFile(new URL('goose.sog.partial', root), bytes);
    await rename(new URL('goose.sog.partial', root), file);
  }
  await writeFile(new URL('goose.json', root), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`goose: ${manifest.count} splats, SHA-256 ${manifest.sha256}`);
  console.log(`Camera: ${JSON.stringify(manifest.camera)}`);
}

{
  const manifestFile = new URL('Tempel/Tempel.lcc2', root);
  const lcc2 = JSON.parse(
    (await cachedOrDownload(manifestFile, tempelSource, tempelSource)).toString('utf8'),
  );
  const splatFiles = lcc2.root?.splatFiles;
  if (!Array.isArray(splatFiles) || splatFiles.some((name) => typeof name !== 'string'))
    throw new Error('Tempel.lcc2 is missing splatFiles');
  const base = new URL('./', tempelSource);
  const entries = [['Tempel/Tempel.lcc2', await readFile(manifestFile)]];
  let peek;
  const env = lcc2.root?.data?.env?.name;
  for (const [index, name] of splatFiles.entries()) {
    const bytes = await cachedOrDownload(
      new URL(`Tempel/${name}`, root),
      new URL(name, base).href,
      name,
    );
    entries.push([`Tempel/${name}`, bytes]);
    if (peek || index === env) continue;
    peek = metadata(bytes);
  }
  if (!peek) throw new Error('Tempel.lcc2 has no non-environment SOG tile to peek');
  if (peek.version !== 2) throw new Error('Expected a SOG v2 tile');
  const bytes = entries.reduce((sum, [, data]) => sum + data.length, 0);
  const manifest = {
    source: tempelSource,
    file: 'Tempel/Tempel.lcc2',
    sha256: hashFiles(entries),
    bytes,
    count: lcc2.totalSplats,
    shBands: peek.shN?.bands ?? 0,
    lodSplats: lcc2.lodSplats,
    // Docs-example interior view, already in the LCC2→Three basis both engines use.
    camera: { position: [-9.09, 1.65, 8.85], target: [-8.21, 1.67, 7.06] },
  };
  await writeFile(new URL('Tempel.json', root), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Tempel: ${manifest.count} splats, SHA-256 ${manifest.sha256}`);
  console.log(`Camera: ${JSON.stringify(manifest.camera)}`);
}

console.log(`Cache: ${fileURLToPath(root)}`);
