import type { SplatDataFormat } from './loading';

/**
 * CPU-side representation of a set of 3D Gaussians, ready for GPU upload.
 *
 * Everything is stored in flat typed arrays (struct-of-arrays) so the data
 * can be copied straight into textures and transferred to workers.
 */
export interface SplatData {
  /** Number of Gaussians. */
  readonly count: number;
  /** Gaussian centers, 3 floats (x, y, z) per splat. */
  readonly positions: Float32Array;
  /** Base color + opacity, 4 bytes (r, g, b, a) per splat. */
  readonly colors: Uint8Array;
  /**
   * 3D covariance matrices, 6 floats per splat: the upper triangle
   * (m00, m01, m02, m11, m12, m22) of the symmetric 3×3 matrix
   * Σ = R·S·Sᵀ·Rᵀ, precomputed from the per-splat scale and rotation.
   */
  readonly covariances: Float32Array;
  /** Higher-order spherical harmonics (view-dependent color), if present. */
  readonly sh?: SplatShData;
  /**
   * Per-splat (rather than palette-compressed) higher-order SH, as LCC `Quality`
   * delivers it. Unlike {@link sh}, this survives being appended into a
   * shared pool, because there is no per-file palette to merge.
   */
  readonly shPacked?: SplatPackedShData;
  /**
   * Scene was trained/exported with antialiasing (e.g. the SOG `antialias`
   * meta flag). When true, {@link SplatMesh} applies the Mip-Splatting 2D
   * filter (dilation + opacity compensation). Absent/false = classic 3DGS.
   */
  readonly antialias?: boolean;
  /**
   * Per-splat LOD-tree links for a streamed `.rad` chunk (the merged coarse
   * nodes and leaves are all present in {@link positions} etc.). The streamed
   * reader uses this to pick the rendered cut across chunks; other formats and
   * the whole-file path leave it undefined. See `parse-rad.ts` and `rad.ts`.
   */
  readonly radTree?: RadTreeData;
  /**
   * Per-splat parent LOD-node size for the frontier cut (`foveationMode:
   * 'frontier'`), sign-encoding leaf-ness: `> 0` internal node, `< 0` leaf,
   * `|value|` is the parent's world size (a large sentinel ≈ ∞ for a root or a
   * splat whose parent is not yet decoded). Attached by `RadFoveatedSource` as
   * chunks stream in; uploaded into `covarianceB.w`. See `docs/formats/rad-notes.md`.
   */
  readonly frontierParent?: Float32Array;
  /** Internal RAD SH codebook retained while a streamed `.rad` scene is set
   * up. It is passed back to later chunk decodes; consumers can ignore it. */
  readonly radShCodebook?: RadShCodebook;
  /**
   * The self-contained format this scene was decoded from, stamped by the
   * loaders ({@link loadSplatData}/{@link loadSplatDataFile}). {@link SplatMesh} reads
   * it to pick the `orientation: 'y-up'` correction. Absent on hand-built data
   * and streamed chunks, in which case no orientation is ever inferred.
   */
  readonly format?: SplatDataFormat;
}

/** Palette emitted once in chunk zero by Spark's clustered RAD SH encoding. */
export interface RadShCodebook {
  readonly bands: 1 | 2 | 3;
  /** RGB triples, coefficient-major and codebook-entry-major. */
  readonly coefficients: Float32Array;
  readonly count: number;
}

/** Per-splat LOD-tree links carried on a streamed `.rad` chunk's `SplatData`. */
export interface RadTreeData {
  /** Number of children of splat `i`; 0 marks a leaf. */
  readonly childCount: Uint16Array;
  /** Global index of splat `i`'s first child; its children are the contiguous
   * range `[childStart, childStart + childCount)`. */
  readonly childStart: Uint32Array;
  /**
   * LOD node size (world units) of splat `i` - Spark's `2·expansion·avg(scale)`,
   * the radius the runtime cut projects to a screen size. Drives foveation
   * (see `docs/formats/rad-notes.md` M14.6): `pixel_scale = size / distance`.
   */
  readonly size: Float32Array;
}

