/**
 * Per-source world transforms for a unified {@link MergedSplatMesh} pool.
 *
 * Multiple splat clouds are concatenated into one pool in their own local
 * space; each cloud ("source") then carries a world matrix applied **in the
 * shader** - never baked into the pool data. That is what lets a source move
 * every frame at full rate: only this small uniform array changes, and neither
 * the pool textures nor the sort keys are rewritten.
 *
 * The same matrix array node is shared by two consumers so they always agree,
 * both through `sourceWorldTransform` in `splat-mesh-material.ts`:
 *  - the material graph, which places a splat's center and covariance **before**
 *    the modifier stack runs, so effects see the splat where it visually is, and
 *  - the depth sorter, which transforms each splat's center to world space
 *    before computing its view-space depth (see `ComputeSorter`).
 *
 * Internal. Nothing here is exported from `index.ts`.
 */
import * as THREE from 'three/webgpu';
import { uniformArray } from 'three/tsl';

/**
 * Maximum number of sources a unified pool can hold. Sized generously - the
 * uniform array costs `4 · MAX_MERGED_SPLAT_SOURCES` vec4s (16 KB at 256), well under the
 * uniform-buffer limit - while bounding the per-splat index range.
 */
export const MAX_MERGED_SPLAT_SOURCES = 256;

/** The channel both the material graph and the sorter read as a source id. */
export const SOURCE_ID_CHANNEL = 'sourceId';

/**
 * A live, shader-visible array of source world matrices, stored as four vec4
 * **columns** per source (three.js `Matrix4.elements` are column-major, so a
 * column maps to `elements[k*4 .. k*4+3]`). Mutating an entry re-uploads with
 * the frame's uniforms - no material or pipeline rebuild.
 */
export class SourceMatrixArray {
  /** `4 · MAX_MERGED_SPLAT_SOURCES` vec4 columns; the TSL node both consumers index. */
  readonly node: ReturnType<typeof uniformArray>;
  /** CPU mirror of the same column-major matrices, for the WebGL2 sorter. */
  readonly matrices: Float32Array;
  private readonly columns: THREE.Vector4[];

  constructor(maxSources = MAX_MERGED_SPLAT_SOURCES) {
    this.matrices = new Float32Array(16 * maxSources);
    this.columns = Array.from({ length: 4 * maxSources }, (_, i) => {
      // Initialize every slot to the identity matrix's columns.
      const column = i % 4;
      return new THREE.Vector4(
        column === 0 ? 1 : 0,
        column === 1 ? 1 : 0,
        column === 2 ? 1 : 0,
        column === 3 ? 1 : 0,
      );
    });
    for (let i = 0; i < maxSources; i++) {
      const base = i * 16;
      this.matrices[base] = 1;
      this.matrices[base + 5] = 1;
      this.matrices[base + 10] = 1;
      this.matrices[base + 15] = 1;
    }
    this.node = uniformArray(this.columns, 'vec4');
  }

  /** Writes source `id`'s world matrix (column-major columns copied verbatim). */
  set(id: number, matrix: THREE.Matrix4): void {
    const e = matrix.elements;
    const base = id * 4;
    for (let c = 0; c < 4; c++) {
      (this.columns[base + c] as THREE.Vector4).set(
        e[c * 4 + 0] as number,
        e[c * 4 + 1] as number,
        e[c * 4 + 2] as number,
        e[c * 4 + 3] as number,
      );
      this.matrices[id * 16 + c * 4 + 0] = e[c * 4 + 0] as number;
      this.matrices[id * 16 + c * 4 + 1] = e[c * 4 + 1] as number;
      this.matrices[id * 16 + c * 4 + 2] = e[c * 4 + 2] as number;
      this.matrices[id * 16 + c * 4 + 3] = e[c * 4 + 3] as number;
    }
  }
}

/** A source's local bounding sphere plus its world matrix, for pool bounds. */
export interface SourceBounds {
  readonly center: THREE.Vector3;
  readonly radius: number;
  readonly matrix: THREE.Matrix4;
}

/**
 * The world-space bounding sphere enclosing every source, for the sorter's
 * depth quantization range. Each source sphere is transformed by its matrix
 * (radius scaled by a conservative maximum linear stretch) and the results
 * unioned.
 */
export function worldBoundsOf(sources: readonly SourceBounds[], out: THREE.Sphere): THREE.Sphere {
  out.makeEmpty();
  const worldCenter = new THREE.Vector3();
  const child = new THREE.Sphere();
  for (const source of sources) {
    worldCenter.copy(source.center).applyMatrix4(source.matrix);
    child.set(worldCenter, source.radius * matrixMaxStretch(source.matrix));
    out.union(child);
  }
  return out;
}

/**
 * A safe upper bound on the largest singular value of a matrix's linear part.
 *
 * This is `sqrt(||AᵀA||∞)`: exact for rotation + per-axis scale, and still
 * conservative when hierarchy composition introduces shear. The latter is
 * essential because a maximum column length can under-bound a sheared sphere.
 */
function matrixMaxStretch(m: THREE.Matrix4): number {
  const e = m.elements;
  const x0 = e[0],
    y0 = e[1],
    z0 = e[2];
  const x1 = e[4],
    y1 = e[5],
    z1 = e[6];
  const x2 = e[8],
    y2 = e[9],
    z2 = e[10];
  const g00 = x0 * x0 + y0 * y0 + z0 * z0;
  const g11 = x1 * x1 + y1 * y1 + z1 * z1;
  const g22 = x2 * x2 + y2 * y2 + z2 * z2;
  const g01 = x0 * x1 + y0 * y1 + z0 * z1;
  const g02 = x0 * x2 + y0 * y2 + z0 * z2;
  const g12 = x1 * x2 + y1 * y2 + z1 * z2;
  return Math.sqrt(
    Math.max(
      g00 + Math.abs(g01) + Math.abs(g02),
      g11 + Math.abs(g01) + Math.abs(g12),
      g22 + Math.abs(g02) + Math.abs(g12),
    ),
  );
}
