#!/usr/bin/env node
/**
 * Non-mutating documentation consistency checks for ROADMAP / CHANGELOG / links.
 * Reports file:line for each failure. Does not rewrite files.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const errors = [];

function fail(file, line, message) {
  errors.push(`${relative(root, file).replaceAll('\\', '/')}:${line}: ${message}`);
}

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function linesOf(text) {
  return text.split(/\r?\n/);
}

/** Blank HTML comments, keeping newlines so line numbers stay valid. */
function withoutHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, ' '));
}

/** Markdown links [text](url) excluding images and http(s)/mailto/# anchors. */
function localLinks(text) {
  const out = [];
  const re = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(withoutHtmlComments(text)))) {
    const url = m[2];
    if (/^(https?:|mailto:|#|data:|\/)/i.test(url)) continue;
    out.push({ url: url.split('#')[0], index: m.index });
  }
  return out;
}

function lineAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function walkMarkdown(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (
      name === 'node_modules' ||
      name === 'dist' ||
      name === 'dist-demo' ||
      name === 'dist-site' ||
      name === 'dist-viewer' ||
      name === '.git'
    ) {
      continue;
    }
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walkMarkdown(path, acc);
    else if (name.endsWith('.md')) acc.push(path);
  }
  return acc;
}

// --- CHANGELOG: exactly one Unreleased heading ---
{
  const file = join(root, 'CHANGELOG.md');
  const text = read('CHANGELOG.md');
  const headings = [];
  linesOf(text).forEach((line, i) => {
    if (/^## \[Unreleased\]\s*$/.test(line)) headings.push(i + 1);
  });
  if (headings.length === 0) fail(file, 1, 'missing ## [Unreleased] heading');
  if (headings.length > 1) {
    for (const line of headings.slice(1)) {
      fail(file, line, 'duplicate ## [Unreleased] heading');
    }
  }

  const pkg = JSON.parse(read('package.json'));
  const version = pkg.version;
  const released = [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  if (released.includes(version)) {
    // package version already released - Unreleased must not claim it
  } else {
    // package is ahead of changelog releases - fine for pre-publish bumps
  }
  // Stale "package.json reads X" notes are forbidden when they contradict package.json
  linesOf(text).forEach((line, i) => {
    const m = line.match(/package\.json`?\s+reads\s+`?(\d+\.\d+\.\d+)/i);
    if (m && m[1] !== version) {
      fail(file, i + 1, `stale package-version claim ${m[1]} (package.json is ${version})`);
    }
  });
}

// --- ROADMAP checkbox / state syntax ---
{
  const file = join(root, 'ROADMAP.md');
  const text = read('ROADMAP.md');
  const allowed = new Set([' ', 'x', 'X', '~', 'v', 'V']);
  linesOf(text).forEach((line, i) => {
    const m = line.match(/^(\s*)- \[([^\]])\]/);
    if (!m) return;
    if (!allowed.has(m[2])) {
      fail(file, i + 1, `unsupported roadmap state "[${m[2]}]" (use [ ], [x], [~], [v])`);
    }
    if (
      /^\s*- \[[xX]\]/.test(line) &&
      /\b(pending|deferred|unverified|still open|not yet|TODO)\b/i.test(line)
    ) {
      fail(
        file,
        i + 1,
        'completed item contains unfinished-status language; use [v] or split the remaining work',
      );
    }
  });
}

// --- Local markdown links ---
{
  const mdFiles = walkMarkdown(root).filter((p) => {
    const rel = relative(root, p).replaceAll('\\', '/');
    return !rel.startsWith('node_modules/') && !rel.startsWith('.cursor/');
  });
  for (const file of mdFiles) {
    const text = readFileSync(file, 'utf8');
    for (const { url, index } of localLinks(text)) {
      if (!url) continue;
      const target = resolve(dirname(file), decodeURIComponent(url));
      if (!existsSync(target)) {
        fail(file, lineAt(text, index), `broken local link → ${url}`);
      }
    }
  }
}

// --- Stale flat docs/ paths (post-taxonomy) ---
{
  const stale = [
    'docs/rad-notes.md',
    'docs/effects-hooks-notes.md',
    'docs/lcc-notes.md',
    'docs/lcc2-notes.md',
    'docs/streamed-shn-notes.md',
    'docs/streamed-sog-notes.md',
    'docs/m6-performance-notes.md',
    'docs/multi-view-notes.md',
    'docs/spatial-query-notes.md',
    'docs/rad-paging-history.md',
    'docs/m15-unified-splat-renderer-design.md',
    'docs/m15-stabilization-history.md',
    'docs/m6-gpu-interval-culling-design.md',
  ];
  const mdFiles = walkMarkdown(root).filter((p) => {
    const rel = relative(root, p).replaceAll('\\', '/');
    return !rel.startsWith('node_modules/') && !rel.startsWith('.cursor/');
  });
  for (const file of mdFiles) {
    const text = readFileSync(file, 'utf8');
    linesOf(text).forEach((line, i) => {
      for (const path of stale) {
        if (line.includes(path)) {
          fail(file, i + 1, `stale flat doc path "${path}" - use docs/README.md taxonomy`);
        }
      }
    });
  }
  const tsFiles = [];
  function walkTs(dir) {
    for (const name of readdirSync(dir)) {
      if (
        name === 'node_modules' ||
        name === 'dist' ||
        name === 'dist-demo' ||
        name === 'dist-site' ||
        name === 'dist-viewer' ||
        name === '.git'
      ) {
        continue;
      }
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walkTs(path);
      else if (name.endsWith('.ts')) tsFiles.push(path);
    }
  }
  walkTs(join(root, 'src'));
  for (const file of tsFiles) {
    const text = readFileSync(file, 'utf8');
    linesOf(text).forEach((line, i) => {
      for (const path of stale) {
        if (line.includes(path)) {
          fail(file, i + 1, `stale flat doc path "${path}" - use docs/README.md taxonomy`);
        }
      }
    });
  }
}

// --- Every sample file appears on the all-samples page ---
{
  // The page is hand-written (each card carries a description), so nothing
  // stops a new sample from being added and quietly never listed. This is the
  // check that catches it - it has already caught one full directory.
  const file = join(root, 'site/examples/all-samples.md');
  const page = read('site/examples/all-samples.md');
  for (const dir of ['docs/guide/samples', 'docs/examples/samples']) {
    for (const name of readdirSync(join(root, dir))) {
      if (!/\.tsx?$/.test(name)) continue;
      if (!page.includes(`${dir}/${name}`)) {
        fail(file, 1, `sample not listed on the all-samples page: ${dir}/${name}`);
      }
    }
  }
}

if (errors.length) {
  console.error('docs:check failed:\n' + errors.map((e) => `  ${e}`).join('\n'));
  process.exit(1);
}
console.log('docs:check passed');
