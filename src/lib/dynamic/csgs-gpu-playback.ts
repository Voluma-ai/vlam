/**
 * The `.csgs` driver of {@link SplatClipMesh}: on WebGPU a `SplatModifier`
 * evaluates the hat curves (`csgs-curve-modifier.ts`), so a section is
 * uploaded once and a frame costs no CPU evaluation and no upload. N pool
 * ranges and N parts of a knot texture hold resident sections; the next ones
 * in the direction of play are staged a chunk at a time under a byte budget,
 * and a section change flips two active prefixes and the uniforms in one
 * frame. A position-only modifier in `sortDisplacement` lets a standalone
 * WebGPU sort see the moving centers; a unified draw sorts gathered centers
 * and honours the same `invalidateSortDisplacement` revision.
 *
 * Elsewhere (WebGL2, a worker sorter, or a clip the GPU path cannot hold) the
 * clip plays on the shared frame path, its worker evaluating whole frames.
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { SplatData } from '../core/splat-data';
import type { SplatRange } from '../core/splat-mesh-types';
import { deviceMaxTextureSize } from '../core/splat-mesh-pool';
import {
  CSGS_KNOT_TEXTURE_WIDTH,
  csgsGpuAlive,
  type CsgsBounds,
  type CsgsGpuSection,
} from '../formats/csgs/csgs-gpu-layout';
import {
  CSGS_CHANNELS,
  csgsCurveModifier,
  csgsPositionModifier,
  type CsgsCurveUniforms,
} from './csgs-curve-modifier';
import { POOL_ROW, framePlan, mod } from './frame-playback';
import type { SplatClip } from './splat-clip';
import type {
  ClipHost,
  ClipPlayback,
  SplatClipDriver,
  SplatClipFrame,
  SplatClipPlanRequest,
  SplatFrameBuffers,
} from './splat-clip-playback';

/** Pool splats staged per chunk (4 rows, ~0.5 MB with SH). */
const POOL_CHUNK = 4 * POOL_ROW;
/** Knot texture rows staged per chunk (2 MB of half floats). */
const KNOT_CHUNK_ROWS = 128;
/** Pool bytes per staged splat: center, color, covariance and packed SH. */
const POOL_BYTES_PER_SPLAT = 116;
/** Header bytes per splat (three float32 channels). */
const HEADER_BYTES_PER_SPLAT = 12;
/** `residentSections` defaults to every section while their packed data stays under this. */
const RESIDENT_ALL_BYTES = 256 * 1024 * 1024;
/** WebGPU's default `maxTextureDimension2D`, when the device cannot be asked. */
const DEFAULT_MAX_TEXTURE_SIZE = 8192;
/**
 * Knot texture rows the float32 `csgsBase` channel addresses exactly: every
 * texel index below 2²⁴. A device allowing taller textures (16384 on most
 * desktops) would otherwise read the wrong knots in the upper slots.
 */
const MAX_KNOT_ROWS = 2 ** 24 / CSGS_KNOT_TEXTURE_WIDTH;

/**
 * What a host knows of one section of a `.csgs` clip: a span of frames
 * played by one fixed set of splats.
 *
 * @experimental
 */
export interface CsgsSectionInfo {
  /** First frame of the section. */
  readonly g0: number;
  /** Frames the section spans. */
  readonly nframes: number;
  /** Splats the section holds (alive or not at a given frame). */
  readonly count: number;
  /**
   * Whether the GPU path can play this section: every knot fits a half
   * float, and no curve has more than 7 knots.
   */
  readonly gpuEligible: boolean;
  /**
   * Knot texels the section needs on the GPU path.
   *
   * @internal
   */
  readonly texels: number;
  /**
   * Box of every position knot of the section.
   *
   * @internal
   */
  readonly bounds: CsgsBounds;
}

/** What the `.csgs` driver plays from: a worker-backed clip, or the procedural test clip. */
export interface CsgsClipSource {
  readonly sections: readonly CsgsSectionInfo[];
  /** Evaluates integer frame `frame`, every splat of its section in its own slot. */
  evaluate(frame: number, recycle?: SplatFrameBuffers, sh?: boolean): Promise<SplatClipFrame>;
  /** Packs section `index` for the GPU path. */
  gpuSection(index: number): Promise<CsgsGpuSection>;
}

/** Index of the section holding integer frame `frame`, or -1. */
export function csgsSectionAt(sections: readonly CsgsSectionInfo[], frame: number): number {
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    if (frame >= s.g0 && frame < s.g0 + s.nframes) return i;
  }
  return -1;
}

