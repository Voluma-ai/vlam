/**
 * Web Worker that runs the `.rad` page-table frontier off the main thread.
 *
 * Demand (what to fetch) is calculated from the same hierarchy walk that
 * selects the rendered cut, then posted *before* gather/transfer. Chunk
 * arrivals update missing-child discovery without waiting for the previous
 * candidate to finish staging. Staging keeps a continuation cursor.
 *
 * Protocol:
 *  - main → worker `init`      : `{ capacity, chunkSize, pagerMode }` once.
 *  - main → worker `chunk`     : a decoded chunk's arrays (buffers transferred).
 *  - main → worker `reschedule`: `{ seq, cameraLocal, budget, … }`.
 *  - worker → main `demand`    : ordered missing chunks, before the matching plan.
 *  - worker → main `plan`      : packed splat writes for the current candidate.
 */
import { FrontierPager, type PagerPlan } from './frontier-pager';
import { IndexedFrontierPager } from './indexed-frontier-pager';
import {
  createFrontierScratch,
  explainFrontierNode,
  frontierView,
  gatherGlobals,
  hierarchyIntermediateCut,
  validateHierarchyCut,
  pixelScaleOf,
  traverseFrontier,
  traverseFrontierBounded,
  type FrontierTraversalResult,
  type FrontierView,
  type FrontierWaiter,
  type FrontierRevealQuality,
  assessFrontierRevealQuality,
} from './rad-frontier';
import type { SplatData } from '../../core/splat-data';
import { DEFAULT_PAGE_TABLE_WRITES_PER_PLAN } from '../../streaming/streaming-defaults';
import { experiments } from '../../internal/experiments';
import { compareDemand } from './frontier-demand';

export type {
  FrontierChunkMessage,
  FrontierInitMessage,
  FrontierRescheduleMessage,
  FrontierRequest,
  PlanSplats,
  FrontierPlanMessage,
  FrontierDemandReply,
  FrontierSnapshotReply,
} from './frontier-worker-protocol';
import type {
  FrontierRequest,
  FrontierRescheduleMessage,
  PlanSplats,
  FrontierPlanMessage,
  FrontierDemandWant,
  FrontierSkipSample,
  FrontierSnapshotReply,
} from './frontier-worker-protocol';

const cache = new Map<number, SplatData>();
const cacheBytes = new Map<number, number>();
const cacheRecency = new Map<number, number>();
let cacheClock = 0;
const roots = new Set<number>();
let pager: FrontierPager | null = null;
let indexed: IndexedFrontierPager | null = null;
let chunkPagesMode = false;
const gpuResidentFiles = new Set<number>();
let chunkSize = 65536;
let cpuCacheBytes = 256 * 1024 * 1024;
let maxPlanWrites = DEFAULT_PAGE_TABLE_WRITES_PER_PLAN;
let totalBytes = 0;
let neededFiles = new Set<number>();
/** Evictions are logically charged immediately but physically removed only
 * after the plan has gathered the source rows it is about to publish. */
const deferredEvictions = new Set<number>();
let solvedLimit = Number.POSITIVE_INFINITY;
let thresholdLimit = Number.POSITIVE_INFINITY;
let thresholdBudget = -1;
const thresholdStack: number[] = [];
let traversalFallbackCount = 0;
let lastTraversalFallback = false;
let lastRootCoverInfeasible = false;
let lastTraversalMs = 0;
let lastTraversalId = 0;
let nextTraversalId = 1;
let initialPublishMinSplats = 0;
const scratch = createFrontierScratch();
let waiters: FrontierWaiter[] = [];
let lastTouched = new Map<number, number>();
let lastView: FrontierView | null = null;
let demandRevision = 0;
let lastDemandCameraKey = '';
const LIMIT_STEP = 1.6;
const LIMIT_FLOOR_FACTOR = 1 / 32;
const BUDGET_SPEND_TARGET = 0.75;
const BUDGET_SPEND_URGENT = 0.5;
const MAX_INTERMEDIATE_CANDIDATE_NEW_SPLATS = 512_000;
type MutablePlanExtras = {
  -readonly [Key in keyof FrontierPlanMessage]?: FrontierPlanMessage[Key];
};

let lastPlanKey: string | null = null;
let lastCameraKey: string | null = null;
let lastLimit = Number.POSITIVE_INFINITY;
let lastTouchedFiles = new Uint32Array(0);
let lastPublish = false;
let lastInfeasibleKey: string | null = null;
let lastSkipSamples: readonly FrontierSkipSample[] = [];
let diagnosticsEnabled = false;
let cacheRevision = 0;
let lastRevision = 0;
let lastBudget = 0;
let indexedTargetGlobals: number[] | null = null;
let indexedTargetCameraKey: string | null = null;
let indexedCandidateCancellationCount = 0;
let chunkPageGeneration = 0;
let lastBoundedCutRefusalReason: FrontierPlanMessage['boundedCutRefusalReason'] = undefined;
let indexedTargetDirty = false;
let indexedCandidateBounded = false;
let indexedCandidateRevealQuality: FrontierRevealQuality | null = null;
let indexedCandidateRevision: number | null = null;
let indexedCandidateCameraKey: string | null = null;
let indexedCancelledCandidateGeneration: number | undefined;
let indexedDiagnosticCut: FrontierPlanMessage['diagnosticCut'] | undefined;

const DIAGNOSTIC_GLOBAL_SAMPLE = 4096;

function diagnosticGlobalSample(globals: ArrayLike<number>): Uint32Array | undefined {
  if (!diagnosticsEnabled || globals.length === 0) return undefined;
  const count = Math.min(globals.length, DIAGNOSTIC_GLOBAL_SAMPLE);
  const sample = new Uint32Array(count);
  if (globals.length <= count) {
    for (let i = 0; i < count; i++) sample[i] = globals[i] as number;
    return sample;
  }
  const head = Math.floor(count / 2);
  for (let i = 0; i < head; i++) sample[i] = globals[i] as number;
  for (let i = head; i < count; i++) {
    sample[i] = globals[globals.length - count + i] as number;
  }
  return sample;
}

function markIndexedCancellation(generation: number | null): void {
  if (generation === null) return;
  indexedCancelledCandidateGeneration = generation;
  indexedCandidateRevision = null;
  indexedCandidateCameraKey = null;
  indexedDiagnosticCut = undefined;
}

function diagnosticCutForGlobals(globals: ArrayLike<number>): FrontierPlanMessage['diagnosticCut'] {
  if (globals.length > DIAGNOSTIC_GLOBAL_SAMPLE * 2) {
    const unique = new Set(Array.from(globals));
    return {
      valid: unique.size === globals.length,
      ancestorOverlap: false,
      duplicate: unique.size !== globals.length,
      missing: false,
    };
  }
  return validateHierarchyCut(cache, [...roots], globals, chunkSize);
}

function revealQualityExtras(quality: FrontierRevealQuality | null): MutablePlanExtras {
  if (!quality) return {};
  return {
    revealReady: quality.revealReady,
    maxCentralProjectedRatio: quality.maxCentralProjectedRatio,
    maxVisibleProjectedRatio: quality.maxVisibleProjectedRatio,
  };
}

