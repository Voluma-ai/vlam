/**
 * A procedural `.csgs`-shaped clip for tests and the playback harness
 * (`clip=procedural`): hand-built `CsgsPlaybackSection`s behind the
 * `SplatClip` interface, evaluated and packed on the main thread with no
 * worker and no download. Unlike Faltwerk's synthetic fixture streams it is
 * GPU-eligible, so it is the GPU path's CI fixture.
 *
 * A few dozen splats at capture scale (a ~0.6 m blob), with births, deaths,
 * continuing splats and every knot count from 1 to 7 per group.
 */
import type { SplatClip } from '../lib/dynamic/splat-clip';
import type { SplatClipFrame } from '../lib/dynamic/splat-clip-playback';
import {
  csgsClipDriver,
  unionCsgsBounds,
  type CsgsClipSource,
  type CsgsSectionInfo,
} from '../lib/dynamic/csgs-gpu-playback';
import {
  createCsgsFrameBuffers,
  evaluateCsgsFrame,
  type CsgsFrameBuffers,
  type CsgsPlaybackSection,
} from '../lib/formats/csgs';
import {
  csgsGpuHalfSafe,
  csgsGpuTexels,
  csgsSectionBounds,
  packCsgsGpuSection,
} from '../lib/formats/csgs/csgs-gpu-layout';
import { packShCoefficient, symmetricShRange } from '../lib/core/sh-pack';

const SH_C0 = 0.28209479177387814;
/** Degree-3 SH coefficients beyond DC per splat. */
const SH_COEFFICIENTS = 15;
const SH_EXTENT = 0.5;

export interface ProceduralCsgsOptions {
  /** Sections, alternating keyed and delta (continuing splats); default 3. */
  readonly sections?: number;
  /** Frames per section; default 8. */
  readonly framesPerSection?: number;
  /** Splats per section; default 36. */
  readonly count?: number;
  /** First frame of the first section; default 0. */
  readonly startFrame?: number;
  /** Center of the blob; default `[0, 1, 0]`. */
  readonly origin?: readonly [number, number, number];
}

/** The procedural sections (see the module comment). */
export function proceduralCsgsSections(options: ProceduralCsgsOptions = {}): CsgsPlaybackSection[] {
  const sectionCount = options.sections ?? 3;
  const nframes = options.framesPerSection ?? 8;
  const count = options.count ?? 36;
  const start = options.startFrame ?? 0;
  const [ox, oy, oz] = options.origin ?? [0, 1, 0];
  const sections: CsgsPlaybackSection[] = [];
  for (let s = 0; s < sectionCount; s++) {
    const g0 = start + s * nframes;
    const delta = s % 2 === 1;
    const birthFrame = new Uint32Array(count);
    const deathFrame = new Uint32Array(count);
    const dims = [3, 4, 3, 1, 3];
    const k = dims.map(() => new Uint8Array(count));
    const knotOff = dims.map(() => new Uint32Array(count));
    const values: number[][] = dims.map(() => []);
    for (let i = 0; i < count; i++) {
      // Births and deaths inside the section; a delta section continues some splats.
      const born = i % 3 === 1 ? 1 + (i % (nframes - 1)) : 0;
      birthFrame[i] = delta && i % 4 === 0 ? 0 : g0 + born;
      const dies = i % 5 === 2 ? Math.min(nframes, born + 2 + (i % 3)) : nframes + 1;
      deathFrame[i] = g0 + dies;
      // Every knot count from 1 to 7, staggered per group.
      for (let g = 0; g < 5; g++) {
        const K = 1 + ((i + 2 * g + s) % 7);
        k[g]![i] = K;
        knotOff[g]![i] = values[g]!.length;
        for (let j = 0; j < K; j++) {
          const phase = i * 0.7 + j * 0.9 + s;
          if (g === 0) {
            // A blob of 0.3 m radius; each splat sways a few centimetres.
            const a = i * 2.399963;
            const r = 0.3 * Math.sqrt((i + 0.5) / count);
            values[0]!.push(
              ox + r * Math.cos(a) + 0.03 * Math.sin(phase),
              oy + 0.6 * ((i + 0.5) / count - 0.5) + 0.02 * Math.cos(phase),
              oz + r * Math.sin(a) + 0.03 * Math.cos(phase * 1.3),
            );
          } else if (g === 1) {
            values[1]!.push(
              1,
              0.3 * Math.sin(phase),
              0.3 * Math.cos(phase),
              0.2 * Math.sin(2 * phase),
            );
          } else if (g === 2) {
            const base = Math.log(0.025 + 0.01 * Math.sin(phase) ** 2);
            values[2]!.push(base, base + 0.4, base - 0.3);
          } else if (g === 3) {
            values[3]!.push(1.5 + Math.sin(phase));
          } else {
            const hue = (i / count + j * 0.05) * 2 * Math.PI;
            for (let c = 0; c < 3; c++) {
              const rgb = 0.5 + 0.4 * Math.cos(hue + (c * 2 * Math.PI) / 3);
              values[4]!.push((rgb - 0.5) / SH_C0);
            }
          }
        }
      }
    }
    const packed = new Uint32Array(count * SH_COEFFICIENTS);
    // A little view-dependent color on the first band, the rest zero.
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < SH_COEFFICIENTS; c++) {
        const v = c < 3 ? 0.1 * Math.sin(i + c) : 0;
        packed[i * SH_COEFFICIENTS + c] = packShCoefficient(v, -v, v / 2, SH_EXTENT);
      }
    }
    sections.push({
      g0,
      nframes,
      count,
      birthFrame,
      deathFrame,
      k,
      knotOff,
      knots: values.map((v) => new Float32Array(v)),
      shPacked: { bands: 3, packed, range: symmetricShRange(SH_EXTENT) },
    });
  }
  return sections;
}

