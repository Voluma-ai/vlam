/**
 * Cross-mesh chunk-fetch arbitration.
 *
 * Every {@link StreamedSplatMesh} owns its own `ChunkLoader` worker and issues
 * chunk requests toward its own in-flight cap, so a scene of streamed meshes
 * fetches with no shared ordering: a marker the camera is pointed at competes
 * for bandwidth and connection slots against a dozen distant ones, each of
 * which is equally entitled to its own cap. Spark does not have this problem
 * structurally - one global traversal orders every fetch want
 * biggest-on-screen-first through one pager, so its network order *is* its
 * visual priority.
 *
 * This is that ordering at whole-mesh granularity: one scheduler shared by
 * every streamed mesh in a scene (the same sharing model as `SplatPool`),
 * handing out a bounded number of fetch slots in proportion to the same
 * camera-projected weight a `CameraBudgetGovernor` already computes for
 * drawing. Within a mesh the existing order still applies - a frontier plan's
 * `touched` list is already sorted biggest-on-screen first - so the two
 * granularities compose.
 *
 * The scheduler brokers **slots**, never fetches: it does not know about
 * `ChunkLoader`, URLs or workers, which is what keeps a future scene-level
 * shared loader an independent change.
 */

/**
 * Why a mesh wants a slot. The kind is the mesh's own statement of intent, and
 * decides what a weightless (hidden, or suspended) mesh may still do:
 *
 * - `priority` - detail the frontier asked for and does not have. The chunks
 *   actually on screen.
 * - `base` - the camera-directed coarse base, and the pinned coverage every
 *   deferred swap substitutes from. A far mesh must keep trickling these or it
 *   has nothing to draw at all.
 * - `sweep` - the background file-order sweep that pulls a whole capture into
 *   the worker cache so later camera moves are served from RAM. Pure
 *   pre-warming: valuable when a mesh is on screen, and the first thing to give
 *   up when it is not.
 */
export type ChunkFetchKind = 'priority' | 'base' | 'sweep';

/** A streamed mesh, as the scheduler sees it. */
export interface ChunkFetchClient {
  /**
   * This mesh's camera-projected weight - larger means more of the pipe.
   * Zero means hidden or suspended: such a mesh keeps its floor for `priority`
   * and `base` work but is denied `sweep` entirely.
   *
   * Read on demand rather than pushed, so the scheduler never holds a stale
   * weight; a `CameraBudgetGovernor.weightOf` call is the intended source.
   */
  weight(): number;
  /**
   * A slot may now be free. The mesh should re-run its reschedule, which
   * re-issues whatever it still wants. The scheduler deliberately keeps no
   * queue of pending requests: the reschedule paths are already idempotent
   * re-issuers, so a poke carries strictly more current information than a
   * request recorded when the camera was somewhere else.
   */
  onSlotAvailable(): void;
  /**
   * Abort in-flight fetches of this kind - the mesh's weight dropped to zero
   * while it held slots. Aborted fetches release their slots through the normal
   * path, so this is how a focus change hands the pipe over immediately rather
   * than after the far meshes' current requests drain.
   */
  shedFetches(kind: ChunkFetchKind): void;
}

/** Options for {@link ChunkFetchScheduler}. */
export interface ChunkFetchSchedulerOptions {
  /**
   * Total chunk fetches in flight across every registered mesh. Default 16.
   *
   * This is the number that decides whether the scheduler helps at all. Too low
   * and a single mesh scene streams slower than it does today; too high and
   * there is nothing to arbitrate, because the browser's own queueing (six per
   * origin on HTTP/1.1; a much larger multiplexed window on HTTP/2) becomes the
   * real scheduler again - and it orders by request time, not by what is on
   * screen. Tune it from a measured concurrency high-water mark, not by feel.
   */
  maxGlobalInflight?: number;
  /**
   * Slots every registered mesh may hold regardless of weight. Default 1.
   *
   * Without a floor a scene's far meshes stop fetching entirely while the
   * focused one streams, and a marker with no coarse coverage draws nothing -
   * so the floor is what turns "far meshes wait" into "far meshes trickle".
   *
   * One slot is always granted regardless of this setting: a mesh entitled to
   * zero would never fetch and never settle. Set this above 1 to widen every
   * mesh's guaranteed trickle.
   */
  perMeshFloor?: number;
}

