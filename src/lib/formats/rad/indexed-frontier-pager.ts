/**
 * Stable-slot RAD frontier staging. A candidate owns its newly allocated slots
 * until it is published or superseded; displayed slots are never relocated.
 * The renderer may therefore keep sorting/drawing the previous index list
 * while bounded uploads fill a completely different tree cut.
 *
 * This is internal bookkeeping, not a rendering path. A host must not
 * acknowledge publication until its matching order and data have passed the
 * backend's visibility boundary.
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
  /** Capacity that was used to relocate this publication, if any. */
  readonly resizeCapacity?: number;
}

export class IndexedFrontierPager {
  private readonly slotOf = new Map<number, number>();
  private readonly residentPerFile = new Map<number, number>();
  private readonly free: number[] = [];
  private slotGlobal: Int32Array;
  private displayed: number[] = [];
  private candidate: {
    generation: number;
    globals: number[];
    files: Set<number>;
    slots: number[];
    cursor: number;
    owned: number[];
    slotLimit: number;
    relocated: Map<number, number>;
  } | null = null;
  private awaitingAck: {
    generation: number;
    retired: number[];
    resizeCapacity: number | null;
    previousDisplayed: number[];
    previousGeneration: number;
  } | null = null;
  private resizeSafeCapacity: number | null = null;
  private pendingShrink: number | null = null;
  private generation = 0;
  private publishedGeneration = 0;

