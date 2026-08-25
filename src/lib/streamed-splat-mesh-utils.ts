/** Scheduling and data helpers shared by the streamed mesh implementation. */
import type { SplatRange } from './splat-mesh';
import type { SplatData } from './splat-data';
import type { LodRun } from './lod-scheduler';
import { resolveCpuCacheBytes } from './splat-budget';

const APPEND_CAP = 32_000;

/** One resident entry: the run description plus its pool handle. */
type ResidentEntry = [string, { run: LodRun; handle: SplatRange }];

/** A set of adds and removals covering one contiguous leaf region. */
export interface SwapGroup {
  adds: LodRun[];
  removes: ResidentEntry[];
  leafStart: number;
  leafEnd: number;
  addCount: number;
}

/**
 * One swap group per run for the startup hold. The mesh is invisible, so L0
 * cell-atomicity is unnecessary; committing slice-by-slice lets the hold finish
 * as soon as the capped set is resident instead of waiting on sibling subchunks.
 */
export function buildHoldSwapGroups(toAdd: readonly LodRun[]): SwapGroup[] {
  return toAdd
    .map((run) => ({
      adds: [run],
      removes: [] as ResidentEntry[],
      leafStart: run.leafStart,
      leafEnd: run.leafEnd,
      addCount: run.count,
    }))
    .sort((a, b) => a.leafStart - b.leafStart);
}

/**
 * Groups adds and removals into visible-cell transactions.
 *
 * Classic LCC (`coverageGroup` set on every run): one transaction per sub-leaf
 * interval at every resolved level (including L0), so a cached slice can
 * replace its own prior coverage while siblings still fetch. Hierarchical
 * sources without coverage groups keep interval-overlap grouping.
 */
export function buildSwapGroups(toAdd: LodRun[], toRemove: ResidentEntry[]): SwapGroup[] {
  const coverageRuns = [...toAdd, ...toRemove.map(([, entry]) => entry.run)];
  if (coverageRuns.length > 0 && coverageRuns.every((run) => run.coverageGroup !== undefined)) {
    type Bucket = { adds: LodRun[]; removes: ResidentEntry[] };
    const buckets = new Map<number, Bucket>();
    const touch = (coverageGroup: number): Bucket => {
      let bucket = buckets.get(coverageGroup);
      if (!bucket) {
        bucket = { adds: [], removes: [] };
        buckets.set(coverageGroup, bucket);
      }
      return bucket;
    };
    for (const run of toAdd) {
      touch(run.coverageGroup as number).adds.push(run);
    }
    for (const entry of toRemove) {
      touch(entry[1].run.coverageGroup as number).removes.push(entry);
    }

    const groups: SwapGroup[] = [];
    for (const bucket of buckets.values()) {
      // Every classic-LCC cut is one transaction per sub-leaf - including
      // resolved L0. Quality cells split into dozens of finest slices; waiting
      // for the whole cell before any swap left near detail stuck on coarse
      // (green) while a few in-flight fetches churned across siblings forever.
      // Per-slice: a ready L0 patch replaces its own prior coverage immediately;
      // siblings keep theirs until their chunks land.
      const byLeaf = new Map<string, SwapGroup>();
      const leafKey = (start: number, end: number): string => `${start}:${end}`;
      const ensure = (start: number, end: number): SwapGroup => {
        const key = leafKey(start, end);
        let group = byLeaf.get(key);
        if (!group) {
          group = { adds: [], removes: [], leafStart: start, leafEnd: end, addCount: 0 };
          byLeaf.set(key, group);
        }
        return group;
      };
      for (const run of bucket.adds) {
        const group = ensure(run.leafStart, run.leafEnd);
        group.adds.push(run);
        group.addCount += run.count;
      }
      for (const entry of bucket.removes) {
        const run = entry[1].run;
        const group = ensure(run.leafStart, run.leafEnd);
        group.removes.push(entry);
        group.leafStart = Math.min(group.leafStart, run.leafStart);
        group.leafEnd = Math.max(group.leafEnd, run.leafEnd);
      }
      groups.push(...byLeaf.values());
    }
    return groups.sort((a, b) => a.leafStart - b.leafStart);
  }

  const items = [
    ...toAdd.map((run) => ({
      start: run.leafStart,
      end: run.leafEnd,
      add: run,
      remove: undefined as ResidentEntry | undefined,
    })),
    ...toRemove.map((entry) => ({
      start: entry[1].run.leafStart,
      end: entry[1].run.leafEnd,
      add: undefined as LodRun | undefined,
      remove: entry,
    })),
  ].sort((a, b) => a.start - b.start || b.end - a.end);

  // Sorted interval sweep finds the same overlap-connected components in
  // O(n log n). Longer equal-start intervals come first so an octree parent
  // opens the full component before its adjacent children are visited.
  const groups: SwapGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (!last || item.start >= last.leafEnd) {
      groups.push({
        adds: [],
        removes: [],
        leafStart: item.start,
        leafEnd: item.end,
        addCount: 0,
      });
    }
    const group = groups[groups.length - 1] as SwapGroup;
    group.leafEnd = Math.max(group.leafEnd, item.end);
    if (item.add) {
      group.adds.push(item.add);
      group.addCount += item.add.count;
    }
    if (item.remove) group.removes.push(item.remove);
  }
  return groups;
}

