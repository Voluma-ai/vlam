import type { SplatData } from '../core/splat-data';
import {
  detectSplatDeviceProfile,
  resolveSplatBudget,
  type SplatDeviceProfile,
} from '../core/splat-budget';
import { linkSplatBudget, type SplatBudgetTenant } from '../core/splat-budget-link';
import { MAX_DRAWABLE_SPLATS } from '../formats/splat-count-limits';
import { limitToDrawOrder } from './limit-splat-count';
import { warn } from '../core/logging';
import type { SplatCountPeekOptions } from './peek-splat-count';

/** Options for {@link SplatSceneBudget}. */
export interface SplatSceneBudgetOptions {
  /**
   * Total resident splats across every file loaded under the budget. It is a
   * ceiling on the device default, never a raise above it: a phone stays
   * within its tier however large the number. Default: the device's
   * `resolveSplatBudget()`. Either way the budget never exceeds 2²⁴, what one
   * unified draw can address.
   */
  total?: number;
  /**
   * Device signals the default is resolved from. Defaults to detecting them;
   * `null` skips detection, so `total` (or the portable floor) applies as is.
   */
  profile?: SplatDeviceProfile | null;
}

/** Options for {@link SplatSceneBudget.plan}. */
export type SplatSceneBudgetPlanOptions = SplatCountPeekOptions;

/**
 * One file's claim on a {@link SplatSceneBudget}, taken while it decodes.
 *
 * The loaders take and settle these themselves; a host only meets one when it
 * drives a custom loader.
 */
export interface SplatBudgetReservation {
  /** The most splats the file may keep; the loader thins it to this. */
  readonly maxSplats: number;
  /**
   * Confirms the decoded data. The budget then holds its splats until the mesh
   * built from it is disposed. Returns the data to use: `data` itself, or a
   * thinner copy when files decoding side by side over-committed the budget.
   */
  commit(data: SplatData): SplatData;
  /** Gives the share back: the load failed or was cancelled. */
  release(): void;
}

interface BudgetEntry {
  /** The file's own splat count, before any thinning. */
  sourceCount: number;
  /** Splats the budget holds for it: its share while it decodes, then its
   * decoded count. */
  held: number;
  /** Decoded (rather than still in flight). */
  committed: boolean;
  /** The mesh built from it, once there is one. */
  tenant: SplatBudgetTenant | null;
}

/**
 * One splat budget shared by every whole-file scene loaded under it, so a
 * scene made of several large files stays within what the device can hold.
 *
 * Pass the same budget as `sceneBudget` to each `loadSplatData` /
 * `loadSplatDataFile` (or `ChunkLoader`) call. Each file is decoded, then
 * thinned in the load worker to its share, keeping its most visible splats
 * (opacity × size) exactly as an oversized single file is. A file takes
 * whatever the budget has free. When that is less than its proportional share
 * of the scene, the meshes already built from earlier files shrink to theirs
 * first (keeping their most visible splats, and reallocating their pools so
 * the memory is really returned), so adding a file later needs no host
 * arithmetic. {@link plan} a known batch first to split the budget up front
 * instead. The budget never exceeds 2²⁴ splats, so the sum of its files always
 * fits one `UnifiedSplatMesh` work buffer.
 *
 * Pass the returned data to `new SplatMesh(data)` unchanged: the mesh reports
 * to the budget and gives its splats back on `dispose()`. Data that never
 * becomes a mesh stays counted until {@link discard}.
 *
 * Thinning is lossy. Disposing one mesh frees budget for the next load, but
 * the meshes that remain do not regain the splats they were thinned by;
 * reload a file to restore its detail. A re-balance happens when the late
 * file's count is known (after it decodes), so the earlier meshes stay
 * shrunk even if that load then fails. Only a plain `SplatMesh` built
 * directly from the budgeted data, with its own editable pool, can shrink;
 * any other consumer keeps its share.
 *
 * Streamed formats (`StreamedSplatMesh`) keep their own governors and are not
 * counted here.
 *
 * @example
 * import { SplatMesh } from '@voluma/vlam';
 * import { loadSplatData, SplatSceneBudget } from '@voluma/vlam/loaders';
 * const budget = new SplatSceneBudget();
 * const urls = ['/a.sog', '/b.sog', '/c.sog'];
 * await budget.plan(urls);
 * const meshes = await Promise.all(
 *   urls.map(async (url) => new SplatMesh(await loadSplatData(url, { sceneBudget: budget }))),
 * );
 */
