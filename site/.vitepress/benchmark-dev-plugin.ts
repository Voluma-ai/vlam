import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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

/** Local-only capture cache and append-only benchmark artifacts; never deployed. */
export function benchmarkDevPlugin(): Plugin {
  return {
    name: 'vlam-benchmark-local-files',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const asset = /^\/benchmark-assets\/(Langenthal-Manola4A|goose)\.(sog|json)$/.exec(
          pathname,
        );
        if (asset && req.method === 'GET') {
          const stream = createReadStream(path.join(cache, `${asset[1]}.${asset[2]}`));
          stream.on('error', () => {
            res.statusCode = 404;
            res.end('Run npm run benchmark:cache first.');
          });
          res.setHeader(
            'Content-Type',
            asset[2] === 'json' ? 'application/json' : 'application/octet-stream',
          );
          stream.pipe(res);
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
