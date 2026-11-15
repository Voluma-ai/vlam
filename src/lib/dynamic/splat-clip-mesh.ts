/**
 * {@link SplatClipMesh}: a dynamic-capacity `SplatMesh` that plays any
 * {@link SplatClip}, driven by a `time` property an `AnimationMixer` can
 * animate. The mesh owns the transport (time, the `AnimationClip`, waiting
 * for a frame, errors, the shared staging budget); how frames reach the GPU
 * is the clip format's business (`splat-clip-playback.ts`):
 *
 * - **A format's GPU path** where it has one (`.csgs` on WebGPU:
 *   `csgs-gpu-playback.ts`), which evaluates the motion in a `SplatModifier`.
 * - **The frame path** otherwise (`frame-playback.ts`): whole frames are
 *   evaluated one ahead of the shown one and swapped into the pool.
 */
import * as THREE from 'three/webgpu';
import { SplatMesh } from '../core/splat-mesh';
import type { SplatMeshOptions, SplatUpdateOptions } from '../core/splat-mesh-types';
import { defaultFrameDriver, mod } from './frame-playback';
import type { SplatClip } from './splat-clip';
import type { ClipHost, ClipPlayback } from './splat-clip-playback';
import { SplatClipStagingBudget } from './splat-clip-staging-budget';

/**
 * A frame step larger than this (either way) is a jump, not playback, unless
 * the step before it was about as large (see `update`).
 */
const JUMP_FRAMES = 2;

/**
 * Options of {@link SplatClipMesh}.
 *
 * @experimental
 */
export interface SplatClipMeshOptions extends SplatMeshOptions {
  /**
   * The renderer the mesh draws with, already initialized
   * (`await renderer.init()`): the playback path and the pool capacity
   * depend on its backend and are fixed in the constructor.
   */
  renderer: THREE.WebGPURenderer;
  /**
   * `'auto'` (default): the clip format's GPU path where it has one and the
   * device can hold it (`.csgs`: WebGPU, every section `gpuEligible`, the knot
   * texture fits), else the frame path. `'gpu'` throws where the GPU path is
   * not possible; `'frames'` always plays the frame path.
   */
  playback?: 'auto' | 'gpu' | 'frames';
  /**
   * GPU path: sections kept on the GPU. `'all'` makes scrubbing free at the
   * cost of memory; 2 is the minimum (shown + next). Lowered to what the
   * device's `maxTextureDimension2D` allows, and to 8192 knot-texture rows
   * (~134 MB of knots) on any device. Default: `'all'` while the clip's
   * packed sections stay under 256 MB, else 2.
   */
  residentSections?: number | 'all';
  /** Shared staging budget (several clips); default: a private 4 MB-per-frame one. */
  staging?: SplatClipStagingBudget;
  /** SH bands of the pool; defaults to the clip's {@link SplatClip.shBands}. */
  shBands?: 0 | 1 | 2 | 3;
}

/**
 * Events of a {@link SplatClipMesh}, on top of `Object3D`'s.
 *
 * @experimental
 */
export interface SplatClipMeshEventMap extends THREE.Object3DEventMap {
  /**
   * A frame evaluation or a section upload failed; the last good frame keeps
   * showing. Without a listener the error is logged to the console.
   */
  error: { error: unknown };
}

/** Clip frame of `time` seconds: wraps into `[0, totalFrames)`, but `duration` is the last frame. */
export function splatClipFrameAt(clip: SplatClip, time: number): number {
  const total = clip.totalFrames;
  let frame = Number.isFinite(time) ? time * clip.fps : 0;
  // `frame / fps * fps` need not round-trip; a hair off a whole frame is that frame.
  const whole = Math.round(frame);
  if (Math.abs(frame - whole) <= 1e-6) frame = whole;
  if (frame >= 0 && frame < total) return frame;
  // A clamped LoopOnce (or a ping-pong turn) holds `time === duration`.
  if (frame === total) return total - 1;
  return mod(frame, total);
}