/**
 * Groups that only add coverage first (coarse before fine), then the ones that
 * retire it - pure removals last of all.
 *
 * The order is what makes the wave gate in `reschedule` decidable: by the time a
 * retiring group is reached, every purely additive group has already had its
 * turn, so "have the replacements landed?" is answered rather than guessed.
 * Pure removals free pool rows, so they go last, where they relieve the
 * over-draw the gate deliberately trades for.
 *
 * Exported for tests only - not part of the public API surface.
 */
export function groupPriority(group: SwapGroup): number {
  if (group.adds.length === 0) return 1000;
  const finest = -Math.max(...group.adds.map((run) => run.level));
  return group.removes.length === 0 ? -1000 + finest : finest;
}

/** True when every transaction belongs to classic LCC physical coverage. */
export function isClassicLccSwapSet(groups: readonly SwapGroup[]): boolean {
  return (
    groups.length > 0 &&
    groups.every((group) =>
      [...group.adds, ...group.removes.map(([, entry]) => entry.run)].every(
        (run) => run.coverageGroup !== undefined,
      ),
    )
  );
}

/**
 * Orders classic display transactions by what the camera can see. This is
 * separate from {@link groupPriority}: its global coarse-before-retirement
 * wave preserves hierarchical RAD coverage, whereas LCC has an independent
 * coarse shell for every L1+ slice and can safely commit a ready centre slice.
 * Exported for tests only - not part of the public API surface.
 */
export function compareClassicSwapGroups(a: SwapGroup, b: SwapGroup): number {
  const describe = (
    group: SwapGroup,
  ): {
    removeOnly: number;
    view: number;
    finest: number;
    screen: number;
    distance: number;
  } => {
    const runs = [...group.adds, ...group.removes.map(([, entry]) => entry.run)];
    return {
      removeOnly: group.adds.length === 0 ? 1 : 0,
      view: runs.some((run) => run.inView !== false) ? 0 : 1,
      finest: group.adds.some((run) => run.level === 0) ? 0 : 1,
      screen: Math.min(...runs.map((run) => run.screenImportance ?? Number.POSITIVE_INFINITY)),
      distance: Math.min(...runs.map((run) => run.distance ?? Number.POSITIVE_INFINITY)),
    };
  };
  const aa = describe(a);
  const bb = describe(b);
  return (
    aa.removeOnly - bb.removeOnly ||
    aa.view - bb.view ||
    aa.finest - bb.finest ||
    aa.screen - bb.screen ||
    aa.distance - bb.distance ||
    a.leafStart - b.leafStart
  );
}

/** One classic-path chunk want, ranked before {@link StreamedSplatMesh} issues it. */
export type ClassicFetchPhase = 'finest-target' | 'coverage' | 'target' | 'background';

export interface ClassicFetchWant {
  /** Cross-mesh scheduler kind derived from {@link phase}. */
  kind: 'priority' | 'base';
  /** Internal classic ranking tier (not exported on ChunkFetchKind). */
  phase: ClassicFetchPhase;
  distance: number;
  level: number;
  /** Prefer in-frustum wants; false means behind-camera / out of view. */
  inView: boolean;
  /** Classic LCC physical cell; `-1` when the source has no coverage groups. */
  coverageGroup: number;
  /** Source interval: L1+ uses this as its progressive display transaction. */
  leafStart: number;
  /** One past {@link leafStart}. */
  leafEnd: number;
  /** Fetch-only angular distance from the screen centre; smaller wins. */
  screenImportance: number;
  /**
   * Min distance among pending wants in this coverage group. Stamped in
   * {@link stampClassicFetchGroups} so a split cell's slices stay together.
   */
  groupDistance: number;
  /** Pending file count in this coverage group; denser near cells win ties. */
  groupPending: number;
  /** True when any pending run in this group is in-frustum. */
  groupInView: boolean;
  /** Best screen-centre score among runs in this fetch transaction. */
  groupScreenImportance: number;
  /** True when this transaction contains a finest-level (L0) target. */
  groupFinest: boolean;
  /** Stable aggregate key: L0 cell, L1+ slice, or singleton file. */
  groupId: string;
  /** Visible(0) / near-out-of-view(1) / background(2) ranking bucket. */
  groupClass: 0 | 1 | 2;
}