function planKey(msg: FrontierRescheduleMessage): string {
  const c = msg.cameraLocal;
  const f = msg.cameraForward;
  return `${experiments.radTraversal}|${c[0]},${c[1]},${c[2]}|${f[0]},${f[1]},${f[2]}|${msg.limit}|${msg.budget}`;
}

function cameraKey(msg: FrontierRescheduleMessage): string {
  const c = msg.cameraLocal;
  const f = msg.cameraForward;
  const p = msg.projection ?? [];
  return [
    c[0],
    c[1],
    c[2],
    f[0],
    f[1],
    f[2],
    msg.limit,
    msg.budget,
    msg.coneFov0,
    msg.coneFov,
    msg.coneFoveate,
    msg.behindFoveate,
    ...p,
  ].join(',');
}

function cameraPoseKey(msg: FrontierRescheduleMessage): string {
  const c = msg.cameraLocal;
  const f = msg.cameraForward;
  return `${c[0]},${c[1]},${c[2]}|${f[0]},${f[1]},${f[2]}`;
}

function buffersOf(splats: PlanSplats): Transferable[] {
  const list: Transferable[] = [
    splats.globals.buffer as ArrayBuffer,
    splats.positions.buffer as ArrayBuffer,
    splats.colors.buffer as ArrayBuffer,
    splats.covariances.buffer as ArrayBuffer,
  ];
  if (splats.shPacked) list.push(splats.shPacked.packed.buffer as ArrayBuffer);
  return list;
}

function emptySplats(): PlanSplats {
  return {
    count: 0,
    globals: new Uint32Array(0),
    positions: new Float32Array(0),
    colors: new Uint8Array(0),
    covariances: new Float32Array(0),
  };
}

function recordRoots(file: number, data: SplatData): void {
  if (file !== 0 || !data.radTree) return;
  const { childCount, childStart } = data.radTree;
  const count = data.count;
  const isChild = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const cc = childCount[i] as number;
    if (cc === 0) continue;
    const start = childStart[i] as number;
    for (let k = 0; k < cc; k++) {
      const local = start + k - file * chunkSize;
      if (local >= 0 && local < count) isChild[local] = 1;
    }
  }
  for (let i = 0; i < count; i++) if (isChild[i] === 0) roots.add(file * chunkSize + i);
}

function residentPager(): { hasResidentIn(file: number): boolean } | null {
  return indexed ?? pager;
}

function evict(): number[] {
  const evicted: number[] = [];
  if (chunkPagesMode) return evicted;
  refreshProtectedFiles();
  const resident = residentPager();
  if (!resident || totalBytes <= cpuCacheBytes) return evicted;
  const candidates = [...cache.keys()]
    .filter(
      (f) =>
        f !== 0 && !deferredEvictions.has(f) && !neededFiles.has(f) && !resident.hasResidentIn(f),
    )
    .sort((a, b) => {
      const importance = (lastTouched.get(a) ?? 0) - (lastTouched.get(b) ?? 0);
      return importance || (cacheRecency.get(a) ?? 0) - (cacheRecency.get(b) ?? 0);
    });
  for (const file of candidates) {
    if (totalBytes <= cpuCacheBytes) break;
    totalBytes -= cacheBytes.get(file) ?? 0;
    deferredEvictions.add(file);
    evicted.push(file);
  }
  return evicted;
}

function commitEvictions(evictedFiles: ArrayLike<number>): void {
  let committed = false;
  for (const file of Array.from(evictedFiles)) {
    if (!deferredEvictions.delete(file)) continue;
    cache.delete(file);
    cacheBytes.delete(file);
    cacheRecency.delete(file);
    committed = true;
  }
  if (committed) {
    cacheRevision++;
    if (indexed) indexedTargetDirty = true;
  }
}

function refreshProtectedFiles(): void {
  const protectedFiles = new Set<number>([0]);
  if (indexed) {
    for (const file of indexed.candidateFiles) protectedFiles.add(file);
  }
  for (const waiter of waiters) {
    protectedFiles.add(Math.floor(waiter.parentGlobal / chunkSize));
    for (const file of waiter.files) protectedFiles.add(file);
  }
  neededFiles = protectedFiles;
}

function protectedCacheBytes(): number {
  const protectedFiles = new Set<number>(neededFiles);
  if (indexed) {
    for (const file of indexed.residentFiles) protectedFiles.add(file);
  }
  if (pager) {
    for (const file of cache.keys()) {
      if (pager.hasResidentIn(file)) protectedFiles.add(file);
    }
  }
  let bytes = 0;
  for (const file of protectedFiles) bytes += cacheBytes.get(file) ?? 0;
  return bytes;
}

function rankTouched(touched: ReadonlyMap<number, number>): FrontierDemandWant[] {
  const wants: FrontierDemandWant[] = [];
  for (const [file, priority] of touched) {
    if (cache.has(file)) continue;
    wants.push({ file, tier: 0, priority });
  }
  if (!chunkPagesMode) wants.sort(compareDemand);
  return wants;
}

function postDemand(
  complete: boolean,
  traversalId: number,
  revision = demandRevision,
  reason: 'traversed' | 'draining' | 'discovery' = complete ? 'traversed' : 'discovery',
): void {
  const wants = rankTouched(lastTouched);
  demandRevision = revision;
  if (diagnosticsEnabled) {
    console.debug(
      '[vlam:rad-demand]',
      JSON.stringify({
        revision,
        complete,
        reason,
        traversalId,
        wants: wants.length,
        wantFiles: wants.slice(0, 16).map((want) => want.file),
        waiters: waiters.length,
        discoveryQueued: Math.max(0, discoveryQueue.length - discoveryCursor),
      }),
    );
  }
  const reply = {
    type: 'demand' as const,
    generation: revision,
    wants,
    complete,
    revision,
    traversalId,
    reason,
  };
  (self as unknown as Worker).postMessage(reply);
}

function postSnapshot(requestId: number): void {
  const dependencies = new Set<number>(lastTouchedFiles);
  for (const waiter of waiters) {
    for (const file of waiter.files) dependencies.add(file);
  }
  const cachedFiles = Uint32Array.from([...cache.keys()].sort((a, b) => a - b));
  const dependencyFiles = Uint32Array.from([...dependencies].sort((a, b) => a - b));
  const displayedGeneration = indexed?.displayGeneration ?? pager?.displayGeneration ?? 0;
  const candidateGeneration = indexed?.candidateGeneration ?? null;
  const selectionCount = indexed
    ? indexed.candidateCount || indexed.displayCount
    : (pager?.residentCount ?? 0);
  const reply: FrontierSnapshotReply = {
    type: 'snapshot',
    requestId,
    revision: lastRevision,
    traversalId: lastTraversalId,
    cacheRevision,
    threshold: lastLimit,
    budget: lastBudget,
    selectionCount,
    cachedFiles,
    cameraLocal: lastView ? [lastView.origin.x, lastView.origin.y, lastView.origin.z] : null,
    cameraForward: lastView?.forward
      ? [lastView.forward.x, lastView.forward.y, lastView.forward.z]
      : null,
    displayedGeneration,
    candidateGeneration,
    awaitingPublication: indexed?.awaitingPublication ?? false,
    dependencyFiles,
    discoveryQueued: Math.max(0, discoveryQueue.length - discoveryCursor),
    discoveryWaiting: waiters.length,
    skipSamples: diagnosticsEnabled ? lastSkipSamples : [],
  };
  (self as unknown as Worker).postMessage(reply, [cachedFiles.buffer, dependencyFiles.buffer]);
}

