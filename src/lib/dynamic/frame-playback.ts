/**
 * The frame path of {@link SplatClipMesh}: frames are evaluated ahead of
 * the shown one (in the direction of play), by the clip's workers when it has
 * them, and swapped into the pool whole. Every format can play this way; it
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
/**
 * Frames evaluated or being evaluated ahead, with one evaluator. The next
 * evaluation starts as soon as one arrives instead of after it is shown, so
 * the evaluator stays busy and a frame costs its evaluation alone, not its
 * evaluation plus the wait for its update. Each further evaluator
 * ({@link SplatClipFrameSource.parallel}) adds one.
 */
const QUEUED_FRAMES = 2;

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
 * Evaluation runs ahead of the shown frame: the frames within the prefetch
 * window are requested as soon as there is room, up to the source's
 * {@link SplatClipFrameSource.parallel} at once, so a steady clip costs its
 * evaluation time per frame divided by its evaluators. Frames may arrive
 * out of order; they wait in play order.
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
  /**
   * Evaluated frames waiting for their turn, in play order, each with the
   * direction of play it was requested in: after a reversal it is not late
   * but stale.
   */
  private readonly queue: { frame: SplatClipFrame; direction: 1 | -1 }[] = [];
  /** Frames being evaluated. */
  private readonly inFlight = new Set<number>();
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
    /** How far `frame` is ahead of the target in the direction of play (0 = on time). */
    const aheadOf = (frame: number) => mod((frame - target) * direction, total);
    const showable = (entry: { frame: SplatClipFrame; direction: 1 | -1 }): boolean => {
      const ahead = aheadOf(entry.frame.frame);
      const behind = ahead === 0 ? 0 : total - ahead;
      return ahead === 0 || (!exact && behind <= late && entry.direction === direction);
    };
    // Play order: frames behind the target first, then on time, then ahead.
    const signed = (frame: number) => {
      const ahead = aheadOf(frame);
      return ahead * 2 < total ? ahead : ahead - total;
    };
    this.queue.sort((a, b) => signed(a.frame.frame) - signed(b.frame.frame));
    while (this.queue.length > 0) {
      const entry = this.queue[0]!;
      const ready = entry.frame;
      if (ready.section !== this.slotSection && !this.carriesSh(ready)) {
        // A new section needs its SH, which this evaluation skipped.
        this.discard(entry);
        continue;
      }
      if (showable(entry)) {
        // Queued frames follow the direction of play, so a later one that can
        // show is nearer the target (the evaluator fell behind): skip to it.
        const next = this.queue[1];
        if (next && showable(next)) {
          this.discard(entry);
          continue;
        }
        if (this.host.sortInFlight()) this.heldSwaps++;
        else this.swap(entry);
        break;
      }
      // A jump (or a pause on another frame) left it stale; a prefetch waits.
      if (exact || aheadOf(ready.frame) > PREFETCH_FRAMES) {
        this.discard(entry);
        continue;
      }
      break;
    }
    const parallel = Math.max(1, Math.floor(this.source.parallel ?? 1));
    const ahead = QUEUED_FRAMES + parallel - 1;
    const have = (frame: number) =>
      this.inFlight.has(frame) || this.queue.some((entry) => entry.frame.frame === frame);
    while (this.inFlight.size < parallel && this.inFlight.size + this.queue.length < ahead) {
      // The target first, then the prefetch window in the direction of play.
      let next = -1;
      if (this.shownFrame !== target && !have(target)) next = target;
      else if (!exact) {
        for (let k = 1; k <= PREFETCH_FRAMES; k++) {
          const frame = mod(target + k * direction, total);
          if (frame !== this.shownFrame && !have(frame)) {
            next = frame;
            break;
          }
        }
      }
      if (next < 0 || next === this.failedFrame) break;
      this.request(next, direction);
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
    const sh = this.source.sectionOf(frame) !== this.slotSection;
    this.inFlight.add(frame);
    this.source.evaluate(frame, this.spare.pop(), sh).then(
      (evaluated) => {
        this.inFlight.delete(frame);
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
        this.queue.push({ frame: evaluated, direction });
      },
      (error: unknown) => {
        this.inFlight.delete(frame);
        if (this.released) return;
        this.failedFrame = frame;
        this.host.fail(error);
      },
    );
  }

  /** Drops a queued frame, keeping its buffers for a later request. */
  private discard(entry: { frame: SplatClipFrame }): void {
    const index = this.queue.indexOf(entry as (typeof this.queue)[number]);
    if (index >= 0) this.queue.splice(index, 1);
    if (entry.frame.buffers) this.spare.push(entry.frame.buffers);
  }

  private swap(entry: { frame: SplatClipFrame }): void {
    const { frame } = entry;
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
    this.discard(entry);
  }
}