function classicFetchPhaseRank(phase: ClassicFetchPhase): number {
  switch (phase) {
    case 'finest-target':
      return 0;
    case 'coverage':
      return 1;
    case 'target':
      return 2;
    default:
      return 3;
  }
}

function kindForClassicFetchPhase(phase: ClassicFetchPhase): ClassicFetchWant['kind'] {
  return phase === 'background' ? 'base' : 'priority';
}

/**
 * Fetch identity mirrors the display transaction. Finest L0 must arrive as a
 * whole physical cell; L1+ is intentionally progressive, one leaf slice at a
 * time, so hidden siblings cannot hold the visible slice in the queue.
 */
function classicFetchGroupKey(
  want: Pick<ClassicFetchWant, 'phase' | 'coverageGroup' | 'leafStart' | 'leafEnd'>,
  file: number,
): string {
  if (want.coverageGroup < 0) return `file:${file}`;
  if (want.phase === 'finest-target') return `cell:${want.coverageGroup}`;
  return `slice:${want.coverageGroup}:${want.leafStart}:${want.leafEnd}`;
}

/**
 * Fills {@link ClassicFetchWant.groupDistance} / `groupPending` so ranking can
 * finish one near cell before sprinkling bandwidth across neighbors.
 */
export function stampClassicFetchGroups(
  pending: Map<number, ClassicFetchWant>,
  lodBaseDistance = 10,
  forceNearPriority = false,
): void {
  const near = nearDisplayDistance(lodBaseDistance);
  const aggregates = new Map<
    string,
    { distance: number; count: number; inView: boolean; screenImportance: number; finest: boolean }
  >();
  for (const [file, want] of pending) {
    const key = classicFetchGroupKey(want, file);
    const prev = aggregates.get(key);
    if (!prev) {
      aggregates.set(key, {
        distance: want.distance,
        count: 1,
        inView: want.inView,
        screenImportance: want.screenImportance,
        finest: want.phase === 'finest-target',
      });
      continue;
    }
    if (want.distance < prev.distance) prev.distance = want.distance;
    if (want.inView) prev.inView = true;
    if (want.screenImportance < prev.screenImportance) {
      prev.screenImportance = want.screenImportance;
    }
    if (want.phase === 'finest-target') prev.finest = true;
    prev.count++;
  }
  for (const [file, want] of pending) {
    const groupId = classicFetchGroupKey(want, file);
    const agg = aggregates.get(groupId);
    if (!agg) continue;
    const groupClass: 0 | 1 | 2 = agg.inView ? 0 : agg.distance <= near ? 1 : 2;
    const kind: ClassicFetchWant['kind'] =
      groupClass === 0 ? 'priority' : groupClass === 1 && forceNearPriority ? 'priority' : 'base';
    want.groupDistance = agg.distance;
    want.groupPending = agg.count;
    want.groupInView = agg.inView;
    want.groupScreenImportance = agg.screenImportance;
    want.groupFinest = agg.finest;
    want.groupId = groupId;
    want.groupClass = groupClass;
    want.kind = kind;
  }
}

/**
 * Distance inside which classic LCC treats a cut as short-range for fetch
 * ranking. Matches {@link LodSourceOptions.lodBaseDistance} (default 10).
 */
export function nearDisplayDistance(lodBaseDistance: number, _lodMultiplier = 2): number {
  return lodBaseDistance;
}

/**
 * True when this deferred group is waiting on resolved finest (L0) - never
 * flash coarsest discs as a stand-in.
 */
export function isWaitingOnFinest(group: SwapGroup): boolean {
  return group.adds.some((run) => run.level === 0);
}

/**
 * Classic fetch phase for a **resolved** desired run. Ambition-only levels are
 * never requested - callers pass runs from `computeDesiredRuns` only.
 */