function skipSamplesFor(
  result: FrontierTraversalResult,
  view: FrontierView,
  limit: number,
  budget: number,
): FrontierSkipSample[] {
  return result.notables
    .map((node) =>
      explainFrontierNode(cache, node.global, chunkSize, view, limit, budget, {
        count: result.count,
        budgetClamped: result.budgetClamped,
      }),
    )
    .filter((sample): sample is FrontierSkipSample => sample !== null);
}

function viewCamera(): Partial<FrontierPlanMessage> {
  if (!lastView) return {};
  return {
    cameraLocal: [lastView.origin.x, lastView.origin.y, lastView.origin.z],
  };
}

function protectPendingAppends(): void {
  if (indexed) {
    refreshProtectedFiles();
    for (const file of indexed.candidateFiles) neededFiles.add(file);
    return;
  }
  refreshProtectedFiles();
  if (!pager?.hasPendingDrain) return;
  for (const global of pager.pendingAppendGlobals()) {
    neededFiles.add(Math.floor(global / chunkSize));
  }
}

export function shouldPublishFrontier(
  uncachedTouchedCount: number,
  hasPublishedDisplay: boolean,
  initialPublishMinSplats = 0,
  currentSplatCount = 0,
  qualityComplete = false,
): boolean {
  void uncachedTouchedCount;
  if (currentSplatCount <= 0) return false;
  if (hasPublishedDisplay) return true;
  // Timeline exception: a traversal that finished at the pixel threshold or
  // leaves may publish below the allocation gate. Empty requests, budget
  // stops, drains, and stale cameras are not this signal.
  if (qualityComplete) return true;
  if (initialPublishMinSplats <= 0) return true;
  return currentSplatCount >= initialPublishMinSplats;
}

function applySelection(result: FrontierTraversalResult): number[] {
  const desiredGlobals: number[] = [];
  for (const [file, locals] of result.selection) {
    const base = file * chunkSize;
    for (let k = 0; k < locals.length; k++) desiredGlobals.push(base + (locals[k] as number));
  }
  lastTouched = result.touched;
  resetDiscovery(chunkPagesMode ? [] : result.waiters);
  return desiredGlobals;
}

let discoveryQueue: number[] = [];
let discoveryCursor = 0;
let discoveryQueued = new Set<number>();
let discoveryRevision = 0;
let discoveryContinuationScheduled = false;

function resetDiscovery(nextWaiters: readonly FrontierWaiter[] = []): void {
  discoveryRevision++;
  waiters = [...nextWaiters];
  discoveryQueue = nextWaiters.map((waiter) => waiter.parentGlobal);
  discoveryQueued = new Set(discoveryQueue);
  discoveryCursor = 0;
}

function enqueueDiscovery(global: number): void {
  if (discoveryQueued.has(global)) return;
  discoveryQueued.add(global);
  discoveryQueue.push(global);
}

function compactDiscoveryQueue(): void {
  if (discoveryCursor === discoveryQueue.length) {
    discoveryQueue = [];
    discoveryCursor = 0;
    discoveryQueued.clear();
  } else if (discoveryCursor >= 1024 && discoveryCursor * 2 >= discoveryQueue.length) {
    discoveryQueue = discoveryQueue.slice(discoveryCursor);
    discoveryCursor = 0;
    discoveryQueued = new Set(discoveryQueue);
  }
}

function hasDiscoveryContinuation(): boolean {
  return discoveryCursor < discoveryQueue.length;
}

function scheduleDiscoveryContinuation(): void {
  if (!lastView || !hasDiscoveryContinuation() || discoveryContinuationScheduled) return;
  discoveryContinuationScheduled = true;
  const revision = discoveryRevision;
  setTimeout(() => {
    discoveryContinuationScheduled = false;
    if (revision !== discoveryRevision || !lastView) return;
    if (expandWaiters()) postDemand(false, 0, demandRevision, 'discovery');
    scheduleDiscoveryContinuation();
  }, 0);
}

/** Walk resident descendants until a missing chunk, leaf, or quality threshold. */
function expandWaiters(budgetMs = 4): boolean {
  const view = lastView;
  if (!view) return false;
  const startedAt = performance.now();
  let discovered = false;
  const remaining: FrontierWaiter[] = [];

  const touchChildren = (
    parentGlobal: number,
    pixelScale: number,
    start: number,
    count: number,
  ) => {
    if (count <= 0) return true;
    const first = Math.floor(start / chunkSize);
    const last = Math.floor((start + count - 1) / chunkSize);
    const files: number[] = [];
    for (let cc = first; cc <= last; cc++) {
      if (cache.has(cc)) continue;
      files.push(cc);
      if (pixelScale > (lastTouched.get(cc) ?? 0)) lastTouched.set(cc, pixelScale);
      discovered = true;
    }
    if (files.length > 0) remaining.push({ parentGlobal, pixelScale, files });
    return files.length === 0;
  };

  const visit = (global: number): void => {
    const file = Math.floor(global / chunkSize);
    const data = cache.get(file);
    if (!data?.radTree) return;
    cacheRecency.set(file, ++cacheClock);
    const local = global - file * chunkSize;
    const childCount = data.radTree.childCount[local] as number;
    if (childCount <= 0) return;
    const pixelScale = pixelScaleOf(data, local, view);
    if (pixelScale <= lastLimit) return;
    const childStart = data.radTree.childStart[local] as number;
    if (!touchChildren(global, pixelScale, childStart, childCount)) return;
    for (let c = 0; c < childCount; c++) enqueueDiscovery(childStart + c);
  };

  let waiterIndex = 0;
  for (; waiterIndex < waiters.length; waiterIndex++) {
    if (performance.now() - startedAt >= budgetMs) {
      for (let i = waiterIndex; i < waiters.length; i++) {
        remaining.push(waiters[i] as FrontierWaiter);
      }
      break;
    }
    const waiter = waiters[waiterIndex] as FrontierWaiter;
    const missing = waiter.files.filter((file) => !cache.has(file));
    if (missing.length > 0) {
      remaining.push({ ...waiter, files: missing });
      continue;
    }
    visit(waiter.parentGlobal);
  }

  while (discoveryCursor < discoveryQueue.length) {
    if (performance.now() - startedAt >= budgetMs) break;
    const global = discoveryQueue[discoveryCursor] as number;
    discoveryQueued.delete(global);
    visit(global);
    discoveryCursor++;
  }
  compactDiscoveryQueue();
  waiters = remaining;
  return discovered;
}

