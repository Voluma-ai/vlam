/**
 * Web Worker that runs the `.rad` page-table frontier off the main thread.
 *
 * It owns the decoded-chunk cache, the LOD tree roots and the {@link FrontierPager},
 * and on each `reschedule` runs Spark's O(frontier) tree traversal, diffs the
 * result through the pager, and posts back a minimal **paging plan** - the packed
 * splat data for the survivors that moved and the newcomers, plus the freed tail
 * and the chunks to fetch next. The main thread only forwards decoded chunks in
 * and memcpys the plan into the GPU pool, so the ~ms traversal + gather never
 * block rendering. See `docs/formats/rad-notes.md` and `StreamedSplatMesh`.
 *
 * Protocol:
 *  - main → worker `init`     : `{ capacity, chunkSize }` once.
 *  - main → worker `chunk`    : a decoded chunk's arrays (buffers transferred).
 *  - main → worker `reschedule`: `{ seq, cameraLocal, planes, budget }`.
 *  - worker → main `plan`     : `{ seq, moves, appends, degenerate, touched, … }`.
 */
import { FrontierPager, type PagerPlan } from './frontier-pager';
import { frontierView, gatherGlobals, traverseFrontier } from './rad-frontier';
import type { SplatData } from '../../core/splat-data';

export type {
  FrontierChunkMessage,
  FrontierInitMessage,
  FrontierRescheduleMessage,
  FrontierRequest,
  PlanSplats,
  FrontierPlanMessage,
} from './frontier-worker-protocol';
import type {
  FrontierRequest,
  FrontierRescheduleMessage,
  PlanSplats,
  FrontierPlanMessage,
} from './frontier-worker-protocol';

// --- Worker state -----------------------------------------------------------

const cache = new Map<number, SplatData>();
const cacheBytes = new Map<number, number>();
const roots = new Set<number>();
let pager: FrontierPager | null = null;
let chunkSize = 65536;
let cpuCacheBytes = 256 * 1024 * 1024;
let totalBytes = 0;
/** Files touched by the last frontier, protected from eviction. */
let neededFiles = new Set<number>();
/**
 * The cut this worker has solved for, carried across reschedules - Spark's
 * `lastPixelLimit`.
 *
 * The host's `limit` is a *quality target* (one splat per pixel), which is the
 * coarsest cut worth drawing. It is not a budget: a mesh granted 4.6 M splats
 * whose 1 px cut only selects 890 k leaves ~80 % of its budget unspent and looks
 * far softer than Spark at the same pose, because Spark solves for the cut that
 * spends `maxSplats` instead of refining to a fixed pixel size.
 *
 * So this refines *below* the host limit while budget remains and the frontier
 * still has cached children, and coarsens back when the budget clamps. One
 * traversal per reschedule (plus at most one extra when badly under), converging
 * over a few frames - the earlier bisection ran the full O(frontier) walk up to
 * five times per reschedule and stalled camera moves for seconds.
 */
let solvedLimit = Number.POSITIVE_INFINITY;

/** Multiplicative step for the cut search; matches `LIMIT_GROW` in rad-frontier. */
const LIMIT_STEP = 1.6;
/** Finest the solve may go below the host's quality target. */
const LIMIT_FLOOR_FACTOR = 1 / 32;
/** Spend at least this fraction of the budget before refining further. */
const BUDGET_SPEND_TARGET = 0.75;
/** Under this fraction, refine immediately rather than waiting a frame. */
const BUDGET_SPEND_URGENT = 0.5;

/**
 * Most splats a single paging plan may append.
 *
 * The main thread applies a plan whole, and writing a splat into the pool costs
 * ~0.15 µs (measured): a hard camera cut that churned one mesh's frontier
 * produced a single 141 ms plan - a visible freeze. The cap is applied in the
 * *pager* rather than by shrinking the traversal budget, because the stalls are
 * driven by churn, not growth: a sideways camera move replaces the frontier at a
 * constant size, so a budget ramp bounds nothing while the pager cap bounds both
 * the appends and (since evictions are paced with them) the swap-remove moves.
 *
 * Each traversal therefore still runs at the full solved cut; only its *delivery*
 * is spread over frames. ~60 k ≈ 9 ms of write per plan, plus at most as much
 * again in moves.
 */
