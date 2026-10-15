import type { SplatData } from '../core/splat-data';
import {
  detectSplatDeviceProfile,
  resolveSplatBudget,
  type SplatDeviceProfile,
} from '../core/splat-budget';
import { linkSplatBudget, type SplatBudgetTenant } from '../core/splat-budget-link';
import { MAX_DRAWABLE_SPLATS } from '../formats/splat-count-limits';
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
   * Confirms the decoded data. The budget then holds `data.count` splats for
   * it until the mesh built from `data` is disposed.
   */
  commit(data: SplatData): void;
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
 * whatever the budget has free; {@link plan} a known batch first to split the
 * budget in proportion to each file's size instead. The budget never exceeds
 * 2²⁴ splats, so the sum of its files always fits one `UnifiedSplatMesh` work
 * buffer.
 *
 * Pass the returned data to `new SplatMesh(data)` unchanged: the mesh reports
 * to the budget and gives its splats back on `dispose()`. Data that never
 * becomes a mesh stays counted until {@link discard}.
 *
 * Thinning is lossy. Disposing one mesh frees budget for the next load, but
 * the meshes that remain do not regain the splats they were thinned by;
 * reload a file to restore its detail.
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
   * @param declared - The file's splat count, when known.
   * @param input - The absolute URL or the `File`, to find a planned share.
   */
  reserve(declared?: number, input?: string | File): SplatBudgetReservation {
    const free = this.free;
    let share = declared === undefined ? free : Math.min(Math.floor(declared), free);
    const planned =
      input === undefined
        ? undefined
        : typeof input === 'string'
          ? this.plannedByUrl.get(input)
          : this.plannedByFile.get(input);
    if (planned !== undefined) share = Math.min(share, planned);
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
        if (settled) return;
        settled = true;
        entry.held = data.count;
        entry.committed = true;
        entry.sourceCount = data.sourceCount ?? data.count;
        this.byData.set(data, entry);
        linkSplatBudget(data, {
          attach: (tenant) => {
            entry.tenant = tenant;
            entry.held = tenant.budgetedSplatCount;
          },
          detach: (tenant) => {
            if (entry.tenant === tenant) this.entries.delete(entry);
          },
        });
      },
      release: () => {
        if (settled) return;
        settled = true;
        this.entries.delete(entry);
      },
    };
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
