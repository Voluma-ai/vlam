import type * as THREE from 'three/webgpu';
import type { SplatData } from '../lib/core';
import { createSelectionVolume, type SelectionVolumeOptions } from '../lib/selection';
import type { TriangleMeshData } from '../lib/formats/lcc';

/**
 * Prototype volume estimation for a selection inside a splat cloud
 * (`?separate=1` demo). Research background, error model, and the promotion
 * path to the library: the implementation and its tests.
 *
 * A gaussian splat capture is a hollow shell - 3DGS reconstructs surfaces, so
 * "how much matter is inside the selection" is not present in the data and has
 * to be inferred by closing that shell. This module does the inference on a
 * voxel grid: mark occupancy from splat centers (and collision triangles when
 * the host has them - thinner, cleaner shells), flood-fill air inward from the
 * selection boundary, and count what the fill cannot reach as interior. The
 * result is a *range* (`massLower`…`massUpper`) plus a leak flag, never one
 * false-precision number.
 *
 * Kept DOM-free and pure so the vitest node environment can test the estimate
 * quantitatively against analytic shapes (same pattern as `separation-state.ts`).
 */

/**
 * The exact volume of a placed selection shape (matter and air alike): the
 * unit-shape volume scaled by the placement transform's determinant. This is
 * the one notion of "selection volume" that is analytic and error-free.
 */
export function analyticSelectionVolume(options: SelectionVolumeOptions): number {
  let unit: number;
  switch (options.kind) {
    case 'box': {
      const he = options.halfExtents as readonly [number, number, number];
      unit = 8 * he[0] * he[1] * he[2];
      break;
    }
    case 'sphere':
      unit = (4 / 3) * Math.PI * (options.radius as number) ** 3;
      break;
    case 'cylinder':
      unit = Math.PI * (options.radius as number) ** 2 * (options.height as number);
      break;
  }
  return unit * Math.abs(options.transform ? options.transform.determinant() : 1);
}

/** The result of {@link estimateSelectionVolume}. All volumes are in world units³. */
export interface VolumeEstimate {
  /** Analytic volume of the selection shape itself (exact). */
  readonly shapeVolume: number;
  /** Volume of voxels occupied by surface (splats and/or collision triangles). */
  readonly shellVolume: number;
  /** Volume the boundary flood-fill could not reach: enclosed space. */
  readonly interiorVolume: number;
  /** Lower bound on the matter volume (interior only). */
  readonly massLower: number;
  /** Upper bound on the matter volume (interior + the whole shell). */
  readonly massUpper: number;
  /**
   * True when surface exists but essentially everything was reachable from the
   * boundary - the shell does not close inside this selection (holes, an open
   * side, or a genuinely thin surface), so `massLower` is not meaningful.
   */
  readonly leaked: boolean;
  /** Cube-root-equivalent edge length of one voxel's world-space volume. */
  readonly voxelSize: number;
}

export interface VolumeEstimateOptions {
  /** Max voxels along the selection AABB's longest axis. Default 96. */
  resolution?: number;
  /**
   * Splats with alpha below this (0–1) are ignored - floaters and haze would
   * otherwise read as phantom surface. Default 0.35.
   */
  opacityThreshold?: number;
  /**
   * Voxels of morphological closing applied to the shell before the flood
   * fill, sealing pinholes up to `2·closingRadius` voxels wide at the cost of
   * over-closing narrow real gaps. Default 1; 0 disables.
   */
  closingRadius?: number;
  /**
   * Collision triangle meshes in the same frame as `data.positions`. Where
   * present they contribute a thin, floater-free shell that closes far better
   * than the splats alone.
   */
  collision?: readonly TriangleMeshData[];
}

/** Voxel states in the occupancy grid. */
const EMPTY = 0;
const SHELL = 1;
const AIR = 2;
const OUTSIDE = 3; // voxel center is not inside the selection shape
const CLOSED = 4; // synthetic shell from closing (fill barrier, uncertain matter)

