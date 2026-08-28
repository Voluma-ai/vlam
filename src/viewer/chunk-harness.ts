import { ChunkLoader } from '../lib/loaders';

/**
 * M2.2 acceptance harness: loads chunks of the Streamed SOG fixture on
 * demand through the persistent ChunkLoader and reports per-chunk timings
 * plus main-thread long tasks (which must stay under 100 ms during
 * sustained loading). Dev-only page: /chunk-harness.html.
 */

interface LodMeta {
  count: number;
  counts: number[];
  lodLevels: number;
  filenames: string[];
}

const FIXTURE = '/sandwijck-lod/';
const log = document.querySelector<HTMLElement>('#log');
const loader = new ChunkLoader();

function print(line: string): void {
  if (log) log.textContent += `\n${line}`;
}

function clear(): void {
  if (log) log.textContent = '';
}

/** Watches main-thread long tasks (> 50 ms) for the duration of `run`. */
async function withLongTaskWatch<T>(
  run: () => Promise<T>,
): Promise<{ result: T; longTasksMs: number[] }> {
  const longTasksMs: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasksMs.push(Math.round(entry.duration));
  });
  observer.observe({ type: 'longtask' });
  try {
    const result = await run();
    await new Promise((resolve) => setTimeout(resolve, 100)); // let entries flush
    return { result, longTasksMs };
  } finally {
    observer.disconnect();
  }
}

async function chunkUrls(): Promise<string[]> {
  const response = await fetch(`${FIXTURE}lod-meta.json`);
  if (!response.ok) throw new Error(`Failed to load fixture manifest: HTTP ${response.status}`);
  const meta = (await response.json()) as LodMeta;
  // filenames entries look like "0_0/meta.json"; chunks load by directory.
  return meta.filenames.map((name) => FIXTURE + name.replace(/\/?meta\.json$/, '/'));
}

async function runSequential(): Promise<Record<string, unknown>> {
  clear();
  print('Sequential load of all chunks…');
  const urls = await chunkUrls();
  const timings: { url: string; ms: number; splats: number }[] = [];
  const { longTasksMs } = await withLongTaskWatch(async () => {
    for (const url of urls) {
      const start = performance.now();
      const data = await loader.load(url, { kind: 'directory' });
      const ms = Math.round(performance.now() - start);
      timings.push({ url, ms, splats: data.count });
      print(`  ${url}  ${data.count.toLocaleString('en-US')} splats  ${ms} ms`);
    }
  });
  const total = timings.reduce((sum, t) => sum + t.ms, 0);
  const summary = {
    chunks: timings.length,
    totalMs: total,
    maxLongTaskMs: Math.max(0, ...longTasksMs),
    longTasks: longTasksMs,
  };
  print(
    `Done: ${timings.length} chunks in ${total} ms · long tasks: [${longTasksMs.join(', ')}] ms`,
  );
  return { mode: 'sequential', timings, ...summary };
}

async function runParallel(): Promise<Record<string, unknown>> {
  clear();
  print('Parallel load of all chunks (all requests in flight)…');
  const urls = await chunkUrls();
  const start = performance.now();
  const { result: settled, longTasksMs } = await withLongTaskWatch(() =>
    Promise.allSettled(
      urls.map(async (url) => {
        const t0 = performance.now();
        const data = await loader.load(url, { kind: 'directory' });
        return { url, ms: Math.round(performance.now() - t0), splats: data.count };
      }),
    ),
  );
  const wallMs = Math.round(performance.now() - start);
  const ok = settled.filter((s) => s.status === 'fulfilled');
  for (const s of ok) {
    if (s.status === 'fulfilled') {
      print(`  ${s.value.url}  ${s.value.splats.toLocaleString('en-US')} splats  ${s.value.ms} ms`);
    }
  }
  const summary = {
    chunks: ok.length,
    failed: settled.length - ok.length,
    wallMs,
    maxLongTaskMs: Math.max(0, ...longTasksMs),
    longTasks: longTasksMs,
  };
  print(
    `Done: ${ok.length}/${settled.length} chunks, wall ${wallMs} ms · long tasks: [${longTasksMs.join(', ')}] ms`,
  );
  return { mode: 'parallel', ...summary };
}

async function runCancellation(): Promise<Record<string, unknown>> {
  clear();
  print('Cancellation: abort the largest chunk 25 ms after requesting…');
  const urls = await chunkUrls();
  const controller = new AbortController();
  const request = loader.load(urls[0] as string, { kind: 'directory', signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  let outcome: string;
  try {
    const data = await request;
    outcome = `not cancelled in time (decoded ${data.count} splats)`;
  } catch (error) {
    outcome =
      error instanceof DOMException && error.name === 'AbortError'
        ? 'AbortError (cancelled as expected)'
        : `unexpected error: ${String(error)}`;
  }
  // The loader must remain usable after a cancellation.
  const after = await loader.load(urls[urls.length - 1] as string, { kind: 'directory' });
  print(`  outcome: ${outcome}`);
  print(`  loader still works: loaded ${after.count.toLocaleString('en-US')} splats after cancel`);
  return { mode: 'cancellation', outcome, loaderUsableAfter: after.count };
}

document.querySelector('#run-sequential')?.addEventListener('click', () => void runSequential());
document.querySelector('#run-parallel')?.addEventListener('click', () => void runParallel());
document.querySelector('#run-cancel')?.addEventListener('click', () => void runCancellation());

// Automation handle for verification.
Object.assign(window, { __harness: { runSequential, runParallel, runCancellation } });
