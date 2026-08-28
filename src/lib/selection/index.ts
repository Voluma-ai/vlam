/**
 * `@voluma/vlam/selection` - volume tests and splat-cloud partitions.
 *
 * Select a box, sphere, cylinder, or custom volume in a loaded {@link SplatData}
 * and split the matching splats into their own cloud so the part can be posed
 * independently.
 *
 * Collision-mesh splitting stays on `@voluma/vlam/formats/lcc`.
 *
 * @module selection
 */
export {
  createSelectionVolume,
  selectInData,
  countInData,
  type SelectionVolume,
  type SelectionVolumeKind,
  type SelectionVolumeOptions,
} from './selection-volume';
export { partitionSplatData, type SplatPartition } from './splat-partition';
