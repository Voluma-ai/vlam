import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as radFrontier from '../formats/rad/rad-frontier';
import type {
  FrontierPlanMessage,
  FrontierRequest,
  FrontierDemandReply,
  FrontierSnapshotReply,
} from '../formats/rad/frontier-worker-protocol';

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
const demands: FrontierDemandReply[] = [];
const snapshots: FrontierSnapshotReply[] = [];

/** A worker global good enough for the module: `onmessage` + `postMessage`. */
const workerSelf = {
  onmessage: null as ((event: MessageEvent<FrontierRequest>) => void) | null,
  postMessage: (message: FrontierPlanMessage | FrontierDemandReply | FrontierSnapshotReply) => {
    if (message.type === 'demand') demands.push(message);
    else if (message.type === 'plan') plans.push(message);
    else if (message.type === 'snapshot') snapshots.push(message);
  },
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
function sendRootChunk(roots: number, fan: number): void {
  const c0 = CHUNK_SIZE;
  const positions = new Float32Array(c0 * 3);
  const size = new Float32Array(c0);
  const childCount = new Uint16Array(c0);
  const childStart = new Uint32Array(c0);
  for (let i = 0; i < roots; i++) {
    positions[i * 3 + 2] = 10;
    size[i] = 8;
    childCount[i] = fan;
    childStart[i] = CHUNK_SIZE + i * fan;
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
}

function sendTree(roots: number, fan: number): void {
  const leafTotal = roots * fan;
  const leafChunks = Math.ceil(leafTotal / CHUNK_SIZE);
  sendRootChunk(roots, fan);

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
  it('publishes the first complete cover without a quality gate', () => {
    expect(frontierWorker.shouldPublishFrontier(8, false, 0, 10)).toBe(true);
    expect(frontierWorker.shouldPublishFrontier(8, false, 100, 10)).toBe(false);
    expect(frontierWorker.shouldPublishFrontier(8, false, 100, 100)).toBe(true);
    expect(frontierWorker.shouldPublishFrontier(0, false, 100, 10)).toBe(false);
    expect(frontierWorker.shouldPublishFrontier(8, true, 100, 10)).toBe(true);
    expect(frontierWorker.shouldPublishFrontier(8, false, 100, 0)).toBe(false);
    expect(frontierWorker.shouldPublishFrontier(8, false, 100, 10, true)).toBe(true);
  });

  beforeEach(() => {
    plans.length = 0;
    demands.length = 0;
    snapshots.length = 0;
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

  it('publishes a coarse complete cover while descendants are still missing', () => {
    send({
      type: 'init',
      pagerMode: 'indexed',
      capacity: 200_000,
      chunkSize: CHUNK_SIZE,
      cpuCacheBytes: 8 * 1024 * 1024 * 1024,
      maxPlanWrites: PLAN_WRITE_CAP,
    });
    sendRootChunk(ROOTS, FAN);
    reschedule(1);
    const plan = plans.at(-1)!;
    expect(plan.candidateSlots?.length).toBeGreaterThan(0);
    expect(plan.displayCount).toBeGreaterThan(0);
    expect(plan.touched.length).toBeGreaterThan(0);
  });

  it('publishes complete bounded refinements after the first cut while discovery is incomplete', () => {
    send({
      type: 'init',
      pagerMode: 'indexed',
      capacity: 200_000,
      chunkSize: CHUNK_SIZE,
      cpuCacheBytes: 8 * 1024 * 1024 * 1024,
      maxPlanWrites: PLAN_WRITE_CAP,
    });
    sendRootChunk(ROOTS, FAN);
    reschedule(1);
    const first = plans.at(-1)!;
    expect(first.candidateSlots?.length).toBeGreaterThan(0);
    send({ type: 'published', generation: first.candidateGeneration!, activeListVersion: 1 });

    const childPositions = new Float32Array(CHUNK_SIZE * 3);
    const childSize = new Float32Array(CHUNK_SIZE).fill(0.01);
    send({
      type: 'chunk',
      file: 1,
      count: CHUNK_SIZE,
      positions: childPositions,
      colors: new Uint8Array(CHUNK_SIZE * 4),
      covariances: new Float32Array(CHUNK_SIZE * 6),
      childCount: new Uint16Array(CHUNK_SIZE),
      childStart: new Uint32Array(CHUNK_SIZE),
      size: childSize,
      shBands: 0,
    });

    plans.length = 0;
    reschedule(2);
    const refinement = plans.at(-1)!;
    expect(refinement.candidateComplete).toBe(true);
    expect(refinement.candidateSlots?.length).toBeGreaterThan(first.candidateSlots!.length);
    expect(refinement.candidateNewSlots).toBeLessThanOrEqual(512_000);
  });

  it('keeps a same-camera candidate while a chunk refreshes the saved target', () => {
    const size = CHUNK_SIZE;
    send({
      type: 'init',
      pagerMode: 'indexed',
      capacity: 32,
      chunkSize: size,
      cpuCacheBytes: 8 * 1024 * 1024,
      maxPlanWrites: 1,
    });
    const rootChildCount = new Uint16Array(size);
    const rootChildStart = new Uint32Array(size);
    rootChildCount[0] = 4;
    rootChildStart[0] = size;
    send({
      type: 'chunk',
      file: 0,
      count: 1,
      positions: new Float32Array(size * 3),
      colors: new Uint8Array(size * 4),
      covariances: new Float32Array(size * 6),
      childCount: rootChildCount,
      childStart: rootChildStart,
      size: new Float32Array(size).fill(8),
      shBands: 0,
    });
    const childCount = new Uint16Array(size);
    const childStart = new Uint32Array(size);
    for (let i = 0; i < 4; i++) {
      childCount[i] = 1;
      childStart[i] = 2 * size + i;
    }
    send({
      type: 'chunk',
      file: 1,
      count: 4,
      positions: new Float32Array(size * 3),
      colors: new Uint8Array(size * 4),
      covariances: new Float32Array(size * 6),
      childCount,
      childStart,
      size: new Float32Array(size).fill(1),
      shBands: 0,
    });

    reschedule(1);
    const first = plans.at(-1)!;
    expect(first.candidateComplete).toBe(false);
    const generation = first.candidateGeneration!;

    const leaves = new Uint16Array(size);
    const leafStarts = new Uint32Array(size);
    send({
      type: 'chunk',
      file: 2,
      count: 4,
      positions: new Float32Array(size * 3),
      colors: new Uint8Array(size * 4),
      covariances: new Float32Array(size * 6),
      childCount: leaves,
      childStart: leafStarts,
      size: new Float32Array(size).fill(0.01),
      shBands: 0,
    });
    reschedule(2);
    expect(plans.at(-1)!.candidateGeneration).toBe(generation);
    expect(plans.at(-1)!.candidateCancellationCount).toBe(0);

    let published: FrontierPlanMessage | undefined;
    for (let seq = 3; seq < 10; seq++) {
      reschedule(seq);
      published = plans.at(-1)!;
      if (published.candidateSlots) break;
    }
    expect(published?.candidateGeneration).toBe(generation);
    expect(published?.candidateSlots).toBeDefined();
    send({ type: 'published', generation, activeListVersion: 1 });
    reschedule(10);
    const newest = plans.at(-1)!;
    expect(newest.candidateGeneration).not.toBe(generation);
    expect(newest.candidateNewSlots).toBeLessThanOrEqual(512_000);
  });

  it('returns a coherent worker snapshot on demand', () => {
    send({
      type: 'init',
      pagerMode: 'indexed',
      capacity: 200_000,
      chunkSize: CHUNK_SIZE,
      cpuCacheBytes: 8 * 1024 * 1024 * 1024,
      maxPlanWrites: PLAN_WRITE_CAP,
      diagnostics: true,
    });
    sendRootChunk(ROOTS, FAN);
    reschedule(1);
    send({ type: 'snapshot', requestId: 7 });

    const snapshot = snapshots.at(-1)!;
    const plan = plans.at(-1)!;
    expect(snapshot.requestId).toBe(7);
    expect(snapshot.traversalId).toBe(plan.traversalId);
    expect(snapshot.cameraLocal).toEqual([0, 0, 0]);
    expect(snapshot.cameraForward).toEqual([0, 0, 1]);
    expect(snapshot.selectionCount).toBeGreaterThan(0);
    expect(Array.from(snapshot.cachedFiles)).toEqual([0]);
    expect(Array.from(snapshot.dependencyFiles)).toContain(1);
    expect(snapshot.skipSamples.length).toBeGreaterThan(0);
  });

  it('holds first publication until the allocation-fraction count is staged', () => {
    send({
      type: 'init',
      pagerMode: 'indexed',
      capacity: 200_000,
      chunkSize: CHUNK_SIZE,
      cpuCacheBytes: 8 * 1024 * 1024 * 1024,
      maxPlanWrites: PLAN_WRITE_CAP,
      initialPublishMinSplats: 100_000,
    });
    sendRootChunk(ROOTS, FAN);
    reschedule(1);
    const plan = plans.at(-1)!;
    expect(plan.candidateSlots).toBeUndefined();
    expect(plan.displayCount ?? 0).toBe(0);
    expect(plan.appends.count).toBeGreaterThan(0);
    expect(plan.touched.length).toBeGreaterThan(0);
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
    expect(first.planReason).toBe('traversed');
    expect(plans[1]?.planReason).toBe('draining');
    expect(first.traversalId).toBeGreaterThan(0);
    expect(plans[1]?.traversalId).toBe(first.traversalId);
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

  it('discovers grandchild demand while a truncated plan is still draining', () => {
    send({
      type: 'init',
      capacity: 64,
      chunkSize: CHUNK_SIZE,
      cpuCacheBytes: 8 * 1024 * 1024 * 1024,
      maxPlanWrites: 1,
    });
    const c0 = CHUNK_SIZE;
    const rootPos = new Float32Array(c0 * 3);
    const rootSize = new Float32Array(c0);
    const rootCount = new Uint16Array(c0);
    const rootStart = new Uint32Array(c0);
    rootPos[2] = 10;
    rootSize[0] = 8;
    rootCount[0] = 2;
    rootStart[0] = CHUNK_SIZE;
    send({
      type: 'chunk',
      file: 0,
      count: c0,
      positions: rootPos,
      colors: new Uint8Array(c0 * 4),
      covariances: new Float32Array(c0 * 6),
      childCount: rootCount,
      childStart: rootStart,
      size: rootSize,
      shBands: 0,
    });
    reschedule(1);
    expect(plans.at(-1)?.converged).toBe(false);
    const afterFirst = traverseSpy.mock.calls.length;
    const touchedBefore = new Set(demands.at(-1)?.wants.map((want) => want.file) ?? []);

    const n = CHUNK_SIZE;
    const childPos = new Float32Array(n * 3);
    const childSize = new Float32Array(n);
    const childCount = new Uint16Array(n);
    const childStart = new Uint32Array(n);
    for (let i = 0; i < 2; i++) {
      childPos[i * 3 + 2] = 10;
      childSize[i] = 4;
      childCount[i] = 2;
      childStart[i] = 2 * CHUNK_SIZE + i * 2;
    }
    send({
      type: 'chunk',
      file: 1,
      count: n,
      positions: childPos,
      colors: new Uint8Array(n * 4),
      covariances: new Float32Array(n * 6),
      childCount,
      childStart,
      size: childSize,
      shBands: 0,
    });

    expect(traverseSpy.mock.calls.length).toBe(afterFirst);
    const grandchildDemand = demands.filter((reply) => !reply.complete);
    expect(grandchildDemand.length).toBeGreaterThan(0);
    expect(grandchildDemand.some((reply) => reply.wants.some((want) => want.file === 2))).toBe(
      true,
    );
    const grandchildWant = grandchildDemand.at(-1)?.wants.find((want) => want.file === 2);
    expect(grandchildWant?.priority).toBeCloseTo(0.4, 5);
    expect(grandchildWant?.tier).toBe(0);
    expect(touchedBefore.has(1) || grandchildDemand.length > 0).toBe(true);

    reschedule(2, 0, true);
    expect(traverseSpy.mock.calls.length).toBe(afterFirst);
  });

  it('continues discovery beyond the old queue cap', async () => {
    const branchCount = 4_100;
    const chunkSize = branchCount;
    send({
      type: 'init',
      capacity: branchCount + 1,
      chunkSize,
      cpuCacheBytes: 8 * 1024 * 1024 * 1024,
      maxPlanWrites: 1,
    });

    const rootPositions = new Float32Array(3);
    rootPositions[2] = 10;
    const rootSize = new Float32Array([8]);
    send({
      type: 'chunk',
      file: 0,
      count: 1,
      positions: rootPositions,
      colors: new Uint8Array(4),
      covariances: new Float32Array(6),
      childCount: new Uint16Array([branchCount]),
      childStart: new Uint32Array([chunkSize]),
      size: rootSize,
      shBands: 0,
    });
    reschedule(1);

    const childPositions = new Float32Array(branchCount * 3);
    const childSize = new Float32Array(branchCount);
    const childCount = new Uint16Array(branchCount);
    const childStart = new Uint32Array(branchCount);
    for (let i = 0; i < branchCount; i++) {
      childPositions[i * 3 + 2] = 10;
      childSize[i] = 4;
      childCount[i] = 1;
      childStart[i] = (2 + i) * chunkSize;
    }
    send({
      type: 'chunk',
      file: 1,
      count: branchCount,
      positions: childPositions,
      colors: new Uint8Array(branchCount * 4),
      covariances: new Float32Array(branchCount * 6),
      childCount,
      childStart,
      size: childSize,
      shBands: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const lastFile = 1 + branchCount;
    expect(demands.some((reply) => reply.wants.some((want) => want.file === lastFile))).toBe(true);
  });

  it('does not inherit an ancestor priority onto deeper branches below the cut', () => {
    send({
      type: 'init',
      capacity: 64,
      chunkSize: CHUNK_SIZE,
      cpuCacheBytes: 8 * 1024 * 1024 * 1024,
      maxPlanWrites: 1,
    });
    const c0 = CHUNK_SIZE;
    const rootPos = new Float32Array(c0 * 3);
    const rootSize = new Float32Array(c0);
    const rootCount = new Uint16Array(c0);
    const rootStart = new Uint32Array(c0);
    rootPos[2] = 10;
    rootSize[0] = 8;
    rootCount[0] = 2;
    rootStart[0] = CHUNK_SIZE;
    send({
      type: 'chunk',
      file: 0,
      count: c0,
      positions: rootPos,
      colors: new Uint8Array(c0 * 4),
      covariances: new Float32Array(c0 * 6),
      childCount: rootCount,
      childStart: rootStart,
      size: rootSize,
      shBands: 0,
    });
    send({
      type: 'reschedule',
      seq: 1,
      cameraLocal: [0, 0, 0],
      cameraForward: [0, 0, 1],
      coneFov0: 0,
      coneFov: 0,
      coneFoveate: 1,
      behindFoveate: 1,
      limit: 0.5,
      budget: 64,
    });

    const n = CHUNK_SIZE;
    const childPos = new Float32Array(n * 3);
    const childSize = new Float32Array(n);
    const childCount = new Uint16Array(n);
    const childStart = new Uint32Array(n);
    for (let i = 0; i < 2; i++) {
      childPos[i * 3 + 2] = 10;
      childSize[i] = 4;
      childCount[i] = 2;
      childStart[i] = 2 * CHUNK_SIZE + i * 2;
    }
    send({
      type: 'chunk',
      file: 1,
      count: n,
      positions: childPos,
      colors: new Uint8Array(n * 4),
      covariances: new Float32Array(n * 6),
      childCount,
      childStart,
      size: childSize,
      shBands: 0,
    });

    const grandchildDemand = demands.filter((reply) => reply.wants.some((want) => want.file === 2));
    expect(grandchildDemand).toEqual([]);
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

  it('builds bounded monotonic hierarchy covers that reach the uncapped cut', () => {
    // Use a small cap here to exercise the same bounded-cut logic without
    // allocating a half-million-node fixture in the unit-test process. The
    // production worker passes 512K to this helper.
    const chunkSize = 16;
    const fan = 3;
    const rootCount = 4;
    const maxNewSplats = 5;
    const rootChildCount = new Uint16Array(rootCount);
    const rootChildStart = new Uint32Array(rootCount);
    for (let root = 0; root < rootCount; root++) {
      rootChildCount[root] = fan;
      rootChildStart[root] = (root + 1) * chunkSize;
    }
    const cache = new Map<number, import('../core/splat-data').SplatData>();
    cache.set(0, {
      count: rootCount,
      positions: new Float32Array(0),
      colors: new Uint8Array(0),
      covariances: new Float32Array(0),
      radTree: {
        childCount: rootChildCount,
        childStart: rootChildStart,
        size: new Float32Array(rootCount),
      },
    });
    const desired: number[] = [];
    for (let file = 1; file <= rootCount; file++) {
      const childCount = new Uint16Array(fan);
      const childStart = new Uint32Array(fan);
      cache.set(file, {
        count: fan,
        positions: new Float32Array(0),
        colors: new Uint8Array(0),
        covariances: new Float32Array(0),
        radTree: { childCount, childStart, size: new Float32Array(fan) },
      });
      for (let child = 0; child < fan; child++) desired.push(file * chunkSize + child);
    }

    const roots = Array.from({ length: rootCount }, (_, root) => root);
    let cut = roots;
    for (let step = 0; step < rootCount; step++) {
      const next = radFrontier.hierarchyIntermediateCut(
        cache,
        roots,
        cut,
        desired,
        chunkSize,
        maxNewSplats,
      );
      expect(next.reason, `step ${step} cut ${cut.length}`).toBe('bounded');
      expect(next.cut).not.toBeNull();
      const old = new Set(cut);
      const newCount = next.cut!.filter((global) => !old.has(global)).length;
      expect(newCount).toBeLessThanOrEqual(maxNewSplats);
      const branchCoverage = new Array(rootCount).fill(0);
      for (const global of next.cut!) {
        const branch = global < chunkSize ? global : Math.floor(global / chunkSize) - 1;
        branchCoverage[branch] += global < chunkSize ? fan : 1;
      }
      expect(branchCoverage).toEqual(new Array(rootCount).fill(fan));
      for (const global of cut) {
        if (next.cut!.includes(global)) continue;
        const root = global as number;
        expect(root).toBeLessThan(chunkSize);
        const start = rootChildStart[root] as number;
        const children = next.cut!.filter((candidate) => candidate >= start && candidate < start + fan);
        expect(children).toHaveLength(fan);
      }
      cut = next.cut!;
      if (cut.length === desired.length) break;
    }
    expect(cut).toEqual(desired);
    expect(
      radFrontier.hierarchyIntermediateCut(cache, roots, cut, cut, chunkSize, maxNewSplats),
    ).toMatchObject({ cut: null, reason: 'already-at-target' });
    expect(
      radFrontier.hierarchyIntermediateCut(cache, roots, cut, roots, chunkSize, maxNewSplats),
    ).toMatchObject({ cut: null, reason: 'non-refinement' });
  });
});
