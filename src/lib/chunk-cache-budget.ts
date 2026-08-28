/**
 * Cross-mesh decoded-chunk cache arbitration.
 *
 * Every {@link StreamedSplatMesh} caps its own decoded-chunk cache, and in
 * `foveationMode: 'pagetable'` that cap is `min(2 GiB, this capture's decoded
 * size)` - a number sized for *one* streamed scene. A scene of streamed additional meshes
 * therefore has no ceiling at all: thirteen extras plus a main are thirteen
 * plus one independent caps, and because each is sized to its own capture, a
 * desktop that fits them never evicts. The background sweep then runs to
 * completion against every one of them, pulling every capture in the scene into
 * RAM and keeping it there.
 *
 * This is the missing ceiling, at whole-mesh granularity: one budget shared by
 * every streamed mesh in a scene (the same sharing model as `SplatPool` and
 * {@link ChunkFetchScheduler}), splitting a scene total by the same
 * camera-projected weight a `CameraBudgetGovernor` already computes for drawing.
 *
 * It bounds **retention**, not prefetching. The sweep still runs and still warms
 * the cache; it simply stops at an allowance the whole scene agreed on rather
 * than at the size of each capture. A mesh the camera approaches gets a larger
 * allowance and resumes sweeping; one it leaves gives bytes back.
 *
 * The budget brokers **bytes**, never chunks: it does not know about
 * `ChunkLoader`, chunk ids or workers, which is what keeps the eviction policy
 * where it belongs - inside the frontier worker, which is the only place that
 * knows what the current cut still needs.
 */

/** A streamed mesh, as the cache budget sees it. */
export interface ChunkCacheClient {
  /**
   * This mesh's camera-projected weight - larger means more of the cache.
   *
   * Read on demand rather than pushed, so the budget never holds a stale
   * weight; a `CameraBudgetGovernor.weightOf` call is the intended source, and
   * is the same one {@link ChunkFetchScheduler} reads. Zero (hidden or
   * suspended) still keeps `perMeshFloorBytes`: a mesh whose coarse base has
   * been evicted draws nothing at all when the camera comes back to it.
   */
  weight(): number;
  /**
   * The most this mesh could ever put to use - for a page-table mesh,
   * `min(PAGETABLE_CACHE_FLOOR_BYTES, estimateSceneDecodedBytes(scene))`.
   *
   * Bytes above it are handed to siblings that can use them, the way
   * `BudgetGovernor` waterfills past a member's `maxBudget`. Without it a scene
   * of one large capture and a dozen small additional meshes would reserve most of the
   * envelope for extras that cannot fill it.
   */
  readonly ceilingBytes: number;
  /**
   * This mesh's allowance moved. The mesh forwards it to its frontier worker;
   * nothing is dropped synchronously, because only the worker's own eviction
   * pass knows which chunks the current cut still needs.
   */
  onAllowanceChanged(bytes: number): void;
}

/** Options for {@link ChunkCacheBudget}. */
export interface ChunkCacheBudgetOptions {
  /**
   * Decoded-chunk bytes every registered mesh may hold **in total**.
   *
   * This is the number that decides whether the budget helps at all. Too low
   * and the focused mesh re-fetches chunks it just evicted; too high and it is
   * inert, because each mesh's own `ceilingBytes` becomes binding again. Size
   * it against the tab's heap, not against any one capture.
   */
  totalBytes: number;
  /**
   * Bytes each mesh keeps regardless of weight. Default 32 MiB, matching
   * `resolveCpuCacheBytes`'s own minimum.
   *
   * Without a floor a far mesh evicts its own coarse base and re-fetches it on
   * the next reschedule, forever - the same thrash {@link
   * ChunkFetchScheduler.perMeshFloor} exists to prevent on the network side.
   */
  perMeshFloorBytes?: number;
  /**
   * Minimum ms between weight-driven reallocations. Default 250, matching the
   * idle reschedule interval - there is no point re-splitting faster than the
   * meshes can act on it. Membership changes bypass it.
   */
  minIntervalMs?: number;
  /**
   * Relative allowance change below which a mesh is not notified. Default 0.15.
   *
   * Every notification is a worker post and, indirectly, an eviction pass. A
   * camera drifting slowly would otherwise repost a 1% different number every
   * quarter second for no change in behaviour.
   */
  deadband?: number;
}

