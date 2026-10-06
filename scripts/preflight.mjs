#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failureSummary } from './preflight-failure.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const skipBrowser = process.argv.includes('--no-browser');
const gates = [
  ['lint'],
  ['typecheck'],
  ['test:coverage'],
  ['docs:check'],
  ['docs:samples'],
  ...(skipBrowser ? [] : [['test:browser', '--', '--workers=2']]),
  ['build'],
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: process.platform === 'win32',
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const pieces = [];
    const forward = (stream, chunk) => {
      stream.write(chunk);
      pieces.push(chunk.toString());
    };
    child.stdout.on('data', (chunk) => forward(process.stdout, chunk));
    child.stderr.on('data', (chunk) => forward(process.stderr, chunk));
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status: status ?? 1, output: pieces.join('') });
    });
  });
}

function reportFailure(label, output, status) {
  process.stderr.write(
    `\n${'─'.repeat(72)}\npreflight failed: ${label} (exit ${status})\n\n${failureSummary(output)}\n${'─'.repeat(72)}\n`,
  );
  process.exit(status);
}

if (skipBrowser) console.log('\n==> skipping npm run test:browser');

for (const [script, ...args] of gates) {
  const label = `npm run ${script}${args.length > 0 ? ` ${args.join(' ')}` : ''}`;
  console.log(`\n==> ${label}`);
  const result = await run(npm, ['run', script, ...args]);
  if (result.status !== 0) reportFailure(label, result.output, result.status);
}

console.log('\n==> node scripts/check-bundle-size.mjs --no-build');
const size = await run(process.execPath, ['scripts/check-bundle-size.mjs', '--no-build']);
if (size.status !== 0) {
  reportFailure('node scripts/check-bundle-size.mjs --no-build', size.output, size.status);
}

console.log('\n==> npm run check:packed-consumer');
const consumer = await run(npm, ['run', 'check:packed-consumer']);
if (consumer.status !== 0) {
  reportFailure('npm run check:packed-consumer', consumer.output, consumer.status);
}

console.log('\nPreflight passed.');