function ingestChunk(msg: Extract<FrontierRequest, { type: 'chunk' }>): void {
  const data: SplatData = {
    count: msg.count,
    positions: msg.positions,
    colors: msg.colors,
    covariances: msg.covariances,
    radTree: { childCount: msg.childCount, childStart: msg.childStart, size: msg.size },
    ...(msg.shBands && msg.shPacked && msg.shRange
      ? { shPacked: { bands: msg.shBands, packed: msg.shPacked, range: msg.shRange } }
      : {}),
  };
  const prev = cacheBytes.get(msg.file);
  if (prev !== undefined) totalBytes -= prev;
  const bytes =
    msg.positions.byteLength +
    msg.colors.byteLength +
    msg.covariances.byteLength +
    msg.childCount.byteLength +
    msg.childStart.byteLength +
    msg.size.byteLength +
    (msg.shPacked?.byteLength ?? 0);
  cache.set(msg.file, data);
  cacheRecency.set(msg.file, ++cacheClock);
  cacheBytes.set(msg.file, bytes);
  totalBytes += bytes;
  cacheRevision++;
  recordRoots(msg.file, data);
  if (indexed) indexedTargetDirty = true;
  if (!chunkPagesMode) {
    if (expandWaiters()) postDemand(false, 0, demandRevision, 'discovery');
    scheduleDiscoveryContinuation();
  }
}

function postClassicPlan(
  seq: number,
  plan: PagerPlan,
  touchedFiles: Uint32Array,
  limit: number,
  evictedFiles: Uint32Array,
  extras: Partial<FrontierPlanMessage> = {},
): void {
  const moveSlots = new Uint32Array(plan.moves.length);
  const moveGlobals = new Uint32Array(plan.moves.length);
  for (let i = 0; i < plan.moves.length; i++) {
    moveSlots[i] = plan.moves[i]!.slot;
    moveGlobals[i] = plan.moves[i]!.global;
  }
  const gatherStats = { missing: 0 };
  const moves: PlanSplats = {
    ...gatherGlobals(cache, moveGlobals, chunkSize, gatherStats),
    globals: moveGlobals,
  };
  const appends: PlanSplats = {
    ...gatherGlobals(cache, plan.appends, chunkSize, gatherStats),
    globals: plan.appends,
  };
  const reply: FrontierPlanMessage = {
    type: 'plan',
    seq,
    moveSlots,
    moves,
    appendStart: plan.appendStart,
    appends,
    degenerateStart: plan.degenerateStart,
    degenerateCount: plan.degenerateCount,
    touched: touchedFiles,
    residentCount: plan.count,
    displayCount: pager!.displayCount,
    displayGeneration: pager!.displayGeneration,
    gatherMissing: gatherStats.missing,
    dropped: plan.dropped,
    evicted: evictedFiles,
    solvedLimit: limit,
    capacity: pager!.capacity,
    converged: !plan.truncated,
    pendingFrontierSplats: pager!.pendingNewcomerCount,
    staleResidentSplats: pager!.pendingStaleCount,
    cacheBytes: totalBytes,
    cacheLimitBytes: cpuCacheBytes,
    traversalStrategy: experiments.radTraversal,
    traversalFallback: lastTraversalFallback,
    traversalFallbackCount,
    rootCoverInfeasible: lastRootCoverInfeasible,
    traversalMs: lastTraversalMs,
    traversalId: lastTraversalId,
    skipSamples: lastSkipSamples,
    ...viewCamera(),
    ...extras,
  };
  commitEvictions(evictedFiles);
  (self as unknown as Worker).postMessage(reply, [
    moveSlots.buffer,
    ...buffersOf(moves),
    ...buffersOf(appends),
    touchedFiles.buffer,
    evictedFiles.buffer,
  ]);
}

function postIndexedPlan(
  seq: number,
  writeSlots: Uint32Array,
  writeGlobals: Uint32Array,
  touchedFiles: Uint32Array,
  limit: number,
  evictedFiles: Uint32Array,
  extras: Partial<FrontierPlanMessage> = {},
): void {
  const gatherStats = { missing: 0 };
  const appends: PlanSplats =
    writeGlobals.length === 0
      ? emptySplats()
      : { ...gatherGlobals(cache, writeGlobals, chunkSize, gatherStats), globals: writeGlobals };
  const missingFiles = new Set<number>();
  if (gatherStats.missing > 0) {
    for (const global of writeGlobals) {
      const file = Math.floor(global / chunkSize);
      if (!cache.has(file)) missingFiles.add(file);
    }
  }
  if (diagnosticsEnabled && missingFiles.size > 0) {
    console.debug(
      '[vlam:rad-gather-mismatch]',
      JSON.stringify({
        missing: gatherStats.missing,
        missingFiles: [...missingFiles].slice(0, 32),
        residentFiles: indexed?.residentFiles.filter((file) => missingFiles.has(file)) ?? [],
        pendingEvictions: [...deferredEvictions].filter((file) => missingFiles.has(file)),
      }),
    );
  }
  let replyWriteSlots = writeSlots;
  let replyAppends = appends;
  let replyExtras = extras;
  if (gatherStats.missing > 0 && indexed) {
    const candidateGeneration = indexed.candidateGeneration;
    const awaitingGeneration = indexed.awaitingPublicationGeneration;
    const cancelledGeneration = candidateGeneration ?? awaitingGeneration;
    if (candidateGeneration !== null) indexed.cancel();
    if (awaitingGeneration !== null) indexed.cancelUnpublishedPublication();
    if (cancelledGeneration !== null) {
      markIndexedCancellation(cancelledGeneration);
      indexedCandidateCancellationCount++;
    } else {
      indexedCandidateRevision = null;
      indexedCandidateCameraKey = null;
      indexedDiagnosticCut = undefined;
    }
    indexedTargetDirty = true;
    indexedCandidateRevealQuality = null;
    indexedCandidateBounded = false;
    replyWriteSlots = new Uint32Array(0);
    replyAppends = emptySplats();
    replyExtras = {
      ...extras,
      candidateGeneration: cancelledGeneration ?? undefined,
      candidateComplete: false,
      candidateFinal: false,
      candidateSlots: undefined,
      converged: false,
      planReason: 'waiting-for-children',
    };
  }
  if (diagnosticsEnabled && indexed) {
    console.debug(
      '[vlam:rad-plan]',
      JSON.stringify({
        seq,
        candidateGeneration: replyExtras.candidateGeneration ?? null,
        candidateComplete: replyExtras.candidateComplete ?? false,
        candidateSize: replyExtras.candidateSize ?? null,
        candidateNewSlots: replyExtras.candidateNewSlots ?? null,
        candidateReusedSlots: replyExtras.candidateReusedSlots ?? null,
        candidateRevision: indexedCandidateRevision,
        planReason: replyExtras.planReason ?? null,
        touched: touchedFiles.length,
        converged: replyExtras.converged ?? indexed.pendingCount === 0,
        pending: indexed.pendingCount,
        waitingPublication: indexed.awaitingPublication,
      }),
    );
  }
  const reply: FrontierPlanMessage = {
    type: 'plan',
    seq,
    moveSlots: new Uint32Array(0),
    moves: emptySplats(),
    appendStart: 0,
    appends: replyAppends,
    writeSlots: replyWriteSlots,
    degenerateStart: 0,
    degenerateCount: 0,
    touched: touchedFiles,
    residentCount: indexed!.residentCount,
    displayCount: indexed!.displayCount,
    displayGeneration: replyExtras.candidateGeneration ?? indexed!.candidateGeneration ?? 0,
    gatherMissing: gatherStats.missing,
    dropped: 0,
    evicted: evictedFiles,
    solvedLimit: limit,
    capacity: indexed!.capacity,
    converged: replyExtras.converged ?? indexed!.pendingCount === 0,
    pendingFrontierSplats: indexed!.pendingCount,
    staleResidentSplats: 0,
    cacheBytes: totalBytes,
    cacheLimitBytes: cpuCacheBytes,
    traversalStrategy: experiments.radTraversal,
    traversalFallback: lastTraversalFallback,
    traversalFallbackCount,
    rootCoverInfeasible: lastRootCoverInfeasible,
    traversalMs: lastTraversalMs,
    traversalId: lastTraversalId,
    skipSamples: lastSkipSamples,
    candidateCancellationCount: indexedCandidateCancellationCount,
    ...(indexedCandidateRevision !== null
      ? {
          candidateRevision: indexedCandidateRevision,
          candidateCameraKey: indexedCandidateCameraKey ?? undefined,
        }
      : {}),
    ...(indexedCancelledCandidateGeneration !== undefined
      ? { cancelledCandidateGeneration: indexedCancelledCandidateGeneration }
      : {}),
    ...(lastBoundedCutRefusalReason
      ? { boundedCutRefusalReason: lastBoundedCutRefusalReason }
      : {}),
    ...(diagnosticsEnabled && missingFiles.size > 0
      ? { diagnosticGatherMissingFiles: Uint32Array.from([...missingFiles].slice(0, 32)) }
      : {}),
    protectedCacheBytes: protectedCacheBytes(),
    ...viewCamera(),
    ...replyExtras,
  };
  indexedCancelledCandidateGeneration = undefined;
  commitEvictions(evictedFiles);
  (self as unknown as Worker).postMessage(reply, [
    ...buffersOf(reply.moves),
    ...buffersOf(replyAppends),
    replyWriteSlots.buffer,
    touchedFiles.buffer,
    evictedFiles.buffer,
    ...(reply.candidateSlots ? [reply.candidateSlots.buffer] : []),
    ...(reply.diagnosticCandidateGlobals ? [reply.diagnosticCandidateGlobals.buffer] : []),
    ...(reply.diagnosticGatherMissingFiles ? [reply.diagnosticGatherMissingFiles.buffer] : []),
  ]);
}

