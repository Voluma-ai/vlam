import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as radFrontier from '../formats/rad/rad-frontier';
import type { FrontierPlanMessage, FrontierRequest } from '../formats/rad/frontier-worker-protocol';

/**
 * The frontier worker's *delivery* behaviour, which is what decides how fast a
 * cold `.rad` reaches its budget.
 *
 * The configured plan cap bounds what one plan may apply, but the traversal and
 * pager diff behind it are O(whole frontier). Re-running both for each of the
 * ~66 plans a 4M-splat frontier needs is quadratic - the reason `cest_ca.rad`
 * sat at ~1.3M of a 4M budget. These tests pin the fix: an unchanged reschedule
 * drains the deferred remainder and must not traverse again, while anything that
 * could move the cut must.
 */

/** Spy that keeps the real traversal, so the plans stay meaningful. */
const traverseSpy = vi.spyOn(radFrontier, 'traverseFrontier');

/** Collects what the worker posts back, and the buffers it transfers. */
const plans: FrontierPlanMessage[] = [];

/** A worker global good enough for the module: `onmessage` + `postMessage`. */
const workerSelf = {
  onmessage: null as ((event: MessageEvent<FrontierRequest>) => void) | null,
  postMessage: (message: FrontierPlanMessage) => plans.push(message),
};
vi.stubGlobal('self', workerSelf);

// Imported after the stub: the module installs `self.onmessage` at load.
const frontierWorker = await import('../formats/rad/frontier-worker');

function send(msg: FrontierRequest, transfer: Transferable[] = []): void {
  workerSelf.onmessage?.({ data: msg } as MessageEvent<FrontierRequest>);
  void transfer;
}

const CHUNK_SIZE = 1024;
const PLAN_WRITE_CAP = 16_000;
/**
 * 200 coarse roots x 500 leaves = 100,000 leaves - comfortably past the worker's
 * configured per-plan cap, so a cold load *must* take the truncate-then-drain
 * path rather than converging in one plan.
 */
const ROOTS = 200;
const FAN = 500;
/** Chunk 0 is padded to a full chunk, and every padding node is a childless root
 * the cut still emits - so the settled frontier is the leaves plus that padding. */
const FRONTIER_SPLATS = ROOTS * FAN + (CHUNK_SIZE - ROOTS);
/** A two-level forest: `roots` coarse nodes in chunk 0, each with `fan` leaves
 * spread over the later chunks, all in front of the camera. */
function sendTree(roots: number, fan: number): void {
  const leafTotal = roots * fan;
  const leafChunks = Math.ceil(leafTotal / CHUNK_SIZE);

  // Chunk 0: the roots (plus padding to a full chunk so child links line up).
  const c0 = CHUNK_SIZE;
  const positions = new Float32Array(c0 * 3);
  const size = new Float32Array(c0);
  const childCount = new Uint16Array(c0);
  const childStart = new Uint32Array(c0);
  for (let i = 0; i < roots; i++) {
    positions[i * 3 + 2] = 10; // 10 units straight ahead
    size[i] = 8;
    childCount[i] = fan;
    childStart[i] = CHUNK_SIZE + i * fan; // children start in chunk 1
  }
  send({
    type: 'chunk',
    file: 0,
    count: c0,
    positions,
    colors: new Uint8Array(c0 * 4),
    covariances: new Float32Array(c0 * 6),
    childCount,
    childStart,
    size,
    shBands: 0,
  });

  for (let f = 1; f <= leafChunks; f++) {
    const n = CHUNK_SIZE;
    const lp = new Float32Array(n * 3);
    const ls = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      lp[i * 3 + 2] = 10;
      ls[i] = 0.01; // far below any limit used here: a true leaf level
    }
    send({
      type: 'chunk',
      file: f,
      count: n,
      positions: lp,
      colors: new Uint8Array(n * 4),
      covariances: new Float32Array(n * 6),
      childCount: new Uint16Array(n),
      childStart: new Uint32Array(n),
      size: ls,
      shBands: 0,
    });
  }
}

function reschedule(seq: number, camZ = 0, continuePendingPlan = false): void {
  send({
    type: 'reschedule',
    seq,
    ...(continuePendingPlan ? { continuePendingPlan: true } : {}),
    cameraLocal: [0, 0, camZ],
    cameraForward: [0, 0, 1],
    coneFov0: 0,
    coneFov: 0,
    coneFoveate: 1,
    behindFoveate: 1,
    limit: 0.05,
    budget: 200_000,
  });
}