/** One box around every section's position knots (empty for no splats). */
export function unionCsgsBounds(sections: readonly CsgsSectionInfo[]): THREE.Box3 {
  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  for (const { bounds } of sections) {
    if (!(bounds.min[0] <= bounds.max[0])) continue;
    box.expandByPoint(corner.fromArray(bounds.min));
    box.expandByPoint(corner.fromArray(bounds.max));
  }
  return box;
}

/** Packed GPU bytes of a section (knots, headers and pool base). */
function sectionBytes(section: CsgsSectionInfo): number {
  return (
    section.texels * 8 +
    section.count * HEADER_BYTES_PER_SPLAT +
    section.count * POOL_BYTES_PER_SPLAT
  );
}

/** The `.csgs` driver over `source` (see the module comment). */
export function csgsClipDriver(
  clip: Pick<SplatClip, 'maxCount'>,
  source: CsgsClipSource,
): SplatClipDriver {
  const frameSource = {
    evaluate: source.evaluate.bind(source),
    sectionOf: (frame: number) => csgsSectionAt(source.sections, frame),
  };
  return {
    plan(request: SplatClipPlanRequest) {
      const framePath = framePlan(clip as SplatClip, frameSource);
      const requested = request.playback;
      if (requested === 'frames') return framePath;
      const { sections } = source;
      const webgpu =
        (request.renderer.backend as { isWebGPUBackend?: boolean } | undefined)?.isWebGPUBackend ===
        true;
      const length = sections.length;
      const rowsPerSlot = Math.ceil(Math.max(clip.maxCount, 1) / POOL_ROW);
      const maxTexels = Math.max(...sections.map((s) => s.texels), 1);
      const partRows = Math.ceil(maxTexels / CSGS_KNOT_TEXTURE_WIDTH);
      const maxTexture = deviceMaxTextureSize(request.renderer) || DEFAULT_MAX_TEXTURE_SIZE;
      const knotRows = Math.min(maxTexture, MAX_KNOT_ROWS);
      const fits = Math.min(
        Math.floor(knotRows / partRows),
        Math.floor((maxTexture - 1) / rowsPerSlot),
      );
      const minimum = Math.min(2, length);
      const wanted = request.residentSections;
      const all =
        wanted === 'all' ||
        (wanted === 'auto' &&
          sections.reduce((sum, s) => sum + sectionBytes(s), 0) <= RESIDENT_ALL_BYTES);
      const asked = all
        ? length
        : Math.max(minimum, Math.min(length, Math.floor(wanted === 'auto' ? 2 : wanted)));
      const resident = Math.min(asked, fits);
      const why = !webgpu
        ? 'it needs the WebGPU backend'
        : !sections.every((s) => s.gpuEligible)
          ? 'the clip has knots beyond the half-float range or curves of more than 7 knots'
          : resident < minimum
            ? `${minimum} sections do not fit the device's maxTextureDimension2D (${maxTexture}) ` +
              `or the ${MAX_KNOT_ROWS} knot rows a float32 index addresses`
            : null;
      if (why !== null) {
        if (requested === 'gpu')
          throw new Error(`SplatClipMesh: playback 'gpu' is not possible: ${why}.`);
        return framePath;
      }
      // The auto path also needs a sorter that sees displaced centers on its own.
      if (requested === 'auto' && request.sortStrategy === 'worker') return framePath;
      return {
        path: 'gpu',
        capacity: (resident * rowsPerSlot + 1) * POOL_ROW,
        create: (host: ClipHost) => new GpuPlayback(host, source, resident, partRows),
      };
    },
  };
}

/** One of the N pool ranges and knot-texture parts a section lives in. */
interface GpuSlot {
  readonly range: SplatRange;
  /** First knot texel of this slot's part of the knot texture. */
  readonly knotBase: number;
  /** Section the slot holds or is staging, or -1. */
  section: number;
  /** Bumped on every restage, so a stale `gpuSection` reply is ignored. */
  token: number;
  /** The packed section while it is staged; released once staged. */
  packed: CsgsGpuSection | null;
  /** Pool splats written so far. */
  poolDone: number;
  /** Knot texture rows written so far. */
  rowsDone: number;
  headersDone: boolean;
  staged: boolean;
  /** Kept from the packed section once staged. */
  count: number;
  g0: number;
  nframes: number;
  life: Float32Array | null;
}

/**
 * GPU path (see the module comment). Staging targets, in order: the section
 * `time` wants when it is not shown, then the next sections in the
 * direction time last moved. A slot is claimed free first, then one still
 * staging (a superseded jump), then the resident section farthest ahead in
 * the direction of play, which is the one just left behind.
 */