function postChunkPagesPlan(
  seq: number,
  globals: Uint32Array,
  touchedFiles: Uint32Array,
  limit: number,
  converged: boolean,
  revision: number,
  cameraKeyValue: string,
  revealQuality: FrontierRevealQuality,
): void {
  const generation = ++chunkPageGeneration;
  const reply: FrontierPlanMessage = {
    type: 'plan',
    seq,
    moveSlots: new Uint32Array(0),
    moves: emptySplats(),
    appendStart: 0,
    appends: emptySplats(),
    writeSlots: new Uint32Array(0),
    candidateGeneration: generation,
    candidateRevision: revision,
    candidateCameraKey: cameraKeyValue,
    candidateSize: globals.length,
    candidateNewSlots: 0,
    candidateReusedSlots: globals.length,
    candidateComplete: true,
    candidateFinal: converged,
    revealReady: revealQuality.revealReady,
    maxCentralProjectedRatio: revealQuality.maxCentralProjectedRatio,
    maxVisibleProjectedRatio: revealQuality.maxVisibleProjectedRatio,
    selectionGlobals: globals,
    degenerateStart: 0,
    degenerateCount: 0,
    touched: touchedFiles,
    residentCount: globals.length,
    displayCount: globals.length,
    displayGeneration: generation,
    gatherMissing: 0,
    dropped: 0,
    evicted: new Uint32Array(0),
    solvedLimit: limit,
    capacity: gpuResidentFiles.size * chunkSize,
    converged,
    pendingFrontierSplats: 0,
    staleResidentSplats: 0,
    cacheBytes: totalBytes,
    cacheLimitBytes: cpuCacheBytes,
    traversalStrategy: experiments.radTraversal,
    traversalFallback: lastTraversalFallback,
    traversalFallbackCount,
    rootCoverInfeasible: lastRootCoverInfeasible,
    traversalMs: lastTraversalMs,
    traversalId: lastTraversalId,
    skipSamples: lastSkipSamples,
    protectedCacheBytes: protectedCacheBytes(),
    ...viewCamera(),
  };
  (self as unknown as Worker).postMessage(reply, [globals.buffer, touchedFiles.buffer]);
}

function solveFrontier(msg: FrontierRescheduleMessage): FrontierTraversalResult {
  const rootList = [...roots].filter((g) => cache.has(Math.floor(g / chunkSize)));
  const view = frontierView(
    { x: msg.cameraLocal[0], y: msg.cameraLocal[1], z: msg.cameraLocal[2] },
    { x: msg.cameraForward[0], y: msg.cameraForward[1], z: msg.cameraForward[2] },
    msg,
  );
  lastView = view;
  const options = { scratch, collectDiagnostics: diagnosticsEnabled };
  const startedAt = performance.now();
  lastTraversalId = nextTraversalId++;
  lastTraversalMs = 0;
  const hardCap = chunkPagesMode ? msg.budget : Math.min(msg.budget, (indexed ?? pager)!.capacity);
  let result: FrontierTraversalResult;
  if (experiments.radTraversal === 'bounded-threshold') {
    if (thresholdBudget !== hardCap) {
      thresholdBudget = hardCap;
      thresholdLimit = msg.limit;
    }
    const floor = msg.limit * LIMIT_FLOOR_FACTOR;
    const limit = Math.max(floor, thresholdLimit);
    const candidate = traverseFrontierBounded(
      cache,
      rootList,
      chunkSize,
      view,
      limit,
      hardCap,
      thresholdStack,
    );
    result = candidate;
    lastTraversalFallback = candidate.fallback;
    lastRootCoverInfeasible = candidate.rootCoverInfeasible;
    lastLimit = limit;
    if (candidate.fallback) {
      traversalFallbackCount++;
      thresholdLimit = limit * 1.25;
    } else {
      const target = hardCap * 0.9;
      thresholdLimit =
        candidate.count < hardCap * 0.8 || candidate.count > hardCap
          ? Math.max(
              floor,
              limit * Math.max(0.8, Math.min(1.25, Math.sqrt(candidate.count / target))),
            )
          : limit;
    }
  } else if (experiments.radTraversal === 'heap') {
    const floor = msg.limit * LIMIT_FLOOR_FACTOR;
    let limit = Math.min(msg.limit, Math.max(floor, solvedLimit));
    result = traverseFrontier(cache, rootList, chunkSize, view, limit, msg.budget, options);
    lastTraversalFallback = false;
    lastRootCoverInfeasible = result.rootCoverInfeasible;
    if (
      !result.budgetClamped &&
      result.refinable &&
      limit > floor &&
      result.count < msg.budget * BUDGET_SPEND_URGENT
    ) {
      const finer = Math.max(floor, limit / LIMIT_STEP);
      const refined = traverseFrontier(
        cache,
        rootList,
        chunkSize,
        view,
        finer,
        msg.budget,
        options,
      );
      if (!refined.budgetClamped && refined.count <= msg.budget) {
        limit = finer;
        result = refined;
      }
    }
    solvedLimit =
      !result.budgetClamped && result.refinable && result.count < msg.budget * BUDGET_SPEND_TARGET
        ? Math.max(floor, limit / LIMIT_STEP)
        : limit;
    lastLimit = limit;
    lastRootCoverInfeasible = result.rootCoverInfeasible;
  } else {
    lastTraversalFallback = false;
    result = traverseFrontier(cache, rootList, chunkSize, view, msg.limit, msg.budget, options);
    lastRootCoverInfeasible = result.rootCoverInfeasible;
    lastLimit = msg.limit;
  }
  lastTraversalMs = performance.now() - startedAt;
  return result;
}

