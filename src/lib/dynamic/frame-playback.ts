/**
 * The frame path of {@link SplatClipMesh}: frames are evaluated one ahead of
 * the shown one (in the direction of play), by the clip's worker when it has
 * one, and swapped into the pool whole. Every format can play this way; it
 * is what WebGL2 and a clip without a GPU path use.
 */
import type { SplatRange } from '../core/splat-mesh-types';
import type { SplatClip } from './splat-clip';
import type {
  ClipHost,
  ClipPlayback,
  SplatClipDriver,
  SplatClipFrame,
  SplatClipFrameSource,
  SplatClipPlan,
  SplatClipPlanRequest,
  SplatFrameBuffers,
} from './splat-clip-playback';

/** Pool rows are 2048 splats wide; a range rounds up to whole rows. */
export const POOL_ROW = 2048;
/**
 * An evaluated frame still shows when it is at most this many updates' worth
 * of frames behind the target (the evaluator is late): 8 frames at one frame
 * per update, more when time moves faster.
 */
const LATE_UPDATES = 8;
/** An evaluated frame up to this far ahead waits for its turn (a prefetch). */
const PREFETCH_FRAMES = 2;

export function mod(value: number, n: number): number {
  return ((value % n) + n) % n;
}

/** The frame path's plan: one pool range sized for the clip's largest frame. */
export function framePlan(clip: SplatClip, source: SplatClipFrameSource): SplatClipPlan {
  return {
    path: 'frames',
    // One spare row: a range rounds up to whole rows.
    capacity: Math.ceil(Math.max(clip.maxCount, 1) / POOL_ROW) * POOL_ROW + POOL_ROW,
    create: (host) => new FramePlayback(host, source),
  };
}

/**
 * The driver of a clip that brings none: frames come from its public
 * {@link SplatClip.frame}, each treated as its own set of splats.
 */
export function defaultFrameDriver(clip: SplatClip): SplatClipDriver {
  const source: SplatClipFrameSource = {
    async evaluate(frame) {
      const started = performance.now();
      const data = await clip.frame(frame);
      if (data.count > clip.maxCount) {
        throw new RangeError(
          `SplatClip "${clip.name}": frame ${frame} holds ${data.count} splats, ` +
            `more than its maxCount (${clip.maxCount}).`,
        );
      }
      return {
        frame,
        section: frame,
        alive: data.count,
        data,
        evalMs: performance.now() - started,
      };
    },
    sectionOf: (frame) => frame,
  };
  return {
    plan(request: SplatClipPlanRequest) {
      if (request.playback === 'gpu') {
        throw new Error(
          `SplatClipMesh: playback 'gpu' is not possible: the ${clip.format} clip has no GPU path.`,
        );
      }
      return framePlan(clip, source);
    },
  };
}

/**
 * Frame playback (see the module comment).
 *
 * One pool range, sized for the clip's largest frame, holds every splat of
 * the current section in a fixed slot (dead splats draw nothing). Within a
 * section a swap rewrites only the moving attributes in place and leaves the
 * static SH where it is; a section change writes everything once and resizes
 * the active prefix.
 *
 * A swap waits while the previous frame's GPU sort is in flight: the mesh
 * keeps drawing that sort's order until it completes, and the swap rewrites
 * the pool rows the order indexes, so the frame in between would draw the new
 * splats in the old order. `StreamedSplatMesh` holds its swaps on the same
 * gate.
 */
class FramePlayback implements ClipPlayback {
  alive = 0;
  shownFrame = -1;
  private evalMs = 0;
  private swapMs = 0;
  private heldSwaps = 0;
  private readonly range: SplatRange;
  /** Section whose splats (and SH) the range holds, or -1 before the first swap. */
  private slotSection = -1;
  /** An evaluated frame waiting for its turn. */
  private ready: SplatClipFrame | null = null;
  private requesting = false;
  /** Direction of play when {@link ready} was requested: after a reversal it is not late but stale. */
  private readyDirection: 1 | -1 = 1;
  /** A frame whose evaluation failed: not asked again until the target moves. */
  private failedFrame = -1;
  /** Integer frame of the last apply, or -1 before the first. */
  private lastTarget = -1;
  /** Buffers of swapped-out frames, handed back with the next request. */
  private readonly spare: SplatFrameBuffers[] = [];
  private released = false;

  constructor(
    private readonly host: ClipHost,
    private readonly source: SplatClipFrameSource,
  ) {
    this.range = host.reserveInactiveRange(host.clip.maxCount);
  }

