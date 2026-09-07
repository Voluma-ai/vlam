import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const supplied = path.resolve(process.argv[2] ?? path.join(repository, '../splatstest'));
const output = path.join(repository, '.tmp/supplied-benchmark');
const locked = path.join(output, 'locked');
const candidate = path.join(output, 'candidate');
const artifacts = path.join(output, 'artifacts');
const ignored = new Set(['.git', '.DS_Store', 'dist', 'node_modules']);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function files(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(root, absolute)));
    else if (entry.isFile()) result.push(path.relative(root, absolute));
  }
  return result.sort();
}

async function hashes(root) {
  return Object.fromEntries(
    await Promise.all(
      (await files(root)).map(async (relative) => [
        relative,
        sha256(await readFile(path.join(root, relative))),
      ]),
    ),
  );
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}).`);
}

async function packageIdentity(workspace, name) {
  const root = path.join(workspace, 'node_modules', ...name.split('/'));
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const entries = await hashes(root);
  return {
    name,
    version: metadata.version,
    treeSha256: sha256(JSON.stringify(entries)),
    files: Object.keys(entries).length,
  };
}

await stat(path.join(supplied, 'package-lock.json'));
const before = await hashes(supplied);
await rm(output, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
for (const destination of [locked, candidate]) {
  await cp(supplied, destination, {
    recursive: true,
    filter: (source) => !ignored.has(path.basename(source)),
  });
  run('npm', ['ci'], destination);
}

run('npm', ['run', 'build:lib'], repository);
const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', artifacts], {
  cwd: repository,
  encoding: 'utf8',
});
if (pack.error) throw pack.error;
if (pack.status !== 0) throw new Error(pack.stderr || 'npm pack failed.');
const jsonStart = Math.max(pack.stdout.lastIndexOf('\n[') + 1, 0);
const packed = JSON.parse(pack.stdout.slice(jsonStart))[0];
const tarball = path.join(artifacts, packed.filename);
run('npm', ['install', '--no-save', '--package-lock=false', tarball], candidate);
run('npm', ['run', 'build'], locked);
run('npm', ['run', 'build'], candidate);

const after = await hashes(supplied);
if (JSON.stringify(before) !== JSON.stringify(after))
  throw new Error('The supplied project changed while preparing benchmark workspaces.');

const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  suppliedProject: supplied,
  sourceUnchanged: true,
  sourceBefore: before,
  sourceAfter: after,
  workspaces: { locked, candidate },
  lockedDependencies: {
    vlam: await packageIdentity(locked, '@voluma/vlam'),
    spark: await packageIdentity(locked, '@sparkjsdev/spark'),
    three: await packageIdentity(locked, 'three'),
  },
  candidateDependencies: {
    vlam: await packageIdentity(candidate, '@voluma/vlam'),
    spark: await packageIdentity(candidate, '@sparkjsdev/spark'),
    three: await packageIdentity(candidate, 'three'),
  },
  candidatePackage: {
    filename: packed.filename,
    sha256: sha256(await readFile(tarball)),
    bytes: (await stat(tarball)).size,
  },
  dependencyDifference: 'Only node_modules/@voluma/vlam is replaced in the candidate workspace.',
};
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared locked and packaged-candidate apps in ${output}`);
console.log(`Manifest: ${path.join(output, 'manifest.json')}`);