/** A procedural clip, with the `.csgs` section view a harness and tests read. */
export interface ProceduralClip extends SplatClip {
  readonly sections: readonly CsgsSectionInfo[];
  readonly gpuEligible: boolean;
}

/**
 * A {@link SplatClip} over procedural sections, evaluated and packed on the
 * main thread and played by the `.csgs` driver. `fps` defaults to 8, so a
 * 3 × 8-frame clip lasts 3 s. `source` lets a test wrap what the driver sees
 * (delay a reply, fail a section, mark sections ineligible).
 */
export function createProceduralClip(
  options: ProceduralCsgsOptions & {
    readonly fps?: number;
    readonly name?: string;
    readonly source?: (source: CsgsClipSource) => CsgsClipSource;
  } = {},
): ProceduralClip {
  const sections = proceduralCsgsSections(options);
  const fps = options.fps ?? 8;
  const totalFrames = Math.max(...sections.map((s) => s.g0 + s.nframes));
  const maxCount = Math.max(...sections.map((s) => s.count));
  const infos: CsgsSectionInfo[] = sections.map((s) => ({
    g0: s.g0,
    nframes: s.nframes,
    count: s.count,
    texels: csgsGpuTexels(s),
    gpuEligible: csgsGpuHalfSafe(s),
    bounds: csgsSectionBounds(s),
  }));
  const bounds = unionCsgsBounds(infos);
  let disposed = false;
  const check = (): void => {
    if (disposed) throw new Error('procedural clip: disposed.');
  };
  const evaluate = async (
    frame: number,
    recycle?: CsgsFrameBuffers,
    sh = true,
    compact = false,
  ): Promise<SplatClipFrame> => {
    check();
    const index = sections.findIndex((s) => frame >= s.g0 && frame < s.g0 + s.nframes);
    const section = sections[index];
    if (!section) throw new Error(`procedural clip: no section holds frame ${frame}.`);
    const buffers =
      recycle && recycle.positions.length >= maxCount * 3
        ? recycle
        : createCsgsFrameBuffers(maxCount);
    const started = performance.now();
    const data = evaluateCsgsFrame(section, frame, buffers, { allSlots: !compact });
    let alive = 0;
    for (let i = 0; i < section.count; i++) {
      if (frame >= section.birthFrame[i]! && frame < section.deathFrame[i]!) alive++;
    }
    const { shPacked, ...rest } = data;
    return {
      frame,
      section: index,
      alive,
      buffers,
      evalMs: performance.now() - started,
      data: sh && shPacked ? { ...rest, shPacked } : rest,
    };
  };
  const base: CsgsClipSource = {
    sections: infos,
    evaluate: (frame, recycle, sh) => evaluate(frame, recycle, sh),
    async gpuSection(index: number) {
      check();
      const section = sections[index];
      if (!section) throw new Error(`procedural clip: no section ${index}.`);
      return packCsgsGpuSection(section);
    },
  };
  const source = options.source?.(base) ?? base;
  return {
    format: 'csgs',
    name: options.name ?? 'procedural',
    fps,
    totalFrames,
    duration: totalFrames / fps,
    maxCount,
    bounds,
    shBands: 3,
    sections: source.sections,
    gpuEligible: source.sections.every((s) => s.gpuEligible),
    driver: csgsClipDriver({ maxCount }, source),
    async frame(index) {
      return (await evaluate(index, undefined, true, true)).data;
    },
    dispose() {
      disposed = true;
    },
  };
}
