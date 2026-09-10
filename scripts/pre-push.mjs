#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const zeroObject = /^0+$/;
const browserSensitive =
  /^(?:\.github\/workflows\/ci\.yml$|assets\/|browser-tests\/|src\/|package(?:-lock)?\.json$|playwright\.config\.ts$|vite\.config\.ts$|Dockerfile\.browser-ci$|scripts\/test-browser-linux\.mjs$)/;

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32' && command === 'npm',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 1}).`);
  }
  return capture ? result.stdout.trim() : '';
}

function mergeBase(commit) {
  for (const candidate of ['refs/remotes/origin/main', 'main']) {
    const result = spawnSync('git', ['merge-base', commit, candidate], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status === 0) return result.stdout.trim();
  }
  return `${commit}^`;
}

const updates = readFileSync(0, 'utf8').trim().split(/\r?\n/).filter(Boolean);
const changed = new Set();
for (const update of updates) {
  const [, localObject, , remoteObject] = update.trim().split(/\s+/);
  if (!localObject || zeroObject.test(localObject)) continue;
  const base =
    remoteObject && !zeroObject.test(remoteObject) ? remoteObject : mergeBase(localObject);
  const names = run('git', ['diff', '--name-only', `${base}..${localObject}`], true);
  for (const name of names.split(/\r?\n/)) if (name) changed.add(name.replaceAll('\\', '/'));
}

run('npm', ['run', 'preflight']);

if ([...changed].some((name) => browserSensitive.test(name))) {
  console.log('\nRenderer-sensitive changes detected; running Linux browser parity...');
  run('npm', ['run', 'test:browser:linux']);
} else {
  console.log('\nNo renderer-sensitive pushed files; Linux browser parity skipped.');
}
