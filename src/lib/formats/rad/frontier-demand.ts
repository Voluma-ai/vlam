/** Incremental, request-only walk of the same best-first RAD cut as the pager.
 * It never changes selection or display; missing child chunks are ranked from
 * the parent which kept their region covered. */
import type { SplatData } from '../../core/splat-data';
import { frontierView, MaxHeap, pixelScaleOf } from './rad-frontier';
import type { FrontierDemandMessage, FrontierDemandWant } from './frontier-worker-protocol';

export function compareDemand(a: FrontierDemandWant, b: FrontierDemandWant): number {
  return a.tier - b.tier || b.priority - a.priority || a.file - b.file;
}

/** Projection is local clip-from-local, including the mesh transform. */
export function rankDemandParent(
  data: SplatData,
  local: number,
  file: number,
  matrix: readonly number[],
  origin: readonly [number, number, number],
): FrontierDemandWant {
  const p = data.positions;
  const x = p[local * 3] as number;
  const y = p[local * 3 + 1] as number;
  const z = p[local * 3 + 2] as number;
  const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
  const dx = x - origin[0];
  const dy = y - origin[1];
  const dz = z - origin[2];
  const size = data.radTree!.size[local] as number;
  const coarseness = size / (Math.hypot(dx, dy, dz) || 1e-6);
  if (w <= 0 || !Number.isFinite(w)) return { file, tier: 1, priority: coarseness };
  const nx = (matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!) / w;
  const ny = (matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!) / w;
  // `size` is a conservative *footprint hint*, not a descendant bound. Never
  // cull an ancestor merely because its center or footprint is outside.
  const radius = Math.min(
    10,
    coarseness *
      Math.max(
        Math.hypot(matrix[0]!, matrix[4]!, matrix[8]!),
        Math.hypot(matrix[1]!, matrix[5]!, matrix[9]!),
      ),
  );
  const extent = Math.max(Math.abs(nx), Math.abs(ny));
  const tier: 0 | 1 | 2 = extent + radius <= 1 ? 0 : extent - radius <= 1.15 ? 1 : 2;
  const center = Math.min(1, extent);
  const smooth = center * center * (3 - 2 * center);
  return { file, tier, priority: coarseness * (4 - 3 * smooth) };
}

export class FrontierDemandScan {
  private readonly heap = new MaxHeap();
  private readonly wants = new Map<number, FrontierDemandWant>();
  private readonly view;
  private count = 0;
  private complete = false;
  private rootIndex = 0;
  private readonly seeded = new Set<number>();

  constructor(
    private readonly cache: ReadonlyMap<number, SplatData>,
    private readonly roots: readonly number[],
    private readonly chunkSize: number,
    private readonly msg: FrontierDemandMessage,
  ) {
    this.view = frontierView(
      { x: msg.cameraLocal[0], y: msg.cameraLocal[1], z: msg.cameraLocal[2] },
      { x: msg.cameraForward[0], y: msg.cameraForward[1], z: msg.cameraForward[2] },
      msg,
    );
  }

  /** Returns null until the whole walk completes; an omitted partial want can
   * never authorize cancellation of a download. */
  step(deadline: number): FrontierDemandWant[] | null {
    if (this.complete) return [...this.wants.values()].sort(compareDemand);
    while (this.rootIndex < this.roots.length && performance.now() < deadline) {
      const global = this.roots[this.rootIndex++] as number;
      if (this.seeded.has(global)) continue;
      const file = Math.floor(global / this.chunkSize);
      const data = this.cache.get(file);
      if (!data?.radTree) continue;
      this.seeded.add(global);
      this.heap.push(global, pixelScaleOf(data, global - file * this.chunkSize, this.view));
      this.count++;
    }
    if (this.rootIndex < this.roots.length) return null;
    while (this.heap.size && performance.now() < deadline) {
      const scale = this.heap.peekPriority();
      if (scale <= this.msg.limit) break;
      const global = this.heap.peek();
      const file = Math.floor(global / this.chunkSize);
      const data = this.cache.get(file);
      const local = global - file * this.chunkSize;
      if (!data?.radTree) {
        this.heap.pop();
        this.count--;
        continue;
      }
      const tree = data.radTree;
      const children = tree.childCount[local] as number;
      if (children === 0) {
        this.heap.pop();
        continue;
      }
      const nextCount = this.count - 1 + children;
      if (nextCount > this.msg.budget) break;
      this.heap.pop();
      const start = tree.childStart[local] as number;
      const first = Math.floor(start / this.chunkSize);
      const last = Math.floor((start + children - 1) / this.chunkSize);
      let available = true;
      for (let cc = first; cc <= last; cc++) {
        if (this.cache.has(cc)) continue;
        available = false;
        const want = rankDemandParent(data, local, cc, this.msg.projection, this.msg.cameraLocal);
        const old = this.wants.get(cc);
        if (!old || compareDemand(want, old) < 0) this.wants.set(cc, want);
      }
      if (!available) continue;
      for (let c = 0; c < children; c++) {
        const child = start + c;
        const cc = Math.floor(child / this.chunkSize);
        const node = this.cache.get(cc)!;
        const childScale = pixelScaleOf(node, child - cc * this.chunkSize, this.view);
        if (childScale > this.msg.limit) this.heap.push(child, childScale);
      }
      this.count = nextCount;
    }
    if (
      this.heap.size &&
      this.heap.peekPriority() > this.msg.limit &&
      this.count -
        1 +
        (this.cache.get(Math.floor(this.heap.peek() / this.chunkSize))?.radTree?.childCount[
          this.heap.peek() % this.chunkSize
        ] ?? 0) <=
        this.msg.budget &&
      performance.now() >= deadline
    )
      return null;
    this.complete = true;
    return [...this.wants.values()].sort(compareDemand);
  }
}