  apply(fractional: number, direction: 1 | -1, exact: boolean): void {
    const total = this.host.clip.totalFrames;
    const target = Math.floor(fractional);
    if (target !== this.failedFrame) this.failedFrame = -1;
    // Frames the target moved since the last apply, in the direction of play.
    const step = this.lastTarget < 0 ? 0 : mod((target - this.lastTarget) * direction, total);
    this.lastTarget = target;
    // A frame lands at least one update after it was asked for, so it is a
    // step or more behind by then: the tolerance follows the step, or fast
    // play would out-run it and show nothing. Capped under half the clip,
    // where "behind" and "ahead" (a prefetch) stop being distinguishable.
    const late = Math.min(LATE_UPDATES * Math.max(step, 1), (total - 1) >> 1);
    const ready = this.ready;
    if (ready) {
      // How far the evaluated frame is ahead of the target in the direction
      // of play (0 = on time); a late frame sits just under `total`.
      const ahead = mod((ready.frame - target) * direction, total);
      const behind = ahead === 0 ? 0 : total - ahead;
      if (ready.section !== this.slotSection && !this.carriesSh(ready)) {
        // A new section needs its SH, which this evaluation skipped.
        this.discard(ready);
      } else if (ahead === 0 || (!exact && behind <= late && this.readyDirection === direction)) {
        if (this.host.sortInFlight()) this.heldSwaps++;
        else this.swap(ready);
      } else if (exact || ahead > PREFETCH_FRAMES) {
        // A jump (or a pause on another frame) left it stale.
        this.discard(ready);
      }
    }
    if (!this.ready && !this.requesting) {
      if (this.shownFrame !== target) this.request(target, direction);
      else if (!exact) this.request(mod(target + direction, total), direction);
    }
  }

  shows(frame: number): boolean {
    return this.shownFrame === Math.floor(frame);
  }

  failedAt(frame: number): boolean {
    return this.failedFrame >= 0 && this.failedFrame === Math.floor(frame);
  }

  stageWithin(): number {
    return 0;
  }

  stats(): Record<string, number> {
    return { evalMs: this.evalMs, swapMs: this.swapMs, heldSwaps: this.heldSwaps };
  }

  dispose(): void {
    this.released = true;
  }

  /** Whether a frame brings the SH a section change needs (or the clip has none). */
  private carriesSh(frame: SplatClipFrame): boolean {
    return this.host.clip.shBands === 0 || !!frame.data.shPacked || !!frame.data.sh;
  }

  private request(frame: number, direction: 1 | -1): void {
    if (frame === this.failedFrame) return;
    const sh = this.source.sectionOf(frame) !== this.slotSection;
    this.requesting = true;
    this.source.evaluate(frame, this.spare.pop(), sh).then(
      (evaluated) => {
        this.requesting = false;
        if (this.released) return;
        if (sh && !this.carriesSh(evaluated)) {
          // Asked with its SH and came back without: asking again would
          // return the same, so this is the clip's error, not a retry.
          if (evaluated.buffers) this.spare.push(evaluated.buffers);
          this.failedFrame = frame;
          const { name, shBands } = this.host.clip;
          this.host.fail(
            new Error(
              `SplatClip "${name}": frame ${frame} carries no SH, ` +
                `but the clip declares shBands ${shBands}.`,
            ),
          );
          return;
        }
        this.ready = evaluated;
        this.readyDirection = direction;
      },
      (error: unknown) => {
        this.requesting = false;
        if (this.released) return;
        this.failedFrame = frame;
        this.host.fail(error);
      },
    );
  }

  private discard(frame: SplatClipFrame): void {
    if (frame.buffers) this.spare.push(frame.buffers);
    this.ready = null;
  }

  private swap(frame: SplatClipFrame): void {
    const started = performance.now();
    if (frame.section !== this.slotSection) {
      // Another section: other splats in the slots, with their own SH.
      this.host.overwriteRangeData(this.range, frame.data, 0);
      this.host.setRangeActivePrefix(this.range, frame.data.count);
      this.slotSection = frame.section;
    } else {
      // Same splats, moved: the static SH stays as uploaded.
      this.host.overwriteRangeCore(this.range, frame.data, 0);
    }
    this.host.invalidateSort();
    this.swapMs = performance.now() - started;
    this.evalMs = frame.evalMs;
    this.alive = frame.alive;
    this.shownFrame = frame.frame;
    // The pool holds its own copy, so the buffers are free again.
    this.discard(frame);
  }
}
