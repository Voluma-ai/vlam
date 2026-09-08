import { createReadStream, type Stats } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cache = path.join(root, '.tmp/benchmark-assets');
const output = path.join(root, '.tmp/benchmark-results');

async function hashFiles(directory: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    const visit = async (current: string): Promise<void> => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) {
          hash.update(path.relative(directory, absolute));
          hash.update(await readFile(absolute));
        }
      }
    };
    await visit(directory);
    return hash.digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function hashFile(filename: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filename))
    .digest('hex');
}

/** Inclusive byte range from a single `bytes=` Range, or `null` for the whole file. */
function assetByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return 'invalid';
  const suffix = match[1] === '';
  const start = suffix ? size - Number(match[2]) : Number(match[1]);
  const requestedEnd = match[2] === '' || suffix ? size - 1 : Number(match[2]);
  const end = Math.min(requestedEnd, size - 1);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= size || start > end)
    return 'invalid';
  return { start, end };
}

function assetContentType(file: string): string {
  const extension = path.extname(file);
  return extension === '.json' || extension === '.lcc2'
    ? 'application/json'
    : 'application/octet-stream';
}

function sendAsset(
  res: {
    statusCode: number;
    setHeader(name: string, value: string | number): void;
    end(body?: string): void;
  },
  file: string,
  info: Stats,
  range: { start: number; end: number } | null,
): void {
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', assetContentType(file));
  if (range) {
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
    res.setHeader('Content-Length', range.end - range.start + 1);
    createReadStream(file, { start: range.start, end: range.end })
      .on('error', () => {
        res.statusCode = 404;
        res.end('Run npm run benchmark:cache first.');
      })
      .pipe(res as NodeJS.WritableStream);
    return;
  }
  res.setHeader('Content-Length', info.size);
  createReadStream(file)
    .on('error', () => {
      res.statusCode = 404;
      res.end('Run npm run benchmark:cache first.');
    })
    .pipe(res as NodeJS.WritableStream);
}

/** Local-only capture cache and append-only benchmark artifacts; never deployed. */
export function benchmarkDevPlugin(): Plugin {
  return {
    name: 'vlam-benchmark-local-files',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const asset = /^\/benchmark-assets\/(.+)$/.exec(pathname);
        if (asset && req.method === 'GET') {
          const relative = decodeURIComponent(asset[1]);
          const file = path.resolve(cache, relative);
          const fromCache = path.relative(cache, file);
          if (fromCache.startsWith('..') || path.isAbsolute(fromCache)) {
            res.statusCode = 404;
            res.end('Run npm run benchmark:cache first.');
            return;
          }
          const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          });
          if (!info?.isFile()) {
            res.statusCode = 404;
            res.end('Run npm run benchmark:cache first.');
            return;
          }
          const range = assetByteRange(
            typeof req.headers.range === 'string' ? req.headers.range : undefined,
            info.size,
          );
          if (range === 'invalid') {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${info.size}`);
            res.end();
            return;
          }
          sendAsset(res, file, info, range);
          return;
        }
        if (pathname === '/__benchmark/environment' && req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          try {
            res.end(
              JSON.stringify({
                commit: execFileSync('git', ['rev-parse', 'HEAD'], {
                  cwd: root,
                  encoding: 'utf8',
                }).trim(),
                dirty: Boolean(
                  execFileSync('git', ['status', '--porcelain'], {
                    cwd: root,
                    encoding: 'utf8',
                  }).trim(),
                ),
                spark: JSON.parse(
                  await readFile(
                    path.join(root, 'node_modules/@sparkjsdev/spark/package.json'),
                    'utf8',
                  ),
                ).version,
                vlam: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
                three: JSON.parse(
                  await readFile(path.join(root, 'node_modules/three/package.json'), 'utf8'),
                ).version,
                hashes: {
                  packageJson: createHash('sha256')
                    .update(await readFile(path.join(root, 'package.json')))
                    .digest('hex'),
                  packageLock: createHash('sha256')
                    .update(await readFile(path.join(root, 'package-lock.json')))
                    .digest('hex'),
                  packagedBuild: await hashFiles(path.join(root, 'dist')),
                  // The dev harness imports this source tree directly through
                  // Vite; dist alone does not identify the code it executed.
                  harnessSource: await hashFiles(path.join(root, 'src')),
                  harnessServer: await hashFile(
                    path.join(root, 'site/.vitepress/benchmark-dev-plugin.ts'),
                  ),
                  harnessConfig: await hashFile(path.join(root, 'site/.vitepress/config.ts')),
                },
              }),
            );
          } catch (error) {
            next(error);
          }
          return;
        }
        if (pathname !== '/__benchmark/results' || req.method !== 'POST') return next();
        // Accept only the local viewer's same-origin request, with no client-controlled paths.
        const origin = req.headers.origin;
        if (
          !origin ||
          new URL(origin).host !== req.headers.host ||
          req.headers['content-type'] !== 'application/json'
        ) {
          res.statusCode = 403;
          res.end('Same-origin JSON required.');
          return;
        }
        try {
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 24 * 1024 * 1024) {
              res.statusCode = 413;
              res.end();
              return;
            }
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (
            body.result?.schemaVersion !== 1 ||
            !['spark', 'vlam'].includes(body.result?.config?.engine) ||
            !Array.isArray(body.screenshots) ||
            body.screenshots.length !== 2 ||
            body.screenshots.some(
              (shot: { data?: unknown }) =>
                typeof shot.data !== 'string' ||
                !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(shot.data),
            )
          ) {
            res.statusCode = 400;
            res.end('Invalid benchmark result.');
            return;
          }
          const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
          const directory = path.join(output, id);
          await mkdir(directory, { recursive: true });
          await writeFile(
            path.join(directory, 'result.json'),
            JSON.stringify(body.result, null, 2),
          );
          for (let i = 0; i < 2; i++)
            await writeFile(
              path.join(directory, `${i === 0 ? 'front' : 'orbit'}.png`),
              Buffer.from(body.screenshots[i].data.split(',')[1], 'base64'),
            );
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ directory: `.tmp/benchmark-results/${id}` }));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