/**
 * A dynamic-capacity `SplatMesh` that plays a {@link SplatClip}: set
 * {@link time} (seconds), or let an `AnimationMixer` drive it through
 * {@link animation}, and call `update` every frame. Works standalone and as a
 * `UnifiedSplatMesh` source (the unified draw calls `update` itself).
 *
 * Playing and scrubbing are one code path: whatever sets `time`, `update`
 * shows that frame as soon as it is available, and holds the last drawn
 * frame until then. Two captured clips are different sets of splats, so the
 * mixer's cross-fades and weights do not blend them; a transition is an
 * opacity fade between two meshes. (Rigged splats, whose motion is a
 * skeleton's, do blend: see `SkinnedSplatMesh`.)
 *
 * The mesh declares the clip's {@link SplatClip.bounds} as its
 * `displacementBounds`, so every pose sorts inside the quantized depth range.
 *
 * @example
 * ```ts
 * import * as THREE from 'three/webgpu';
 * import { loadSplatClip, SplatClipMesh } from '@voluma/vlam/dynamic';
 *
 * await renderer.init();
 * const clip = await loadSplatClip(sceneUrl);
 * const mesh = new SplatClipMesh(clip, { renderer });
 * scene.add(mesh);
 *
 * const mixer = new THREE.AnimationMixer(mesh);
 * const action = mixer.clipAction(mesh.animation);
 * action.play();
 *
 * const timer = new THREE.Timer();
 * renderer.setAnimationLoop(() => {
 *   timer.update();
 *   mixer.update(timer.getDelta());
 *   mesh.update(camera, renderer);
 *   renderer.render(scene, camera);
 * });
 *
 * action.paused = true; // pause
 * action.time = 1.2; // scrub (seconds)
 * action.timeScale = -1; // play backwards
 * ```
 *
 * @experimental The API may change in a minor release.
 */
export class SplatClipMesh extends SplatMesh {
  readonly clip: SplatClip;
  /**
   * An `AnimationClip` named after the clip, with one linear track driving
   * `.time` from 0 to `duration`, for an `AnimationMixer` rooted at this mesh.
   */
  readonly animation: THREE.AnimationClip;
  /** The playback path the constructor picked: a format's GPU path, or frames. */
  readonly playback: 'gpu' | 'frames';
  private clipTime = 0;
  private readonly strategy: ClipPlayback;
  private readonly staging: SplatClipStagingBudget;
  private lastFrame: number | null = null;
  /** Frames `time` moved between the last two updates (signed, the short way round). */
  private lastDelta = 0;
  private direction: 1 | -1 = 1;
  private waiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  private lastError: unknown = null;
  private readonly errorListeners = new Set<unknown>();
  private released = false;

  constructor(clip: SplatClip, options: SplatClipMeshOptions) {
    const {
      renderer,
      playback = 'auto',
      residentSections = 'auto',
      staging,
      ...meshOptions
    } = options;
    const plan = (clip.driver ?? defaultFrameDriver(clip)).plan({
      renderer,
      playback,
      residentSections,
      sortStrategy: options.sortStrategy,
    });
    super(
      { capacity: plan.capacity },
      { ...meshOptions, shBands: options.shBands ?? clip.shBands },
    );
    this.clip = clip;
    this.playback = plan.path;
    this.staging = staging ?? new SplatClipStagingBudget();
    this.displacementBounds = clip.bounds;
    this.animation = new THREE.AnimationClip(clip.name, clip.duration, [
      new THREE.NumberKeyframeTrack('.time', [0, clip.duration], [0, clip.duration]),
    ]);
    const host: ClipHost = {
      clip,
      renderer,
      reserveInactiveRange: (count) => this.reserveInactiveRange(count),
      overwriteRangeData: (range, data, offset) => this.overwriteRangeData(range, data, offset),
      overwriteRangeCore: (range, data, offset) => this.overwriteRangeCore(range, data, offset),
      setRangeActivePrefix: (range, prefix) => this.setRangeActivePrefix(range, prefix),
      defineChannel: (name) => this.defineChannel(name),
      writeChannel: (range, name, data) => this.writeChannel(range, name, data),
      setModifiers: (modifiers, sortDisplacement) => {
        this.modifiers = [...modifiers];
        this.sortDisplacement = sortDisplacement;
      },
      invalidateSort: () => this.invalidateSort(),
      invalidateSortDisplacement: () => this.invalidateSortDisplacement(),
      sortInFlight: () => this.hasInFlightSortSubmission(),
      fail: (error) => this.fail(error),
    };
    this.strategy = plan.create(host);
  }

  /**
   * Clip time in seconds. Values outside `[0, duration)` wrap, except
   * `duration` itself, which shows the last frame (a clamped `LoopOnce`).
   * Animatable: {@link animation} drives it.
   */
  get time(): number {
    return this.clipTime;
  }

  set time(value: number) {
    this.clipTime = value;
  }

  /** Fractional clip frame of {@link time}. */
  get frame(): number {
    return splatClipFrameAt(this.clip, this.clipTime);
  }

  /**
   * Integer frame currently drawn, or -1 before the first. Trails
   * {@link frame} while the wanted frame is uploaded or evaluated.
   */
  get shownFrame(): number {
    return this.strategy.shownFrame;
  }

