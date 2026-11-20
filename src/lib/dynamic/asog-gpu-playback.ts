/**
 * The `.asog` driver of {@link SplatClipMesh}. An `.asog` clip is one set of
 * splats for its whole length, each visible for a short life, so it plays
 * from one pool range:
 *
 * - **GPU path** (WebGPU): the canonical splats are uploaded once, a chunk at
 *   a time under the staging budget, with their motion in a texture; a
 *   `SplatModifier` (`asog-motion-modifier.ts`) evaluates every splat at a
 *   time uniform, so a frame costs no upload. A position-only twin in `sortDisplacement` lets the GPU
 *   sort see the moving centres.
 * - **Frame path** (WebGL2, a worker sorter, or a clip the motion texture
 *   cannot address): the clip's workers evaluate whole frames, two at once,
 *   every splat in its own slot (an invisible one at opacity 0), and the SH
 *   is written once.
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { SplatData } from '../core/splat-data';
import type { SplatRange } from '../core/splat-mesh-types';
import { deviceMaxTextureSize } from '../core/splat-mesh-pool';
import { asogClipLocalTime, asogClipWeight, asogTemporalWeight } from '../formats/asog/asog-motion';
import { ASOG_CLIP_FLOATS, ASOG_MOTION, ASOG_MOTION_FLOATS } from '../formats/asog/parse-asog';
import {
  ASOG_BASE_CHANNEL,
  ASOG_MOTION_TEXELS,
  ASOG_MOTION_TEXTURE_WIDTH,
  asogMotionModifier,
  asogPositionModifier,
  type AsogMotionState,
} from './asog-motion-modifier';
import type { AsogGpuData } from './asog-worker-protocol';
import { POOL_ROW, framePlan } from './frame-playback';
import type { SplatClip } from './splat-clip';
import type {
  ClipHost,
  ClipPlayback,
  SplatClipDriver,
  SplatClipFrame,
  SplatClipPlanRequest,
  SplatFrameBuffers,
} from './splat-clip-playback';

/** Pool splats staged per chunk (4 rows). */
const POOL_CHUNK = 4 * POOL_ROW;
/** Pool bytes per staged splat: center, color, covariance and packed SH. */
const POOL_BYTES_PER_SPLAT = 116;
/** WebGPU's default `maxTextureDimension2D`, when the device cannot be asked. */
const DEFAULT_MAX_TEXTURE_SIZE = 8192;
/** Motion texels the float32 base channel addresses exactly. */
const MAX_MOTION_TEXELS = 2 ** 24;

/** What the `.asog` driver plays from. */
export interface AsogClipSource {
  readonly count: number;
  readonly fps: number;
  /** The clip table, `ASOG_CLIP_FLOATS` per clip. */
  readonly clips: Float32Array;
  /** Frames evaluated at once on the frame path (its workers). */
  readonly parallel?: number;
  /** Evaluates integer frame `frame`, splat `i` in slot `i`. */
  evaluate(frame: number, recycle?: SplatFrameBuffers, sh?: boolean): Promise<SplatClipFrame>;
  /** The canonical splats and their motion, for the GPU path. */
  gpuData(): Promise<AsogGpuData>;
}

/** Why the GPU path cannot play `count` splats on this renderer, or null. */
function gpuBlocker(renderer: THREE.WebGPURenderer, count: number): string | null {
  const webgpu =
    (renderer.backend as { isWebGPUBackend?: boolean } | undefined)?.isWebGPUBackend === true;
  if (!webgpu) return 'it needs the WebGPU backend';
  const texels = count * ASOG_MOTION_TEXELS;
  const rows = Math.ceil(texels / ASOG_MOTION_TEXTURE_WIDTH);
  const maxTexture = deviceMaxTextureSize(renderer) || DEFAULT_MAX_TEXTURE_SIZE;
  if (rows > maxTexture || texels > MAX_MOTION_TEXELS) {
    return (
      `${count} splats need ${rows} motion texture rows, beyond the device's ` +
      `maxTextureDimension2D (${maxTexture}) or the ${MAX_MOTION_TEXELS} texels a float32 index addresses`
    );
  }
  return null;
}