class GpuPlayback implements ClipPlayback {
  alive = 0;
  private readonly knots: THREE.DataTexture;
  /** Reused source of the knot-row copies (one chunk of rows). */
  private readonly staging: THREE.DataTexture;
  private readonly uniforms: CsgsCurveUniforms;
  private readonly slots: GpuSlot[];
  /** Index into {@link slots} of the shown section, or -1. */
  private shown = -1;
  private shownSection = -1;
  /** Section `time` wants, or -1 before the first apply. */
  private target = -1;
  private direction: 1 | -1 = 1;
  /** Whether the uniforms hold a different frame than asked (waiting for a section). */
  private holding = true;
  private aliveFrame = -1;
  /** Sections whose packing failed: not claimed again. */
  private readonly failed = new Set<number>();
  private released = false;

  private readonly renderer: THREE.WebGPURenderer;

  constructor(
    private readonly host: ClipHost,
    private readonly source: CsgsClipSource,
    resident: number,
    partRows: number,
  ) {
    const { clip } = host;
    this.renderer = host.renderer;
    this.knots = new THREE.DataTexture(
      new Uint16Array(CSGS_KNOT_TEXTURE_WIDTH * resident * partRows * 4),
      CSGS_KNOT_TEXTURE_WIDTH,
      resident * partRows,
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
    const slotSplats = clip.maxCount;
    this.slots = Array.from({ length: resident }, (_, part) => ({
      range: host.reserveInactiveRange(slotSplats),
      knotBase: part * partRows * CSGS_KNOT_TEXTURE_WIDTH,
      section: -1,
      token: 0,
      packed: null,
      poolDone: 0,
      rowsDone: 0,
      headersDone: false,
      staged: false,
      count: 0,
      g0: 0,
      nframes: 1,
      life: null,
    }));
    this.uniforms = { local: uniform(0), span: uniform(1) };
    for (const name of CSGS_CHANNELS) host.defineChannel(name);
    host.setModifiers(
      [csgsCurveModifier(this.knots, this.uniforms)],
      [csgsPositionModifier(this.knots, this.uniforms)],
    );
  }

  get shownFrame(): number {
    if (this.shown < 0) return -1;
    return this.slots[this.shown]!.g0 + Math.floor(this.uniforms.local.value);
  }

  apply(frame: number, direction: 1 | -1): void {
    this.direction = direction;
    const wanted = csgsSectionAt(this.source.sections, Math.floor(frame));
    if (wanted < 0) return;
    this.target = wanted;
    let local: number;
    if (wanted !== this.shownSection) {
      const slot = this.slotOf(wanted) ?? this.claim(wanted, new Set([this.shownSection]));
      // Nothing shown yet: nothing to keep smooth, stage it whole.
      if (slot && this.shown < 0) this.stage(slot, Infinity);
      if (slot?.staged) {
        this.switchTo(slot);
        local = frame - slot.g0;
        this.holding = false;
      } else {
        this.holding = true;
        if (this.shown < 0) return;
        const shown = this.slots[this.shown]!;
        const length = this.source.sections.length;
        // Playing into the next section: hold the shown one at its edge.
        // Any other jump holds the drawn frame as it is.
        if (mod(this.shownSection + direction, length) !== wanted) return;
        local = direction > 0 ? shown.nframes - 1 : 0;
      }
    } else {
      local = frame - this.slots[this.shown]!.g0;
      this.holding = false;
    }
    if (local !== this.uniforms.local.value) {
      this.uniforms.local.value = local;
      this.host.invalidateSortDisplacement();
    }
    this.countAlive(Math.floor(local));
  }

  shows(frame: number): boolean {
    if (this.holding || this.shown < 0) return false;
    const slot = this.slots[this.shown]!;
    return this.uniforms.local.value === frame - slot.g0;
  }

  failedAt(frame: number): boolean {
    return this.failed.has(csgsSectionAt(this.source.sections, Math.floor(frame)));
  }

  stageWithin(budget: number): number {
    if (this.released) return 0;
    const slot = this.nextToStage();
    return slot ? this.stage(slot, budget) : 0;
  }

  stats(): Record<string, number> {
    return {
      resident: this.slots.length,
      staged: this.slots.filter((slot) => slot.staged).length,
    };
  }

  dispose(): void {
    this.released = true;
    this.knots.dispose();
    this.staging.dispose();
  }

  private slotOf(section: number): GpuSlot | null {
    return this.slots.find((slot) => slot.section === section) ?? null;
  }

  /** The slot to stage now, claiming (and restaging) one if needed. */
  private nextToStage(): GpuSlot | null {
    const length = this.source.sections.length;
    if (this.target < 0) return null;
    const keep = new Set([this.shownSection]);
    if (this.target !== this.shownSection) {
      const slot = this.slotOf(this.target) ?? this.claim(this.target, keep);
      if (slot && !slot.staged) return slot;
      keep.add(this.target);
    }
    if (this.shownSection < 0) return null;
    for (let step = 1; step < Math.min(this.slots.length, length); step++) {
      const section = mod(this.shownSection + this.direction * step, length);
      if (this.failed.has(section)) continue;
      const slot = this.slotOf(section) ?? this.claim(section, keep);
      keep.add(section);
      if (!slot) return null;
      if (!slot.staged) return slot;
    }
    return null;
  }

  /** Restages a slot for `section`, never one holding a section in `keep`. */
  private claim(section: number, keep: ReadonlySet<number>): GpuSlot | null {
    if (this.failed.has(section)) return null;
    const length = this.source.sections.length;
    const origin = this.shownSection >= 0 ? this.shownSection : section;
    let best: GpuSlot | null = null;
    let bestScore = -Infinity;
    for (const slot of this.slots) {
      if (slot.section >= 0 && keep.has(slot.section)) continue;
      if (this.slots[this.shown] === slot) continue;
      const score =
        slot.section < 0
          ? 3 * length
          : !slot.staged
            ? 2 * length
            : mod((slot.section - origin) * this.direction, length);
      if (score > bestScore) {
        best = slot;
        bestScore = score;
      }
    }
    if (best) this.restage(best, section);
    return best;
  }

  /** Points a slot at `section` and fetches its packed data. */
  private restage(slot: GpuSlot, section: number): void {
    slot.section = section;
    slot.token++;
    slot.packed = null;
    slot.poolDone = 0;
    slot.rowsDone = 0;
    slot.headersDone = false;
    slot.staged = false;
    slot.life = null;
    const token = slot.token;
    this.source.gpuSection(section).then(
      (packed) => {
        // A newer restage of the slot wins over this reply.
        if (this.released || slot.token !== token) return;
        slot.packed = packed;
      },
      (error: unknown) => {
        if (this.released || slot.token !== token) return;
        this.failed.add(section);
        slot.section = -1;
        this.host.fail(error);
      },
    );
  }

  /**
   * Uploads up to `budget` bytes of a slot's section; returns the bytes used.
   * Headers first (small), then pool chunks, then knot rows through the
   * staging texture.
   */
  private stage(slot: GpuSlot, budget: number): number {
    const packed = slot.packed;
    if (!packed || slot.staged) return 0;
    let used = 0;
    if (!slot.headersDone) {
      const base = new Float32Array(packed.count);
      for (let i = 0; i < packed.count; i++) base[i] = packed.base[i]! + slot.knotBase;
      this.host.writeChannel(slot.range, 'csgsBase', base);
      this.host.writeChannel(slot.range, 'csgsK', packed.k);
      this.host.writeChannel(slot.range, 'csgsLife', packed.life);
      slot.headersDone = true;
      used += packed.count * HEADER_BYTES_PER_SPLAT;
    }
    while (slot.poolDone < packed.pool.count && used < budget) {
      const start = slot.poolDone;
      const end = Math.min(packed.pool.count, start + POOL_CHUNK);
      this.host.overwriteRangeData(slot.range, sliceSplats(packed.pool, start, end), start);
      slot.poolDone = end;
      used += (end - start) * POOL_BYTES_PER_SPLAT;
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
    if (slot.poolDone >= packed.pool.count && slot.rowsDone >= rows) {
      slot.staged = true;
      slot.count = packed.count;
      slot.g0 = packed.g0;
      slot.nframes = packed.nframes;
      slot.life = packed.life;
      // The GPU holds its copy now; keep only what counting alive splats needs.
      slot.packed = null;
    }
    return used;
  }

  /** Shows a staged slot: both active prefixes and the uniforms at once. */
  private switchTo(slot: GpuSlot): void {
    if (this.shown >= 0) this.host.setRangeActivePrefix(this.slots[this.shown]!.range, 0);
    this.host.setRangeActivePrefix(slot.range, slot.count);
    this.uniforms.span.value = Math.max(slot.nframes - 1, 1);
    this.host.invalidateSort();
    this.host.invalidateSortDisplacement();
    this.shown = this.slots.indexOf(slot);
    this.shownSection = slot.section;
    this.aliveFrame = -1;
  }

  private countAlive(local: number): void {
    if (local === this.aliveFrame || this.shown < 0) return;
    const slot = this.slots[this.shown]!;
    const life = slot.life;
    if (!life) return;
    let alive = 0;
    for (let i = 0; i < slot.count; i++) if (csgsGpuAlive(life, i, local)) alive++;
    this.alive = alive;
    this.aliveFrame = local;
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