/**
 * A mesh's registration. Opaque to callers: hold it from {@link
 * ChunkFetchScheduler.register} and pass it back to acquire, release and
 * unregister.
 */
export interface ChunkFetchHandle {
  readonly client: ChunkFetchClient;
}

interface Entry extends ChunkFetchHandle {
  /** Slots currently held (granted and not yet released). */
  held: number;
  /** Denied at least once since the last grant - wake this mesh on a release. */
  demanding: boolean;
  /** Registered? Cleared by `unregister` so late releases stay accountable. */
  live: boolean;
}

const DEFAULT_MAX_GLOBAL_INFLIGHT = 16;
const DEFAULT_PER_MESH_FLOOR = 1;

/** See the module comment. Construct one per scene and pass it to every mesh. */
export class ChunkFetchScheduler {
  private readonly entries = new Set<Entry>();
  private readonly maxGlobalInflight: number;
  private readonly perMeshFloor: number;
  private inflightCount = 0;
  private disposed = false;

  constructor(options: ChunkFetchSchedulerOptions = {}) {
    this.maxGlobalInflight = Math.max(
      1,
      Math.floor(options.maxGlobalInflight ?? DEFAULT_MAX_GLOBAL_INFLIGHT),
    );
    this.perMeshFloor = Math.max(0, Math.floor(options.perMeshFloor ?? DEFAULT_PER_MESH_FLOOR));
  }

  /** Total slots granted and not yet released. */
  get inflight(): number {
    return this.inflightCount;
  }

  /** Meshes currently registered. */
  get clientCount(): number {
    return this.entries.size;
  }

  register(client: ChunkFetchClient): ChunkFetchHandle {
    const entry: Entry = { client, held: 0, demanding: false, live: true };
    this.entries.add(entry);
    return entry;
  }

  /**
   * Drops a mesh. Slots it still holds are released here: a disposing mesh
   * aborts its fetches, and those aborts land after the handle is gone.
   */
  unregister(handle: ChunkFetchHandle): void {
    const entry = handle as Entry;
    if (!this.entries.delete(entry)) return;
    entry.live = false;
    if (entry.held > 0) {
      this.inflightCount -= entry.held;
      entry.held = 0;
      this.wake();
    }
  }

  /**
   * Grants a fetch slot, or denies and remembers the demand.
   *
   * A denial is not a failure and must not feed a mesh's retry backoff - the
   * mesh simply did not fetch this tick, and will be woken (or reschedule on
   * its own within the idle interval) to ask again.
   */
  tryAcquire(handle: ChunkFetchHandle, kind: ChunkFetchKind): boolean {
    const entry = handle as Entry;
    if (this.disposed || !entry.live) return false;

    const weight = normalizeWeight(entry.client.weight());
    // A weightless mesh pre-warming its cache is the exact traffic that starves
    // the focused marker, and it buys nothing while nobody is looking at it.
    if (kind === 'sweep' && weight <= 0) {
      entry.demanding = false;
      return false;
    }
    if (
      this.inflightCount >= this.maxGlobalInflight ||
      entry.held >= this.shareFor(entry, weight)
    ) {
      entry.demanding = true;
      return false;
    }

    entry.held++;
    entry.demanding = false;
    this.inflightCount++;
    return true;
  }

  /**
   * Returns a slot. Must be called exactly once for every granted acquire -
   * on success, on failure **and** on abort - or the pipe leaks capacity until
   * the scene is torn down.
   */
  release(handle: ChunkFetchHandle): void {
    const entry = handle as Entry;
    if (entry.held <= 0) return;
    entry.held--;
    this.inflightCount--;
    this.wake();
  }