  /** Splats alive in the drawn frame. */
  get alive(): number {
    return this.strategy.alive;
  }

  /**
   * Resolves once the drawn content is exactly {@link time}'s frame (for
   * tests, captures and thumbnails). Needs `update` calls to progress; a
   * later `time` change moves the goal. Rejects if the mesh is disposed
   * first, or if that frame failed to evaluate or upload.
   */
  whenShown(): Promise<void> {
    if (this.released) return Promise.reject(new Error('SplatClipMesh: disposed.'));
    if (this.lastFrame !== null && this.strategy.shows(this.frame)) return Promise.resolve();
    if (this.lastFrame !== null && this.strategy.failedAt(this.frame)) {
      return Promise.reject(this.failure());
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /**
   * Debug counters of the playback path (frames: `evalMs`, `swapMs`,
   * `heldSwaps`; GPU: `resident`, `staged`).
   *
   * @internal
   */
  get playbackStats(): Record<string, number> {
    return this.strategy.stats();
  }

  override addEventListener<T extends Extract<keyof SplatClipMeshEventMap, string>>(
    type: T,
    listener: THREE.EventListener<SplatClipMeshEventMap[T], T, this>,
  ): void {
    if (type === 'error') this.errorListeners.add(listener);
    super.addEventListener(type as never, listener);
  }

  override removeEventListener<T extends Extract<keyof SplatClipMeshEventMap, string>>(
    type: T,
    listener: THREE.EventListener<SplatClipMeshEventMap[T], T, this>,
  ): void {
    if (type === 'error') this.errorListeners.delete(listener);
    super.removeEventListener(type as never, listener);
  }

  /**
   * Shows {@link time}'s frame (or moves toward it), queues staging, then
   * runs the `SplatMesh` update. Call every frame before rendering; a
   * `UnifiedSplatMesh` calls it for its sources.
   */
  override update(
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGPURenderer,
    options?: SplatUpdateOptions,
  ): void {
    if (!this.released) {
      const frame = this.frame;
      const total = this.clip.totalFrames;
      let jump = true;
      let delta = 0;
      if (this.lastFrame !== null) {
        delta = frame - this.lastFrame;
        // Across the loop point, the short way round.
        if (delta > total / 2) delta -= total;
        else if (delta < -total / 2) delta += total;
        if (delta > 0) this.direction = 1;
        else if (delta < 0) this.direction = -1;
        // A jump is a step that is large and unlike the one before it. Fast
        // play (a high `timeScale`, or a renderer slower than the clip) steps
        // far on every update and is still playback: treated as a jump each
        // time, the frame path would discard every frame it evaluates.
        jump =
          Math.abs(delta) > JUMP_FRAMES &&
          Math.abs(delta - this.lastDelta) > Math.max(JUMP_FRAMES, Math.abs(this.lastDelta));
      }
      this.lastDelta = delta;
      const moved = frame !== this.lastFrame;
      // Staging first: a flush it triggers can finish a section this apply switches to.
      this.staging.request(this.strategy);
      this.strategy.apply(frame, this.direction, !moved || jump);
      this.lastFrame = frame;
      if (this.waiters.length > 0) {
        if (this.strategy.shows(frame)) this.settleWaiters(null);
        else if (this.strategy.failedAt(frame)) this.settleWaiters(this.failure());
      }
    }
    super.update(camera, renderer, options);
  }

  override dispose(): void {
    if (!this.released) {
      this.released = true;
      this.staging.remove(this.strategy);
      this.strategy.dispose();
      this.settleWaiters(new Error('SplatClipMesh: disposed.'));
    }
    super.dispose();
  }

  private fail(error: unknown): void {
    if (this.released) return;
    this.lastError = error;
    if (this.errorListeners.size === 0) {
      console.error(`vlam: SplatClipMesh "${this.clip.name}": playback failed.`, error);
    }
    (this as unknown as THREE.EventDispatcher<SplatClipMeshEventMap>).dispatchEvent({
      type: 'error',
      error,
    });
  }

  private failure(): Error {
    const error = this.lastError;
    if (error instanceof Error) return error;
    return new Error(
      error === null
        ? `SplatClipMesh: frame ${Math.floor(this.frame)} failed.`
        : `SplatClipMesh: ${String(error)}`,
    );
  }

  /** Resolves every waiter (`error === null`) or rejects them all. */
  private settleWaiters(error: unknown): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      if (error === null) waiter.resolve();
      else waiter.reject(error);
    }
  }
}
