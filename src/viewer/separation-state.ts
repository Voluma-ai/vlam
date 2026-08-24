import type { SplatData } from '../lib';

/**
 * The bookkeeping behind the separation demo, kept free of DOM and THREE so it
 * can be unit-tested (the vitest environment is `node`).
 *
 * The state machine exists because two very different things both arrive as
 * "the scene changed":
 *
 *  - a **scene swap the tool caused** - separating replaces the on-screen mesh
 *    with the outside half, restoring puts the original back. The separated
 *    parts and the restore point must survive these.
 *  - an **external scene change** - a dropped file, a `?scene=` load, or an
 *    effect rebuild that re-mounts the mesh from `splatData`. The parts belong
 *    to the previous scene and must be dropped.
 *
 * Telling them apart matters: after a separate, the host's `splatData` is the
 * *outside* half, so treating an effect rebuild as a fresh scene would both
 * destroy the separated region and adopt the outside half as the restore
 * point - leaving no way back to the full cloud.
 */
export interface SeparationState {
  /** The data to hand back when the user restores, or null when unusable. */
  readonly restorePoint: SplatData | null;
  /** The data currently on screen (the outside half after a separate). */
  readonly currentData: SplatData | null;
  /** Whether a scene supporting separation is mounted. */
  readonly usable: boolean;

  /**
   * Records a mounted scene.
   *
   * @param data - The mounted scene's splats, or null for a streamed scene
   * (separation needs fully resident data).
   * @param origin - `'self'` for the tool's own separate/restore swaps,
   * `'external'` for anything else.
   * @returns Whether the caller should discard the separated parts and reset
   * the volume placement - true exactly for an external change.
   */
  onScene(data: SplatData | null, origin: 'self' | 'external'): boolean;

  /** Records that a separation committed, leaving `outside` on screen. */
  onSeparated(outside: SplatData): void;

  /** Records that a restore completed, putting `data` back on screen. */
  onRestored(data: SplatData): void;
}

export function createSeparationState(): SeparationState {
  let restorePoint: SplatData | null = null;
  let currentData: SplatData | null = null;

  return {
    get restorePoint() {
      return restorePoint;
    },
    get currentData() {
      return currentData;
    },
    get usable() {
      return currentData !== null;
    },

    onScene(data, origin): boolean {
      currentData = data;
      if (data === null) {
        // A streamed scene cannot be separated; drop everything so a later
        // static scene starts clean rather than restoring another scene's data.
        restorePoint = null;
        return true;
      }
      // Only an external change re-baselines. The tool's own swaps deliberately
      // keep the restore point captured before the first separation.
      if (origin === 'external' || restorePoint === null) {
        restorePoint = data;
        return origin === 'external';
      }
      return false;
    },

    onSeparated(outside): void {
      currentData = outside;
    },

    onRestored(data): void {
      currentData = data;
      restorePoint = data;
    },
  };
}
