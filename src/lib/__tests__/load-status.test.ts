import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadWorkerRequest, LoadWorkerResponse } from '../loaders/load-worker-protocol';

afterEach(() => vi.unstubAllGlobals());

describe('worker load status', () => {
  it.each(['file', 'url'] as const)(
    'reports read/decode and byte completion for %s input',
    async (from) => {
      vi.resetModules();
      const messages: LoadWorkerResponse[] = [];
      const scope = {
        onmessage: null as ((event: { data: LoadWorkerRequest }) => Promise<void>) | null,
        postMessage: (message: LoadWorkerResponse) => messages.push(message),
      };
      vi.stubGlobal('self', scope);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(new Uint8Array(32))),
      );
      await import('../loaders/one-shot-worker');
      const source =
        from === 'file'
          ? { from, file: new File([new Uint8Array(32)], 'a.splat') }
          : { from, url: 'https://scene.test/a.splat', kind: 'file' as const };
      await scope.onmessage!({
        data: { type: 'load', id: 7, source, format: 'splat', progress: true, status: true },
      });
      expect(messages.filter((m) => m.type === 'status')).toEqual([
        { type: 'status', id: 7, status: 'reading' },
        { type: 'status', id: 7, status: 'decoding' },
      ]);
      expect(messages).toContainEqual({
        type: 'progress',
        id: 7,
        loaded: 32,
        total: from === 'file' ? 32 : 0,
      });
      expect(messages.at(-1)).toMatchObject({ type: 'result', id: 7, ok: true });
    },
  );
});
