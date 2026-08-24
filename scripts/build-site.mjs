#!/usr/bin/env node
/**
 * Build the documentation site into dist-site/:
 *   1. TypeDoc markdown → site/api/ (VitePress pages)
 *   2. VitePress pages (Home, Get started, Examples, API)
 *   3. Interactive viewer at /demo/
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distSite = join(root, 'dist-site');

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (existsSync(distSite)) rmSync(distSite, { recursive: true, force: true });
mkdirSync(distSite, { recursive: true });

run('npx', ['typedoc', '--options', 'typedoc.site.json']);
run('npx', ['vitepress', 'build', 'site']);

run('npx', ['vite', 'build'], {
  VLAM_VIEWER_BASE: '/demo/',
  VLAM_VIEWER_OUT: 'dist-site/demo',
});

// Runnable example apps at /examples/live/<slug>/ (site/examples/*.md links here).
run('npx', ['vite', 'build', '--config', 'vite.config.examples.ts']);

// The examples fetch `/goose.sog` - site root, not the viewer's or the example
// bundle's own public dir - because that is the URL their published source
// shows. One copy serves every page.
copyFileSync(join(root, 'assets', 'goose.sog'), join(distSite, 'goose.sog'));

console.log('Built documentation site → dist-site/');