export class SplatSceneBudget {
  /** The ceiling, in splats; at most 2²⁴. */
  readonly total: number;
  private readonly entries = new Set<BudgetEntry>();
  private readonly byData = new WeakMap<SplatData, BudgetEntry>();
  private readonly plannedByUrl = new Map<string, number>();
  private readonly plannedByFile = new WeakMap<File, number>();

  /**
   * @throws {RangeError} if `options.total` is not a positive finite number.
   */
  constructor(options: SplatSceneBudgetOptions = {}) {
    const { total } = options;
    if (total !== undefined && (!Number.isFinite(total) || total <= 0)) {
      throw new RangeError('SplatSceneBudget: total must be a positive finite number.');
    }
    const profile =
      options.profile === undefined ? detectSplatDeviceProfile() : (options.profile ?? undefined);
    let resolved: number;
    if (total === undefined) resolved = resolveSplatBudget(undefined, profile);
    // `cap`, not `override`: the host's number tightens the device tier and
    // can never lift a constrained device above it.
    else if (profile) resolved = resolveSplatBudget(undefined, profile, { cap: total });
    else resolved = Math.floor(total);
    this.total = Math.max(1, Math.min(resolved, MAX_DRAWABLE_SPLATS));
  }

  /** Splats held by loaded scenes (decoded data or the meshes built from it). */
  get resident(): number {
    let sum = 0;
    for (const entry of this.entries) if (entry.committed) sum += entry.held;
    return sum;
  }

  /** Splats not yet promised to any load, decoded or in flight. */
  get free(): number {
    let held = 0;
    for (const entry of this.entries) held += entry.held;
    return Math.max(0, this.total - held);
  }

  /**
   * Splits the budget across a batch of files in proportion to their sizes,
   * before any of them loads: each gets `⌊total × count / Σ count⌋`, never more
   * than its own count. Later loads of these inputs take their planned share
   * instead of whatever is free.
   *
   * The counts come from each file's header (a few small range requests per
   * URL). A file whose count cannot be read cheaply - a server without `Range`
   * support, a legacy gzip `.spz`, a whole-file `.rad` - is left out of the
   * split and takes what is free when it loads.
   *
   * @param inputs - The URLs (resolved against `options.baseUrl`) or local
   * files about to load. A URL must later be loaded by the same absolute URL.
   * @throws Rejects only with an `AbortError` when `options.signal` fires.
   */
  async plan(
    inputs: readonly (string | URL | File)[],
    options: SplatSceneBudgetPlanOptions = {},
  ): Promise<void> {
    const { peekSplatCount } = await import('./peek-splat-count');
    const { resolveSplatUrl } = await import('./loading');
    const counts = await Promise.all(inputs.map((input) => peekSplatCount(input, options)));
    const shares = proportionalShares(
      counts.map((count) => count ?? 0),
      this.total,
    );
    inputs.forEach((input, index) => {
      if (counts[index] === undefined) return;
      const share = shares[index] as number;
      if (typeof File !== 'undefined' && input instanceof File) {
        this.plannedByFile.set(input, share);
      } else {
        this.plannedByUrl.set(resolveSplatUrl(input as string | URL, options.baseUrl).href, share);
      }
    });
  }

