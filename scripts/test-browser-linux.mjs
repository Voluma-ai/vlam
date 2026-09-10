#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const playwrightVersion = lock.packages?.['node_modules/@playwright/test']?.version;
if (typeof playwrightVersion !== 'string') {
  throw new Error('package-lock.json does not contain @playwright/test. Run npm install first.');
}

const image = `vlam-browser-ci:${playwrightVersion}`;

function docker(args) {
  const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Building Linux browser preflight with Playwright ${playwrightVersion}...`);
docker([
  'build',
  '--file',
  'Dockerfile.browser-ci',
  '--build-arg',
  `PLAYWRIGHT_VERSION=${playwrightVersion}`,
  '--tag',
  image,
  '.',
]);
docker(['run', '--rm', '--ipc=host', image]);
