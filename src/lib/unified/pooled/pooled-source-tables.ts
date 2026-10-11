/**
 * Per-source shader tables for the pooled draw, packed into two uniform arrays.
 *
 * On WebGL2 three emits every `uniformArray` as its own std140 uniform block,
 * and a vertex stage may bind as few as 12 blocks (the WebGL2 minimum). One
 * array per per-source quantity (matrix, opacity, LOD alpha, SH range, …)
 * spent five of them before any host effect; these tables use two, and size
 * them to the live source count rather than the configured maximum.
 */
import * as THREE from 'three/webgpu';
import { uniformArray } from 'three/tsl';

/** vec4 rows per source in {@link PooledSourceTables.dataNode}. */
export const SOURCE_DATA_ROWS = 7;
/** Row: x = display opacity, y = stored-alpha multiplier (2 for `.rad`). */
export const ROW_PARAMS = 0;
/** Rows: packed-SH dequantization range (xyz). */
export const ROW_SH_MIN = 1;
export const ROW_SH_MAX = 2;
/** Row: camera position in the source's local frame (xyz). */
export const ROW_CAMERA_LOCAL = 3;
/** Rows: columns of the inverse of the source's linear (3×3) placement. */
export const ROW_INVERSE_LINEAR = 4;

const MIN_CAPACITY = 2;
const _linear = new THREE.Matrix3();

export class PooledSourceTables {
  /** Four vec4 columns per source world matrix (three's column-major order). */
  readonly columnsNode: ReturnType<typeof uniformArray>;
  /** {@link SOURCE_DATA_ROWS} vec4 rows per source. */
  readonly dataNode: ReturnType<typeof uniformArray>;
  /** CPU copy of the world matrices, read by the sort worker. */
  readonly matrices: Float32Array;
  private readonly columns: THREE.Vector4[];
  private readonly data: THREE.Vector4[];

  constructor(readonly capacity: number) {
    this.matrices = new Float32Array(16 * capacity);
    this.columns = Array.from({ length: 4 * capacity }, () => new THREE.Vector4());
    this.data = Array.from({ length: SOURCE_DATA_ROWS * capacity }, () => new THREE.Vector4());
    for (let id = 0; id < capacity; id++) this.setMatrix(id, new THREE.Matrix4());
    this.columnsNode = uniformArray(this.columns, 'vec4');
    this.dataNode = uniformArray(this.data, 'vec4');
  }

  /** Smallest power-of-two capacity holding source ids `0 … count-1`. */
  static capacityFor(count: number, max: number): number {
    let capacity = MIN_CAPACITY;
    while (capacity < count) capacity *= 2;
    return Math.min(capacity, max);
  }

  /** A larger table carrying every row of `previous`. */
  static grownFrom(previous: PooledSourceTables, capacity: number): PooledSourceTables {
    const next = new PooledSourceTables(capacity);
    next.matrices.set(previous.matrices);
    for (let i = 0; i < previous.columns.length; i++) {
      (next.columns[i] as THREE.Vector4).copy(previous.columns[i] as THREE.Vector4);
    }
    for (let i = 0; i < previous.data.length; i++) {
      (next.data[i] as THREE.Vector4).copy(previous.data[i] as THREE.Vector4);
    }
    return next;
  }

  setMatrix(id: number, matrix: THREE.Matrix4): void {
    const e = matrix.elements;
    this.matrices.set(e, id * 16);
    for (let c = 0; c < 4; c++) (this.columns[id * 4 + c] as THREE.Vector4).fromArray(e, c * 4);
    // A singular placement (a source scaled to zero) has no inverse; keep the
    // previous rows rather than writing NaN into every frame remap.
    _linear.setFromMatrix4(matrix);
    if (Math.abs(_linear.determinant()) < 1e-20) return;
    _linear.invert();
    const m = _linear.elements;
    for (let c = 0; c < 3; c++) {
      this.row(id, ROW_INVERSE_LINEAR + c).set(m[c * 3]!, m[c * 3 + 1]!, m[c * 3 + 2]!, 0);
    }
  }

  setParams(id: number, opacity: number, alphaScale: number): void {
    this.row(id, ROW_PARAMS).set(opacity, alphaScale, 0, 0);
  }

  setOpacity(id: number, opacity: number): void {
    this.row(id, ROW_PARAMS).x = opacity;
  }

  setShRange(id: number, min: THREE.Vector3 | null, max: THREE.Vector3 | null): void {
    const lo = this.row(id, ROW_SH_MIN);
    const hi = this.row(id, ROW_SH_MAX);
    if (min && max) {
      lo.set(min.x, min.y, min.z, 0);
      hi.set(max.x, max.y, max.z, 0);
    } else {
      lo.set(0, 0, 0, 0);
      hi.set(0, 0, 0, 0);
    }
  }

  /** Writes the camera position in source `id`'s local frame. */
  setCameraLocal(id: number, worldCamera: THREE.Vector3, sourceWorld: THREE.Matrix4): void {
    _camera.copy(worldCamera).applyMatrix4(_inverse.copy(sourceWorld).invert());
    if (!Number.isFinite(_camera.x)) return;
    this.row(id, ROW_CAMERA_LOCAL).set(_camera.x, _camera.y, _camera.z, 0);
  }

  /** Current camera-local rows, so a secondary view can restore them. */
  snapshotCameraLocal(): Float32Array {
    const out = new Float32Array(this.capacity * 3);
    for (let id = 0; id < this.capacity; id++) {
      const row = this.row(id, ROW_CAMERA_LOCAL);
      out.set([row.x, row.y, row.z], id * 3);
    }
    return out;
  }

  restoreCameraLocal(snapshot: Float32Array): void {
    for (let id = 0; id < this.capacity; id++) {
      this.row(id, ROW_CAMERA_LOCAL).set(
        snapshot[id * 3]!,
        snapshot[id * 3 + 1]!,
        snapshot[id * 3 + 2]!,
        0,
      );
    }
  }

  private row(id: number, row: number): THREE.Vector4 {
    return this.data[id * SOURCE_DATA_ROWS + row] as THREE.Vector4;
  }
}

const _camera = new THREE.Vector3();
const _inverse = new THREE.Matrix4();