/**
 * Palette-compressed higher-order SH coefficients, as in the SOG format:
 * each splat references one of up to 65,536 palette entries (its "label"),
 * and each entry holds the coefficients for all three color channels.
 */
export interface SplatShData {
  /** SH bands beyond the DC term: 1, 2 or 3 → 3, 8 or 15 coefficients. */
  readonly bands: number;
  /** Per-splat palette index, `count` entries. */
  readonly labels: Uint32Array;
  /**
   * Dequantized palette coefficients as an RGBA float image in the SOG
   * centroids layout: palette entry n, coefficient c lives at column
   * (n % 64) · coefficientCount + c, row ⌊n / 64⌋; the R, G, B channels
   * hold that coefficient for the red, green and blue SH respectively.
   * Uploadable directly as an RGBA32F texture.
   */
  readonly palette: Float32Array;
  readonly paletteWidth: number;
  readonly paletteHeight: number;
}

/**
 * Per-splat higher-order SH coefficients, still in their source packing:
 * one `uint32` per coefficient holding all three channels (R: bits 0-10,
 * G: bits 11-20, B: bits 21-31), dequantized across {@link range}.
 *
 * The words are kept packed all the way to the GPU - the shader unpacks them.
 * Expanding to floats would cost 45 floats per splat (~1.15 GB over a 6M-splat
 * pool) where the packed form costs 64 bytes (~384 MB) and is lossless.
 */
export interface SplatPackedShData {
  /** SH bands beyond the DC term: 1, 2 or 3 → 3, 8 or 15 coefficients. */
  readonly bands: 1 | 2 | 3;
  /** `count * coefficients` words, splat-major. */
  readonly packed: Uint32Array;
  /** Per-channel dequantization range shared by every coefficient. */
  readonly range: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
}

/** First-order spherical harmonics constant: Y₀₀ = 1 / (2√π). */
export const SH_C0 = 0.28209479177387814;

/**
 * Folds a splat's linear scale and rotation quaternion into the upper
 * triangle of its 3D covariance matrix Σ = R·S·Sᵀ·Rᵀ (the 3DGS paper's
 * parameterization), written to `out` at `index * 6`.
 *
 * The quaternion (w, x, y, z) does not need to be normalized.
 */
export function writeCovariance(
  out: Float32Array,
  index: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  qw: number,
  qx: number,
  qy: number,
  qz: number,
): void {
  const qLength = Math.hypot(qw, qx, qy, qz) || 1;
  const w = qw / qLength;
  const x = qx / qLength;
  const y = qy / qLength;
  const z = qz / qLength;

  // M = R·S (rotation matrix from the quaternion, columns scaled).
  const m00 = (1 - 2 * (y * y + z * z)) * scaleX;
  const m01 = 2 * (x * y - w * z) * scaleY;
  const m02 = 2 * (x * z + w * y) * scaleZ;
  const m10 = 2 * (x * y + w * z) * scaleX;
  const m11 = (1 - 2 * (x * x + z * z)) * scaleY;
  const m12 = 2 * (y * z - w * x) * scaleZ;
  const m20 = 2 * (x * z - w * y) * scaleX;
  const m21 = 2 * (y * z + w * x) * scaleY;
  const m22 = (1 - 2 * (x * x + y * y)) * scaleZ;

  // Σ = M·Mᵀ is symmetric; store its upper triangle.
  out[index * 6 + 0] = m00 * m00 + m01 * m01 + m02 * m02;
  out[index * 6 + 1] = m00 * m10 + m01 * m11 + m02 * m12;
  out[index * 6 + 2] = m00 * m20 + m01 * m21 + m02 * m22;
  out[index * 6 + 3] = m10 * m10 + m11 * m11 + m12 * m12;
  out[index * 6 + 4] = m10 * m20 + m11 * m21 + m12 * m22;
  out[index * 6 + 5] = m20 * m20 + m21 * m21 + m22 * m22;
}

