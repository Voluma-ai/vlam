import { Worker as NodeWorker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Spark 2.1's PackedSplats decoder runs in a classic Web Worker. Vitest's node
 * environment has none, so the oracle test shims just enough of that API to
 * execute the inlined WASM worker.
 */
export function installNodeWorkerPolyfill(): void {
  if (typeof globalThis.Worker === 'function') return;
  const self = globalThis as typeof globalThis & { self: typeof globalThis };
  (self as unknown as { self: typeof globalThis }).self = self;
  URL.createObjectURL = () => {
    throw new Error('blob workers unsupported in node tests');
  };

  class BrowserWorker {
    readonly #inner: NodeWorker;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;

    constructor(url: string) {
      let source: string;
      if (url.startsWith('data:')) {
        const comma = url.indexOf(',');
        source = decodeURIComponent(url.slice(comma + 1));
      } else {
        throw new Error(`Unsupported worker script ${url.slice(0, 64)}`);
      }
      const shim = `
import { parentPort } from 'node:worker_threads';
globalThis.self = globalThis;
globalThis.location = { href: import.meta.url };
globalThis.postMessage = (data, transfer) => {
  const list = Array.isArray(transfer) ? transfer : transfer?.transfer;
  parentPort.postMessage(data, list);
};
const messageListeners = [];
globalThis.addEventListener = (type, fn) => {
  if (type === 'message') messageListeners.push(fn);
  if (type === 'error') parentPort.on('error', fn);
};
globalThis.removeEventListener = (type, fn) => {
  if (type !== 'message') return;
  const index = messageListeners.indexOf(fn);
  if (index >= 0) messageListeners.splice(index, 1);
};
parentPort.on('message', (data) => {
  const event = { data };
  for (const fn of messageListeners) fn(event);
  if (typeof globalThis.onmessage === 'function') globalThis.onmessage(event);
});
`;
      const file = join(
        tmpdir(),
        `spark-worker-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`,
      );
      writeFileSync(file, `${shim}\n${source}`);
      this.#inner = new NodeWorker(file);
      this.#inner.on('message', (data) => this.onmessage?.({ data }));
      this.#inner.on('error', (error) => this.onerror?.(error));
    }

    addEventListener(type: string, fn: (event: unknown) => void): void {
      if (type === 'message') this.#inner.on('message', (data) => fn({ data }));
      if (type === 'error') this.#inner.on('error', fn);
    }

    postMessage(data: unknown, options?: Transferable[] | { transfer?: Transferable[] }): void {
      const transfer = Array.isArray(options) ? options : options?.transfer;
      this.#inner.postMessage(data, transfer);
    }

    terminate(): void {
      void this.#inner.terminate();
    }
  }

  (globalThis as unknown as { Worker: typeof BrowserWorker }).Worker = BrowserWorker;
}