export function classicFetchPhaseForDesired(
  run: LodRun,
  lodBaseDistance: number,
  lodMultiplier = 2,
): ClassicFetchPhase {
  void lodMultiplier;
  if (run.level === 0) return 'finest-target';
  const distance = run.distance ?? Number.POSITIVE_INFINITY;
  if (run.inView === false && distance > nearDisplayDistance(lodBaseDistance)) return 'background';
  return 'target';
}

/** Classic fetch phase for a pinned coarsest substitute of an L1+ gap. */
export function classicFetchPhaseForCoverage(
  run: LodRun,
  lodBaseDistance: number,
  lodMultiplier = 2,
): ClassicFetchPhase {
  void lodMultiplier;
  const distance = run.distance ?? Number.POSITIVE_INFINITY;
  if (run.inView === false && distance > nearDisplayDistance(lodBaseDistance)) return 'background';
  return 'coverage';
}

/**
 * Maps a desired run to the cross-mesh fetch kind. Prefer
 * {@link classicFetchPhaseForDesired} for ranking; this remains for tests.
 */
export function classicFetchKindForDesired(
  run: LodRun,
  lodBaseDistance: number,
  lodMultiplier = 2,
): ClassicFetchWant['kind'] {
  return kindForClassicFetchPhase(classicFetchPhaseForDesired(run, lodBaseDistance, lodMultiplier));
}

export function enqueueClassicFetch(
  pending: Map<number, ClassicFetchWant>,
  file: number,
  phase: ClassicFetchPhase,
  run: LodRun,
): void {
  const distance = run.distance ?? Number.POSITIVE_INFINITY;
  const level = run.level;
  const inView = run.inView !== false;
  const coverageGroup = run.coverageGroup ?? -1;
  const screenImportance = run.screenImportance ?? Number.POSITIVE_INFINITY;
  const kind = kindForClassicFetchPhase(phase);
  const prev = pending.get(file);
  if (!prev) {
    const groupId = classicFetchGroupKey(
      { phase, coverageGroup, leafStart: run.leafStart, leafEnd: run.leafEnd },
      file,
    );
    pending.set(file, {
      kind,
      phase,
      distance,
      level,
      inView,
      coverageGroup,
      leafStart: run.leafStart,
      leafEnd: run.leafEnd,
      screenImportance,
      groupDistance: distance,
      groupPending: 1,
      groupInView: inView,
      groupScreenImportance: screenImportance,
      groupFinest: phase === 'finest-target',
      groupId,
      // Provisional; finalized in stampClassicFetchGroups().
      groupClass: 2,
    });
    return;
  }
  const betterPhase = classicFetchPhaseRank(phase) < classicFetchPhaseRank(prev.phase);
  const samePhaseNearer =
    phase === prev.phase &&
    (distance < prev.distance || (distance === prev.distance && level < prev.level));
  const samePhaseBetterView =
    phase === prev.phase &&
    distance === prev.distance &&
    level === prev.level &&
    inView &&
    !prev.inView;
  if (betterPhase || samePhaseNearer || samePhaseBetterView) {
    pending.set(file, {
      kind,
      phase,
      distance,
      level,
      inView: inView || prev.inView,
      coverageGroup: coverageGroup >= 0 ? coverageGroup : prev.coverageGroup,
      leafStart: run.leafStart,
      leafEnd: run.leafEnd,
      screenImportance,
      groupDistance: Math.min(distance, prev.groupDistance),
      groupPending: prev.groupPending,
      groupInView: inView || prev.groupInView,
      groupScreenImportance: Math.min(screenImportance, prev.groupScreenImportance),
      groupFinest: phase === 'finest-target' || prev.groupFinest,
      groupId: prev.groupId,
      groupClass: prev.groupClass,
    });
  }
}

/**
 * Sort by coverage group first: visible groups, then near out-of-view, then
 * background. Within a group: coverage → resolved target (L0/L1+) → background.
 */
