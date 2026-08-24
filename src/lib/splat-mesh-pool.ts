/**
 * Texture-pool primitives behind `SplatMesh`.
 *
 * Splat attributes live in pool data textures, a fixed number of texels wide,
 * and every range the mesh hands out is a whole number of rows in them. This
 * module holds the parts of that scheme with no dependency on the mesh's own
 * state: creating the textures, measuring the backend's limits, and the row-span
 * bookkeeping the allocator runs on.
 *
 * {@link SplatPool} is public - a host builds one to let several meshes draw
 * from a shared memory envelope. The rest is internal.
 */
import * as THREE from 'three/webgpu';

/**
 * Texels per row in every pool data texture.
 *
 * A range is row-aligned, so this also sets the allocation granularity: a
 * 10-splat chunk still occupies a whole 2048-texel row. Wider rows waste more
 * on small chunks; narrower rows need more rows than a backend may allow.
 */
export const SPLAT_DATA_TEXTURE_WIDTH = 2048;

/** A free span of rows in the pool, as a row index and a row count. */
export interface RowSpan {
  start: number;
  count: number;
}

/**
 * Takes `rowCount` contiguous rows out of `spans`, best-fit.
 *
 * Best-fit rather than first-fit: a chunk pool churns ranges of very different
 * sizes, and spending the smallest span that fits keeps the large ones intact
 * for the large chunks that have nowhere else to go.
 *
 * Mutates `spans` in place. Throws when nothing contiguous is left, which is
 * the caller's cue to compact.
 *
 * @param poolRows - Total rows in the pool; named in the failure only.
 * @returns The starting row of the allocated span.
 */
export function allocateRowSpan(spans: RowSpan[], rowCount: number, poolRows: number): number {
  let bestIndex = -1;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i] as RowSpan;
    if (span.count < rowCount) continue;
    if (bestIndex === -1 || span.count < (spans[bestIndex] as RowSpan).count) {
      bestIndex = i;
    }
    if (span.count === rowCount) break;
  }
  if (bestIndex !== -1) {
    const span = spans[bestIndex] as RowSpan;
    const start = span.start;
    span.start += rowCount;
    span.count -= rowCount;
    if (span.count === 0) spans.splice(bestIndex, 1);
    return start;
  }
  throw new Error(
    `SplatMesh capacity exceeded: no contiguous space for ${rowCount} rows ` +
      `(${SPLAT_DATA_TEXTURE_WIDTH} splats each) in a ${poolRows}-row pool.`,
  );
}

/**
 * Returns a span to the free list, coalescing it with any neighbours.
 *
 * Merging on release is what keeps {@link allocateRowSpan} able to satisfy a
 * large request after many small ranges have come and gone; without it the
 * free list fragments into unusable slivers.
 *
 * @returns The new free list, sorted by start row.
 */
export function releaseRowSpan(spans: RowSpan[], start: number, count: number): RowSpan[] {
  spans.push({ start, count });
  spans.sort((a, b) => a.start - b.start);
  const merged: RowSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && last.start + last.count > span.start) {
      // Overlapping free spans mean a double (or overlapping) release - left
      // silent, the same rows would be handed out twice by allocateRowSpan.
      throw new Error(
        `SplatMesh pool released rows [${start}, ${start + count}) overlap an already-free span.`,
      );
    }
    if (last && last.start + last.count === span.start) last.count += span.count;
    else merged.push(span);
  }
  return merged;
}

/** CPU-side mirror of the pool textures, kept for partial uploads. */
export interface SplatPoolBacking {
  centers: Float32Array;
  colors: Uint8Array;
  covarianceA: Float32Array;
  covarianceB: Float32Array;
  /** Per-splat packed SH; texture t holds coefficients 4t..4t+3. */
  shPacked: Uint32Array[];
}

/** A tenant's allocation in the pool, as a row index and a row count. */
export interface SplatPoolRange {
  startRow: number;
  rowCount: number;
}

/**
 * A mesh that draws from a {@link SplatPool}.
 *
 * Only compaction needs this: packing the pool relocates rows belonging to
 * every tenant, so each must be able to enumerate its ranges, follow them to
 * their new rows, and rebuild whatever it keyed by pool index.
 */
