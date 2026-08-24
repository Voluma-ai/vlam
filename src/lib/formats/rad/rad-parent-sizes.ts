/**
 * Propagates each `.rad` splat's **parent LOD node size** as chunks stream in.
 *
 * The foveation cut (see `docs/formats/rad-notes.md` M14.6) draws a splat `i` when
 * `parentPixelScale(i) > limit ≥ ownPixelScale(i)` - exactly one node per
 * root→leaf path, since `pixel_scale = size / distance` decreases monotonically
 * down the tree. That test needs each splat's *parent's* `size`, but the file
 * only stores the forward links (`child_start`/`child_count`): a node lists its
 * children, not its parent.
 *
 * So we invert the links incrementally. When a chunk decodes, each internal
 * node's `size` is recorded against the global index range of its children
 * (`[child_start, child_start + child_count)`); a later chunk holding those
 * children reads its own parent sizes back out. Because chunks stream roughly
 * coarsest-first (a node's parent is always at a lower global index, and the
 * coarse base loads first), parents are normally decoded before their children.
 * A child whose parent has not decoded yet gets `Infinity` - treated as a root,
 * so it draws whenever it is small enough on screen; the worst case is a little
 * over-draw, never a hole or a crash.
 *
 * This decode order is the **original** chunk order (no frontier reorder), so
 * `child_start` still points at the right splats - the foveation path keeps
 * splats in file order and lets the GPU cull choose the cut per splat.
 */
export class RadParentSizes {
  private readonly chunkSize: number;
  /** Parent-size ranges awaiting the child chunk that will consume them,
   * keyed by that child chunk index. Each range is a global-index span. */
  private readonly pending = new Map<number, { start: number; end: number; size: number }[]>();
  /** Chunks already resolved - a parent decoded after its child can't fix it,
   * so we drop such stragglers rather than leak them. */
  private readonly resolved = new Set<number>();

  constructor(chunkSize: number) {
    this.chunkSize = chunkSize;
  }

  /**
   * Records `chunkIndex`'s internal→child links and returns that chunk's
   * per-splat parent sizes (in the chunk's own splat order). Call once per
   * chunk, as it decodes.
   *
   * @param childCount - Per-splat child count (0 = leaf).
   * @param childStart - Per-splat first-child global index.
   * @param size - Per-splat LOD node size.
   */
  resolve(
    chunkIndex: number,
    childCount: Uint16Array,
    childStart: Uint32Array,
    size: Float32Array,
  ): Float32Array {
    const count = childCount.length;
    const base = chunkIndex * this.chunkSize;
    // No known parent → Infinity (root-like: drawn when small enough on screen).
    const parentSize = new Float32Array(count).fill(Infinity);

    const ranges = this.pending.get(chunkIndex);
    if (ranges) {
      for (const range of ranges) {
        const from = Math.max(range.start - base, 0);
        const to = Math.min(range.end - base, count);
        for (let local = from; local < to; local++) parentSize[local] = range.size;
      }
      this.pending.delete(chunkIndex);
    }
    this.resolved.add(chunkIndex);

    // Record this chunk's children so they can read their parent size later.
    for (let i = 0; i < count; i++) {
      const cc = childCount[i] as number;
      if (cc === 0) continue;
      const parentNodeSize = size[i] as number;
      let g = childStart[i] as number;
      const end = g + cc;
      // Children are contiguous but may straddle a chunk boundary (rare).
      while (g < end) {
        const childChunk = Math.floor(g / this.chunkSize);
        const chunkEnd = (childChunk + 1) * this.chunkSize;
        const rangeEnd = Math.min(end, chunkEnd);
        if (!this.resolved.has(childChunk)) this.push(childChunk, g, rangeEnd, parentNodeSize);
        g = rangeEnd;
      }
    }

    return parentSize;
  }

  private push(childChunk: number, start: number, end: number, size: number): void {
    let ranges = this.pending.get(childChunk);
    if (!ranges) {
      ranges = [];
      this.pending.set(childChunk, ranges);
    }
    ranges.push({ start, end, size });
  }
}
