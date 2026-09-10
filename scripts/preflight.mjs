#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const gates = [
  ['lint'],
  ['typecheck'],
  ['test:coverage'],
  ['docs:check'],
  ['docs:samples'],
  ['test:browser', '--', '--workers=2'],
  ['build'],
];

for (const [script, ...args] of gates) {
  console.log(`\n==> npm run ${script}${args.length > 0 ? ` ${args.join(' ')}` : ''}`);
  const result = spawnSync(npm, ['run', script, ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('\n==> node scripts/check-bundle-size.mjs --no-build');
const size = spawnSync(process.execPath, ['scripts/check-bundle-size.mjs', '--no-build'], {
  cwd: root,
  stdio: 'inherit',
});
if (size.error) throw size.error;
if (size.status !== 0) process.exit(size.status ?? 1);

console.log('\nPreflight passed.');