function countNewGlobals(base: ArrayLike<number>, candidate: ArrayLike<number>): number {
  const resident = new Set<number>();
  for (let i = 0; i < base.length; i++) resident.add(base[i] as number);
  let count = 0;
  for (let i = 0; i < candidate.length; i++) {
    if (!resident.has(candidate[i] as number)) count++;
  }
  return count;
}

function indexedCandidateIsFinal(): boolean {
  return (
    !indexedTargetDirty &&
    indexed !== null &&
    indexedTargetGlobals !== null &&
    indexed.matchesCandidate(indexedTargetGlobals)
  );
}

function drainIndexed(msg: FrontierRescheduleMessage): void {
  if (!indexed) return;
  const generation = indexed.candidateGeneration;
  if (generation === null) return;
  const diagnosticCandidateGlobals = diagnosticsEnabled
    ? diagnosticGlobalSample(indexed.candidateGlobals)
    : undefined;
  const stage = indexed.stage(generation, maxPlanWrites);
  if (!stage) return;
  protectPendingAppends();
  const extras: MutablePlanExtras = {
    candidateGeneration: generation,
    traversalMs: 0,
    converged: false,
    planReason: stage.complete
      ? indexedCandidateBounded
        ? 'intermediate'
        : 'traversed'
      : 'draining',
    candidateSize: indexed.candidateCount,
    candidateNewSlots: indexed.candidateNewCount,
    candidateReusedSlots: indexed.candidateReusedCount,
    candidateComplete: stage.complete,
    candidateFinal: stage.complete && indexedCandidateIsFinal(),
    ...(diagnosticCandidateGlobals ? { diagnosticCandidateGlobals } : {}),
    ...(indexedDiagnosticCut ? { diagnosticCut: indexedDiagnosticCut } : {}),
    ...revealQualityExtras(indexedCandidateRevealQuality),
  };
  if (stage.complete && lastPublish && !indexed.awaitingPublication) {
    const publication = indexed.beginPublication(generation);
    if (publication) {
      const finalCandidate = extras.candidateFinal === true;
      extras.candidateSlots = publication.slots;
      extras.displayCount = publication.count;
      extras.displayGeneration = publication.generation;
      extras.converged = finalCandidate;
      extras.candidateFinal = finalCandidate;
    }
  }
  postIndexedPlan(
    msg.seq,
    stage.slots,
    stage.globals,
    Uint32Array.from(lastTouchedFiles),
    lastLimit,
    Uint32Array.from(evict()),
    extras,
  );
}