  /**
   * Re-examines weights after the camera moved. Call it once per frame, right
   * after the budget governor's own update.
   *
   * Meshes that just lost all weight shed their pre-warming sweeps, so a focus
   * change frees the pipe now rather than when a dozen far requests happen to
   * finish.
   */
  weightsChanged(): void {
    if (this.disposed) return;
    for (const entry of this.entries) {
      if (entry.held > 0 && normalizeWeight(entry.client.weight()) <= 0) {
        entry.client.shedFetches('sweep');
      }
    }
    this.wake();
  }

  /**
   * Releases every registration. Meshes are not disposed - the scheduler is
   * shared and does not own them, exactly as a shared `SplatPool` does not own
   * its meshes.
   */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries) {
      entry.live = false;
      entry.held = 0;
      entry.demanding = false;
    }
    this.entries.clear();
    this.inflightCount = 0;
  }

  /**
   * The most slots this mesh may hold: its weight-proportional share of the
   * *whole* pipe, floored so it can always trickle and capped so its siblings
   * can always reach their own floors.
   *
   * This is a ceiling, not a reservation. The global cap does the real
   * limiting, so a heavy mesh can use capacity its idle siblings are leaving on
   * the table, while a far mesh's ceiling stays at its floor however early it
   * asks - which is what keeps the first mesh to reschedule from taking the
   * pipe and holding it. Dividing the *remainder* after every participant's
   * floor instead would invert the whole point on a large scene: thirteen
   * markers and a main at floor 1 consume a 16-slot pipe entirely, leaving the
   * focused marker a smaller share than the far ones it is competing with.
   *
   * The denominator counts every mesh that plausibly wants the pipe - all
   * registered meshes except those both weightless and idle, plus the caller.
   */
  private shareFor(entry: Entry, weight: number): number {
    let participants = 0;
    let totalWeight = 0;
    for (const other of this.entries) {
      const otherWeight = other === entry ? weight : normalizeWeight(other.client.weight());
      // A hidden mesh with nothing in flight is not competing for anything.
      if (other !== entry && otherWeight <= 0 && other.held === 0 && !other.demanding) continue;
      participants++;
      totalWeight += otherWeight;
    }
    if (participants <= 1) return this.maxGlobalInflight;

    // All-zero weights (every mesh hidden) share evenly rather than dividing by
    // zero.
    const share =
      totalWeight > 0
        ? (this.maxGlobalInflight * weight) / totalWeight
        : this.maxGlobalInflight / participants;
    // At least one slot, whatever the arithmetic and whatever the configured
    // floor: a mesh wedged at zero entitlement while the pipe has room would
    // never fetch and never settle, and `isStreaming` would stay true forever.
    const floored = Math.max(1, this.perMeshFloor, Math.round(share));
    // Never so much that another participant could not reach its own floor.
    const reservedForOthers = Math.max(1, this.perMeshFloor) * (participants - 1);
    return Math.max(1, Math.min(floored, this.maxGlobalInflight - reservedForOthers));
  }

  /** Pokes the heaviest mesh that was denied since its last grant. */
  private wake(): void {
    if (this.disposed || this.inflightCount >= this.maxGlobalInflight) return;
    let best: Entry | null = null;
    let bestWeight = -Infinity;
    for (const entry of this.entries) {
      if (!entry.demanding) continue;
      const weight = normalizeWeight(entry.client.weight());
      if (weight > bestWeight) {
        best = entry;
        bestWeight = weight;
      }
    }
    if (!best) return;
    // Cleared before the callback: the poke re-runs a reschedule that will
    // acquire (clearing it anyway) or be denied again (setting it again), and
    // leaving it set would make this mesh the perpetual answer to every wake.
    best.demanding = false;
    best.client.onSlotAvailable();
  }
}

/** Negative, NaN and infinite weights are all "no claim on the pipe". */
function normalizeWeight(weight: number): number {
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}