  /**
   * Claims a share for a file about to be thinned. The loaders call this from
   * the load worker's request once the decoded count is known; a host does not
   * need to.
   *
   * A file gets what is free, and at least its proportional share of the
   * scene whenever the others can give that up: loaded meshes above their
   * shares shrink at once, and files still loading above theirs are thinned
   * when they commit. The budget can therefore be briefly over-committed
   * while several files decode at the same time, never once they are loaded.
   *
   * @param declared - The file's splat count, when known.
   * @param input - The absolute URL or the `File`, to find a planned share.
   */
  reserve(declared?: number, input?: string | File): SplatBudgetReservation {
    const planned =
      input === undefined
        ? undefined
        : typeof input === 'string'
          ? this.plannedByUrl.get(input)
          : this.plannedByFile.get(input);
    let want = declared === undefined ? Infinity : Math.max(0, Math.floor(declared));
    if (planned !== undefined) want = Math.min(want, planned);
    let share = Math.min(want, this.free);
    if (declared !== undefined && want > share) {
      const entry = { sourceCount: Math.floor(declared) };
      const fair = this.fairShares(entry);
      this.shrinkLoaded(fair);
      // Files still decoding above their shares give the difference back
      // when they commit; until then this newcomer may count on it. Data
      // already handed to the host can only shrink once it is a mesh.
      let reclaimable = 0;
      for (const other of this.entries) {
        if (!other.committed) reclaimable += Math.max(0, other.held - (fair.get(other) ?? 0));
      }
      const target = Math.min(want, fair.get(entry) ?? 0);
      share = Math.min(want, Math.max(this.free, Math.min(target, this.free + reclaimable)));
    }
    share = Math.max(0, share);
    const entry: BudgetEntry = {
      sourceCount: declared ?? share,
      held: share,
      committed: false,
      tenant: null,
    };
    this.entries.add(entry);
    let settled = false;
    return {
      maxSplats: share,
      commit: (data: SplatData) => {
        if (settled) return data;
        settled = true;
        entry.committed = true;
        entry.sourceCount = data.sourceCount ?? data.count;
        entry.held = data.count;
        // Over-committed while files decoded side by side: this one gives
        // back what it holds above its share before any mesh is built from it.
        let committed = data;
        if (this.overCommitted > 0) {
          const fair = this.fairShares().get(entry) ?? 0;
          if (data.count > fair && data.drawOrder) {
            committed = limitToDrawOrder(data, Math.max(fair, data.count - this.overCommitted));
            entry.held = committed.count;
          }
          this.shrinkLoaded(this.fairShares());
        }
        this.byData.set(committed, entry);
        linkSplatBudget(committed, {
          attach: (tenant) => {
            entry.tenant = tenant;
            entry.held = tenant.budgetedSplatCount;
            if (this.overCommitted > 0) this.shrinkLoaded(this.fairShares());
          },
          detach: (tenant) => {
            if (entry.tenant === tenant) this.entries.delete(entry);
          },
        });
        return committed;
      },
      release: () => {
        if (settled) return;
        settled = true;
        this.entries.delete(entry);
      },
    };
  }

  /** Splats promised beyond the total (only while several files decode at once). */
  private get overCommitted(): number {
    let held = 0;
    for (const entry of this.entries) held += entry.held;
    return Math.max(0, held - this.total);
  }

  /**
   * Each file's proportional share of the scene - `total × sourceCount / Σ`,
   * by its *original* count, so a file thinned before is not penalised twice -
   * never above its own count. `extra` is a newcomer not yet registered.
   */
  private fairShares(extra?: { sourceCount: number }): Map<object, number> {
    const all: { sourceCount: number }[] = [...this.entries];
    if (extra) all.push(extra);
    let sum = 0;
    for (const entry of all) sum += entry.sourceCount;
    const shares = new Map<object, number>();
    for (const entry of all) {
      shares.set(
        entry,
        sum <= this.total
          ? entry.sourceCount
          : Math.min(entry.sourceCount, Math.floor((this.total * entry.sourceCount) / sum)),
      );
    }
    return shares;
  }

  /**
   * Shrinks every loaded mesh holding more than its share to that share,
   * keeping its most visible splats. Runs once per added file, on the main
   * thread.
   */
  private shrinkLoaded(fair: Map<object, number>): void {
    let freed = 0;
    let shrunk = 0;
    for (const entry of this.entries) {
      const tenant = entry.tenant;
      const share = fair.get(entry);
      if (!tenant?.budgetShrinkable || share === undefined || entry.held <= share) continue;
      const held = tenant.shrinkToBudget(share);
      if (held >= entry.held) continue;
      freed += entry.held - held;
      entry.held = held;
      shrunk++;
    }
    if (shrunk > 0) {
      warn(
        `Scene budget of ${this.total.toLocaleString('en-US')} splats re-balanced for a new ` +
          `file: ${shrunk} loaded scene(s) gave up ${freed.toLocaleString('en-US')} of ` +
          `their least visible splats.`,
      );
    }
  }

  /**
   * Returns the splats of loaded data that will not become a mesh. A no-op
   * for data already built into one (dispose the mesh instead).
   */
  discard(data: SplatData): void {
    const entry = this.byData.get(data);
    if (!entry || entry.tenant) return;
    this.entries.delete(entry);
    this.byData.delete(data);
  }
}

/**
 * `⌊total × count / Σ count⌋` per file, never above its own count. Flooring
 * keeps the sum at or below `total`.
 *
 * @internal Exported for tests.
 */
export function proportionalShares(counts: readonly number[], total: number): number[] {
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum <= total) return counts.slice();
  return counts.map((count) => Math.min(count, Math.floor((total * count) / sum)));
}
