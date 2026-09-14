import { describe, expect, it, vi } from 'vitest';
import type { FrontierPlanMessage, FrontierRequest } from '../formats/rad/frontier-worker-protocol';

vi.mock('../internal/experiments', () => ({ experiments: { radTraversal: 'bounded-threshold' } }));
const plans: FrontierPlanMessage[] = [];
const workerSelf = {
  onmessage: null as ((event: MessageEvent<FrontierRequest>) => void) | null,
  postMessage: (message: FrontierPlanMessage) => plans.push(message),
};
vi.stubGlobal('self', workerSelf);
await import('../formats/rad/frontier-worker');
const send = (message: FrontierRequest) =>
  workerSelf.onmessage?.({ data: message } as MessageEvent<FrontierRequest>);

describe('bounded threshold worker integration', () => {
  it('uses the threshold cut, then falls back once when the budget shrinks', () => {
    send({ type: 'init', capacity: 3, chunkSize: 3, cpuCacheBytes: 1024 * 1024, maxPlanWrites: 3 });
    send({
      type: 'chunk',
      file: 0,
      count: 3,
      positions: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      colors: new Uint8Array(12),
      covariances: new Float32Array(18),
      childCount: new Uint16Array([2, 0, 0]),
      childStart: new Uint32Array([1, 0, 0]),
      size: new Float32Array([8, 1, 1]),
      shBands: 0,
    });
    const request = (seq: number, budget: number): FrontierRequest => ({
      type: 'reschedule',
      seq,
      cameraLocal: [0, 0, 0],
      cameraForward: [0, 0, 1],
      coneFov0: 0,
      coneFov: 0,
      coneFoveate: 1,
      behindFoveate: 1,
      limit: 2,
      budget,
    });
    send(request(1, 2));
    expect(plans.at(-1)?.traversalStrategy).toBe('bounded-threshold');
    expect(plans.at(-1)?.traversalFallback).toBe(false);
    expect(plans.at(-1)?.residentCount).toBe(2);
    send({ type: 'resize', capacity: 1 });
    send(request(2, 1));
    expect(plans.at(-1)?.traversalFallback).toBe(true);
    expect(plans.at(-1)?.traversalFallbackCount).toBe(1);
    expect(plans.at(-1)?.residentCount).toBeLessThanOrEqual(1);
    expect(plans.at(-1)?.gatherMissing).toBe(0);
    expect(plans.at(-1)?.dropped).toBe(0);
  });
});
