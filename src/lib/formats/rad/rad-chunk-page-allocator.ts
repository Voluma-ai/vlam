/**
 * Stable page ownership for the RAD chunk-residency path.
 *
 * A page is one authored RAD chunk. Its pool position does not change while
 * the chunk is resident, so changing the frontier only changes the draw-index
 * list and never copies selected splat attributes.
 */
export class RadChunkPageAllocator {
  private readonly freePages: number[] = [];
  private readonly pages = new Map<number, { page: number; count: number }>();

  constructor(
    readonly capacityPages: number,
    readonly chunkSize = 65_536,
  ) {
    if (!Number.isInteger(capacityPages) || capacityPages < 0) {
      throw new RangeError('RAD page capacity must be a non-negative integer.');
    }
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new RangeError('RAD chunk size must be a positive integer.');
    }
    for (let page = capacityPages - 1; page >= 0; page--) this.freePages.push(page);
  }

  /** Number of chunks currently backed by stable pool pages. */
  get residentCount(): number {
    return this.pages.size;
  }

  /** Files with an allocated GPU page, in file order. */
  get residentFiles(): readonly number[] {
    return [...this.pages.keys()].sort((a, b) => a - b);
  }

  /** Returns the page number for a resident file, if any. */
  pageOf(file: number): number | undefined {
    return this.pages.get(file)?.page;
  }

  /** Allocates one stable page for a decoded chunk. */
  allocate(file: number, count: number): number | undefined {
    if (!Number.isInteger(file) || file < 0) throw new RangeError('Invalid RAD chunk file.');
    if (!Number.isInteger(count) || count < 0 || count > this.chunkSize) {
      throw new RangeError('RAD chunk count exceeds its authored page size.');
    }
    const existing = this.pages.get(file);
    if (existing) {
      if (existing.count !== count) throw new Error('RAD chunk was decoded with a new size.');
      return existing.page;
    }
    const page = this.freePages.pop();
    if (page === undefined) return undefined;
    this.pages.set(file, { page, count });
    return page;
  }

  /** Releases a page so a later residency period can reuse its slot range. */
  release(file: number): boolean {
    const entry = this.pages.get(file);
    if (!entry) return false;
    this.pages.delete(file);
    this.freePages.push(entry.page);
    this.freePages.sort((a, b) => b - a);
    return true;
  }

  /** Maps a global RAD node id to its stable pool slot. */
  poolSlot(global: number): number | undefined {
    if (!Number.isInteger(global) || global < 0) return undefined;
    const file = Math.floor(global / this.chunkSize);
    const local = global - file * this.chunkSize;
    return this.poolSlotForNode(file, local);
  }

  /** Maps a chunk id and local node index to its stable pool slot. */
  poolSlotForNode(file: number, local: number): number | undefined {
    if (!Number.isInteger(file) || file < 0 || !Number.isInteger(local) || local < 0) {
      return undefined;
    }
    const entry = this.pages.get(file);
    if (!entry || local >= entry.count) return undefined;
    return entry.page * this.chunkSize + local;
  }

  /** Maps a selected global-id list to pool indices, or returns null if a page is absent. */
  poolSlots(globals: ArrayLike<number>): Uint32Array | null {
    const slots = new Uint32Array(globals.length);
    for (let i = 0; i < globals.length; i++) {
      const slot = this.poolSlot(globals[i] as number);
      if (slot === undefined) return null;
      slots[i] = slot;
    }
    return slots;
  }
}