  constructor(
    public capacity: number,
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

  get displayGlobals(): Uint32Array {
    return Uint32Array.from(this.displayed, (slot) => this.slotGlobal[slot] as number);
  }

  get pendingCount(): number {
    return this.candidate ? this.candidate.globals.length - this.candidate.cursor : 0;
  }

  get candidateCount(): number {
    return this.candidate?.globals.length ?? 0;
  }

  get candidateNewCount(): number {
    return this.candidate?.owned.length ?? 0;
  }

  get candidateReusedCount(): number {
    return this.candidate ? this.candidate.slots.length - this.candidate.owned.length : 0;
  }

  get residentCount(): number {
    return this.slotOf.size;
  }

  get residentFiles(): readonly number[] {
    return [...this.residentPerFile.keys()];
  }

  get displayCount(): number {
    return this.displayed.length;
  }

  get displayGeneration(): number {
    return this.publishedGeneration;
  }

  get hasPublishedDisplay(): boolean {
    return this.displayed.length > 0;
  }

  get candidateGeneration(): number | null {
    return this.candidate?.generation ?? null;
  }

  get candidateGlobals(): Uint32Array {
    return Uint32Array.from(this.candidate?.globals ?? []);
  }

  get candidateFiles(): readonly number[] {
    return this.candidate ? [...this.candidate.files] : [];
  }

  get awaitingPublicationGeneration(): number | null {
    return this.awaitingAck?.generation ?? null;
  }

  get awaitingPublication(): boolean {
    return this.awaitingAck !== null;
  }

  /** Slot cap for a pending shrink; displayed tail slots relocate into this prefix. */
  get pendingSlotLimit(): number {
    return this.pendingShrink ?? this.capacity;
  }

  matchesDisplay(globals: readonly number[], slotLimit = this.capacity): boolean {
    if (globals.length !== this.displayed.length) return false;
    for (let i = 0; i < globals.length; i++) {
      const slot = this.displayed[i] as number;
      if (slot >= slotLimit || this.slotGlobal[slot] !== globals[i]) return false;
    }
    return true;
  }

  matchesCandidate(globals: readonly number[]): boolean {
    const candidate = this.candidate;
    if (!candidate || candidate.globals.length !== globals.length) return false;
    for (let i = 0; i < globals.length; i++) {
      if (candidate.globals[i] !== globals[i]) return false;
    }
    return true;
  }

  /** The chunk cache must protect both published and candidate splats. */
  hasResidentIn(file: number): boolean {
    return this.residentPerFile.has(file);
  }

  /** Whether the candidate can coexist with the current display below `slotLimit`. */
  canStage(globals: Iterable<number>, slotLimit = this.capacity): boolean {
    if (this.awaitingAck || this.candidate || slotLimit > this.capacity || slotLimit < 0) {
      return false;
    }
    const values = [...globals];
    const unique = new Set(values);
    if (unique.size !== values.length) return false;
    if (unique.size > slotLimit) return false;
    let writes = 0;
    for (const global of unique) {
      const slot = this.slotOf.get(global);
      if (slot === undefined || slot >= slotLimit) writes++;
    }
    let free = 0;
    for (const slot of this.free) if (slot < slotLimit) free++;
    return writes <= free;
  }

  /** A newer camera discards only unpublished slots. */
  select(globals: Iterable<number>, slotLimit = this.capacity): number {
    if (this.awaitingAck) throw new Error('A publication is awaiting acknowledgment.');
    this.cancel();
    const values = [...globals];
    const unique = [...new Set(values)];
    if (unique.length !== values.length) {
      throw new RangeError('Frontier candidate contains duplicate globals.');
    }
    if (unique.length > slotLimit || slotLimit > this.capacity || slotLimit < 0) {
      throw new RangeError('Frontier exceeds slot capacity.');
    }
    const generation = ++this.generation;
    this.candidate = {
      generation,
      globals: unique,
      files: new Set(unique.map((global) => Math.floor(global / this.chunkSize))),
      slots: [],
      cursor: 0,
      owned: [],
      slotLimit,
      relocated: new Map(),
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
        if (writes === maxWrites) break;
        slot = this.takeFree(candidate.slotLimit);
        if (slot === undefined) break;
        this.slotOf.set(global, slot);
        this.slotGlobal[slot] = global;
        const file = Math.floor(global / this.chunkSize);
        this.residentPerFile.set(file, (this.residentPerFile.get(file) ?? 0) + 1);
        candidate.owned.push(slot);
        slots.push(slot);
        globals.push(global);
        writes++;
      } else if (slot >= candidate.slotLimit) {
        if (writes === maxWrites) break;
        const replacement = this.takeFree(candidate.slotLimit);
        if (replacement === undefined) break;
        candidate.relocated.set(global, slot);
        candidate.owned.push(replacement);
        this.slotOf.set(global, replacement);
        this.slotGlobal[replacement] = global;
        slot = replacement;
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
      resizeCapacity: candidate.slotLimit < this.capacity ? candidate.slotLimit : null,
      previousDisplayed: this.displayed,
      previousGeneration: this.publishedGeneration,
    };
    this.displayed = candidate.slots;
    this.publishedGeneration = generation;
    this.candidate = null;
    const resizeCapacity = this.awaitingAck.resizeCapacity;
    return {
      generation,
      slots: Uint32Array.from(this.displayed),
      count: this.displayed.length,
      ...(resizeCapacity === null ? {} : { resizeCapacity }),
    };
  }

  /** The former display remains owned until the new generation is visible. */
  acknowledge(generation: number): boolean {
    if (this.awaitingAck?.generation !== generation) return false;
    const awaiting = this.awaitingAck;
    for (const slot of awaiting.retired) this.release(slot);
    this.awaitingAck = null;
    if (awaiting.resizeCapacity !== null && this.pendingShrink === awaiting.resizeCapacity) {
      this.finalizeResize(awaiting.resizeCapacity);
      this.resizeSafeCapacity = awaiting.resizeCapacity;
      this.pendingShrink = null;
    }
    return true;
  }

  /** Returns and clears the capacity whose tail is now safe to release. */
  consumeResizeSafeCapacity(): number | null {
    const capacity = this.resizeSafeCapacity;
    this.resizeSafeCapacity = null;
    return capacity;
  }

  /** Grows the logical slot space after the host has reserved physical pages. */
  grow(capacity: number): void {
    this.pendingShrink = null;
    this.resizeSafeCapacity = null;
    if (capacity <= this.capacity) return;
    const next = new Int32Array(capacity).fill(-1);
    next.set(this.slotGlobal);
    for (let slot = capacity - 1; slot >= this.capacity; slot--) this.free.push(slot);
    this.slotGlobal = next;
    this.capacity = capacity;
  }

  /** Records a shrink and applies it immediately only when the tail is unused. */
  requestShrink(capacity: number): boolean {
    if (capacity >= this.capacity) return true;
    this.pendingShrink = capacity;
    if (this.shrinkIfSafe(capacity)) {
      this.pendingShrink = null;
      this.resizeSafeCapacity = capacity;
      return true;
    }
    return false;
  }

  /** Shrinks immediately only when no current or pending selection uses the tail. */
  shrinkIfSafe(capacity: number): boolean {
    if (capacity >= this.capacity || this.candidate || this.awaitingAck) return false;
    if (this.displayed.some((slot) => slot >= capacity)) return false;
    this.finalizeResize(capacity);
    return true;
  }

  /** Never release a slot shared by the published cut and a candidate. */
  cancel(): void {
    if (!this.candidate) return;
    const candidate = this.candidate;
    for (const [global, slot] of candidate.relocated) this.slotOf.set(global, slot);
    for (const slot of candidate.owned) this.release(slot);
    this.candidate = null;
  }

  /** Cancels a complete but not yet acknowledged publication and restores the prior display. */
  cancelUnpublishedPublication(): boolean {
    const awaiting = this.awaitingAck;
    if (!awaiting) return false;
    const previous = new Set(awaiting.previousDisplayed);
    for (const slot of this.displayed) {
      if (!previous.has(slot)) this.release(slot);
    }
    for (const slot of awaiting.previousDisplayed) {
      const global = this.slotGlobal[slot] as number;
      const current = this.slotOf.get(global);
      if (global >= 0 && current !== undefined && current !== slot) {
        this.slotGlobal[current] = -1;
        this.free.push(current);
        this.slotOf.set(global, slot);
        this.slotGlobal[slot] = global;
      }
    }
    this.displayed = awaiting.previousDisplayed;
    this.publishedGeneration = awaiting.previousGeneration;
    this.awaitingAck = null;
    return true;
  }

  private release(slot: number): void {
    const global = this.slotGlobal[slot] as number;
    if (global >= 0 && this.slotOf.get(global) === slot) {
      this.slotOf.delete(global);
      const file = Math.floor(global / this.chunkSize);
      const remaining = (this.residentPerFile.get(file) ?? 0) - 1;
      if (remaining > 0) this.residentPerFile.set(file, remaining);
      else this.residentPerFile.delete(file);
    }
    this.slotGlobal[slot] = -1;
    this.free.push(slot);
  }

  private takeFree(limit: number): number | undefined {
    for (let i = this.free.length - 1; i >= 0; i--) {
      const slot = this.free[i] as number;
      if (slot >= limit) continue;
      this.free.splice(i, 1);
      return slot;
    }
    return undefined;
  }

  private finalizeResize(capacity: number): void {
    for (const slot of this.slotOf.values()) {
      if (slot >= capacity) throw new Error('Indexed frontier resize retains a tail slot.');
    }
    const next = new Int32Array(capacity).fill(-1);
    next.set(this.slotGlobal.subarray(0, capacity));
    this.slotGlobal = next;
    this.capacity = capacity;
    this.free.length = 0;
    for (let slot = capacity - 1; slot >= 0; slot--) {
      if (this.slotGlobal[slot] === -1) this.free.push(slot);
    }
  }
}