const MAX_PLAN_APPEND_SPLATS = 60_000;

/**
 * Inputs of the last *full* plan, and the cache revision it saw.
 *
 * `MAX_PLAN_APPEND_SPLATS` bounds what one plan may *apply*, but the traversal
 * and the pager diff it rode on were O(whole frontier) and ran again for every
 * one of the ~66 plans a cold 4 M-splat frontier needs - quadratic, and the
 * reason `cest_ca.rad` sat at ~1.3 M of a 4 M budget. When nothing that decides
 * the frontier has changed, the answer is already known: drain the deferred
 * remainder instead of recomputing it.
 *
 * Deliberately exact: a stale drain against a moved camera would page in splats
 * the current view never selected. The host coalesces reschedules and reposts
 * the identical camera while idle, so equality needs no tolerance, and any doubt
 * costs one ordinary traversal.
 *
 * A newly cached chunk deliberately does *not* invalidate the queue. It cannot
 * make a queued splat wrong - every one of them is a node the last cut selected,
 * and delivering them keeps the cover valid - it only means the next full
 * traversal will find more detail. Invalidating on it would defeat the whole
 * mechanism during a cold load, which is precisely when chunks arrive
 * continuously and the ramp matters most. Eviction is likewise safe: queued
 * chunks are pinned in `neededFiles` (see {@link protectPendingAppends}), so the
 * data a drain gathers is always still there.
 */
let lastPlanKey: string | null = null;

function planKey(msg: FrontierRescheduleMessage): string {
  const c = msg.cameraLocal;
  const f = msg.cameraForward;
  return `${c[0]},${c[1]},${c[2]}|${f[0]},${f[1]},${f[2]}|${msg.limit}|${msg.budget}`;
}

/** Buffers to transfer with a message (their `.buffer`s). */
function buffersOf(splats: PlanSplats): Transferable[] {
  const list: Transferable[] = [
    splats.positions.buffer as ArrayBuffer,
    splats.colors.buffer as ArrayBuffer,
    splats.covariances.buffer as ArrayBuffer,
  ];
  if (splats.shPacked) list.push(splats.shPacked.packed.buffer as ArrayBuffer);
  return list;
}

function recordRoots(file: number, data: SplatData): void {
  // Children always have a higher global index than their parent, so the forest
  // roots live in chunk 0: a chunk-0 node with no chunk-0 node listing it as a
  // child. Derived from the tree structure alone.
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

function evict(): number[] {
  const evicted: number[] = [];
  if (!pager || totalBytes <= cpuCacheBytes) return evicted;
  const resident = pager;
  // Drop non-needed, non-0 chunks until under the cap. A finer policy can wait;
  // correctness holds because the traversal skips absent chunks and re-fetches
  // via the touched set - provided the main thread learns of the eviction.
  //
  // "Not needed" has to mean *nothing of it is on screen*, not merely "the
  // current frontier stopped selecting it". `maxAppends` keeps deferred leavers
  // resident and drawn for another plan or two, and evicting their chunk makes
  // the gather for their next swap-remove write zeros into a live slot - the
  // dark speckle that appeared in a region while it refined. So the pager's
  // resident set protects chunks too, exactly as Spark's `freeablePages`
  // excludes anything the current cut still points at. If everything resident is
  // protected the cache simply stays over its cap for a round; the next plan
  // retires the leavers and frees them.
  const candidates = [...cache.keys()]
    .filter((f) => f !== 0 && !neededFiles.has(f) && !resident.hasResidentIn(f))
    .sort((a, b) => b - a); // evict the highest (finest, most transient) first
  for (const file of candidates) {
    if (totalBytes <= cpuCacheBytes) break;
    totalBytes -= cacheBytes.get(file) ?? 0;
    cache.delete(file);
    cacheBytes.delete(file);
    evicted.push(file);
  }
  return evicted;
}

/** Gathers a plan's splat data and posts it. Shared by the full and drain paths;
 * `touched` and `limit` describe the frontier the plan is delivering, which for
 * a drain is still the one the last full traversal solved. */
function postPlan(
  seq: number,
  plan: PagerPlan,
  touchedFiles: Uint32Array,
  limit: number,
  evictedFiles: Uint32Array,
): void {
  const moveSlots = new Uint32Array(plan.moves.length);
  const moveGlobals = new Uint32Array(plan.moves.length);
  for (let i = 0; i < plan.moves.length; i++) {
    moveSlots[i] = plan.moves[i]!.slot;
    moveGlobals[i] = plan.moves[i]!.global;
  }
  // A miss here means a resident splat's chunk was evicted under it, so the slot
  // would be written as zeros while still drawn - a hole. `evict` is supposed to
  // make this impossible; the count is reported so a regression is visible
  // instead of merely looking like speckle.
  const gatherStats = { missing: 0 };
  const moves = gatherGlobals(cache, moveGlobals, chunkSize, gatherStats) as PlanSplats;
  const appends = gatherGlobals(cache, plan.appends, chunkSize, gatherStats) as PlanSplats;

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
    gatherMissing: gatherStats.missing,
    dropped: plan.dropped,
    evicted: evictedFiles,
    solvedLimit: limit,
    capacity: pager!.capacity,
    converged: !plan.truncated,
    cacheBytes: totalBytes,
    cacheLimitBytes: cpuCacheBytes,
  };
  (self as unknown as Worker).postMessage(reply, [
    moveSlots.buffer,
    ...buffersOf(moves),
    ...buffersOf(appends),
    touchedFiles.buffer,
    evictedFiles.buffer,
  ]);
}

