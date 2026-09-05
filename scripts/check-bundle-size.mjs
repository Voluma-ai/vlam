#!/usr/bin/env node
/**
 * Bundle-size and package-boundary guard for the published library entries.
 *
 * Builds the library (unless `--no-build` is passed and `dist/index.js` is
 * already present) and fails when a gated entry's gzip size exceeds its
 * budget, or when an optional system has leaked into the wrong static graph.
 *
 * What counts is the **static import graph**, not one file: `dist/index.js`
 * statically imports the shared chunk holding `splat-mesh.ts` and friends, so
 * measuring the entry file alone under-reports the entry. Dynamic `import()`
 * is deliberately excluded: those chunks are fetched on demand.
 *
 * Each budget is ~15% above the measured size at the time it was last
 * reviewed - raise it deliberately, with a rationale, not as a reflex when the
 * check fires.
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Gzip budgets for the entries whose static graphs must stay small.
 *
 * Root was rebased after the package-boundary split (core renderer only).
 * `/loaders` is gated separately so static LOD or streaming cannot leak back
 * into the one-shot decode path.
 */
const BUDGET_GZIP_BYTES = {
  '.': 80_000,
  './loaders': 40_000,
  './static-lod': 80_000,
  './relighting': 50_000,
  './streaming': 160_000,
  './unified': 80_000,
  './selection': 20_000,
};

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');

if (!process.argv.includes('--no-build') || !existsSync(join(dist, 'index.js'))) {
  execSync('npm run build:lib', { cwd: root, stdio: 'inherit' });
}

/**
 * Static `import`/`export … from` specifiers in an emitted chunk.
 *
 * Requires whitespace after the keyword, which is what excludes dynamic
 * `import(` - the whole point of the walk. A false positive inside a string
 * literal (the inlined workers are string literals of module code) resolves to
 * a path that does not exist in `dist/`, and is dropped by the walk.
 */