/** The `.asog` driver over `source` (see the module comment). */
export function asogClipDriver(
  clip: Pick<SplatClip, 'maxCount'>,
  source: AsogClipSource,
): SplatClipDriver {
  const frameSource = {
    evaluate: source.evaluate.bind(source),
    // One set of splats in fixed slots: the SH is written once.
    sectionOf: () => 0,
    ...(source.parallel !== undefined ? { parallel: source.parallel } : {}),
  };
  return {
    plan(request: SplatClipPlanRequest) {
      const framePath = framePlan(clip as SplatClip, frameSource);
      if (request.playback === 'frames') return framePath;
      const why = gpuBlocker(request.renderer, source.count);
      if (why !== null) {
        if (request.playback === 'gpu') {
          throw new Error(`SplatClipMesh: playback 'gpu' is not possible: ${why}.`);
        }
        return framePath;
      }
      // The auto path also needs a sorter that sees displaced centers on its own.
      if (request.playback === 'auto' && request.sortStrategy === 'worker') return framePath;
      return {
        path: 'gpu',
        capacity: Math.ceil(Math.max(source.count, 1) / POOL_ROW) * POOL_ROW + POOL_ROW,
        create: (host: ClipHost) => new AsogGpuPlayback(host, source),
      };
    },
  };
}

/** GPU path (see the module comment). */
class AsogGpuPlayback implements ClipPlayback {
  private readonly range: SplatRange;
  private readonly state: AsogMotionState;
  private data: AsogGpuData | null = null;
  /** μ, σ and flags per splat, kept for {@link alive}. */
  private timing: Float32Array | null = null;
  private poolDone = 0;
  private staged = false;
  private failed = false;
  private released = false;
  /** Fractional frame the time uniform holds, or -1. */
  private shownAt = -1;

  /** Frame `apply` last asked for. */
  private target = -1;
  private aliveFrame = -1;
  private aliveCount = 0;

