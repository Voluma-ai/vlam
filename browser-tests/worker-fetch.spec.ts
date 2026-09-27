import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

let server: Server;
let base: string;
const text = 'decoded splat bytes '.repeat(200);
const decoded = new TextEncoder().encode(text);

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    const encoded = gzipSync(decoded);
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Content-Encoding': 'gzip',
      'Content-Length': encoded.length,
      'Content-Type': 'application/octet-stream',
      // Deliberately no Access-Control-Expose-Headers: encoding stays hidden.
    });
    response.end(encoded);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing cross-origin server port');
  base = `http://127.0.0.1:${address.port}/scene`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test('downloads a real CORS gzip body whose encoding header is hidden', async ({ page }) => {
  await page.goto('/src/viewer/worker-fetch-probe.html');
  const result = await page.evaluate(
    async ({ url, modulePath }) => {
      const response = await fetch(url);
      const encoding = response.headers.get('Content-Encoding');
      const declared = Number(response.headers.get('Content-Length'));
      const { fetchBuffer } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('../src/lib/loaders/worker-fetch');
      const progress: number[][] = [];
      const buffer = await fetchBuffer(
        url,
        undefined,
        new AbortController().signal,
        (loaded: number, total: number) => progress.push([loaded, total]),
      );
      const withoutProgress = await fetchBuffer(url, undefined, new AbortController().signal);
      return {
        type: response.type,
        encoding,
        declared,
        text: new TextDecoder().decode(buffer),
        length: withoutProgress.byteLength,
        progress,
      };
    },
    { url: base, modulePath: '/src/lib/loaders/worker-fetch.ts' },
  );
  expect(result.type).toBe('cors');
  expect(result.encoding).toBeNull();
  expect(result.declared).toBeLessThan(decoded.length);
  expect(result.text).toBe(text);
  expect(result.length).toBe(decoded.length);
  expect(result.progress.at(-1)).toEqual([decoded.length, 0]);
  expect(result.progress.every(([, total]) => total === 0)).toBe(true);
});
