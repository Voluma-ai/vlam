#!/usr/bin/env node
// Import the packed artifact from a fresh consumer with no source path aliases.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// npm run supplies the CLI path. Invoke it through Node so Windows .cmd files
// and paths containing spaces never need shell parsing.
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check via npm run check:packed-consumer.');
const temporary = mkdtempSync(join(tmpdir(), 'vlam-packed-consumer-'));

function run(args, cwd, capture = false) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || 'npm ' + args.join(' ') + ' failed');
  }
  return result.stdout;
}

try {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const packed = JSON.parse(
    run(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root, true),
  );
  const packageInfo = Array.isArray(packed) ? packed[0] : packed['@voluma/vlam'];
  if (!packageInfo?.filename) throw new Error('npm pack did not report a tarball');
  const tarball = join(temporary, packageInfo.filename);
  writeFileSync(join(temporary, 'package.json'), '{"private":true,"type":"module"}\n');
  copyFileSync(join(root, 'scripts/fixtures/packed-consumer.mjs'), join(temporary, 'consumer.mjs'));
  run(
    [
      'install',
      '--prefer-offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
      'three@0.186.0',
    ],
    temporary,
  );
  const result = spawnSync(process.execPath, ['consumer.mjs'], {
    cwd: temporary,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else console.log('Packed consumer imports passed for @voluma/vlam@' + version);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