/**
 * A mesh's registration. Opaque to callers: hold it from {@link
 * ChunkCacheBudget.register} and pass it back to read the allowance or
 * unregister.
 */
export interface ChunkCacheHandle {
  readonly client: ChunkCacheClient;
}

interface Entry extends ChunkCacheHandle {
  /** Bytes currently allocated to this mesh. */
  allowance: number;
  /** Registered? Cleared by `unregister` so a late callback stays inert. */
  live: boolean;
}

const DEFAULT_PER_MESH_FLOOR_BYTES = 32 * 1024 * 1024;
const DEFAULT_MIN_INTERVAL_MS = 250;
const DEFAULT_DEADBAND = 0.15;

/** See the module comment. Construct one per scene and pass it to every mesh. */
export class ChunkCacheBudget {
  private readonly entries = new Set<Entry>();
  private readonly perMeshFloorBytes: number;
  private readonly minIntervalMs: number;
  private readonly deadband: number;
  private totalBytesValue: number;
  private lastAllocationMs = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(options: ChunkCacheBudgetOptions) {
    if (!Number.isFinite(options.totalBytes) || options.totalBytes <= 0) {
      throw new RangeError('Chunk cache totalBytes must be a positive finite number.');
    }
    this.totalBytesValue = Math.floor(options.totalBytes);
    this.perMeshFloorBytes = Math.max(
      0,
      Math.floor(options.perMeshFloorBytes ?? DEFAULT_PER_MESH_FLOOR_BYTES),
    );
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
    this.deadband = Math.max(0, options.deadband ?? DEFAULT_DEADBAND);
  }

  /** Bytes shared across every registered mesh. */
  get totalBytes(): number {
    return this.totalBytesValue;
  }