describe('frontier worker delivery', () => {
  it('uses cache saturation only to publish the first usable cut', () => {
    expect(frontierWorker.shouldPublishFrontier(false, 8, true, false)).toBe(true);
    expect(frontierWorker.shouldPublishFrontier(false, 8, true, true)).toBe(false);
    expect(frontierWorker.shouldPublishFrontier(false, 0, true, true)).toBe(true);
    expect(frontierWorker.shouldPublishFrontier(true, 8, true, true)).toBe(true);
    expect(frontierWorker.shouldPublishFrontier(false, 8, false, false, 100, 100)).toBe(true);
    expect(frontierWorker.shouldPublishFrontier(false, 8, false, false, 101, 100)).toBe(false);
    expect(frontierWorker.shouldPublishFrontier(false, 8, false, true, 100, 100)).toBe(false);
  });

  it('coalesces small stationary indexed refinements until the cache is idle', () => {
    const start = frontierWorker.shouldStartIndexedCandidate;
    expect(start(0, 10, 100, false, 2, 0)).toBe(true); // first complete cover
    expect(start(10, 39, 100, false, 2, 0)).toBe(false);
    expect(start(10, 40, 100, false, 2, 0)).toBe(true); // geometric milestone
    expect(start(95, 100, 100, false, 0, 199)).toBe(false);
    expect(start(95, 100, 100, false, 0, 200)).toBe(true); // settled exact cut
    expect(start(95, 96, 100, true, 3, 0)).toBe(true); // camera movement
  });

  it('allows one mid-budget indexed follow-up without changing the coarse ramp', () => {
    const start = frontierWorker.shouldStartIndexedMidBudgetFollowup;
    expect(start(34, 80, 100, false)).toBe(false);
    expect(start(35, 52, 100, false)).toBe(false);
    expect(start(35, 53, 100, false)).toBe(true);
    expect(start(35, 80, 100, true)).toBe(false);
    expect(start(90, 100, 100, false)).toBe(false);
  });

  beforeEach(() => {
    plans.length = 0;
    traverseSpy.mockClear();
    // A fresh pager and cache generation per test.
    send({
      type: 'init',
      capacity: 200_000,
      chunkSize: CHUNK_SIZE,
      cpuCacheBytes: 8 * 1024 * 1024 * 1024,
      maxPlanWrites: PLAN_WRITE_CAP,
    });
  });

  it('drains a truncated plan without traversing again', () => {
    sendTree(ROOTS, FAN);
    plans.length = 0;
    traverseSpy.mockClear();

    reschedule(1);
    expect(traverseSpy).toHaveBeenCalled();
    const first = plans.at(-1)!;
    // The whole point: this frontier cannot be delivered in one capped plan.
    expect(first.converged).toBe(false);
    expect(first.staleResidentSplats).toBe(0);
    expect(first.pendingFrontierSplats).toBeGreaterThan(0);

    // Every remaining plan must come from the drain queue, so the traversal
    // count stays exactly where the first reschedule left it.
    const traversalsAfterFirst = traverseSpy.mock.calls.length;
    let seq = 2;
    let last = first;
    while (!last.converged && seq < 200) {
      reschedule(seq++);
      last = plans.at(-1)!;
    }
    expect(last.converged).toBe(true);
    expect(plans.length).toBeGreaterThanOrEqual(2); // at least one drain ran
    expect(traverseSpy.mock.calls.length).toBe(traversalsAfterFirst);
    expect(last.gatherMissing).toBe(0);
  });

  it('re-traverses when the camera moves', () => {
    sendTree(ROOTS, FAN);
    reschedule(1);
    const before = traverseSpy.mock.calls.length;
    reschedule(2, 1); // camera stepped forward
    expect(traverseSpy.mock.calls.length).toBeGreaterThan(before);
  });

  it('finishes a queued cut while the host coalesces a moving camera', () => {
    sendTree(ROOTS, FAN);
    reschedule(1);
    expect(plans.at(-1)?.converged).toBe(false);
    const traversals = traverseSpy.mock.calls.length;

    reschedule(2, 1, true);
    const drain = plans.at(-1)!;
    expect(traverseSpy.mock.calls.length).toBe(traversals);
    expect(drain.appends.count + drain.moves.count + drain.degenerateCount).toBeLessThanOrEqual(
      PLAN_WRITE_CAP,
    );
  });

  it('holds a complete indexed parent cut until every child slot is staged and acknowledged', () => {
    const fan = 1_000;
    send({
      type: 'init',
      pagerMode: 'indexed',
      capacity: 8_192,
      chunkSize: CHUNK_SIZE,
      cpuCacheBytes: 8 * 1024 * 1024 * 1024,
      maxPlanWrites: CHUNK_SIZE,
    });
    const positions = new Float32Array(CHUNK_SIZE * 3);
    const size = new Float32Array(CHUNK_SIZE).fill(0.01);
    const childCount = new Uint16Array(CHUNK_SIZE);
    const childStart = new Uint32Array(CHUNK_SIZE);
    for (let i = 0; i < CHUNK_SIZE; i++) positions[i * 3 + 2] = 10;
    size[0] = size[1] = 8;
    childCount[0] = childCount[1] = fan;
    childStart[0] = 10 * CHUNK_SIZE;
    childStart[1] = 10 * CHUNK_SIZE + fan;
    send({
      type: 'chunk',
      file: 0,
      count: CHUNK_SIZE,
      positions,
      colors: new Uint8Array(CHUNK_SIZE * 4),
      covariances: new Float32Array(CHUNK_SIZE * 6),
      childCount,
      childStart,
      size,
      shBands: 0,
    });
    plans.length = 0;
    reschedule(1);
    const coarse = plans.at(-1)!;
    expect(coarse.candidateSlots?.length).toBe(CHUNK_SIZE);
    const coarseGeneration = coarse.candidateGeneration as number;
    send({ type: 'published', generation: coarseGeneration, activeListVersion: 1 });

    for (const file of [10, 11]) {
      const count = CHUNK_SIZE;
      const leafPositions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) leafPositions[i * 3 + 2] = 10;
      send({
        type: 'chunk',
        file,
        count,
        positions: leafPositions,
        colors: new Uint8Array(count * 4),
        covariances: new Float32Array(count * 6),
        childCount: new Uint16Array(count),
        childStart: new Uint32Array(count),
        size: new Float32Array(count).fill(0.01),
        shBands: 0,
      });
    }

    plans.length = 0;
    reschedule(2, 1); // a camera move makes the complete replacement immediately eligible
    const staged = plans.at(-1)!;
    expect(staged.converged).toBe(false);
    expect(staged.candidateSlots).toBeUndefined();
    expect(staged.appends.count).toBe(CHUNK_SIZE);

    reschedule(3, 2, true); // newer camera is coalesced behind this candidate
    const ready = plans.at(-1)!;
    expect(ready.converged).toBe(true);
    expect(ready.candidateGeneration).toBe(staged.candidateGeneration);
    expect(ready.candidateSlots?.length).toBe(2 * fan + CHUNK_SIZE - 2);

    // Until the matching publication is acknowledged the worker emits no new
    // selection, so neither the roots nor their children can be mixed on screen.
    const beforeAck = plans.length;
    reschedule(4, 3);
    expect(plans.length).toBe(beforeAck);
    send({
      type: 'published',
      generation: ready.candidateGeneration as number,
      activeListVersion: 2,
    });
    expect(plans.length).toBeGreaterThan(beforeAck);
  });

  it('finishes the pending drain before re-traversing for a newly cached chunk', () => {
    // A late chunk gives the cut somewhere finer to descend, but it cannot make
    // an already-queued splat wrong. Draining first is what keeps a cold load
    // moving: that is exactly when chunks arrive continuously, so invalidating
    // on each one would restart the ramp forever and never deliver it.
    sendTree(ROOTS, FAN);
    reschedule(1);
    expect(plans.at(-1)!.converged).toBe(false); // a drain is pending
    const afterFirst = traverseSpy.mock.calls.length;

    const n = CHUNK_SIZE;
    send({
      type: 'chunk',
      file: 400,
      count: n,
      positions: new Float32Array(n * 3),
      colors: new Uint8Array(n * 4),
      covariances: new Float32Array(n * 6),
      childCount: new Uint16Array(n),
      childStart: new Uint32Array(n),
      size: new Float32Array(n),
      shBands: 0,
    });

    // The queue drains first, on no further traversals...
    let seq = 2;
    while (!plans.at(-1)!.converged && seq < 200) reschedule(seq++);
    expect(plans.at(-1)!.converged).toBe(true);
    expect(traverseSpy.mock.calls.length).toBe(afterFirst);

    // ...and only then does the next reschedule re-solve with the new chunk.
    reschedule(seq);
    expect(traverseSpy.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('never writes a slot twice in one ramp, and lands on the full frontier', () => {
    sendTree(ROOTS, FAN);
    plans.length = 0;
    // A slot is "written" once a move or an append has covered it. Tracked as a
    // flat byte array and reduced to one assertion per plan: the drawn prefix
    // must never contain a slot the host was not told to fill.
    const written = new Uint8Array(200_000);
    let seq = 1;
    let last: FrontierPlanMessage | undefined;
    do {
      reschedule(seq++);
      last = plans.at(-1)!;
      for (let i = 0; i < last.moveSlots.length; i++) written[last.moveSlots[i] as number] = 1;
      for (let j = 0; j < last.appends.count; j++) written[last.appendStart + j] = 1;
      let unwritten = -1;
      for (let s = 0; s < last.residentCount; s++) {
        if (written[s] === 0) {
          unwritten = s;
          break;
        }
      }
      expect(unwritten).toBe(-1);
      expect(last.moves.globals).toHaveLength(last.moves.count);
      expect(last.appends.globals).toHaveLength(last.appends.count);
      expect(last.moves.count + last.appends.count + last.degenerateCount).toBeLessThanOrEqual(
        PLAN_WRITE_CAP,
      );
      expect(last.gatherMissing).toBe(0);
      expect(last.dropped).toBe(0);
    } while (!last.converged && seq < 200);
    expect(last.converged).toBe(true);
    expect(last.residentCount).toBe(FRONTIER_SPLATS);
  });
});
