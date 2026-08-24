import type { SplatData } from './splat-data';
import { selectInData, type SelectionVolume } from './selection-volume';

/**
 * Splits a {@link SplatData} into the part inside a {@link SelectionVolume}
 * and the rest, so the selected region can live as its own independently
 * transformed (and therefore independently animated) object.
 *
 * Both halves keep the source's local frame - separation does not bake any
 * transform. Register them as `SplatScene` or `UnifiedSplatRenderer` sources
 * for one global sort while they are posed independently. Separate
 * `SplatMesh` draw calls sort only within each mesh and can misblend where
 * their Gaussian footprints overlap.
 */
export interface SplatPartition {
  /** The splats whose centers passed the volume test. */
  readonly inside: SplatData;
  /** Everything else. */
  readonly outside: SplatData;
  /** Source indices of {@link inside}'s splats, ascending. */
  readonly insideIndices: Uint32Array;
}

/**
 * Partitions `data` by a selection.
 *
 * `selection` is either a volume (each splat center is tested) or an already
 * computed ascending index list, e.g. from {@link selectInData} - passing the
 * list avoids re-testing when a host previews a selection before separating.
 *
 * Per-splat arrays (positions, colors, covariances, SH) are gathered by index;
 * a SOG SH palette is shared by reference between the halves (it is immutable
 * and per-splat `labels` keep it valid for any subset). Streamed-only fields
 * (`radTree`, `frontierParent`, `radShCodebook`) do not survive a partition -
 * their index topology is meaningless on a subset - so they are dropped;
 * partitioning is for fully resident data. An empty or all-inclusive selection
 * is valid and yields a zero-count half.
 */
export function partitionSplatData(
  data: SplatData,
  selection: SelectionVolume | Uint32Array,
): SplatPartition {
  // `ArrayBuffer.isView`, not `instanceof Uint32Array`: this library moves
  // typed arrays across worker realms (`load-worker.ts` transfers them), and a
  // foreign-realm array fails `instanceof` - it would fall through to the
  // volume branch and throw `containsPoint is not a function`.
  const insideIndices = ArrayBuffer.isView(selection)
    ? validateIndices(selection, data.count)
    : selectInData(data, selection);

  const insideMask = new Uint8Array(data.count);
  for (const i of insideIndices) insideMask[i] = 1;
  const outsideIndices = new Uint32Array(data.count - insideIndices.length);
  let n = 0;
  for (let i = 0; i < data.count; i++) {
    if (insideMask[i] === 0) outsideIndices[n++] = i;
  }

  return {
    inside: gatherSplatData(data, insideIndices),
    outside: gatherSplatData(data, outsideIndices),
    insideIndices,
  };
}

/** SH coefficients beyond DC for 1, 2 or 3 bands. */
function shCoefficientCount(bands: number): number {
  return (bands + 1) * (bands + 1) - 1;
}

/**
 * A new {@link SplatData} holding `indices`' splats of `data`, in order.
 *
 * Internal: it assumes `indices` is already validated (see
 * {@link partitionSplatData}) and shares an immutable SOG palette by
 * reference, both of which are contracts a public helper would have to state.
 */
function gatherSplatData(data: SplatData, indices: Uint32Array): SplatData {
  const count = indices.length;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let k = 0; k < count; k++) {
    const i = indices[k] as number;
    positions[k * 3] = data.positions[i * 3] as number;
    positions[k * 3 + 1] = data.positions[i * 3 + 1] as number;
    positions[k * 3 + 2] = data.positions[i * 3 + 2] as number;
    colors[k * 4] = data.colors[i * 4] as number;
    colors[k * 4 + 1] = data.colors[i * 4 + 1] as number;
    colors[k * 4 + 2] = data.colors[i * 4 + 2] as number;
    colors[k * 4 + 3] = data.colors[i * 4 + 3] as number;
    for (let c = 0; c < 6; c++) {
      covariances[k * 6 + c] = data.covariances[i * 6 + c] as number;
    }
  }

  const result: {
    count: number;
    positions: Float32Array;
    colors: Uint8Array;
    covariances: Float32Array;
    sh?: SplatData['sh'];
    shPacked?: SplatData['shPacked'];
    antialias?: boolean;
    sourceFormat?: SplatData['sourceFormat'];
  } = { count, positions, colors, covariances };

  if (data.sh) {
    const labels = new Uint32Array(count);
    for (let k = 0; k < count; k++) labels[k] = data.sh.labels[indices[k] as number] as number;
    // The palette is immutable and label-addressed, so both halves share it.
    result.sh = { ...data.sh, labels };
  }
  if (data.shPacked) {
    const words = shCoefficientCount(data.shPacked.bands);
    const packed = new Uint32Array(count * words);
    for (let k = 0; k < count; k++) {
      const i = indices[k] as number;
      for (let w = 0; w < words; w++) {
        packed[k * words + w] = data.shPacked.packed[i * words + w] as number;
      }
    }
    result.shPacked = { ...data.shPacked, packed };
  }
  if (data.antialias !== undefined) result.antialias = data.antialias;
  if (data.sourceFormat !== undefined) result.sourceFormat = data.sourceFormat;
  return result;
}

/**
 * Validates an ascending, in-range, duplicate-free index list and returns a
 * private copy - the result is published on a `readonly` field, so a caller
 * reusing a scratch buffer must not be able to mutate the partition after the
 * fact.
 */
function validateIndices(indices: Uint32Array, count: number): Uint32Array {
  let previous = -1;
  for (const i of indices) {
    if (i >= count) {
      throw new Error(`partitionSplatData: index ${i} is out of range (count ${count}).`);
    }
    if (i <= previous) {
      throw new Error('partitionSplatData: selection indices must be ascending and unique.');
    }
    previous = i;
  }
  return Uint32Array.from(indices);
}
