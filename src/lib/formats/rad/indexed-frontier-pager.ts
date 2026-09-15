/**
 * Stable-slot RAD frontier staging. A candidate owns its newly allocated slots
 * until it is published or superseded; displayed slots are never relocated.
 * The renderer may therefore keep sorting/drawing the previous index list
 * while bounded uploads fill a completely different tree cut.
 *
 * This is internal bookkeeping, not a rendering path. In particular, a host
 * must not acknowledge publication until its matching order and data have
 * passed the backend's visibility boundary.
 */

export interface IndexedFrontierStage {
  readonly generation: number;
  readonly slots: Uint32Array;
  readonly globals: Uint32Array;
  readonly complete: boolean;
}

export interface IndexedFrontierPublication {
  readonly generation: number;
  readonly slots: Uint32Array;
  readonly count: number;
}

export class IndexedFrontierPager {
  private readonly slotOf = new Map<number, number>();
  private readonly residentPerFile = new Map<number, number>();
  private readonly free: number[] = [];
  private readonly slotGlobal: Int32Array;
  private displayed: number[] = [];
  private candidate: {
    generation: number;
    globals: number[];
    slots: number[];
    cursor: number;
    owned: number[];
  } | null = null;
  private awaitingAck: { generation: number; retired: number[] } | null = null;
  private generation = 0;

  constructor(
    readonly capacity: number,
    private readonly chunkSize = 65536,
  ) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new RangeError('Invalid capacity.');
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError('Invalid chunk size.');
    this.slotGlobal = new Int32Array(capacity).fill(-1);
    // Pop from the end to allocate low slots first.
    for (let slot = capacity - 1; slot >= 0; slot--) this.free.push(slot);
  }

  get displaySlots(): Uint32Array {
    return Uint32Array.from(this.displayed);
  }

  get pendingCount(): number {
    return this.candidate ? this.candidate.globals.length - this.candidate.cursor : 0;
  }

  get residentCount(): number {
    return this.slotOf.size;
  }

  get displayCount(): number {
    return this.displayed.length;
  }

  get hasPublishedDisplay(): boolean {
    return this.displayed.length > 0;
  }

  get candidateGeneration(): number | null {
    return this.candidate?.generation ?? null;
  }

  get awaitingPublication(): boolean {
    return this.awaitingAck !== null;
  }

  matchesDisplay(globals: readonly number[]): boolean {
    if (globals.length !== this.displayed.length) return false;
    for (let i = 0; i < globals.length; i++) {
      if (this.slotGlobal[this.displayed[i] as number] !== globals[i]) return false;
    }
    return true;
  }

  /** The chunk cache must protect both published and candidate splats. */
  hasResidentIn(file: number): boolean {
    return this.residentPerFile.has(file);
  }

  /** A newer camera discards only unpublished slots. */
  select(globals: Iterable<number>): number {
    if (this.awaitingAck) throw new Error('A publication is awaiting acknowledgment.');
    this.cancel();
    const unique = [...new Set(globals)];
    if (unique.length > this.capacity) throw new RangeError('Frontier exceeds slot capacity.');
    const generation = ++this.generation;
    this.candidate = {
      generation,
      globals: unique,
      slots: [],
      cursor: 0,
      owned: [],
    };
    return generation;
  }

  /**
   * Stages at most `maxWrites` newcomers. Existing globals retain their slots.
   * Insufficient storage is a wait, never permission to evict displayed data.
   */
  stage(generation: number, maxWrites: number): IndexedFrontierStage | null {
    const candidate = this.candidate;
    if (!candidate || candidate.generation !== generation) return null;
    if (!Number.isInteger(maxWrites) || maxWrites < 0) throw new RangeError('Invalid write cap.');
    const slots: number[] = [];
    const globals: number[] = [];
    let writes = 0;
    while (candidate.cursor < candidate.globals.length) {
      const global = candidate.globals[candidate.cursor] as number;
      let slot = this.slotOf.get(global);
      if (slot === undefined) {
        if (writes === maxWrites || this.free.length === 0) break;
        slot = this.free.pop();
        if (slot === undefined) break;
        this.slotOf.set(global, slot);
        this.slotGlobal[slot] = global;
        const file = Math.floor(global / this.chunkSize);
        this.residentPerFile.set(file, (this.residentPerFile.get(file) ?? 0) + 1);
        candidate.owned.push(slot);
        slots.push(slot);
        globals.push(global);
        writes++;
      }
      candidate.slots.push(slot);
      candidate.cursor++;
    }
    return {
      generation,
      slots: Uint32Array.from(slots),
      globals: Uint32Array.from(globals),
      complete: candidate.cursor === candidate.globals.length,
    };
  }

  /** Hands a complete candidate to the host; slots remain owned until its acknowledgment. */
  beginPublication(generation: number): IndexedFrontierPublication | null {
    const candidate = this.candidate;
    if (!candidate || candidate.generation !== generation || this.pendingCount !== 0) return null;
    const next = new Set(candidate.slots);
    this.awaitingAck = {
      generation,
      retired: this.displayed.filter((slot) => !next.has(slot)),
    };
    this.displayed = candidate.slots;
    this.candidate = null;
    return { generation, slots: Uint32Array.from(this.displayed), count: this.displayed.length };
  }

  /** The former display remains owned until the new generation is visible. */
  acknowledge(generation: number): boolean {
    if (this.awaitingAck?.generation !== generation) return false;
    for (const slot of this.awaitingAck.retired) this.release(slot);
    this.awaitingAck = null;
    return true;
  }

  /** Never release a slot shared by the published cut and a candidate. */
  cancel(): void {
    if (!this.candidate) return;
    for (const slot of this.candidate.owned) this.release(slot);
    this.candidate = null;
  }

  private release(slot: number): void {
    const global = this.slotGlobal[slot] as number;
    this.slotOf.delete(global);
    const file = Math.floor(global / this.chunkSize);
    const remaining = (this.residentPerFile.get(file) ?? 0) - 1;
    if (remaining > 0) this.residentPerFile.set(file, remaining);
    else this.residentPerFile.delete(file);
    this.slotGlobal[slot] = -1;
    this.free.push(slot);
  }
}