export function compareClassicFetches(
  a: ClassicFetchWant,
  b: ClassicFetchWant,
  fileA: number,
  fileB: number,
): number {
  const groupDistA = a.groupDistance ?? a.distance;
  const groupDistB = b.groupDistance ?? b.distance;
  const pendingA = a.groupPending ?? 1;
  const pendingB = b.groupPending ?? 1;
  const groupA = a.groupId ?? classicFetchGroupKey(a, fileA);
  const groupB = b.groupId ?? classicFetchGroupKey(b, fileB);
  const classA = a.groupClass ?? (a.inView ? 0 : 2);
  const classB = b.groupClass ?? (b.inView ? 0 : 2);
  const screenA = a.groupScreenImportance ?? a.screenImportance;
  const screenB = b.groupScreenImportance ?? b.screenImportance;
  const finestA = a.groupFinest ? 0 : 1;
  const finestB = b.groupFinest ? 0 : 1;
  const rankInGroup = (phase: ClassicFetchPhase): number => {
    if (phase === 'coverage') return 0;
    if (phase === 'background') return 2;
    return 1; // target + finest-target
  };
  return (
    classA - classB ||
    finestA - finestB ||
    screenA - screenB ||
    groupDistA - groupDistB ||
    pendingB - pendingA ||
    (groupA < groupB ? -1 : groupA > groupB ? 1 : 0) ||
    rankInGroup(a.phase) - rankInGroup(b.phase) ||
    a.level - b.level ||
    fileA - fileB
  );
}

/** Zero-copy view of one contiguous splat range within a decoded chunk.
 * Exported for tests only - not part of the public API surface. */
export function sliceSplatData(chunk: SplatData, offset: number, count: number): SplatData {
  // A manifest can over-declare a range against the chunk it points into;
  // subarray would silently clamp, yielding a SplatData whose count exceeds
  // its arrays and corrupting the shared pool. Fail the chunk instead.
  if (offset < 0 || count < 0 || offset + count > chunk.count) {
    throw new Error(
      `Splat range [${offset}, ${offset + count}) exceeds its chunk's ${chunk.count} splats; ` +
        'the manifest and chunk data disagree.',
    );
  }
  const sh = chunk.shPacked;
  return {
    count,
    positions: chunk.positions.subarray(offset * 3, (offset + count) * 3),
    colors: chunk.colors.subarray(offset * 4, (offset + count) * 4),
    covariances: chunk.covariances.subarray(offset * 6, (offset + count) * 6),
    // Per-splat SH is splat-major, so it slices like everything else. Palette
    // shN (`chunk.sh`) is deliberately not carried: its labels index a
    // per-file codebook the shared pool has no way to hold.
    ...(sh
      ? {
          shPacked: {
            ...sh,
            packed: sh.packed.subarray(
              offset * shWordsPerSplat(sh.bands),
              (offset + count) * shWordsPerSplat(sh.bands),
            ),
          },
        }
      : {}),
    // Per-splat frontier `parent_size` (foveated `.rad`) slices splat-major like
    // the rest; uploaded into `covarianceB.w` by the pool.
    ...(chunk.frontierParent
      ? { frontierParent: chunk.frontierParent.subarray(offset, offset + count) }
      : {}),
  };
}

/** Packed SH words each splat carries at a band count (1, 2 or 3). */
function shWordsPerSplat(bands: 1 | 2 | 3): number {
  return bands === 1 ? 3 : bands === 2 ? 8 : 15;
}

export function chunkBytes(data: SplatData): number {
  return (
    data.positions.byteLength +
    data.colors.byteLength +
    data.covariances.byteLength +
    // SH is the largest part of an LCC Quality chunk (64 B/splat against the
    // base 32); omitting it would let the CPU cache run ~3x over its cap.
    (data.shPacked?.packed.byteLength ?? 0)
  );
}

/** An abort signal's reason as an Error, whatever the caller aborted with. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
}

export function validateAppendCap(value: number | undefined): number {
  const cap = value ?? APPEND_CAP;
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new RangeError('StreamedSplatMesh maxSplatsPerSwap must be a positive integer.');
  }
  return cap;
}

/** Validates Spark's per-mesh `lodScale`; `undefined` means the neutral 1. */
export function validateLodScale(value: number | undefined): number {
  const scale = value ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError('StreamedSplatMesh lodScale must be a positive finite number.');
  }
  return scale;
}

/**
 * The decoded-chunk cache cap.
 *
 * Delegates to {@link resolveCpuCacheBytes} rather than re-deriving it. The
 * local copy this replaces read `navigator.deviceMemory ?? 4`, which looks
 * equivalent but is not: **iOS never reports `deviceMemory` at all**, so every
 * iPhone took the `4` fallback and a 128 MiB cache, where the profile-aware
 * policy gives a memory-less device 32 MiB. That is 96 MiB of decoded chunks
 * held on the one platform whose tab gets killed for holding too much.
 */
export function defaultCpuCacheBytes(): number {
  return resolveCpuCacheBytes();
}