  /**
   * Resizes the scene envelope and re-splits immediately. For a host reacting
   * to a quality change or a device-memory signal.
   */
  setTotalBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      throw new RangeError('Chunk cache totalBytes must be a positive finite number.');
    }
    const next = Math.floor(bytes);
    if (next === this.totalBytesValue) return;
    this.totalBytesValue = next;
    this.allocate();
  }

  /** Meshes currently registered. */
  get clientCount(): number {
    return this.entries.size;
  }

  /**
   * Adds a mesh and re-splits at once, so the caller can read its opening
   * allowance out of {@link allowanceFor} before posting worker init.
   */
  register(client: ChunkCacheClient): ChunkCacheHandle {
    const entry: Entry = { client, allowance: 0, live: true };
    this.entries.add(entry);
    this.allocate({ force: true, silentFor: entry });
    return entry;
  }

  /** Drops a mesh and hands its bytes back to the siblings. */
  unregister(handle: ChunkCacheHandle): void {
    const entry = handle as Entry;
    if (!this.entries.delete(entry)) return;
    entry.live = false;
    entry.allowance = 0;
    this.allocate({ force: true });
  }

  /** This mesh's current allowance in bytes, or 0 once unregistered. */
  allowanceFor(handle: ChunkCacheHandle): number {
    const entry = handle as Entry;
    return entry.live ? entry.allowance : 0;
  }

  /**
   * Re-splits after the camera moved. Call it once per frame, right beside
   * {@link ChunkFetchScheduler.weightsChanged} - the two read the same weights,
   * so cache and network follow the same measure.
   *
   * Rate-limited and dead-banded; calling it every frame is the intended use.
   */
  weightsChanged(now: number = Date.now()): void {
    if (this.disposed) return;
    if (now - this.lastAllocationMs < this.minIntervalMs) return;
    // Only this path stamps the limiter, and only with the caller's own clock.
    // Structural allocations (register/unregister/resize) must not stamp it:
    // they would otherwise mix `Date.now()` into a host that drives this from a
    // frame clock, and throttle every later call against a timestamp from a
    // different epoch.
    this.lastAllocationMs = now;
    this.allocate();
  }

  /**
   * Releases every registration. Meshes are not disposed - the budget is shared
   * and does not own them, exactly as a shared `SplatPool` does not own its
   * meshes.
   */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries) {
      entry.live = false;
      entry.allowance = 0;
    }
    this.entries.clear();
  }

  /**
   * Cap-aware waterfill: weight-proportional shares, floored so every mesh can
   * hold its coarse base, clamped at each mesh's `ceilingBytes`, and the surplus
   * from clamped meshes redistributed over the rest until it settles.
   *
   * The invariant callers depend on is `Σ allowance <= totalBytes`. It holds in
   * every branch, including the degenerate one where the floors alone exceed
   * the envelope - there the floors are scaled down proportionally rather than
   * silently overcommitting, because a budget that can be exceeded by
   * registering more meshes is the bug this class exists to fix.
   */
  private allocate(options: { force?: boolean; silentFor?: Entry } = {}): void {
    if (this.disposed) return;
    const entries = [...this.entries];
    if (entries.length === 0) return;

    const total = this.totalBytesValue;
    // A floor is a claim *inside* the envelope, not a reservation on top of it:
    // cap it at an even split so N floors can never sum past the total, then
    // hand out only what is left over by weight. Adding a weighted share to an
    // unreserved floor would overcommit whenever any mesh sat below its share.
    const floor = Math.min(this.perMeshFloorBytes, Math.floor(total / entries.length));
    const next = new Map<Entry, number>();
    const unclamped = new Set<Entry>(entries);
    let pool = total;

    // Waterfill. Each pass either clamps at least one mesh at its ceiling and
    // returns what it could not use to the pool, or reaches the fixpoint and
    // stops - so it terminates in at most one pass per mesh.
    for (let pass = 0; pass <= entries.length && unclamped.size > 0; pass++) {
      const distributable = Math.max(0, pool - floor * unclamped.size);
      let totalWeight = 0;
      for (const entry of unclamped) totalWeight += normalizeWeight(entry.client.weight());
      const clamped: Entry[] = [];
      for (const entry of unclamped) {
        const weight = normalizeWeight(entry.client.weight());
        // All-zero weights (every mesh hidden) share the remainder evenly
        // rather than dividing by zero.
        const share =
          totalWeight > 0 ? (distributable * weight) / totalWeight : distributable / unclamped.size;
        const ceiling = normalizeCeiling(entry.client.ceilingBytes);
        const wanted = Math.floor(floor + share);
        // Never above what this mesh could actually put to use: holding a 4 MB
        // capture at a 32 MB floor would strand 28 MB its siblings can use.
        if (wanted >= ceiling) {
          next.set(entry, ceiling);
          clamped.push(entry);
        } else {
          next.set(entry, wanted);
        }
      }
      if (clamped.length === 0) break;
      for (const entry of clamped) {
        unclamped.delete(entry);
        pool -= next.get(entry) ?? 0;
      }
      pool = Math.max(0, pool);
    }

    for (const entry of entries) {
      const value = next.get(entry) ?? 0;
      const previous = entry.allowance;
      entry.allowance = value;
      if (entry === options.silentFor) continue;
      if (!options.force && !this.movedEnough(previous, value)) continue;
      if (previous === value) continue;
      entry.client.onAllowanceChanged(value);
    }
  }

  /** Suppresses reposts for changes too small to alter any mesh's behaviour. */
  private movedEnough(previous: number, next: number): boolean {
    if (previous === next) return false;
    if (previous === 0 || next === 0) return true;
    return Math.abs(next - previous) / previous >= this.deadband;
  }
}

/** Negative, NaN and infinite weights are all "no claim on the cache". */
function normalizeWeight(weight: number): number {
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

/** A missing or nonsensical ceiling means "this mesh can use whatever it is given". */
function normalizeCeiling(ceiling: number): number {
  return Number.isFinite(ceiling) && ceiling > 0 ? Math.floor(ceiling) : Number.MAX_SAFE_INTEGER;
}
