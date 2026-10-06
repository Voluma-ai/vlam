/**
 * Live per-source display opacity for the unified draw.
 *
 * Whole-source opacity (marker crossfades, reveal fades) used to be baked into
 * `centers.w` by the gather. Every fade step therefore failed the gather cache,
 * re-ran a full gather and forced a sort that bypasses the camera cadence; the
 * sort then held the next frame, so the fade only advanced on gathered frames.
 * During a timeline crossfade that doubled GPU work and made the fade step
 * irregularly.
 *
 * Instead the gather bakes only drawability (`0` or `1`) for live sources, and
 * the draw multiplies by `current / gathered` read from a small range table that
 * is refreshed every prepare, including held frames.
 */

/** Ranges the draw scans per vertex; fades rarely involve more than two sources. */
export const MAX_LIVE_OPACITY_RANGES = 8;

/**
 * Opacity the gather writes into `centers.w`. A live source bakes only whether
 * it draws at all; crossing zero still invalidates (it culls the slice).
 */
export const resolveGatherOpacity = (effectiveOpacity: number, live: boolean): number =>
  live ? (effectiveOpacity > 0 ? 1 : 0) : effectiveOpacity;

/** Fractional opacities need a live range; `0` and `1` gather identically either way. */
export const isFractionalOpacity = (effectiveOpacity: number): boolean =>
  effectiveOpacity > 0 && effectiveOpacity !== 1;

/** One drawn work-buffer slice and the opacity it was gathered with. */
export interface LiveOpacitySlice {
  offset: number;
  activeCount: number;
  /** Opacity baked into `centers.w` by this slice's last gather. */
  gatheredOpacity: number;
  /** Opacity the source should display this frame. */
  currentOpacity: number;
}

/** Minimal `Vector4.set` surface so the table can be tested without a renderer. */
export interface LiveOpacityRangeTarget {
  set(x: number, y: number, z: number, w: number): unknown;
}

/**
 * Writes `[start, end, scale, 0]` for each drawn slice whose display opacity
 * differs from what was gathered, in slice order, and returns the count. A
 * slice gathered at `0` is already culled and cannot be revived by a scale.
 */
export function writeLiveOpacityRanges(
  slices: Iterable<LiveOpacitySlice>,
  target: readonly LiveOpacityRangeTarget[],
): number {
  let count = 0;
  for (const slice of slices) {
    if (count >= target.length) break;
    if (slice.activeCount <= 0 || !(slice.gatheredOpacity > 0)) continue;
    const scale = Math.max(0, slice.currentOpacity) / slice.gatheredOpacity;
    if (scale === 1) continue;
    (target[count] as LiveOpacityRangeTarget).set(
      slice.offset,
      slice.offset + slice.activeCount,
      scale,
      0,
    );
    count++;
  }
  return count;
}
