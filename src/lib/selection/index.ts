/**
 * `@voluma/vlam/selection` - volume and brush tests plus splat-cloud partitions.
 *
 * Select a box, sphere, cylinder, custom volume, or depth-aware brush stroke in
 * a loaded {@link SplatData}. Volume results can be split into their own cloud
 * so the part can be posed independently.
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
export {
  selectBrushStrokeInData,
  type BrushStroke,
  type BrushStrokeSample,
  type BrushStrokeSelectionOptions,
  type SelectionDepthMode,
  type SelectionFootprintMode,
} from './brush-stroke';