export interface SplatPoolTenant {
  /** The tenant's current allocations. */
  poolRanges(): Iterable<SplatPoolRange>;
  /**
   * Adopts a new start row for one of this tenant's ranges. The pool has
   * already moved the splat data; the tenant moves anything else keyed by pool
   * row (per-splat channels) and records that those rows need re-uploading.
   */
  relocatePoolRange(range: SplatPoolRange, targetRow: number): void;
  /** Called once after a compaction, so the tenant can rebuild draw state. */
  onPoolCompacted(): void;
}

/** Options for {@link SplatPool}. */
export interface SplatPoolOptions {
  /** Splats the pool must hold; rounded up to whole rows. */
  capacity: number;
  /**
   * Texture precision for centers and covarianceA. `'float16'` halves their
   * VRAM; covarianceB stays float32 either way because it packs integer IDs
   * (SOG palette label, `.rad` frontier parent) that halves cannot represent
   * exactly above 2048.
   */
  floatTextures?: 'float32' | 'float16';
  /** Bands of per-splat (non-palette) SH to allocate for; 0 disables. */
  packedShBands?: 0 | 1 | 2 | 3;
  /** Packed-SH coefficient count for `packedShBands`, supplied by the caller
   * so this module stays free of the SH packing tables. */
  packedShTextureCount?: number;
  /**
   * The device's `maxTextureDimension2D`, so a pool too tall for it fails here
   * rather than at first draw. Pass {@link deviceMaxTextureSize}.
   *
   * `SplatMesh.update` also checks this, but only once and only if it is ever
   * reached: a pool created past the limit and drawn through a path that
   * swallows that first throw renders forever against invalid textures, which
   * surfaces as an unreadable cascade of WebGPU "invalid due to a previous
   * error" validation failures and a black canvas. Checking at construction is
   * both earlier (before the allocation) and unskippable.
   *
   * Omitted or 0 skips the check, so a caller that cannot read the limit is not
   * falsely rejected.
   */
  maxTextureSize?: number;
}

/**
 * The splat storage a mesh draws from: the data textures, their CPU backing,
 * and the row allocator that hands out space in them.
 *
 * Split out of `SplatMesh` because storage and drawing have different
 * lifetimes and, ultimately, different owners. A mesh's *draw identity* is
 * already independent of where its splats sit - `splatIndex` maps each
 * instance to a pool index and the sorter rewrites it freely - so the pool
 * behind those indices is a separate concern, and one pool can in principle
 * back several meshes (each keeping its own active list of pool indices).
 *
 * Allocation is row-aligned and best-fit; see {@link allocateRowSpan}.
 */
export class SplatPool {
  readonly width = SPLAT_DATA_TEXTURE_WIDTH;
  readonly rows: number;
  readonly floatTextures: 'float32' | 'float16';
  readonly packedShBands: 0 | 1 | 2 | 3;
  readonly backing: SplatPoolBacking;
  readonly centersTexture: THREE.DataTexture;
  readonly colorsTexture: THREE.DataTexture;
  readonly covarianceATexture: THREE.DataTexture;
  readonly covarianceBTexture: THREE.DataTexture;
  readonly shPackedTextures: readonly THREE.DataTexture[];
  /** Free row spans, sorted by start row. Mutated in place by the allocator. */
  freeRowSpans: RowSpan[];
  private readonly tenants = new Set<SplatPoolTenant>();
  /**
   * Pool index → its owner's packed active-list slot, valid only while that
   * pool index is active.
   *
   * Pool-owned rather than per-mesh because it is keyed by *pool* index: a
   * per-mesh copy would have to span the whole pool, so N meshes sharing one
   * pool would each pay 4 B per pool splat (a 4 M-splat pool shared by 13
   * meshes = ~200 MB of reverse maps). One array is safe because a row belongs
   * to exactly one tenant at a time, so no two tenants ever write the same
   * entry - the slot numbers in it are simply read back by whoever owns
   * the row.
   */
  readonly activeSlotByPoolIndex: Uint32Array;
  private poolIndexTemplate: Uint32Array | null = null;