const STATIC_IMPORT = /^\s*(?:import|export)\s(?:[^'"()]*?\sfrom\s*)?["']([^"']+)["']/gm;

/** Every chunk reachable from `entry` without crossing a dynamic import. */
function staticGraph(entry) {
  const seen = new Set();
  const external = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const [, specifier] of code.matchAll(STATIC_IMPORT)) {
      if (specifier.startsWith('.')) stack.push(resolve(dirname(file), specifier));
      else external.add(specifier);
    }
  }
  return { chunks: [...seen], external: [...external] };
}

function measure(entry) {
  const { chunks, external } = staticGraph(entry);
  let raw = 0;
  let gzip = 0;
  const code = [];
  for (const chunk of chunks) {
    const bytes = readFileSync(chunk);
    raw += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
    code.push(bytes.toString('utf8'));
  }
  return { chunks, external, raw, gzip, code: code.join('\n') };
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entries = Object.entries(pkg.exports)
  .filter(([, target]) => typeof target === 'object' && target.import)
  .map(([name, target]) => [name, resolve(root, target.import)]);

// A subpath added to `package.json#exports` and `scripts/vite.config.lib.ts` but not to
// `tsconfig.lib.json#include` builds a `.js` with no `.d.ts` beside it, and the
// entry resolves untyped for consumers. Cheap to check here, invisible otherwise.
const missing = Object.entries(pkg.exports)
  .filter(([, target]) => typeof target === 'object')
  .flatMap(([name, target]) =>
    ['import', 'types']
      .filter((field) => target[field] && !existsSync(resolve(root, target[field])))
      .map((field) => `  ${name} → ${field}: ${target[field]}`),
  );
if (missing.length > 0) {
  console.error(
    `bundle-size check failed: published entries missing from dist:\n${missing.join('\n')}`,
  );
  process.exit(1);
}

const rows = entries.map(([name, file]) => [name, measure(file)]);
const byName = Object.fromEntries(rows);
const width = Math.max(...rows.map(([name]) => name.length));

console.log('static import graph per published entry (three external, dynamic chunks excluded):\n');
for (const [name, { chunks, raw, gzip }] of rows) {
  const gate = name in BUDGET_GZIP_BYTES ? '  <- gated' : '';
  console.log(
    `  ${name.padEnd(width)}  ${String(chunks.length).padStart(2)} chunks  ` +
      `${raw.toLocaleString().padStart(9)} B raw  ${gzip.toLocaleString().padStart(8)} B gzip${gate}`,
  );
}

const failures = [];

function graphOf(name) {
  const row = byName[name];
  if (!row) {
    failures.push(`missing published entry "${name}"`);
    return { chunks: [], code: '', gzip: 0 };
  }
  return row;
}

function mustNotContain(name, needle, why) {
  if (graphOf(name).code.includes(needle)) {
    failures.push(`${name}: static graph contains ${JSON.stringify(needle)} (${why})`);
  }
}

function mustContain(name, needle, why) {
  if (!graphOf(name).code.includes(needle)) {
    failures.push(`${name}: static graph missing ${JSON.stringify(needle)} (${why})`);
  }
}

mustNotContain('.', 'parseSogDirectory', 'decode-worker/parser payload belongs in /loaders');
mustNotContain('.', 'rad-chunk', 'chunk decode formats belong in /loaders');
mustNotContain('.', 'Static LOD build aborted.', 'static LOD belongs in /static-lod');
mustNotContain('.', 'Proxy-mesh screen-space relighting', 'relighting belongs in /relighting');
mustNotContain('.', 'StreamedSplatMesh: maxBudget', 'streaming schedulers belong in /streaming');
mustNotContain(
  '.',
  'UnifiedSplatMesh requires a WebGPU backend',
  'unified work buffers belong in /unified',
);
mustNotContain('.', 'createSelectionVolume', 'selection volumes belong in /selection');

mustNotContain('./loaders', 'Static LOD build aborted.', 'static LOD must not leak into /loaders');
mustNotContain(
  './loaders',
  'Proxy-mesh screen-space relighting',
  'relighting must not leak into /loaders',
);
mustNotContain(
  './loaders',
  'StaticLodSplatMesh',
  'static LOD builder must not enter the default one-shot download',
);
mustNotContain(
  './loaders',
  'StreamedSplatMesh: maxBudget',
  'streaming must not leak into /loaders',
);
mustNotContain(
  './loaders',
  'getUnifiedSourceView',
  'SplatMesh runtime must not leak into /loaders',
);

mustContain('./loaders', 'rad-chunk', 'inlined streaming decode worker');
mustContain(
  './streaming',
  'StreamedSplatMesh: maxBudget',
  'streaming entry owns StreamedSplatMesh',
);
mustContain(
  './static-lod',
  'Static LOD build aborted.',
  'static-lod entry owns StaticLodSplatMesh',
);
mustContain('./relighting', 'attachRelighting', 'relighting entry owns the display attachment');
mustContain(
  './unified',
  'UnifiedSplatMesh requires a WebGPU backend',
  'unified entry owns the compositor',
);
mustContain('./selection', 'createSelectionVolume', 'selection entry owns volume tests');

const distJs = [];
function walkDist(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) walkDist(path);
    else if (name.name.endsWith('.js')) distJs.push(path);
  }
}
walkDist(dist);
const allDist = distJs.map((file) => readFileSync(file, 'utf8')).join('\n');
if (!allDist.includes('parseSpz')) {
  failures.push('no published chunk contains parseSpz; one-shot worker is unreachable');
}
if (!allDist.includes('import("./formats/lcc.js")')) {
  failures.push('no published chunk lazy-loads formats/lcc.js');
}
if (!allDist.includes('import("./formats/rad.js")')) {
  failures.push('no published chunk lazy-loads formats/rad.js');
}

console.log(`\n"${'.'}" chunks:`);
for (const chunk of graphOf('.').chunks) {
  console.log(`  ${relative(root, chunk).replaceAll('\\', '/')}`);
}
console.log(`\n"./loaders" chunks:`);
for (const chunk of graphOf('./loaders').chunks) {
  console.log(`  ${relative(root, chunk).replaceAll('\\', '/')}`);
}

for (const [name, budget] of Object.entries(BUDGET_GZIP_BYTES)) {
  const { gzip } = graphOf(name);
  const pct = ((gzip / budget) * 100).toFixed(1);
  console.log(`\n${name} budget: ${budget.toLocaleString()} B gzip (${pct}% used)`);
  if (gzip > budget) {
    failures.push(
      `${name}: gzip size exceeds budget by ${(gzip - budget).toLocaleString()} B ` +
        `(${gzip.toLocaleString()} > ${budget.toLocaleString()})`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\nbundle-size check failed:\n${failures.map((line) => `  - ${line}`).join('\n')}`);
  process.exit(1);
}
console.log('\nbundle-size check passed');