/**
 * Estimates how much of a selection is matter versus air.
 *
 * `options`/`worldMatrix` are the same values a host passes to
 * `createSelectionVolume` - the analytic shape description is required (rather
 * than a bare `SelectionVolume`) because the estimator needs the shape's AABB
 * and exact volume.
 *
 * Cost is O(count + resolution³ + triangles·samples); intended for an explicit
 * user action, not a per-frame or per-input-event call.
 */
export function estimateSelectionVolume(
  data: SplatData,
  options: SelectionVolumeOptions,
  worldMatrix: THREE.Matrix4 | undefined,
  opts: VolumeEstimateOptions = {},
): VolumeEstimate {
  const resolution = Math.max(8, Math.floor(opts.resolution ?? 96));
  const opacityThreshold = opts.opacityThreshold ?? 0.35;
  const closingRadius = Math.max(0, Math.floor(opts.closingRadius ?? 1));
  const volume = createSelectionVolume(options, worldMatrix);
  const shapeVolume = analyticSelectionVolume(options);

  // --- Grid over the placed shape's AABB, in the positions' own frame -------
  // The AABB comes from the shape's local corners through transform, then into
  // the positions' frame through worldMatrix⁻¹ - conservative (an AABB of an
  // AABB) but only costs some OUTSIDE voxels, which the shape test discards.
  const aabb = selectionAabb(options, worldMatrix);
  const spanX = aabb.maxX - aabb.minX;
  const spanY = aabb.maxY - aabb.minY;
  const spanZ = aabb.maxZ - aabb.minZ;
  const longest = Math.max(spanX, spanY, spanZ);
  if (!(longest > 0) || !Number.isFinite(longest)) {
    return {
      shapeVolume,
      shellVolume: 0,
      interiorVolume: 0,
      massLower: 0,
      massUpper: 0,
      leaked: false,
      voxelSize: 0,
    };
  }
  const h = longest / resolution;
  const nx = Math.max(1, Math.ceil(spanX / h));
  const ny = Math.max(1, Math.ceil(spanY / h));
  const nz = Math.max(1, Math.ceil(spanZ / h));
  const grid = new Uint8Array(nx * ny * nz);
  const index = (ix: number, iy: number, iz: number): number => (iz * ny + iy) * nx + ix;
  const centerOf = (ix: number, iy: number, iz: number): [number, number, number] => [
    aabb.minX + (ix + 0.5) * h,
    aabb.minY + (iy + 0.5) * h,
    aabb.minZ + (iz + 0.5) * h,
  ];

  // Classify voxel centers against the exact selection shape once.
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const [x, y, z] = centerOf(ix, iy, iz);
        if (!volume.containsPoint(x, y, z)) grid[index(ix, iy, iz)] = OUTSIDE;
      }
    }
  }

  // --- Mark the shell -------------------------------------------------------
  const mark = (x: number, y: number, z: number): void => {
    const ix = Math.floor((x - aabb.minX) / h);
    const iy = Math.floor((y - aabb.minY) / h);
    const iz = Math.floor((z - aabb.minZ) / h);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return;
    const i = index(ix, iy, iz);
    if (grid[i] === EMPTY) grid[i] = SHELL;
  };

  const { positions, colors, covariances, count } = data;
  const alphaFloor = Math.round(opacityThreshold * 255);
  for (let i = 0; i < count; i++) {
    if ((colors[i * 4 + 3] as number) < alphaFloor) continue;
    const x = positions[i * 3] as number;
    const y = positions[i * 3 + 1] as number;
    const z = positions[i * 3 + 2] as number;
    mark(x, y, z);
    // A splat is not a point: dilate by its ~1σ radius (largest covariance
    // diagonal) so a shell sampled sparser than the grid still closes. Capped
    // at 2 voxels - beyond that the splat is larger than the feature size the
    // grid can represent anyway.
    const sigma = Math.sqrt(
      Math.max(
        covariances[i * 6] as number,
        covariances[i * 6 + 3] as number,
        covariances[i * 6 + 5] as number,
        0,
      ),
    );
    const reach = Math.min(2, Math.floor(sigma / h));
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          mark(x + dx * h, y + dy * h, z + dz * h);
        }
      }
    }
  }

  for (const mesh of opts.collision ?? []) {
    markTriangles(mesh, h, mark);
  }

  // --- Optional morphological closing (seals pinholes before the fill) ------
  if (closingRadius > 0) closeShell(grid, nx, ny, nz, closingRadius);

  // --- Flood-fill air from the selection boundary ---------------------------
  // Seeds: every in-shape, unmarked voxel on the grid boundary or adjacent to
  // an OUTSIDE voxel - i.e. every place air can enter the selection.
  const queue = new Int32Array(nx * ny * nz);
  let head = 0;
  let tail = 0;
  const trySeed = (ix: number, iy: number, iz: number): void => {
    const i = index(ix, iy, iz);
    if (grid[i] === EMPTY) {
      grid[i] = AIR;
      queue[tail++] = i;
    }
  };
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const onEdge =
          ix === 0 || iy === 0 || iz === 0 || ix === nx - 1 || iy === ny - 1 || iz === nz - 1;
        if (onEdge || hasOutsideNeighbor(grid, nx, ny, nz, ix, iy, iz)) trySeed(ix, iy, iz);
      }
    }
  }
  while (head < tail) {
    const i = queue[head++] as number;
    const ix = i % nx;
    const iy = Math.floor(i / nx) % ny;
    const iz = Math.floor(i / (nx * ny));
    if (ix > 0) trySeed(ix - 1, iy, iz);
    if (ix < nx - 1) trySeed(ix + 1, iy, iz);
    if (iy > 0) trySeed(ix, iy - 1, iz);
    if (iy < ny - 1) trySeed(ix, iy + 1, iz);
    if (iz > 0) trySeed(ix, iy, iz - 1);
    if (iz < nz - 1) trySeed(ix, iy, iz + 1);
  }

  // --- Count ---------------------------------------------------------------
  let shellCount = 0;
  let interiorCount = 0;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i] as number;
    if (v === OUTSIDE) continue;
    // A closed voxel was invented to bridge missing surface, so it cannot be
    // part of the confident interior lower bound. Keep it in the uncertain
    // shell instead: this preserves lower ≤ true volume ≤ upper.
    if (v === SHELL || v === CLOSED) shellCount++;
    else if (v === EMPTY) interiorCount++; // unreached = enclosed
  }
  // Grid coordinates are in the SplatData-local frame, but this API reports
  // world-space volumes. A local voxel maps through worldMatrix, scaling its
  // volume by the absolute determinant (also correct for non-uniform scale).
  const worldVolumeScale = Math.abs(worldMatrix?.determinant() ?? 1);
  const cell = h * h * h * worldVolumeScale;
  const shellVolume = shellCount * cell;
  const interiorVolume = interiorCount * cell;
  // Shell exists but encloses (almost) nothing → the surface does not close
  // inside this selection. The second clause exempts solid regions: when a
  // sizeable fraction of the selection is occupied, the "shell" IS the matter
  // (a solid fill has no enclosed emptiness to find) and the bracket is
  // meaningful - only a *thin* non-enclosing surface means the capture is open.
  const leaked =
    shellCount > 0 && interiorCount < shellCount * 0.05 && shellVolume < shapeVolume * 0.25;

  return {
    shapeVolume,
    shellVolume,
    interiorVolume,
    massLower: interiorVolume,
    massUpper: interiorVolume + shellVolume,
    leaked,
    voxelSize: Math.cbrt(cell),
  };
}

