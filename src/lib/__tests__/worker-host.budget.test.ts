import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SplatData } from '../core/splat-data';
import type { LoadWorkerRequest, LoadWorkerResponse } from '../loaders/load-worker-protocol';

/** The worker global `serveLoadRequests` installs itself on. */
const scope = {
  onmessage: null as ((event: MessageEvent<LoadWorkerRequest>) => Promise<void>) | null,
  posted: [] as LoadWorkerResponse[],
  postMessage(message: LoadWorkerResponse) {
    this.posted.push(message);
  },
};
vi.stubGlobal('self', scope);
const { serveLoadRequests } = await import('../loaders/worker-host');

afterEach(() => {
  scope.posted = [];
});

/** Four splats with importance 1, 4, 2, 3 (opacity × trace). */
function decoded(): SplatData {
  const count = 4;
  const variances = [1, 4, 2, 3];
  const covariances = new Float32Array(count * 6);
  variances.forEach((v, i) => covariances.set([v, 0, 0, v, 0, v], i * 6));
  return {
    count,
    positions: Float32Array.from({ length: 12 }, (_, i) => Math.floor(i / 3)),
    colors: new Uint8Array(count * 4).fill(255),
    covariances,
  };
}

function load(id: number, budgeted: boolean): MessageEvent<LoadWorkerRequest> {
  return {
    data: {
      type: 'load',
      id,
      source: { from: 'url', url: 'https://x.test/a.ply', kind: 'file' },
      format: 'ply',
      ...(budgeted ? { budgeted: true } : {}),
    },
  } as MessageEvent<LoadWorkerRequest>;
}

const message = (data: LoadWorkerRequest) => ({ data }) as MessageEvent<LoadWorkerRequest>;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('serveLoadRequests budget handshake', () => {
  it('asks for a share with the decoded count and thins to the grant', async () => {
    serveLoadRequests(async () => decoded());
    const done = scope.onmessage?.(load(1, true));
    await flush();
    expect(scope.posted).toEqual([{ type: 'budget', id: 1, count: 4 }]);

    await scope.onmessage?.(message({ type: 'grant', id: 1, maxSplats: 2 }));
    await done;
    const reply = scope.posted.at(-1) as Extract<LoadWorkerResponse, { ok: true }>;
    expect(reply.ok).toBe(true);
    expect(reply.data.count).toBe(2);
    expect(reply.data.sourceCount).toBe(4);
    // Kept splats 1 (importance 4) and 3 (importance 3), in file order.
    expect(Array.from(reply.data.positions.filter((_, i) => i % 3 === 0))).toEqual([1, 3]);
    expect(Array.from(reply.data.drawOrder ?? [])).toEqual([0, 1]);
  });

  it('attaches a draw order even when the grant covers the whole file', async () => {
    serveLoadRequests(async () => decoded());
    const done = scope.onmessage?.(load(2, true));
    await flush();
    await scope.onmessage?.(message({ type: 'grant', id: 2, maxSplats: 100 }));
    await done;
    const reply = scope.posted.at(-1) as Extract<LoadWorkerResponse, { ok: true }>;
    expect(reply.data.count).toBe(4);
    expect(reply.data.sourceCount).toBeUndefined();
    expect(Array.from(reply.data.drawOrder ?? [])).toEqual([1, 3, 2, 0]);
  });

  it('does not ask or order without a budget', async () => {
    serveLoadRequests(async () => decoded());
    await scope.onmessage?.(load(3, false));
    expect(scope.posted.some((posted) => posted.type === 'budget')).toBe(false);
    const reply = scope.posted.at(-1) as Extract<LoadWorkerResponse, { ok: true }>;
    expect(reply.data.drawOrder).toBeUndefined();
  });

  it('reports a cancel that lands while waiting for the grant', async () => {
    serveLoadRequests(async () => decoded());
    const done = scope.onmessage?.(load(4, true));
    await flush();
    await scope.onmessage?.(message({ type: 'cancel', id: 4 }));
    await done;
    const reply = scope.posted.at(-1);
    expect(reply).toMatchObject({ type: 'result', id: 4, ok: false, cancelled: true });
  });

  it('lets a parser that asked first reuse the same grant', async () => {
    serveLoadRequests(async (_message, _signal, _progress, _status, requestBudget) => {
      expect(await requestBudget?.(4)).toBe(3);
      return decoded();
    });
    const done = scope.onmessage?.(load(5, true));
    await flush();
    await scope.onmessage?.(message({ type: 'grant', id: 5, maxSplats: 3 }));
    await done;
    expect(scope.posted.filter((posted) => posted.type === 'budget')).toHaveLength(1);
    const reply = scope.posted.at(-1) as Extract<LoadWorkerResponse, { ok: true }>;
    expect(reply.data.count).toBe(3);
  });
});