  constructor(options: SplatPoolOptions) {
    if (!(options.capacity > 0)) throw new Error('SplatPool capacity must be positive.');
    this.rows = Math.ceil(options.capacity / this.width);
    assertPoolRowsFitDevice(this.rows, options.maxTextureSize ?? 0, this.width);
    const texelCount = this.width * this.rows;
    this.floatTextures = options.floatTextures === 'float16' ? 'float16' : 'float32';
    this.packedShBands = options.packedShBands ?? 0;
    const floatType = this.floatTextures === 'float16' ? THREE.HalfFloatType : THREE.FloatType;

    this.backing = {
      centers: new Float32Array(texelCount * 4),
      colors: new Uint8Array(texelCount * 4),
      covarianceA: new Float32Array(texelCount * 4),
      covarianceB: new Float32Array(texelCount * 4),
      // One RGBA32UI texel per splat per texture; sharing the pool's row
      // geometry lets the whole partial-upload/compaction path reuse the
      // existing row arithmetic unchanged.
      shPacked: Array.from(
        { length: options.packedShTextureCount ?? 0 },
        () => new Uint32Array(texelCount * 4),
      ),
    };
    // Under float16 the textures get their own half-encoded images; the float32
    // backing above stays authoritative and is re-encoded on upload.
    const centersImage: Float32Array | Uint16Array =
      this.floatTextures === 'float16' ? new Uint16Array(texelCount * 4) : this.backing.centers;
    const covarianceAImage: Float32Array | Uint16Array =
      this.floatTextures === 'float16' ? new Uint16Array(texelCount * 4) : this.backing.covarianceA;

    this.centersTexture = createDataTexture(centersImage, this.width, this.rows, floatType);
    this.colorsTexture = createDataTexture(
      this.backing.colors,
      this.width,
      this.rows,
      THREE.UnsignedByteType,
    );
    this.covarianceATexture = createDataTexture(covarianceAImage, this.width, this.rows, floatType);
    this.covarianceBTexture = createDataTexture(
      this.backing.covarianceB,
      this.width,
      this.rows,
      THREE.FloatType,
    );
    this.shPackedTextures = this.backing.shPacked.map((data) =>
      createIntegerDataTexture(data, this.width, this.rows),
    );
    this.freeRowSpans = [{ start: 0, count: this.rows }];
    this.activeSlotByPoolIndex = new Uint32Array(texelCount);
  }

  /**
   * A reusable `0, 1, 2, …` ramp over the pool, used to fill runs of pool
   * indices and active-list slots without a per-element loop. Pool-owned so
   * tenants sharing a pool share the one copy.
   */
  indexTemplate(): Uint32Array {
    if (this.poolIndexTemplate) return this.poolIndexTemplate;
    const indices = new Uint32Array(this.capacity);
    for (let index = 0; index < indices.length; index++) indices[index] = index;
    this.poolIndexTemplate = indices;
    return indices;
  }

  /** Splats the pool holds, always a whole number of rows. */
  get capacity(): number {
    return this.rows * this.width;
  }

  /** Whether `texture` belongs to this pool (and so outlives any one tenant). */
  isPoolTexture(texture: THREE.Texture): boolean {
    return (
      texture === this.centersTexture ||
      texture === this.colorsTexture ||
      texture === this.covarianceATexture ||
      texture === this.covarianceBTexture ||
      this.shPackedTextures.includes(texture as THREE.DataTexture)
    );
  }

  /** The four core textures, in the order the upload path indexes them. */
  get coreTextures(): readonly THREE.DataTexture[] {
    return [
      this.centersTexture,
      this.colorsTexture,
      this.covarianceATexture,
      this.covarianceBTexture,
    ];
  }

  /** Rows still free, whether or not they are contiguous. */
  get freeRows(): number {
    let rows = 0;
    for (const span of this.freeRowSpans) rows += span.count;
    return rows;
  }

  /** Takes `rowCount` contiguous rows; throws when none are left (compact cue). */
  allocateRows(rowCount: number): number {
    return allocateRowSpan(this.freeRowSpans, rowCount, this.rows);
  }