  constructor(
    private readonly host: ClipHost,
    private readonly source: AsogClipSource,
  ) {
    const count = source.count;
    this.range = host.reserveInactiveRange(count);
    const rows = Math.max(1, Math.ceil((count * ASOG_MOTION_TEXELS) / ASOG_MOTION_TEXTURE_WIDTH));
    const motion = new THREE.DataTexture(
      new Float32Array(ASOG_MOTION_TEXTURE_WIDTH * rows * 4),
      ASOG_MOTION_TEXTURE_WIDTH,
      rows,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    const clipCount = source.clips.length / ASOG_CLIP_FLOATS;
    // The clip table as two texels per clip (see `AsogMotionState`).
    const clips = new THREE.DataTexture(
      source.clips.slice(),
      clipCount * 2,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    clips.needsUpdate = true;
    this.state = { motion, clips, time: uniform(0) };
    host.defineChannel(ASOG_BASE_CHANNEL);
    host.setModifiers([asogMotionModifier(this.state)], [asogPositionModifier(this.state)]);
    source.gpuData().then(
      (data) => {
        if (this.released) return;
        this.data = data;
        const timing = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          const m = i * ASOG_MOTION_FLOATS;
          timing[i * 3] = data.motion[m + ASOG_MOTION.mu]!;
          timing[i * 3 + 1] = data.motion[m + ASOG_MOTION.sigma]!;
          timing[i * 3 + 2] = data.motion[m + ASOG_MOTION.flags]!;
        }
        this.timing = timing;
      },
      (error: unknown) => {
        if (this.released) return;
        this.failed = true;
        this.host.fail(error);
      },
    );
  }

  get shownFrame(): number {
    return this.staged && this.shownAt >= 0 ? Math.floor(this.shownAt) : -1;
  }

  get alive(): number {
    const frame = this.shownFrame;
    if (frame < 0 || !this.timing) return 0;
    if (frame !== this.aliveFrame) {
      this.aliveCount = this.countAlive(this.shownAt / this.source.fps);
      this.aliveFrame = frame;
    }
    return this.aliveCount;
  }

  apply(frame: number): void {
    this.target = frame;
    // Nothing shown yet: nothing to keep smooth, stage it whole.
    if (!this.staged) this.stage(Infinity);
    if (!this.staged || frame === this.shownAt) return;
    this.state.time.value = frame / this.source.fps;
    this.shownAt = frame;
    this.host.invalidateSortDisplacement();
  }

  shows(frame: number): boolean {
    return this.staged && this.shownAt === frame;
  }

  failedAt(): boolean {
    return this.failed;
  }

  stageWithin(budget: number): number {
    if (this.released || this.staged) return 0;
    const used = this.stage(budget);
    if (this.staged && this.target >= 0) this.apply(this.target);
    return used;
  }

  stats(): Record<string, number> {
    return { staged: this.staged ? 1 : 0, poolDone: this.poolDone };
  }

  dispose(): void {
    this.released = true;
    this.state.motion.dispose();
    this.state.clips.dispose();
  }

  /** Uploads up to `budget` bytes of the canonical splats; returns the bytes used. */
  private stage(budget: number): number {
    const data = this.data;
    if (!data || this.staged) return 0;
    let used = 0;
    const { pool } = data;
    if (this.poolDone === 0) {
      const base = new Float32Array(pool.count);
      for (let i = 0; i < pool.count; i++) base[i] = i * ASOG_MOTION_TEXELS;
      this.host.writeChannel(this.range, ASOG_BASE_CHANNEL, base);
      const image = this.state.motion.image.data as Float32Array;
      image.set(data.motion);
      this.state.motion.needsUpdate = true;
      used += data.motion.byteLength + pool.count * 4;
    }
    while (this.poolDone < pool.count && used < budget) {
      const start = this.poolDone;
      const end = Math.min(pool.count, start + POOL_CHUNK);
      this.host.overwriteRangeData(this.range, sliceSplats(pool, start, end), start);
      this.poolDone = end;
      used += (end - start) * POOL_BYTES_PER_SPLAT;
    }
    if (this.poolDone >= pool.count) {
      this.staged = true;
      this.host.setRangeActivePrefix(this.range, pool.count);
      this.host.invalidateSort();
      // The GPU holds its copy now.
      this.data = null;
    }
    return used;
  }

  private countAlive(t: number): number {
    const timing = this.timing!;
    const { clips } = this.source;
    const clipCount = clips.length / ASOG_CLIP_FLOATS;
    const local = new Float64Array(clipCount);
    const weight = new Float64Array(clipCount);
    for (let c = 0; c < clipCount; c++) {
      local[c] = asogClipLocalTime(clips, c, t);
      weight[c] = asogClipWeight(clips, c, t);
    }
    let alive = 0;
    for (let i = 0; i < this.source.count; i++) {
      const flags = timing[i * 3 + 2]!;
      const clip = Math.floor(flags / 2);
      if (!(weight[clip]! > 0)) continue;
      if (
        flags % 2 === 1 ||
        asogTemporalWeight(local[clip]! - timing[i * 3]!, timing[i * 3 + 1]!) > 0
      ) {
        alive++;
      }
    }
    return alive;
  }
}

/** Splats `[start, end)` of `data`, as views. */
function sliceSplats(data: SplatData, start: number, end: number): SplatData {
  const sh = data.shPacked;
  const words = sh ? sh.packed.length / data.count : 0;
  return {
    count: end - start,
    positions: data.positions.subarray(start * 3, end * 3),
    colors: data.colors.subarray(start * 4, end * 4),
    covariances: data.covariances.subarray(start * 6, end * 6),
    ...(sh ? { shPacked: { ...sh, packed: sh.packed.subarray(start * words, end * words) } } : {}),
  };
}