/**
 * Transforms an existing covariance Σ (upper triangle `m00,m01,m02,m11,m12,m22`)
 * by the 3×3 linear part `A` of a world matrix, writing Σ' = A·Σ·Aᵀ back as an
 * upper triangle. This is how a Gaussian's shape maps into a parent frame when a
 * splat cloud is placed with a world transform - the rotation/scale portion of
 * that transform (translation does not affect covariance) applied to the shape.
 *
 * Unlike {@link writeCovariance}, which *builds* Σ from a splat's scale and
 * rotation, this operates on an already-folded Σ. Non-uniform scale and shear in
 * `A` are handled exactly (the result is still a valid symmetric covariance).
 *
 * `a` is the linear part in **column-major** order - the first 9 elements of a
 * {@link https://threejs.org/docs/#api/en/math/Matrix4 | THREE.Matrix4}'s
 * `elements` layout for a matrix with no projective row, i.e.
 * `[a00, a10, a20, a01, a11, a21, a02, a12, a22]`. Reading `Matrix4.elements`
 * directly (ignoring the translation column and bottom row) yields exactly this.
 */
export function transformCovariance(
  out: Float32Array,
  outIndex: number,
  cov: Float32Array,
  covIndex: number,
  a: ArrayLike<number>,
): void {
  // A, column-major: a[col*4 ... ] would be Matrix4; here we take the linear 3×3
  // as elements[0..2] = column 0, [3..5] would skip - but Matrix4 stores a 4×4,
  // so callers pass the compacted 9-element linear part described above.
  const a00 = a[0] as number;
  const a10 = a[1] as number;
  const a20 = a[2] as number;
  const a01 = a[3] as number;
  const a11 = a[4] as number;
  const a21 = a[5] as number;
  const a02 = a[6] as number;
  const a12 = a[7] as number;
  const a22 = a[8] as number;

  // Σ (symmetric) from the upper triangle.
  const s00 = cov[covIndex * 6 + 0] as number;
  const s01 = cov[covIndex * 6 + 1] as number;
  const s02 = cov[covIndex * 6 + 2] as number;
  const s11 = cov[covIndex * 6 + 3] as number;
  const s12 = cov[covIndex * 6 + 4] as number;
  const s22 = cov[covIndex * 6 + 5] as number;

  // T = A·Σ (3×3). Rows of A dotted with columns of the symmetric Σ.
  const t00 = a00 * s00 + a01 * s01 + a02 * s02;
  const t01 = a00 * s01 + a01 * s11 + a02 * s12;
  const t02 = a00 * s02 + a01 * s12 + a02 * s22;
  const t10 = a10 * s00 + a11 * s01 + a12 * s02;
  const t11 = a10 * s01 + a11 * s11 + a12 * s12;
  const t12 = a10 * s02 + a11 * s12 + a12 * s22;
  const t20 = a20 * s00 + a21 * s01 + a22 * s02;
  const t21 = a20 * s01 + a21 * s11 + a22 * s12;
  const t22 = a20 * s02 + a21 * s12 + a22 * s22;

  // Σ' = T·Aᵀ; store the upper triangle (Σ' is symmetric).
  out[outIndex * 6 + 0] = t00 * a00 + t01 * a01 + t02 * a02;
  out[outIndex * 6 + 1] = t00 * a10 + t01 * a11 + t02 * a12;
  out[outIndex * 6 + 2] = t00 * a20 + t01 * a21 + t02 * a22;
  out[outIndex * 6 + 3] = t10 * a10 + t11 * a11 + t12 * a12;
  out[outIndex * 6 + 4] = t10 * a20 + t11 * a21 + t12 * a22;
  out[outIndex * 6 + 5] = t20 * a20 + t21 * a21 + t22 * a22;
}