  /** Returns rows to the free list, coalescing neighbours. */
  releaseRows(start: number, count: number): void {
    this.freeRowSpans = releaseRowSpan(this.freeRowSpans, start, count);
  }

  /** Resets the free list to one span covering the whole pool. */
  resetFreeRows(fromRow = 0): void {
    this.freeRowSpans = fromRow < this.rows ? [{ start: fromRow, count: this.rows - fromRow }] : [];
  }

  /**
   * Adds a mesh that draws from this pool. Registration exists for
   * {@link compact}: packing the pool moves rows that belong to *every*
   * tenant, so each has to be told where its ranges went.
   */
  register(tenant: SplatPoolTenant): void {
    this.tenants.add(tenant);
  }

  /**
   * Drops a tenant. Release its ranges first: an unregistered tenant is
   * invisible to {@link compact}, which would then treat rows it still holds
   * as free and hand them to someone else. `compact` throws rather than let
   * that happen silently.
   */
  unregister(tenant: SplatPoolTenant): void {
    this.tenants.delete(tenant);
  }

  /** Number of meshes drawing from this pool. */
  get tenantCount(): number {
    return this.tenants.size;
  }

  /**
   * Packs every tenant's ranges toward row 0, removing the gaps that add /
   * remove churn leaves behind and restoring a single contiguous free span.
   * Callers reach this when {@link allocateRows} throws despite enough total
   * free rows - row-alignment fragmentation.
   *
   * The CPU backing arrays are authoritative, so nothing is re-fetched; moved
   * rows are re-uploaded on the tenant's next update.
   *
   * Note this is a whole-pool stall: with several tenants, one mesh's
   * fragmentation relocates the others' rows too, and every tenant rebuilds
   * its draw state. (Spark sidesteps the equivalent by allocating fixed-size,
   * interchangeable pages that never need packing; vlam's ranges are variable
   * runs, so it packs instead.)
   */
  compact(): void {
    const width = this.width;
    // Move in ascending row order so each target row is <= its current row and
    // no not-yet-moved range is ever overwritten. Ordering is global across
    // tenants, because they interleave in one address space.
    const placements: { tenant: SplatPoolTenant; range: SplatPoolRange }[] = [];
    let heldRows = 0;
    for (const tenant of this.tenants) {
      for (const range of tenant.poolRanges()) {
        placements.push({ tenant, range });
        heldRows += range.rowCount;
      }
    }
    // Every row is either free or held by a registered tenant. A shortfall
    // means rows are allocated to something the pool cannot see - an
    // unregistered tenant, or a range the tenant forgot to report - and
    // packing would hand those rows out a second time.
    if (heldRows + this.freeRows !== this.rows) {
      throw new Error(
        `SplatPool compaction found ${this.rows - heldRows - this.freeRows} unaccounted row(s): ` +
          `${heldRows} held by ${this.tenants.size} tenant(s), ${this.freeRows} free, ${this.rows} total. ` +
          `Release a tenant's ranges before unregistering it.`,
      );
    }
    placements.sort((a, b) => a.range.startRow - b.range.startRow);

    let targetRow = 0;
    for (const { tenant, range } of placements) {
      if (range.startRow !== targetRow) {
        const from = range.startRow * width * 4;
        const to = targetRow * width * 4;
        const length = range.rowCount * width * 4;
        this.backing.centers.copyWithin(to, from, from + length);
        this.backing.colors.copyWithin(to, from, from + length);
        this.backing.covarianceA.copyWithin(to, from, from + length);
        this.backing.covarianceB.copyWithin(to, from, from + length);
        // Packed SH shares the pool's row geometry and its RGBA texel stride,
        // so it relocates on exactly the same arithmetic.
        for (const group of this.backing.shPacked) group.copyWithin(to, from, from + length);
        // The tenant moves whatever else is keyed by pool row (channels) and
        // adopts the new start.
        tenant.relocatePoolRange(range, targetRow);
      }
      targetRow += range.rowCount;
    }
    this.resetFreeRows(targetRow);
    for (const tenant of this.tenants) tenant.onPoolCompacted();
  }