/** The chunks the last full traversal wanted, and the cut it solved - replayed
 * by drain plans, which deliver that same frontier. */
let lastTouched = new Uint32Array(0);
let lastLimit = 0;

/**
 * Records the chunks a truncated plan still intends to append, so {@link evict}
 * protects them. A queued newcomer whose chunk is dropped before its drain would
 * be gathered as zeros into a slot inside the drawn prefix - the same hole
 * `hasResidentIn` prevents for deferred leavers.
 */
function protectPendingAppends(): void {
  if (!pager?.hasPendingDrain) return;
  for (const global of pager.pendingAppendGlobals()) {
    neededFiles.add(Math.floor(global / chunkSize));
  }
}

function reschedule(msg: FrontierRescheduleMessage): void {
  if (!pager) return;

  // Nothing that decides the frontier has moved and the last plan was held
  // short: finish it, rather than recomputing an answer already in hand.
  const key = planKey(msg);
  if (key === lastPlanKey && pager.hasPendingDrain) {
    const plan = pager.drain(MAX_PLAN_APPEND_SPLATS);
    protectPendingAppends();
    postPlan(msg.seq, plan, Uint32Array.from(lastTouched), lastLimit, Uint32Array.from(evict()));
    return;
  }

  const rootList = [...roots].filter((g) => cache.has(Math.floor(g / chunkSize)));

  // One traversal per reschedule, exactly as Spark does: the cut `limit` is a
  // fixed function of the projection and the budget is enforced *inside* the
  // descent, so the result is always complete and always within budget. The
  // earlier limit-bisection ran the whole O(frontier) walk up to five times per
  // reschedule and could still return an over-budget cut for the pager to
  // truncate - which is what made a camera move stall for seconds and then drop
  // an arbitrary slice of the scene.
  const view = frontierView(
    { x: msg.cameraLocal[0], y: msg.cameraLocal[1], z: msg.cameraLocal[2] },
    { x: msg.cameraForward[0], y: msg.cameraForward[1], z: msg.cameraForward[2] },
    msg,
  );

  // Solve for the cut that spends the budget, warm-started from the last one
  // (Spark's `lastPixelLimit`). `msg.limit` is the coarsest cut allowed - the
  // quality target - and the floor is how far below it the budget may buy.
  const floor = msg.limit * LIMIT_FLOOR_FACTOR;
  let limit = Math.min(msg.limit, Math.max(floor, solvedLimit));
  let result = traverseFrontier(cache, rootList, chunkSize, view, limit, msg.budget);

  if (result.budgetClamped && limit < msg.limit) {
    // Over budget at this cut: coarsen. Re-running once here (rather than next
    // frame) matters because an over-budget plan is the one case the pager has
    // to truncate, which shows up as missing geometry.
    limit = Math.min(msg.limit, limit * LIMIT_STEP);
    result = traverseFrontier(cache, rootList, chunkSize, view, limit, msg.budget);
  } else if (
    !result.budgetClamped &&
    result.refinable &&
    limit > floor &&
    result.count < msg.budget * BUDGET_SPEND_URGENT
  ) {
    // Badly under budget with detail available: refine now, but only accept the
    // finer cut if it stays within budget (never refine into an over-budget
    // selection - the invariant `searchLimitWithinBudget` was built around).
    const finer = Math.max(floor, limit / LIMIT_STEP);
    const refined = traverseFrontier(cache, rootList, chunkSize, view, finer, msg.budget);
    if (!refined.budgetClamped && refined.count <= msg.budget) {
      limit = finer;
      result = refined;
    }
  }

  // Converge over subsequent reschedules: nudge the remembered cut one step in
  // whichever direction the budget says, so a settled camera walks to the right
  // cut without ever paying for more than one extra traversal per frame.
  if (result.budgetClamped) {
    solvedLimit = Math.min(msg.limit, limit * LIMIT_STEP);
  } else if (result.refinable && result.count < msg.budget * BUDGET_SPEND_TARGET) {
    solvedLimit = Math.max(floor, limit / LIMIT_STEP);
  } else {
    solvedLimit = limit;
  }

  // Desired globals grouped by chunk; protect those chunks from eviction.
  neededFiles = new Set<number>();
  const desiredGlobals: number[] = [];
  for (const [file, locals] of result.selection) {
    neededFiles.add(file);
    const base = file * chunkSize;
    for (let k = 0; k < locals.length; k++) desiredGlobals.push(base + (locals[k] as number));
  }

  const plan = pager.update(desiredGlobals, { maxAppends: MAX_PLAN_APPEND_SPLATS });
  protectPendingAppends();

  const touched = Uint32Array.from(
    [...result.touched]
      .filter(([cc]) => !cache.has(cc))
      .sort((a, b) => b[1] - a[1])
      .map(([cc]) => cc),
  );

  // Remember what this traversal answered, so an unchanged reschedule can drain
  // the remainder instead of running it again.
  lastTouched = touched;
  lastLimit = limit;
  lastPlanKey = planKey(msg);

  postPlan(msg.seq, plan, Uint32Array.from(touched), limit, Uint32Array.from(evict()));
}

