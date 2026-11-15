/**
 * {@link computeSplatSkinWeights}: gives a static splat the skin of a rigged
 * proxy mesh, so a captured scan can be animated by a skeleton made for that
 * proxy (a glTF character, creature or vehicle).
 */
import * as THREE from 'three/webgpu';
import type { SplatData } from '../core/splat-data';
import type { SplatSkinData } from './skinned-splat-mesh';

/**
 * Options of {@link computeSplatSkinWeights}.
 *
 * @experimental
 */
export interface SplatSkinWeightOptions {
  /**
   * Bones kept per splat: the heaviest of the vertex's four, renormalized.
   * Default 4; 2 halves the per-splat cost and suits most creatures.
   */
  bonesPerSplat?: 1 | 2 | 4;
  /**
   * Carries splat centers into the proxy geometry's frame, when the two were
   * not made in the same one (a scan aligned to its rig by hand, a capture in
   * 3DGS axes against a Y-up character). Default: the frames coincide.
   */
  splatToProxy?: THREE.Matrix4;
}

/** A uniform grid over the proxy's vertices, for nearest-vertex queries. */
class VertexGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly min: THREE.Vector3;
  private readonly cell: number;
  private readonly dims: [number, number, number];

  constructor(
    private readonly positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  ) {
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++)
      box.expandByPoint(p.fromBufferAttribute(positions, i));
    const size = box.getSize(new THREE.Vector3());
    // About two vertices per cell, and no more cells along the longest axis
    // than a cube of that many would have: a flat or thin proxy (a plane, a
    // tail) must not turn into millions of empty cells to search.
    const count = Math.max(positions.count, 1);
    const volume = Math.max(size.x, 1e-6) * Math.max(size.y, 1e-6) * Math.max(size.z, 1e-6);
    const extent = Math.max(size.x, size.y, size.z, 1e-6);
    const perAxis = Math.max(1, Math.round(Math.cbrt(count / 2)));
    this.cell = Math.max(Math.cbrt((volume / count) * 2), extent / perAxis);
    this.min = box.min.clone();
    this.dims = [
      Math.max(1, Math.ceil(size.x / this.cell) + 1),
      Math.max(1, Math.ceil(size.y / this.cell) + 1),
      Math.max(1, Math.ceil(size.z / this.cell) + 1),
    ];
    for (let i = 0; i < positions.count; i++) {
      p.fromBufferAttribute(positions, i);
      const key = this.key(...this.coords(p));
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    }
  }

  /** Index of the vertex nearest `point`. */
  nearest(point: THREE.Vector3): number {
    const [cx, cy, cz] = this.coords(point);
    const [nx, ny, nz] = this.dims;
    const v = new THREE.Vector3();
    let best = -1;
    let bestDistance = Infinity;
    const visit = (x: number, y: number, z: number): void => {
      for (const index of this.cells.get(this.key(x, y, z)) ?? []) {
        const distance = v.fromBufferAttribute(this.positions, index).distanceToSquared(point);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
    };
    const maxRing = Math.max(nx, ny, nz);
    for (let ring = 0; ring <= maxRing; ring++) {
      // Every vertex in a farther ring is at least (ring - 1) cells away.
      if (best >= 0 && Math.sqrt(bestDistance) < (ring - 1) * this.cell) break;
      // The shell of cells `ring` away, clipped to the grid: every cell of a
      // column on the x or y faces, and only the two z ends of the others.
      const zLow = cz - ring;
      const zHigh = cz + ring;
      for (let x = Math.max(cx - ring, 0); x <= Math.min(cx + ring, nx - 1); x++) {
        for (let y = Math.max(cy - ring, 0); y <= Math.min(cy + ring, ny - 1); y++) {
          if (Math.abs(x - cx) === ring || Math.abs(y - cy) === ring) {
            for (let z = Math.max(zLow, 0); z <= Math.min(zHigh, nz - 1); z++) visit(x, y, z);
          } else {
            if (zLow >= 0) visit(x, y, zLow);
            if (zHigh < nz && zHigh !== zLow) visit(x, y, zHigh);
          }
        }
      }
    }
    return Math.max(best, 0);
  }

  private coords(p: THREE.Vector3): [number, number, number] {
    const clamp = (value: number, max: number) => Math.min(Math.max(Math.floor(value), 0), max - 1);
    return [
      clamp((p.x - this.min.x) / this.cell, this.dims[0]),
      clamp((p.y - this.min.y) / this.cell, this.dims[1]),
      clamp((p.z - this.min.z) / this.cell, this.dims[2]),
    ];
  }

  private key(x: number, y: number, z: number): number {
    return (z * this.dims[1] + y) * this.dims[0] + x;
  }
}

/**
 * Transfers a rigged proxy's skin to a splat: each splat takes the bone
 * indices and weights of the proxy vertex nearest its center. The proxy is
 * any `THREE.SkinnedMesh` (a glTF character's mesh, a low-poly cage drawn
 * around a scan). Its geometry is matched in the splat's local frame unless
 * `options.splatToProxy` says how to carry splat centers into the proxy's. Pass the result to `SkinnedSplatMesh`, then bind the proxy's
 * skeleton.
 *
 * Nearest-vertex transfer is coarse where the proxy is: splats between two
 * limbs follow whichever vertex is nearer. A denser proxy, or weights made
 * for the splats themselves, gives cleaner joints.
 *
 * @throws {Error} when the proxy has no `skinIndex` / `skinWeight` attributes.
 * @experimental The API may change in a minor release.
 */
export function computeSplatSkinWeights(
  data: Pick<SplatData, 'count' | 'positions'>,
  proxy: THREE.SkinnedMesh,
  options: SplatSkinWeightOptions = {},
): SplatSkinData {
  const n = options.bonesPerSplat ?? 4;
  const { position, skinIndex, skinWeight } = proxy.geometry.attributes;
  if (!position || !skinIndex || !skinWeight) {
    throw new Error(
      'computeSplatSkinWeights: the proxy needs position, skinIndex and skinWeight attributes.',
    );
  }
  const grid = new VertexGrid(position);
  const indices = new Uint16Array(data.count * n);
  const weights = new Float32Array(data.count * n);
  const p = new THREE.Vector3();
  const pairs: { bone: number; weight: number }[] = [];
  for (let i = 0; i < data.count; i++) {
    p.fromArray(data.positions, i * 3);
    if (options.splatToProxy) p.applyMatrix4(options.splatToProxy);
    const vertex = grid.nearest(p);
    pairs.length = 0;
    for (let k = 0; k < 4; k++) {
      pairs.push({
        bone: skinIndex.getComponent(vertex, k),
        weight: skinWeight.getComponent(vertex, k),
      });
    }
    pairs.sort((a, b) => b.weight - a.weight);
    let sum = 0;
    for (let k = 0; k < n; k++) sum += pairs[k]!.weight;
    for (let k = 0; k < n; k++) {
      indices[i * n + k] = pairs[k]!.bone;
      weights[i * n + k] = sum > 0 ? pairs[k]!.weight / sum : k === 0 ? 1 : 0;
    }
  }
  return { bonesPerSplat: n, indices, weights };
}