  dispose(): void {
    for (const texture of this.coreTextures) texture.dispose();
    for (const texture of this.shPackedTextures) texture.dispose();
    this.tenants.clear();
  }
}

export function createDataTexture(
  data: Float32Array | Uint8Array | Uint16Array,
  width: number,
  height: number,
  type: THREE.TextureDataType,
): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, type);
  texture.needsUpdate = true;
  return texture;
}

/**
 * An RGBA32UI data texture: four raw `uint32` per texel, delivered to the
 * shader as a `uvec4` with no filtering or normalization. Packed SH words go
 * through this rather than a float texture so they survive bit-exact.
 */
export function createIntegerDataTexture(
  data: Uint32Array,
  width: number,
  height: number,
): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAIntegerFormat,
    THREE.UnsignedIntType,
  );
  // Integer textures cannot be filtered; nearest is the only legal choice and
  // is what a per-texel lookup wants anyway. The backend derives the concrete
  // format (`rgba32uint` on WebGPU, `RGBA32UI` on WebGL2) from format + type,
  // so `internalFormat` is deliberately left alone.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The renderer backend's maximum 2D texture dimension, or 0 when it can't be
 * read (in which case callers skip any limit check rather than falsely reject).
 * WebGPU exposes `device.limits.maxTextureDimension2D`; WebGL2 exposes
 * `gl.MAX_TEXTURE_SIZE`.
 */
export function deviceMaxTextureSize(renderer: THREE.WebGPURenderer): number {
  const backend = renderer.backend as
    | {
        device?: { limits?: { maxTextureDimension2D?: number } };
        gl?: WebGL2RenderingContext;
      }
    | undefined;
  const wgpu = backend?.device?.limits?.maxTextureDimension2D;
  if (typeof wgpu === 'number' && wgpu > 0) return wgpu;
  const gl = backend?.gl;
  if (gl) {
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as unknown;
    if (typeof max === 'number' && max > 0) return max;
  }
  return 0;
}

/**
 * Throws when a pool's data textures would be taller than the device allows.
 *
 * `maxTextureSize <= 0` means "limit unknown" and skips the check rather than
 * risk a false rejection; see {@link deviceMaxTextureSize}.
 *
 * @param rows - Rows the pool needs.
 * @param maxTextureSize - The device's `maxTextureDimension2D`.
 * @param width - Texels per row, for the splat count in the message.
 */
export function assertPoolRowsFitDevice(
  rows: number,
  maxTextureSize: number,
  width: number = SPLAT_DATA_TEXTURE_WIDTH,
): void {
  if (!(maxTextureSize > 0) || rows <= maxTextureSize) return;
  throw new Error(
    `SplatPool: this scene needs a ${width}×${rows} data texture, but this device ` +
      `caps texture dimensions at ${maxTextureSize} (about ` +
      `${(maxTextureSize * width).toLocaleString('en-US')} pool splats). Lower the ` +
      `splat budget, or raise maxTextureDimension2D in the renderer's requiredLimits ` +
      `if the adapter advertises more.`,
  );
}

/**
 * Three's WebGPU backend submits one `queue.writeBuffer` per update range.
 * Merge touching mutations here so a region-atomic commit does not turn a
 * handful of contiguous backfills into several main-thread submissions.
 */
export function addMergedUpdateRange(
  attribute: THREE.BufferAttribute,
  start: number,
  count: number,
): void {
  let mergedStart = start;
  let mergedEnd = start + count;
  const disjoint: { start: number; count: number }[] = [];
  for (const range of attribute.updateRanges) {
    const rangeEnd = range.start + range.count;
    if (rangeEnd < mergedStart || range.start > mergedEnd) {
      disjoint.push(range);
      continue;
    }
    mergedStart = Math.min(mergedStart, range.start);
    mergedEnd = Math.max(mergedEnd, rangeEnd);
  }
  disjoint.push({ start: mergedStart, count: mergedEnd - mergedStart });
  disjoint.sort((a, b) => a.start - b.start);
  attribute.clearUpdateRanges();
  for (const range of disjoint) attribute.addUpdateRange(range.start, range.count);
}