self.onmessage = (event: MessageEvent<FrontierRequest>): void => {
  const msg = event.data;
  if (msg.type === 'init') {
    chunkSize = msg.chunkSize;
    cpuCacheBytes = msg.cpuCacheBytes;
    pager = new FrontierPager(msg.capacity, chunkSize);
    lastPlanKey = null;
    return;
  }
  if (msg.type === 'resize') {
    // Only the pager's slot count changes; `cache` and its roots are untouched,
    // so a mesh growing or shrinking its storage re-downloads nothing.
    pager?.resize(msg.capacity);
    return;
  }
  if (msg.type === 'cacheBudget') {
    // Cap only. The next `reschedule` runs `evict()` and brings the cache under
    // it against a frontier that is still current - evicting here would drop
    // chunks the resident set still points at, with no plan to report it on.
    cpuCacheBytes = msg.cpuCacheBytes;
    return;
  }
  if (msg.type === 'chunk') {
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
    // The tree arrays are retained for the whole chunk's life and are what the
    // traversal actually reads, so they count: omitting them understated the
    // cache by ~20 % and evicted a capture the cap was sized to hold.
    const bytes =
      msg.positions.byteLength +
      msg.colors.byteLength +
      msg.covariances.byteLength +
      msg.childCount.byteLength +
      msg.childStart.byteLength +
      msg.size.byteLength +
      (msg.shPacked?.byteLength ?? 0);
    cache.set(msg.file, data);
    cacheBytes.set(msg.file, bytes);
    totalBytes += bytes;
    recordRoots(msg.file, data);
    return;
  }
  reschedule(msg);
};