function updateIndexed(
  msg: FrontierRescheduleMessage,
  desiredGlobals: number[],
  desiredRevealQuality: FrontierRevealQuality,
  publish: boolean,
  allowIntermediate: boolean,
): void {
  if (!indexed) return;
  const targetCameraKey = cameraKey(msg);
  const targetRevision = msg.revision ?? demandRevision;
  const candidateRevisionChanged =
    indexedCandidateRevision !== null && indexedCandidateRevision !== targetRevision;
  const cameraRevisionChanged =
    indexedTargetCameraKey !== targetCameraKey || candidateRevisionChanged;
  indexedTargetCameraKey = targetCameraKey;
  // The target is mutable while a same-camera candidate stages. The candidate
  // is not: it remains the exact cut selected at its own generation.
  indexedTargetGlobals = desiredGlobals.slice();
  indexedTargetDirty = false;
  if (cameraRevisionChanged) {
    if (indexed.candidateGeneration !== null) {
      markIndexedCancellation(indexed.candidateGeneration);
      indexed.cancel();
      indexedCandidateRevealQuality = null;
      indexedCandidateCancellationCount++;
    }
    const awaitingGeneration = indexed.awaitingPublicationGeneration;
    if (indexed.cancelUnpublishedPublication()) {
      markIndexedCancellation(awaitingGeneration);
      indexedCandidateRevealQuality = null;
      indexedCandidateCancellationCount++;
    }
  }
  if (indexed.awaitingPublication) {
    lastTraversalMs = 0;
    postIndexedPlan(
      msg.seq,
      new Uint32Array(0),
      new Uint32Array(0),
      Uint32Array.from(lastTouchedFiles),
      lastLimit,
      Uint32Array.from(evict()),
      {
        candidateGeneration: indexed.candidateGeneration ?? undefined,
        converged: false,
        planReason: 'awaiting-publication',
        candidateSize: indexed.candidateCount,
        candidateNewSlots: indexed.candidateNewCount,
        candidateReusedSlots: indexed.candidateReusedCount,
      },
    );
    return;
  }
  const slotLimit = indexed.pendingSlotLimit;
  if (indexed.matchesDisplay(desiredGlobals, slotLimit) && indexed.candidateGeneration === null) {
    postIndexedPlan(
      msg.seq,
      new Uint32Array(0),
      new Uint32Array(0),
      Uint32Array.from(lastTouchedFiles),
      lastLimit,
      Uint32Array.from(evict()),
      {
        converged: true,
        planReason: 'unchanged-selection',
      },
    );
    return;
  }
  if (indexed.candidateGeneration === null) {
    let candidateGlobals = desiredGlobals;
    let bounded = allowIntermediate && indexed.hasPublishedDisplay;
    if (bounded) {
      const result = hierarchyIntermediateCut(
        cache,
        [...roots],
        indexed.displayGlobals,
        desiredGlobals,
        chunkSize,
        MAX_INTERMEDIATE_CANDIDATE_NEW_SPLATS,
        lastView ?? undefined,
      );
      if (!result.cut) {
        if (result.reason === 'non-refinement' || result.reason === 'already-at-target') {
          // A camera/configuration change may coarsen or reorder the cut. The
          // displayed selection cannot cover that target by descendant-only
          // replacement, so use the complete target in one atomic publish.
          bounded = false;
          candidateGlobals = desiredGlobals;
        } else {
          lastBoundedCutRefusalReason = result.reason;
          postIndexedPlan(
            msg.seq,
            new Uint32Array(0),
            new Uint32Array(0),
            Uint32Array.from(lastTouchedFiles),
            lastLimit,
            Uint32Array.from(evict()),
            {
              converged: false,
              planReason: result.reason === 'invalid-cut' ? 'non-refinement' : result.reason,
            },
          );
          return;
        }
      }
      if (result.cut) {
        candidateGlobals = result.cut;
        if (result.newCount > MAX_INTERMEDIATE_CANDIDATE_NEW_SPLATS) {
          lastBoundedCutRefusalReason = 'waiting-for-children';
          postIndexedPlan(
            msg.seq,
            new Uint32Array(0),
            new Uint32Array(0),
            Uint32Array.from(lastTouchedFiles),
            lastLimit,
            Uint32Array.from(evict()),
            { converged: false, planReason: 'waiting-for-children' },
          );
          return;
        }
        lastBoundedCutRefusalReason = undefined;
      }
    } else {
      lastBoundedCutRefusalReason = undefined;
    }
    if (
      bounded &&
      countNewGlobals(indexed.displayGlobals, candidateGlobals) >
        MAX_INTERMEDIATE_CANDIDATE_NEW_SPLATS
    ) {
      lastBoundedCutRefusalReason = 'waiting-for-children';
      postIndexedPlan(
        msg.seq,
        new Uint32Array(0),
        new Uint32Array(0),
        Uint32Array.from(lastTouchedFiles),
        lastLimit,
        Uint32Array.from(evict()),
        { converged: false, planReason: 'waiting-for-children' },
      );
      return;
    }
    if (!indexed.canStage(candidateGlobals, slotLimit)) {
      postIndexedPlan(
        msg.seq,
        new Uint32Array(0),
        new Uint32Array(0),
        Uint32Array.from(lastTouchedFiles),
        lastLimit,
        Uint32Array.from(evict()),
        { converged: false, planReason: 'capacity-blocked' },
      );
      return;
    }
    indexed.select(candidateGlobals, slotLimit);
    indexedCandidateRevision = lastRevision;
    indexedCandidateCameraKey = targetCameraKey;
    indexedDiagnosticCut = diagnosticsEnabled
      ? diagnosticCutForGlobals(candidateGlobals)
      : undefined;
    if (indexedDiagnosticCut && !indexedDiagnosticCut.valid) {
      markIndexedCancellation(indexed.candidateGeneration);
      indexed.cancel();
      lastBoundedCutRefusalReason = 'invalid-cut';
      postIndexedPlan(
        msg.seq,
        new Uint32Array(0),
        new Uint32Array(0),
        Uint32Array.from(lastTouchedFiles),
        lastLimit,
        Uint32Array.from(evict()),
        { converged: false, planReason: 'non-refinement', diagnosticCut: indexedDiagnosticCut },
      );
      return;
    }
    indexedCandidateBounded = bounded;
    indexedCandidateRevealQuality =
      candidateGlobals === desiredGlobals
        ? desiredRevealQuality
        : assessFrontierRevealQuality(
            cache,
            candidateGlobals,
            chunkSize,
            lastView as FrontierView,
            msg.projection ?? [],
            // The reveal gate is measured against the configured projected
            // target, never the adaptive traversal limit. The latter may be
            // coarsened to spend the draw budget and would let oversized
            // startup nodes pass the visual-quality gate.
            msg.limit,
          );
  }
  const generation = indexed.candidateGeneration;
  if (generation === null) return;
  const diagnosticCandidateGlobals = diagnosticsEnabled
    ? diagnosticGlobalSample(indexed.candidateGlobals)
    : undefined;
  const stage = indexed.stage(generation, maxPlanWrites);
  const extras: MutablePlanExtras = {
    candidateGeneration: generation,
    converged: !!stage?.complete,
    planReason: stage?.complete && indexedCandidateBounded ? 'intermediate' : 'traversed',
    candidateSize: indexed.candidateCount,
    candidateNewSlots: indexed.candidateNewCount,
    candidateReusedSlots: indexed.candidateReusedCount,
    candidateComplete: !!stage?.complete,
    candidateFinal: !!stage?.complete && indexedCandidateIsFinal(),
    ...(diagnosticCandidateGlobals ? { diagnosticCandidateGlobals } : {}),
    ...(indexedDiagnosticCut ? { diagnosticCut: indexedDiagnosticCut } : {}),
    ...revealQualityExtras(indexedCandidateRevealQuality),
  };
  // Once a complete display exists, every hierarchy-valid intermediate cut is
  // publishable even while the final traversal is still waiting on missing
  // descendants. The quality gate applies to the first/settled cut, not to
  // cadence between complete refinement cuts.
  if (stage?.complete && (publish || allowIntermediate)) {
    const publication = indexed.beginPublication(generation);
    if (publication) {
      const finalCandidate = extras.candidateFinal === true;
      extras.candidateSlots = publication.slots;
      extras.displayCount = publication.count;
      extras.displayGeneration = publication.generation;
      extras.converged = finalCandidate;
      extras.candidateFinal = finalCandidate;
    }
  }
  postIndexedPlan(
    msg.seq,
    stage?.slots ?? new Uint32Array(0),
    stage?.globals ?? new Uint32Array(0),
    Uint32Array.from(lastTouchedFiles),
    lastLimit,
    Uint32Array.from(evict()),
    extras,
  );
}

function reschedule(msg: FrontierRescheduleMessage): void {
  if (msg.diagnostics !== undefined) diagnosticsEnabled = msg.diagnostics;
  lastRevision = msg.revision ?? demandRevision;
  lastBudget = msg.budget;
  const key = planKey(msg);
  const camKey = cameraKey(msg);
  const poseKey = cameraPoseKey(msg);
  const cameraMoved = lastCameraKey !== null && poseKey !== lastCameraKey;
  if (msg.initialPublishMinSplats !== undefined) {
    initialPublishMinSplats = msg.initialPublishMinSplats;
  }
  const revision = msg.revision ?? demandRevision;
  if (camKey !== lastDemandCameraKey) {
    lastDemandCameraKey = camKey;
    if (cameraMoved) resetDiscovery();
  }
  demandRevision = revision;

  const draining =
    !chunkPagesMode &&
    (msg.continuePendingPlan || key === lastPlanKey) &&
    ((pager?.hasPendingDrain ?? false) || (indexed !== null && indexed.pendingCount > 0));

  if (draining && (!cameraMoved || msg.continuePendingPlan)) {
    lastTraversalMs = 0;
    if (expandWaiters()) postDemand(false, lastTraversalId, revision, 'draining');
    scheduleDiscoveryContinuation();
    if (indexed) drainIndexed(msg);
    else if (pager) {
      const plan = pager.drain(maxPlanWrites, maxPlanWrites, maxPlanWrites);
      protectPendingAppends();
      postClassicPlan(
        msg.seq,
        plan,
        Uint32Array.from(lastTouchedFiles),
        lastLimit,
        Uint32Array.from(evict()),
        {
          traversalMs: 0,
          planReason: 'draining',
        },
      );
    }
    return;
  }

  if (!pager && !indexed && !chunkPagesMode) return;
  const infeasibleKey = `${camKey}|${chunkPagesMode ? gpuResidentFiles.size : (indexed ?? pager)!.capacity}`;
  if (lastRootCoverInfeasible && lastInfeasibleKey === infeasibleKey) {
    lastTraversalMs = 0;
    postDemand(true, lastTraversalId, revision);
    if (indexed) {
      postIndexedPlan(
        msg.seq,
        new Uint32Array(0),
        new Uint32Array(0),
        Uint32Array.from(lastTouchedFiles),
        lastLimit,
        Uint32Array.from(evict()),
        { converged: false, rootCoverInfeasible: true, planReason: 'capacity-blocked' },
      );
    }
    return;
  }
  const result = solveFrontier(msg);
  const desiredGlobals = applySelection(result);
  const desiredRevealQuality = assessFrontierRevealQuality(
    cache,
    desiredGlobals,
    chunkSize,
    lastView as FrontierView,
    msg.projection ?? [],
    msg.limit,
  );
  const touchedFiles = [...result.touched].filter(([cc]) => !cache.has(cc));
  if (!chunkPagesMode) touchedFiles.sort((a, b) => b[1] - a[1]);
  lastTouchedFiles = Uint32Array.from(touchedFiles.map(([cc]) => cc));
  lastSkipSamples =
    diagnosticsEnabled && lastView ? skipSamplesFor(result, lastView, lastLimit, msg.budget) : [];
  postDemand(true, lastTraversalId, revision, 'traversed');

  const uncachedTouched = lastTouchedFiles.length;
  lastCameraKey = poseKey;
  const qualityComplete =
    result.waiters.length === 0 && !result.budgetClamped && lastTraversalId > 0;
  const publish = shouldPublishFrontier(
    uncachedTouched,
    chunkPagesMode ? false : (indexed?.hasPublishedDisplay ?? pager!.hasPublishedDisplay),
    initialPublishMinSplats,
    result.count,
    qualityComplete,
  );

  lastPlanKey = key;
  lastPublish = publish;
  lastInfeasibleKey = result.rootCoverInfeasible ? infeasibleKey : null;
  if (chunkPagesMode) {
    postChunkPagesPlan(
      msg.seq,
      Uint32Array.from(desiredGlobals),
      Uint32Array.from(lastTouchedFiles),
      lastLimit,
      result.waiters.length === 0 && !result.budgetClamped,
      revision,
      camKey,
      desiredRevealQuality,
    );
    return;
  }
  if (indexed) {
    // The helper itself rejects coarsening or a camera cut that is not a
    // hierarchy refinement. Those cases fall back to the existing full-cut
    // path; a pure refinement may still be delivered in bounded covers while
    // the camera/configuration revision settles.
    updateIndexed(
      msg,
      desiredGlobals,
      desiredRevealQuality,
      publish,
      publish || indexed.hasPublishedDisplay,
    );
    return;
  }
  const plan = pager!.update(desiredGlobals, {
    maxAppends: maxPlanWrites,
    maxWrites: maxPlanWrites,
    maxMoveSlotSpan: maxPlanWrites,
    publish,
  });
  protectPendingAppends();
  postClassicPlan(
    msg.seq,
    plan,
    Uint32Array.from(lastTouchedFiles),
    lastLimit,
    Uint32Array.from(evict()),
    { planReason: 'traversed' },
  );
}

