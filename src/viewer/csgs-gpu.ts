/**
 * GPU playback of `.csgs` clips: a {@link SplatModifier} evaluates every
 * splat's curves at a time uniform, so a section is uploaded once (its knots,
 * per-splat headers and a static base, see `csgs-gpu-layout.ts`) and frames
 * cost no CPU evaluation and no upload.
 *
 * The modifier moves the center (`offset`), shapes the covariance through its
 * linear output (the base covariance is the identity, so `M = R(t)·S(t)` gives
 * `R·S²·Rᵀ`), sets the DC color and opacity, and masks dead splats. Only a
 * `UnifiedSplatMesh` sorts on the displaced centers; a standalone mesh keeps
 * its pre-displacement order, so this path is for the unified draw (WebGPU).
 */
import * as THREE from 'three/webgpu';
import {
  clamp,
  exp,
  float,
  floor,
  int,
  ivec2,
  mat3,
  max,
  min,
  mix,
  textureLoad,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import {
  SplatMesh,
  type SplatData,
  type SplatMeshOptions,
  type SplatModifier,
  type SplatRange,
} from '../lib/core';
import {
  CSGS_BOUNDS_MARKERS,
  CSGS_K_RADIX,
  CSGS_KNOT_TEXTURE_WIDTH,
  CSGS_LIFE_RADIX,
  CSGS_MAX_LOG_SCALE,
  CSGS_NEUTRAL_BYTE,
  type CsgsGpuSection,
} from './csgs-gpu-layout';
import type { CsgsClip } from './csgs-playback';

const SH_C0 = 0.28209479177387814;
/** Pool rows are 2048 splats wide; a range rounds up to whole rows. */
const POOL_ROW = 2048;
/**
 * Bytes of the next sections a host stages per rendered frame, shared among
 * its clips (see {@link CsgsGpuPlaybackMesh.stage}). A demo section is 20 to
 * 40 MB, staged during the ~1.1 s the shown one plays. Four demo clips need
 * ~120 MB/s: 4 MB per frame keeps them on schedule (1.5 MB lets them stall at
 * section ends), and halves the worst frame against staging a section at once.
 */
export const CSGS_STAGE_BYTES_PER_FRAME = 4 * 1024 * 1024;

/** Pool splats staged per chunk (4 rows, ~0.5 MB with SH). */
const POOL_CHUNK = 4 * POOL_ROW;
/** Knot texture rows staged per chunk (2 MB of half floats). */
const KNOT_CHUNK_ROWS = 128;

interface CsgsGpuUniforms {
  /** Absolute frame time (fractional frames interpolate). */
  readonly time: THREE.UniformNode<'float', number>;
  /** First frame of the shown section. */
  readonly g0: THREE.UniformNode<'float', number>;
  /** `max(nframes - 1, 1)` of the shown section. */
  readonly span: THREE.UniformNode<'float', number>;
}

/** The curve-evaluating modifier over `knots` (see the module comment). */
function csgsCurveModifier(knots: THREE.DataTexture, u: CsgsGpuUniforms): SplatModifier {
  return (ctx) => {
    const width = int(CSGS_KNOT_TEXTURE_WIDTH);
    const fetch = (texel: Node<'int'>): Node<'vec4'> =>
      textureLoad(knots, ivec2(texel.mod(width), texel.div(width)));
    const radix = int(CSGS_K_RADIX);
    const packedK = int(ctx.channel('csgsK'));
    const kP = packedK.mod(radix);
    const kR = packedK.div(radix).mod(radix);
    const kS = packedK.div(radix.mul(radix)).mod(radix);
    const kO = packedK.div(radix.mul(radix).mul(radix)).mod(radix);
    const kD = packedK.div(radix.mul(radix).mul(radix).mul(radix)).mod(radix);
    const startP = int(ctx.channel('csgsBase'));
    const startR = startP.add(kP);
    const startS = startR.add(kR);
    const startO = startS.add(kS);
    // Opacity knots pack four per texel (see csgs-gpu-layout.ts).
    const startD = startO.add(kO.add(3).div(4));
    // Hat curve: the segment under `time` and its blend weight; one knot is
    // a constant (km1 = 0 pins both reads to it and the weight to zero).
    const segment = (k: Node<'int'>) => {
      const km1 = float(k.sub(1));
      const tau = clamp(u.time.sub(u.g0).mul(km1).div(u.span), 0, km1);
      const j = min(floor(tau), max(km1.sub(1), 0));
      return { j: int(j), next: int(min(j.add(1), km1)), w: tau.sub(j) };
    };
    const sample = (start: Node<'int'>, k: Node<'int'>): Node<'vec4'> => {
      const { j, next, w } = segment(k);
      return mix(fetch(start.add(j)), fetch(start.add(next)), w);
    };
    /** Knot `index` of the packed scalar opacity curve. */
    const scalar = (start: Node<'int'>, index: Node<'int'>): Node<'float'> => {
      const lane = index.mod(int(4));
      const pick = vec4(
        lane.equal(int(0)).toFloat(),
        lane.equal(int(1)).toFloat(),
        lane.equal(int(2)).toFloat(),
        lane.equal(int(3)).toFloat(),
      );
      return fetch(start.add(index.div(int(4)))).dot(pick);
    };
    const position = sample(startP, kP).xyz;
    const q = sample(startR, kR).normalize();
    const s = exp(min(sample(startS, kS).xyz, float(CSGS_MAX_LOG_SCALE)));
    const opacityKnots = segment(kO);
    const logit = mix(
      scalar(startO, opacityKnots.j),
      scalar(startO, opacityKnots.next),
      opacityKnots.w,
    );
    const dc = sample(startD, kD).xyz;
    // Rotation matrix of the wxyz quaternion, columns scaled: M = R·S, the
    // same convention as `writeCovariance`.
    const w = q.x;
    const x = q.y;
    const y = q.z;
    const z = q.w;
    const linear = mat3(
      vec3(
        float(1).sub(y.mul(y).add(z.mul(z)).mul(2)),
        x.mul(y).add(w.mul(z)).mul(2),
        x.mul(z).sub(w.mul(y)).mul(2),
      ).mul(s.x),
      vec3(
        x.mul(y).sub(w.mul(z)).mul(2),
        float(1).sub(x.mul(x).add(z.mul(z)).mul(2)),
        y.mul(z).add(w.mul(x)).mul(2),
      ).mul(s.y),
      vec3(
        x.mul(z).add(w.mul(y)).mul(2),
        y.mul(z).sub(w.mul(x)).mul(2),
        float(1).sub(x.mul(x).add(y.mul(y)).mul(2)),
      ).mul(s.z),
    );
    // Liveness as a float mask on alpha: `visible`/`select` drop splats in a
    // modifier graph (see proxy-depth.ts).
    const life = int(ctx.channel('csgsLife'));
    const frame = floor(u.time);
    const alive = frame
      .greaterThanEqual(float(life.mod(int(CSGS_LIFE_RADIX))))
      .and(frame.lessThan(float(life.div(int(CSGS_LIFE_RADIX)))))
      .toFloat();
    const opacity = float(1)
      .div(float(1).add(exp(logit.negate())))
      .mul(alive);
    // The pool's neutral color plus SH; swap the neutral DC for the curve's.
    const rgb = clamp(ctx.color.rgb.sub(CSGS_NEUTRAL_BYTE / 255).add(dc.mul(SH_C0).add(0.5)), 0, 1);
    return {
      offset: ctx.offset.add(position.sub(ctx.localCenter)),
      rotation: ctx.rotation.mul(linear),
      color: vec4(rgb, opacity),
    };
  };
}

/** One of the two pool ranges and knot-texture halves a section lives in. */
interface CsgsGpuSlot {
  readonly range: SplatRange;
  /** First knot texel of this slot's half of the knot texture. */
  readonly knotBase: number;
  /** Section the slot holds or is staging, or -1. */
  section: number;
  packed: CsgsGpuSection | null;
  /** Pool splats written so far. */
  poolDone: number;
  /** Knot texture rows written so far. */
  rowsDone: number;
  headersDone: boolean;
}

/**
 * A dynamic-capacity {@link SplatMesh} that plays a clip on the GPU (see the
 * module comment). {@link setTime} moves the clip; a host drawing it through
 * a `UnifiedSplatMesh` registers it with `cacheModifiers: true` and calls
 * `invalidateSource` whenever `setTime` reports a change, which re-gathers and
 * re-sorts it.
 *
 * Two slots (pool range + half of the knot texture) hold the shown section
 * and stage the next one. {@link stage} uploads the next section a chunk at a
 * time, within a byte budget the host shares among clips, as soon as the
 * shown one is up; at the boundary the slots swap their active prefixes and
 * the uniforms change in the same frame, so a section change uploads nothing.
 */
export class CsgsGpuPlaybackMesh extends SplatMesh {
  readonly clip: CsgsClip;
  /** Index of the section on the GPU, or -1 before the first one arrives. */
  shownSection = -1;
  /** Splats alive at the shown frame. */
  alive = 0;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly knots: THREE.DataTexture;
  /** Reused source of the knot-row copies (one chunk of rows). */
  private readonly staging: THREE.DataTexture;
  private readonly uniforms: CsgsGpuUniforms;
  private readonly slots: [CsgsGpuSlot, CsgsGpuSlot];
  /** Index into {@link slots} of the shown section, or -1. */
  private shown = -1;
  private aliveFrame = -1;
  private released = false;

  constructor(clip: CsgsClip, renderer: THREE.WebGPURenderer, options: SplatMeshOptions = {}) {
    const slots = clip.maxCount + CSGS_BOUNDS_MARKERS;
    const rowsPerSlot = Math.ceil(slots / POOL_ROW);
    // Two ranges, plus one spare row: a range rounds up to whole rows.
    super({ capacity: (2 * rowsPerSlot + 1) * POOL_ROW }, options);
    this.clip = clip;
    this.renderer = renderer;
    for (const name of ['csgsBase', 'csgsK', 'csgsLife']) this.defineChannel(name);
    const maxTexels = Math.max(...clip.sections.map((s) => s.texels), 1);
    const halfRows = Math.ceil(maxTexels / CSGS_KNOT_TEXTURE_WIDTH);
    this.knots = new THREE.DataTexture(
      new Uint16Array(CSGS_KNOT_TEXTURE_WIDTH * 2 * halfRows * 4),
      CSGS_KNOT_TEXTURE_WIDTH,
      2 * halfRows,
      THREE.RGBAFormat,
      THREE.HalfFloatType,
    );
    this.knots.needsUpdate = true;
    this.staging = new THREE.DataTexture(
      new Uint16Array(CSGS_KNOT_TEXTURE_WIDTH * KNOT_CHUNK_ROWS * 4),
      CSGS_KNOT_TEXTURE_WIDTH,
      KNOT_CHUNK_ROWS,
      THREE.RGBAFormat,
      THREE.HalfFloatType,
    );
    const slot = (half: number): CsgsGpuSlot => ({
      range: this.reserveInactiveRange(slots),
      knotBase: half * halfRows * CSGS_KNOT_TEXTURE_WIDTH,
      section: -1,
      packed: null,
      poolDone: 0,
      rowsDone: 0,
      headersDone: false,
    });
    this.slots = [slot(0), slot(1)];
    this.uniforms = { time: uniform(0), g0: uniform(0), span: uniform(1) };
    this.modifiers = [csgsCurveModifier(this.knots, this.uniforms)];
  }

  /** Whether frame `frame`'s section is the one on the GPU. */
  shows(frame: number): boolean {
    return this.sectionAt(frame) === this.shownSection;
  }

  /**
   * Moves the clip to absolute frame time `t`. A section that is not staged
   * yet holds the shown one at its last frame (`hold`, for playback), or
   * leaves the shown frame as it is (a seek, which then waits for
   * {@link shows}). Returns whether the drawn content changed (time or
   * section), i.e. whether a unified host must `invalidateSource` this mesh.
   */
  setTime(t: number, hold = true): boolean {
    let changed = false;
    const wanted = this.sectionAt(Math.floor(t));
    if (wanted !== this.shownSection) {
      const next = this.slots[this.shown === 0 ? 1 : 0];
      if (next.section !== wanted) this.restage(next, wanted);
      // Nothing shown yet, or a seek: nothing to keep smooth, stage it whole.
      if (this.shown < 0 || !hold) this.stage(Infinity);
      if (this.staged(next)) {
        this.switchTo(this.shown === 0 ? 1 : 0);
        changed = true;
      } else {
        const shown = this.clip.sections[this.shownSection];
        // Hold the shown section at its end until the next one is staged.
        if (shown && hold) t = shown.g0 + shown.nframes - 1;
        else return false;
      }
    }
    if (t !== this.uniforms.time.value) {
      this.uniforms.time.value = t;
      changed = true;
    }
    this.countAlive(Math.floor(t));
    return changed;
  }

  /**
   * Uploads up to `budget` bytes of the next section into the free slot;
   * returns the bytes used. Call once per frame; hosts with several clips
   * share one budget so their boundaries do not burst the upload path.
   */
  stage(budget: number): number {
    if (this.released) return 0;
    const slot = this.slots[this.shown === 0 ? 1 : 0];
    if (slot.section < 0 && this.shownSection >= 0) {
      this.restage(slot, (this.shownSection + 1) % this.clip.sections.length);
    }
    const packed = slot.packed;
    if (!packed || this.staged(slot)) return 0;
    let used = 0;
    if (!slot.headersDone) {
      // Small (12 B per splat): all at once.
      const base = new Float32Array(packed.count);
      for (let i = 0; i < packed.count; i++) base[i] = packed.base[i]! + slot.knotBase;
      this.writeChannel(slot.range, 'csgsBase', base);
      this.writeChannel(slot.range, 'csgsK', packed.k);
      this.writeChannel(slot.range, 'csgsLife', packed.life);
      slot.headersDone = true;
      used += packed.count * 12;
    }
    const poolBytesPerSplat = 116;
    while (slot.poolDone < packed.pool.count && used < budget) {
      const start = slot.poolDone;
      const end = Math.min(packed.pool.count, start + POOL_CHUNK);
      this.overwriteRangeData(slot.range, sliceSplats(packed.pool, start, end), start);
      slot.poolDone = end;
      used += (end - start) * poolBytesPerSplat;
    }
    const rows = Math.ceil(packed.texels / CSGS_KNOT_TEXTURE_WIDTH);
    const rowFloats = CSGS_KNOT_TEXTURE_WIDTH * 4;
    const stagingData = this.staging.image.data as Uint16Array;
    while (slot.rowsDone < rows && used < budget) {
      const start = slot.rowsDone;
      const count = Math.min(KNOT_CHUNK_ROWS, rows - start);
      const chunk = packed.knots.subarray(start * rowFloats, (start + count) * rowFloats);
      stagingData.set(chunk);
      if (chunk.length < count * rowFloats) stagingData.fill(0, chunk.length, count * rowFloats);
      this.staging.needsUpdate = true;
      this.renderer.copyTextureToTexture(
        this.staging,
        this.knots,
        new THREE.Box2(new THREE.Vector2(0, 0), new THREE.Vector2(CSGS_KNOT_TEXTURE_WIDTH, count)),
        new THREE.Vector2(0, slot.knotBase / CSGS_KNOT_TEXTURE_WIDTH + start),
      );
      slot.rowsDone = start + count;
      used += count * rowFloats * 2;
    }
    return used;
  }

  override dispose(): void {
    this.released = true;
    this.knots.dispose();
    this.staging.dispose();
    super.dispose();
  }

  private sectionAt(frame: number): number {
    return this.clip.sections.findIndex((s) => frame >= s.g0 && frame < s.g0 + s.nframes);
  }

  private staged(slot: CsgsGpuSlot): boolean {
    const packed = slot.packed;
    return (
      packed !== null &&
      slot.headersDone &&
      slot.poolDone >= packed.pool.count &&
      slot.rowsDone >= Math.ceil(packed.texels / CSGS_KNOT_TEXTURE_WIDTH)
    );
  }

  /** Points a free slot at `section` and fetches its packed data. */
  private restage(slot: CsgsGpuSlot, section: number): void {
    slot.section = section;
    slot.packed = null;
    slot.poolDone = 0;
    slot.rowsDone = 0;
    slot.headersDone = false;
    if (section < 0) return;
    this.clip.gpuSection(section).then(
      (packed) => {
        // A newer restage of the slot wins over this reply.
        if (this.released || slot.section !== section || slot.packed) return;
        slot.packed = packed;
      },
      (error: unknown) => {
        if (!this.released) console.error('CSGS GPU section failed', error);
      },
    );
  }

  /** Shows the staged slot: both active prefixes and the uniforms at once. */
  private switchTo(index: number): void {
    const next = this.slots[index]!;
    const packed = next.packed!;
    if (this.shown >= 0) this.setRangeActivePrefix(this.slots[this.shown]!.range, 0);
    this.setRangeActivePrefix(next.range, packed.count);
    this.uniforms.g0.value = packed.g0;
    this.uniforms.span.value = Math.max(packed.nframes - 1, 1);
    this.invalidateSort();
    const previous = this.shown >= 0 ? this.slots[this.shown]! : null;
    this.shown = index;
    this.shownSection = next.section;
    this.aliveFrame = -1;
    // The old slot is free now: stage the section after this one into it.
    if (previous) this.restage(previous, (next.section + 1) % this.clip.sections.length);
  }

  private countAlive(frame: number): void {
    if (frame === this.aliveFrame || this.shown < 0) return;
    const packed = this.slots[this.shown]!.packed;
    if (!packed) return;
    let alive = 0;
    for (let i = 0; i < packed.count; i++) {
      const life = packed.life[i]!;
      if (frame >= life % CSGS_LIFE_RADIX && frame < Math.floor(life / CSGS_LIFE_RADIX)) alive++;
    }
    this.alive = alive;
    this.aliveFrame = frame;
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
