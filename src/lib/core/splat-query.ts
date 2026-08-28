/**
 * A lazily built uniform spatial grid over splat centers, for the CPU spatial
 * queries `SplatMesh` exposes (M9). Pure array math - no THREE, no GPU - over
 * the pool's CPU-side centers, so it is cheap to build and to test.
 *
 * The grid indexes a set of *pool indices* into a shared centers array (the
 * pool's `backing.centers`, RGBA-strided: splat `p`'s center is
 * `centers[p*4 + 0..2]`). Only the indices handed in are indexed, so a static
 * mesh grids its whole scene and a streamed mesh grids exactly its resident
 * splats. Everything is in the mesh's **local** space; the caller converts
 * world queries in and results out.
 */

/** Largest per-axis cell count, to bound the cell-start array's size. */
const MAX_DIM = 1024;
/** Largest total cell count; above this the grid coarsens rather than allocate. */
const MAX_CELLS = 1 << 21;

export class UniformGrid {
  /** Populated-region minimum corner (local space). */
  private readonly min = new Float64Array(3);
  /** Per-axis cell size (local units). */
  private readonly cellSize = new Float64Array(3);
  /** Per-axis cell counts. */
  private readonly dims = new Int32Array(3);
  /** CSR cell offsets: cell c owns `items[start[c] .. start[c+1])`. */
  private readonly cellStart: Int32Array;
  /** Pool indices, bucketed by cell. */
  private readonly items: Uint32Array;
  /** Pool centers array this grid points into (RGBA stride 4). */
  private readonly centers: Float32Array;

  readonly count: number;

  /**
   * @param centers - The pool's CPU centers (stride 4: x,y,z,_ per splat).
   * @param poolIndices - The pool indices to index (e.g. the active list).
   * @param count - How many entries of `poolIndices` are valid.
   */
  constructor(centers: Float32Array, poolIndices: Uint32Array, count: number) {
    this.centers = centers;
    this.count = count;
    if (count === 0) {
      this.dims.set([1, 1, 1]);
      this.cellSize.set([1, 1, 1]);
      this.cellStart = new Int32Array(2);
      this.items = new Uint32Array(0);
      return;
    }

    // 1. Bounds of the populated region.
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      const base = (poolIndices[i] as number) * 4;
      for (let a = 0; a < 3; a++) {
        const v = centers[base + a] as number;
        if (v < (lo[a] as number)) lo[a] = v;
        if (v > (hi[a] as number)) hi[a] = v;
      }
    }

    // 2. Cell sizing. Target ~one splat per cell using only the populated
    //    dimensions, so a planar or linear scene still resolves well.
    const size = [
      (hi[0] as number) - (lo[0] as number),
      (hi[1] as number) - (lo[1] as number),
      (hi[2] as number) - (lo[2] as number),
    ];
    const nonZero = size.filter((s) => s > 0);
    const spanProduct = nonZero.reduce((a, b) => a * b, 1);
    let cell = nonZero.length > 0 ? Math.pow(spanProduct / count, 1 / nonZero.length) : 1;
    if (!(cell > 0) || !Number.isFinite(cell)) cell = 1;

    const chooseDims = (cellEdge: number): void => {
      for (let a = 0; a < 3; a++) {
        const s = size[a] as number;
        this.dims[a] = s > 0 ? Math.max(1, Math.min(MAX_DIM, Math.round(s / cellEdge) || 1)) : 1;
        // A cell must span the whole axis when there is only one of them, so a
        // point exactly at the max corner still lands in-range.
        this.cellSize[a] = (this.dims[a] as number) > 0 ? s / (this.dims[a] as number) || 1 : 1;
        this.min[a] = lo[a] as number;
      }
    };
    chooseDims(cell);
    // Coarsen until the cell array fits the cap (huge, near-degenerate scenes).
    while (this.dims[0]! * this.dims[1]! * this.dims[2]! > MAX_CELLS) {
      cell *= 1.5;
      chooseDims(cell);
    }

    const cellCount = this.dims[0]! * this.dims[1]! * this.dims[2]!;
    // 3. Counting sort into CSR.
    const counts = new Int32Array(cellCount + 1);
    for (let i = 0; i < count; i++) counts[this.cellOf(poolIndices[i] as number) + 1]!++;
    for (let c = 0; c < cellCount; c++) counts[c + 1]! += counts[c]!;
    this.cellStart = counts;
    this.items = new Uint32Array(count);
    const cursor = Int32Array.from(counts.subarray(0, cellCount));
    for (let i = 0; i < count; i++) {
      const p = poolIndices[i] as number;
      this.items[cursor[this.cellOf(p)]!++] = p;
    }
  }

  /** The cell index of pool splat `p`, clamped into range. */
  private cellOf(p: number): number {
    const base = p * 4;
    const ix = this.axisCell(0, this.centers[base] as number);
    const iy = this.axisCell(1, this.centers[base + 1] as number);
    const iz = this.axisCell(2, this.centers[base + 2] as number);
    return (iz * (this.dims[1] as number) + iy) * (this.dims[0] as number) + ix;
  }

  private axisCell(a: number, value: number): number {
    const i = Math.floor((value - (this.min[a] as number)) / (this.cellSize[a] as number));
    return Math.max(0, Math.min((this.dims[a] as number) - 1, i));
  }

  /**
   * Visits every indexed splat within `radius` (local units) of the local
   * point, calling `visit(poolIndex, distanceSq)`. Cells are pruned by their
   * axis span and each candidate is distance-filtered here, so the callback
   * only ever sees splats truly within the radius.
   */
  forEachWithin(
    x: number,
    y: number,
    z: number,
    radius: number,
    visit: (poolIndex: number, distanceSq: number) => void,
  ): void {
    if (this.count === 0 || radius < 0) return;
    const r2 = radius * radius;
    const lo = [0, 0, 0];
    const hi = [0, 0, 0];
    const q = [x, y, z];
    for (let a = 0; a < 3; a++) {
      const span = Math.ceil(radius / (this.cellSize[a] as number));
      const c = this.axisCell(a, q[a] as number);
      lo[a] = Math.max(0, c - span);
      hi[a] = Math.min((this.dims[a] as number) - 1, c + span);
    }
    for (let iz = lo[2] as number; iz <= (hi[2] as number); iz++) {
      for (let iy = lo[1] as number; iy <= (hi[1] as number); iy++) {
        const rowBase = (iz * (this.dims[1] as number) + iy) * (this.dims[0] as number);
        const from = this.cellStart[rowBase + (lo[0] as number)] as number;
        const to = this.cellStart[rowBase + (hi[0] as number) + 1] as number;
        for (let k = from; k < to; k++) {
          const p = this.items[k] as number;
          const base = p * 4;
          const dx = (this.centers[base] as number) - x;
          const dy = (this.centers[base + 1] as number) - y;
          const dz = (this.centers[base + 2] as number) - z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 <= r2) visit(p, d2);
        }
      }
    }
  }

  /**
   * The nearest indexed splat to the local point within `radius`, or null.
   * Returns its pool index and squared local distance.
   */
  nearest(
    x: number,
    y: number,
    z: number,
    radius: number,
  ): { poolIndex: number; distSq: number } | null {
    let bestIndex = -1;
    let bestSq = Infinity;
    this.forEachWithin(x, y, z, radius, (p, d2) => {
      if (d2 < bestSq) {
        bestSq = d2;
        bestIndex = p;
      }
    });
    return bestIndex < 0 ? null : { poolIndex: bestIndex, distSq: bestSq };
  }
}