self.onmessage = (event: MessageEvent<FrontierRequest>): void => {
  const msg = event.data;
  if (msg.type === 'init') {
    chunkSize = msg.chunkSize;
    cpuCacheBytes = msg.cpuCacheBytes;
    maxPlanWrites = msg.maxPlanWrites;
    initialPublishMinSplats = msg.initialPublishMinSplats ?? 0;
    if (msg.pagerMode === 'indexed') {
      indexed = new IndexedFrontierPager(msg.capacity, chunkSize);
      indexedCandidateBounded = false;
      pager = null;
      chunkPagesMode = false;
    } else if (msg.pagerMode === 'chunk-pages') {
      indexed = null;
      pager = null;
      chunkPagesMode = true;
    } else {
      pager = new FrontierPager(msg.capacity, chunkSize);
      indexed = null;
      chunkPagesMode = false;
    }
    solvedLimit = Number.POSITIVE_INFINITY;
    thresholdLimit = Number.POSITIVE_INFINITY;
    thresholdBudget = -1;
    traversalFallbackCount = 0;
    lastPlanKey = null;
    lastCameraKey = null;
    lastDemandCameraKey = '';
    demandRevision = 0;
    waiters = [];
    discoveryQueue = [];
    discoveryCursor = 0;
    discoveryQueued = new Set();
    lastTouched = new Map();
    lastView = null;
    lastLimit = Number.POSITIVE_INFINITY;
    lastTouchedFiles = new Uint32Array(0);
    lastPublish = false;
    indexedTargetGlobals = null;
    indexedTargetCameraKey = null;
    indexedCandidateCancellationCount = 0;
    chunkPageGeneration = 0;
    indexedCandidateBounded = false;
    indexedCandidateRevealQuality = null;
    indexedCandidateRevision = null;
    indexedCandidateCameraKey = null;
    indexedCancelledCandidateGeneration = undefined;
    indexedDiagnosticCut = undefined;
    lastBoundedCutRefusalReason = undefined;
    indexedTargetDirty = false;
    lastInfeasibleKey = null;
    lastSkipSamples = [];
    diagnosticsEnabled = msg.diagnostics ?? false;
    cacheRevision = 0;
    lastRevision = 0;
    lastBudget = 0;
    lastRootCoverInfeasible = false;
    discoveryRevision++;
    discoveryContinuationScheduled = false;
    cache.clear();
    cacheBytes.clear();
    cacheRecency.clear();
    deferredEvictions.clear();
    cacheClock = 0;
    roots.clear();
    totalBytes = 0;
    neededFiles = new Set();
    gpuResidentFiles.clear();
    return;
  }
  if (msg.type === 'chunkPages') {
    if (!chunkPagesMode) return;
    const next = new Set(Array.from(msg.files));
    for (const file of cache.keys()) {
      if (next.has(file)) continue;
      const bytes = cacheBytes.get(file) ?? 0;
      totalBytes -= bytes;
      cache.delete(file);
      cacheBytes.delete(file);
      cacheRecency.delete(file);
    }
    gpuResidentFiles.clear();
    for (const file of next) gpuResidentFiles.add(file);
    cacheRevision++;
    return;
  }
  if (msg.type === 'published') {
    if (!indexed) return;
    if (indexed.acknowledge(msg.generation)) {
      indexedCandidateRevision = null;
      indexedCandidateCameraKey = null;
      indexedDiagnosticCut = undefined;
    }
    const safe = indexed.consumeResizeSafeCapacity();
    if (safe !== null) {
      (self as unknown as Worker).postMessage({ type: 'resizeSafe', capacity: safe });
    }
    return;
  }
  if (msg.type === 'snapshot') {
    postSnapshot(msg.requestId);
    return;
  }
  if (msg.type === 'resize') {
    if (indexed) {
      if (msg.capacity > indexed.capacity) {
        indexed.grow(msg.capacity);
        const safe = indexed.consumeResizeSafeCapacity();
        if (safe !== null) {
          (self as unknown as Worker).postMessage({ type: 'resizeSafe', capacity: safe });
        }
      } else if (!indexed.requestShrink(msg.capacity)) {
        // Keep the larger logical capacity until a matching publication relocates
        // surviving tail slots and the host acknowledges them unused.
      } else {
        const safe = indexed.consumeResizeSafeCapacity();
        if (safe !== null) {
          (self as unknown as Worker).postMessage({ type: 'resizeSafe', capacity: safe });
        }
      }
    } else {
      pager?.resize(msg.capacity);
    }
    thresholdBudget = -1;
    return;
  }
  if (msg.type === 'cacheBudget') {
    cpuCacheBytes = msg.cpuCacheBytes;
    return;
  }
  if (msg.type === 'chunk') {
    ingestChunk(msg);
    return;
  }
  if (msg.type === 'demand') {
    // Host demand messages are ignored: the authoritative walk posts demand
    // itself, before gather, and chunk arrivals expand waiters without a
    // second competing scanner.
    return;
  }
  reschedule(msg);
};
