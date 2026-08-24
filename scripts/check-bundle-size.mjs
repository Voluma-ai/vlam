#!/usr/bin/env node
/**
 * Bundle-size guard for the published library entries.
 *
 * Builds the library (unless `--no-build` is passed and `dist/index.js` is
 * already present) and fails when the main entry's gzip size exceeds the
 * budget.
 *
 * What counts is the **static import graph**, not one file: `dist/index.js`
 * statically imports the shared chunk holding `splat-mesh.ts` and friends, so
 * measuring the entry file alone under-reports the entry by about a third -
 * which is how the budget ended up chasing a number that could not explain its
 * own growth. Dynamic `import()` is deliberately excluded: those chunks are
 * fetched on demand and are not part of what a consumer pays to import the
 * entry.
 *
 * The budget is set ~15% above the measured size at the time it was last
 * reviewed - raise it deliberately, with a rationale, not as a reflex when the
 * check fires.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Gzip bytes allowed for the `.` entry's static graph.
 *
 * Rebased after the M12-M18 renderer work measured 123,655 B on 2026-08-09;
 * 142,500 B restores the guard's documented ~15% review headroom. The mobile
 * HUD diagnostics account for only 77 B of that graph (the parent measured
 * 123,578 B), so this records accumulated shipped capability rather than
 * disguising the diagnostics as the source of the overage.
 */
const BUDGET_GZIP_BYTES = 142_500;

/** The entry the budget gates; every other export is reported, not gated. */
const GATED_ENTRY = '.';

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
  for (const chunk of chunks) {
    const bytes = readFileSync(chunk);
    raw += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
  }
  return { chunks, external, raw, gzip };
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entries = Object.entries(pkg.exports)
  .filter(([, target]) => typeof target === 'object' && target.import)
  .map(([name, target]) => [name, resolve(root, target.import)]);

// A subpath added to `package.json#exports` and `vite.config.lib.ts` but not to
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
const width = Math.max(...rows.map(([name]) => name.length));

console.log('static import graph per published entry (three external, dynamic chunks excluded):\n');
for (const [name, { chunks, raw, gzip }] of rows) {
  const gate = name === GATED_ENTRY ? '  <- gated' : '';
  console.log(
    `  ${name.padEnd(width)}  ${String(chunks.length).padStart(2)} chunks  ` +
      `${raw.toLocaleString().padStart(9)} B raw  ${gzip.toLocaleString().padStart(8)} B gzip${gate}`,
  );
}

const gated = rows.find(([name]) => name === GATED_ENTRY);
if (!gated) {
  console.error(`bundle-size check failed: no "${GATED_ENTRY}" entry in package.json#exports.`);
  process.exit(1);
}
const { chunks, gzip } = gated[1];
const pct = ((gzip / BUDGET_GZIP_BYTES) * 100).toFixed(1);

console.log(`\n"${GATED_ENTRY}" chunks:`);
for (const chunk of chunks) console.log(`  ${relative(root, chunk).replaceAll('\\', '/')}`);
console.log(`\nbudget: ${BUDGET_GZIP_BYTES.toLocaleString()} B gzip (${pct}% used)`);

if (gzip > BUDGET_GZIP_BYTES) {
  console.error(
    `bundle-size check failed: gzip size exceeds budget by ${(gzip - BUDGET_GZIP_BYTES).toLocaleString()} B. ` +
      'Trim the main entry (heavy code belongs behind the formats/* subpaths or dynamic imports), ' +
      'or raise BUDGET_GZIP_BYTES in scripts/check-bundle-size.mjs with a rationale.',
  );
  process.exit(1);
}
console.log('bundle-size check passed');