/** Axis-aligned bounds of the placed shape, in the positions' frame. */
function selectionAabb(
  options: SelectionVolumeOptions,
  worldMatrix: THREE.Matrix4 | undefined,
): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } {
  // Local extents of the unit shape.
  let ex: number;
  let ey: number;
  let ez: number;
  if (options.kind === 'box') {
    const he = options.halfExtents as readonly [number, number, number];
    [ex, ey, ez] = he;
  } else if (options.kind === 'sphere') {
    ex = ey = ez = options.radius as number;
  } else {
    ex = ez = options.radius as number;
    ey = (options.height as number) / 2;
  }
  // Corners through transform (volume-local → world), then world → positions
  // frame through worldMatrix⁻¹. Column-major 4x4 multiply, done by hand to
  // keep this module allocation-light and THREE-optional at runtime.
  const t = options.transform?.elements ?? IDENTITY;
  const wInv = worldMatrix ? invertRigidOrAffine(worldMatrix.elements) : IDENTITY;
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
  for (let corner = 0; corner < 8; corner++) {
    const lx = corner & 1 ? ex : -ex;
    const ly = corner & 2 ? ey : -ey;
    const lz = corner & 4 ? ez : -ez;
    // world = T · local
    const wx =
      (t[0] as number) * lx + (t[4] as number) * ly + (t[8] as number) * lz + (t[12] as number);
    const wy =
      (t[1] as number) * lx + (t[5] as number) * ly + (t[9] as number) * lz + (t[13] as number);
    const wz =
      (t[2] as number) * lx + (t[6] as number) * ly + (t[10] as number) * lz + (t[14] as number);
    // positions frame = W⁻¹ · world
    const px =
      (wInv[0] as number) * wx +
      (wInv[4] as number) * wy +
      (wInv[8] as number) * wz +
      (wInv[12] as number);
    const py =
      (wInv[1] as number) * wx +
      (wInv[5] as number) * wy +
      (wInv[9] as number) * wz +
      (wInv[13] as number);
    const pz =
      (wInv[2] as number) * wx +
      (wInv[6] as number) * wy +
      (wInv[10] as number) * wz +
      (wInv[14] as number);
    bounds.minX = Math.min(bounds.minX, px);
    bounds.minY = Math.min(bounds.minY, py);
    bounds.minZ = Math.min(bounds.minZ, pz);
    bounds.maxX = Math.max(bounds.maxX, px);
    bounds.maxY = Math.max(bounds.maxY, py);
    bounds.maxZ = Math.max(bounds.maxZ, pz);
  }
  return bounds;
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * General 4×4 affine inverse (column-major, bottom row assumed 0,0,0,1) via
 * the 3×3 adjugate. `createSelectionVolume` has already rejected singular
 * matrices upstream, so the determinant is nonzero here.
 */
function invertRigidOrAffine(e: ArrayLike<number>): number[] {
  const a00 = e[0] as number,
    a10 = e[1] as number,
    a20 = e[2] as number,
    a01 = e[4] as number,
    a11 = e[5] as number,
    a21 = e[6] as number,
    a02 = e[8] as number,
    a12 = e[9] as number,
    a22 = e[10] as number,
    tx = e[12] as number,
    ty = e[13] as number,
    tz = e[14] as number;
  const b00 = a11 * a22 - a12 * a21;
  const b01 = a02 * a21 - a01 * a22;
  const b02 = a01 * a12 - a02 * a11;
  const det = a00 * b00 + a10 * b01 + a20 * b02;
  const inv = 1 / det;
  const m00 = b00 * inv;
  const m01 = b01 * inv;
  const m02 = b02 * inv;
  const m10 = (a12 * a20 - a10 * a22) * inv;
  const m11 = (a00 * a22 - a02 * a20) * inv;
  const m12 = (a02 * a10 - a00 * a12) * inv;
  const m20 = (a10 * a21 - a11 * a20) * inv;
  const m21 = (a01 * a20 - a00 * a21) * inv;
  const m22 = (a00 * a11 - a01 * a10) * inv;
  return [
    m00,
    m10,
    m20,
    0,
    m01,
    m11,
    m21,
    0,
    m02,
    m12,
    m22,
    0,
    -(m00 * tx + m01 * ty + m02 * tz),
    -(m10 * tx + m11 * ty + m12 * tz),
    -(m20 * tx + m21 * ty + m22 * tz),
    1,
  ];
}

/** Samples every triangle at ~half-voxel spacing and marks the touched voxels. */
function markTriangles(
  mesh: TriangleMeshData,
  h: number,
  mark: (x: number, y: number, z: number) => void,
): void {
  const { positions, indices, triangleCount } = mesh;
  const step = h / 2;
  for (let t = 0; t < triangleCount; t++) {
    const a = (indices[t * 3] as number) * 3;
    const b = (indices[t * 3 + 1] as number) * 3;
    const c = (indices[t * 3 + 2] as number) * 3;
    const ax = positions[a] as number;
    const ay = positions[a + 1] as number;
    const az = positions[a + 2] as number;
    const abx = (positions[b] as number) - ax;
    const aby = (positions[b + 1] as number) - ay;
    const abz = (positions[b + 2] as number) - az;
    const acx = (positions[c] as number) - ax;
    const acy = (positions[c + 1] as number) - ay;
    const acz = (positions[c + 2] as number) - az;
    const lenAb = Math.hypot(abx, aby, abz);
    const lenAc = Math.hypot(acx, acy, acz);
    const nu = Math.max(1, Math.ceil(lenAb / step));
    const nv = Math.max(1, Math.ceil(lenAc / step));
    for (let iu = 0; iu <= nu; iu++) {
      const u = iu / nu;
      for (let iv = 0; iv <= nv; iv++) {
        const v = (iv / nv) * (1 - u); // stay inside the triangle (u + v ≤ 1)
        mark(ax + abx * u + acx * v, ay + aby * u + acy * v, az + abz * u + acz * v);
      }
    }
  }
}

/** True when any 6-neighbor of the voxel is OUTSIDE the selection shape. */
function hasOutsideNeighbor(
  grid: Uint8Array,
  nx: number,
  ny: number,
  nz: number,
  ix: number,
  iy: number,
  iz: number,
): boolean {
  const at = (x: number, y: number, z: number): number => grid[(z * ny + y) * nx + x] as number;
  return (
    (ix > 0 && at(ix - 1, iy, iz) === OUTSIDE) ||
    (ix < nx - 1 && at(ix + 1, iy, iz) === OUTSIDE) ||
    (iy > 0 && at(ix, iy - 1, iz) === OUTSIDE) ||
    (iy < ny - 1 && at(ix, iy + 1, iz) === OUTSIDE) ||
    (iz > 0 && at(ix, iy, iz - 1) === OUTSIDE) ||
    (iz < nz - 1 && at(ix, iy, iz + 1) === OUTSIDE)
  );
}

/**
 * Morphological closing of the shell: dilate by `radius`, then erode by
 * `radius`, so pinholes up to ~2·radius voxels seal while the shell's outer
 * extent is restored. Voxels sealed by closing become CLOSED - they block the
 * flood fill (that is the point) and remain part of the uncertain shell, not
 * the confident interior lower bound.
 */
function closeShell(grid: Uint8Array, nx: number, ny: number, nz: number, radius: number): void {
  const size = nx * ny * nz;
  let current: Uint8Array = new Uint8Array(size);
  for (let i = 0; i < size; i++) current[i] = grid[i] === SHELL ? 1 : 0;

  const pass = (src: Uint8Array, dilate: boolean): Uint8Array => {
    const out = new Uint8Array(size);
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const i = (iz * ny + iy) * nx + ix;
          const self = src[i] === 1;
          const anyNeighbor =
            (ix > 0 && src[i - 1] === 1) ||
            (ix < nx - 1 && src[i + 1] === 1) ||
            (iy > 0 && src[i - nx] === 1) ||
            (iy < ny - 1 && src[i + nx] === 1) ||
            (iz > 0 && src[i - nx * ny] === 1) ||
            (iz < nz - 1 && src[i + nx * ny] === 1);
          const allNeighbors =
            (ix === 0 || src[i - 1] === 1) &&
            (ix === nx - 1 || src[i + 1] === 1) &&
            (iy === 0 || src[i - nx] === 1) &&
            (iy === ny - 1 || src[i + nx] === 1) &&
            (iz === 0 || src[i - nx * ny] === 1) &&
            (iz === nz - 1 || src[i + nx * ny] === 1);
          out[i] = dilate ? (self || anyNeighbor ? 1 : 0) : self && allNeighbors ? 1 : 0;
        }
      }
    }
    return out;
  };

  for (let r = 0; r < radius; r++) current = pass(current, true);
  for (let r = 0; r < radius; r++) current = pass(current, false);

  for (let i = 0; i < size; i++) {
    if (current[i] === 1 && grid[i] === EMPTY) grid[i] = CLOSED;
  }
}
