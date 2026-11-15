import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeCovariance } from '../core/splat-data';
import {
  CsgsDecoder,
  createCsgsFrameBuffers,
  evaluateCsgsFrame,
  prepareCsgsSection,
  type CsgsPlaybackSection,
} from '../formats/csgs';
import {
  CSGS_HALF_MAX,
  CSGS_LIFE_RADIX,
  csgsGpuHalfSafe,
  packCsgsGpuSection,
  sampleCsgsGpuSection,
} from '../formats/csgs/csgs-gpu-layout';
import { proceduralCsgsSections } from '../../viewer/csgs-procedural';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'csgs');

/** Largest |delta| of splat `i`'s position knots from its first one (what the layout stores). */
function positionDelta(prepared: CsgsPlaybackSection, i: number): number {
  const values = prepared.knots[0]!;
  const offset = prepared.knotOff[0]![i]!;
  let largest = 0;
  for (let j = 0; j < prepared.k[0]![i]!; j++) {
    for (let c = 0; c < 3; c++) {
      largest = Math.max(largest, Math.abs(values[offset + j * 3 + c]! - values[offset + c]!));
    }
  }
  return largest;
}

/** Every fixture section of Faltwerk's synthetic streams, decoded in order. */
function sections() {
  const names = [
    'synth_res_s0000.csgs',
    'synth_res_s0001.csgs',
    'synth_shared_s0000.csgs',
    'synth_shared_s0001.csgs',
    'synth_shared_s0002.csgs',
  ];
  const out = [];
  const decoders = new Map<string, CsgsDecoder>();
  for (const name of names) {
    const stream = name.replace(/_s\d+\.csgs$/, '');
    const decoder = decoders.get(stream) ?? new CsgsDecoder();
    decoders.set(stream, decoder);
    try {
      const section = decoder.decode(new Uint8Array(readFileSync(join(FIXTURES, name))));
      out.push({ name, prepared: prepareCsgsSection(section, decoder.params!) });
    } catch {
      // Unsupported container versions are covered by parse-csgs.test.ts.
    }
  }
  return out;
}

describe('csgs GPU layout', () => {
  it('reproduces the CPU evaluation from the packed data alone', () => {
    // Knots are stored as half floats: each value carries a relative error up
    // to 2^-11, so every bound below scales with that splat's own knots. A
    // layout or index mistake errs by the knots' full magnitude instead.
    const HALF = 2 ** -11;
    const all = sections();
    expect(all.length).toBeGreaterThan(0);
    let compared = 0;
    for (const { name, prepared } of all) {
      const packed = packCsgsGpuSection(prepared);
      expect(packed.pool.count).toBe(prepared.count);
      const buffers = createCsgsFrameBuffers(prepared.count);
      const covariance = new Float32Array(6);
      /** Largest |value| among splat `i`'s knots of group `g`, and the smallest knot norm. */
      const knots = (g: number, i: number, dims: number) => {
        const values = prepared.knots[g]!;
        const offset = prepared.knotOff[g]![i]!;
        let largest = 0;
        let smallestNorm = Infinity;
        for (let j = 0; j < prepared.k[g]![i]!; j++) {
          let norm = 0;
          for (let c = 0; c < dims; c++) {
            const value = values[offset + j * dims + c]!;
            largest = Math.max(largest, Math.abs(value));
            norm += value * value;
          }
          smallestNorm = Math.min(smallestNorm, Math.sqrt(norm));
        }
        return { largest, smallestNorm };
      };
      for (let f = prepared.g0; f < prepared.g0 + prepared.nframes; f += 0.5) {
        const cpu = evaluateCsgsFrame(prepared, f, buffers, { allSlots: true });
        for (let i = 0; i < prepared.count; i++) {
          const gpu = sampleCsgsGpuSection(packed, i, f);
          const at = `${name} frame ${f} splat ${i}`;
          expect(gpu.alive, at).toBe(cpu.colors[i * 4 + 3]! > 0 || cpu.covariances[i * 6]! > 0);
          if (!gpu.alive) continue;
          // Splats with knots beyond the half range are outside the GPU
          // path's contract (csgsGpuHalfSafe); the synthetic streams have them.
          // Positions are stored as deltas from the first knot.
          const dims = [3, 4, 3, 1, 3];
          if (dims.some((d, g) => g > 0 && knots(g, i, d).largest > CSGS_HALF_MAX)) continue;
          const delta = positionDelta(prepared, i);
          if (delta > CSGS_HALF_MAX) continue;
          compared++;
          // Half-float error of the delta, plus float32 rounding of the center
          // and of the CPU's own interpolation at that magnitude.
          const p = knots(0, i, 3).largest;
          for (let c = 0; c < 3; c++) {
            expect(Math.abs(gpu.position[c]! - cpu.positions[i * 3 + c]!), at).toBeLessThanOrEqual(
              2 * HALF * delta + 2 ** -22 * p + 1e-6,
            );
          }
          // Bytes: C0·255 ≈ 72 per unit of D, at most 255/4 per unit of logit.
          const colorSlack = Math.ceil(72 * 2 * HALF * knots(4, i, 3).largest) + 1;
          for (let c = 0; c < 3; c++) {
            const byte = Math.round(Math.min(Math.max(gpu.color[c]!, 0), 1) * 255);
            expect(Math.abs(byte - cpu.colors[i * 4 + c]!), at).toBeLessThanOrEqual(colorSlack);
          }
          const opacitySlack = Math.ceil(64 * 2 * HALF * knots(3, i, 1).largest) + 1;
          expect(
            Math.abs(Math.round(gpu.opacity * 255) - cpu.colors[i * 4 + 3]!),
            at,
          ).toBeLessThanOrEqual(opacitySlack);
          const [qw, qx, qy, qz] = gpu.rotation;
          writeCovariance(covariance, 0, ...gpu.scale, qw, qx, qy, qz);
          // Relative to the matrix's magnitude: a log-scale error δ scales an
          // axis by e^δ, a quaternion error tilts it by ~|Δq|/|q|.
          const rotation = knots(1, i, 4);
          const logScale = Math.min(knots(2, i, 3).largest, 20);
          const relative =
            2 * (Math.exp(2 * HALF * logScale) - 1) +
            8 * HALF * (rotation.largest / Math.max(rotation.smallestNorm, 1e-6)) +
            1e-5;
          let magnitude = 1e-12;
          for (let c = 0; c < 6; c++) {
            magnitude = Math.max(magnitude, Math.abs(cpu.covariances[i * 6 + c]!));
          }
          for (let c = 0; c < 6; c++) {
            expect(Math.abs(covariance[c]! - cpu.covariances[i * 6 + c]!), at).toBeLessThanOrEqual(
              relative * magnitude,
            );
          }
        }
      }
    }
    // The skip above must leave most of the fixture under test.
    expect(compared).toBeGreaterThan(1000);
  });

  it('reports whether a section fits the half-float range', () => {
    let rejected = 0;
    for (const { name, prepared } of sections()) {
      let largest = 0;
      for (let g = 1; g < 5; g++) {
        for (const v of prepared.knots[g]!) largest = Math.max(largest, Math.abs(v));
      }
      for (let i = 0; i < prepared.count; i++) {
        largest = Math.max(largest, positionDelta(prepared, i));
      }
      expect(csgsGpuHalfSafe(prepared), name).toBe(largest <= CSGS_HALF_MAX);
      if (!csgsGpuHalfSafe(prepared)) rejected++;
    }
    // The synthetic stress streams exceed it, so both outcomes are exercised.
    expect(rejected).toBeGreaterThan(0);
  });

  it('rejects curves with more knots than the packed counts hold', () => {
    const [section] = proceduralCsgsSections({ sections: 1, count: 16 });
    expect(csgsGpuHalfSafe(section!)).toBe(true);
    // The container allows any ascending `ks`; radix-8 packing holds 1 to 7.
    // Eight would carry into the next group's count and read the wrong knots.
    const k = section!.k.map((counts) => counts.slice());
    k[4]![3] = 8;
    expect(csgsGpuHalfSafe({ ...section!, k })).toBe(false);
  });

  it('stores a half-precision copy of every knot, opacity four per texel', () => {
    for (const { prepared } of sections()) {
      const packed = packCsgsGpuSection(prepared);
      let texels = 0;
      for (let i = 0; i < prepared.count; i++) {
        for (let g = 0; g < 5; g++) {
          const K = prepared.k[g]![i]!;
          texels += g === 3 ? Math.ceil(K / 4) : K;
        }
      }
      expect(packed.texels).toBe(texels);
      expect(packed.knots.length).toBe(texels * 4);
    }
  });

  it('bounds every position knot, and so every pose', () => {
    for (const { prepared } of sections()) {
      const { bounds } = packCsgsGpuSection(prepared);
      if (prepared.count === 0) continue;
      const knots = prepared.knots[0]!;
      for (let v = 0; v < knots.length; v += 3) {
        for (let c = 0; c < 3; c++) {
          expect(knots[v + c]!).toBeGreaterThanOrEqual(bounds.min[c]!);
          expect(knots[v + c]!).toBeLessThanOrEqual(bounds.max[c]!);
        }
      }
      // Interpolated poses stay inside (the curves are piecewise linear).
      const buffers = createCsgsFrameBuffers(prepared.count);
      const frame = evaluateCsgsFrame(prepared, prepared.g0 + prepared.nframes / 2 + 0.25, buffers);
      for (let i = 0; i < frame.count; i++) {
        for (let c = 0; c < 3; c++) {
          expect(frame.positions[i * 3 + c]!).toBeGreaterThanOrEqual(bounds.min[c]! - 1e-4);
          expect(frame.positions[i * 3 + c]!).toBeLessThanOrEqual(bounds.max[c]! + 1e-4);
        }
      }
      // Every pool splat is a slot: nothing extra to keep the bounds.
      expect(packCsgsGpuSection(prepared).pool.count).toBe(prepared.count);
    }
  });

  it('packs life relative to the section, so long clips keep exact frames', () => {
    for (const { prepared } of sections()) {
      const packed = packCsgsGpuSection(prepared);
      for (let i = 0; i < prepared.count; i++) {
        const life = packed.life[i]!;
        const birth = life % CSGS_LIFE_RADIX;
        const death = Math.floor(life / CSGS_LIFE_RADIX);
        const clamp = (frame: number) =>
          Math.min(Math.max(frame - prepared.g0, 0), prepared.nframes);
        expect(birth).toBe(clamp(prepared.birthFrame[i]!));
        expect(death).toBe(clamp(prepared.deathFrame[i]!));
      }
    }
    // A section starting past frame 4095 (2 min 16 s at 30 fps) still packs exactly.
    const [late] = proceduralCsgsSections({ startFrame: 9000, sections: 1, count: 24 });
    const packed = packCsgsGpuSection(late!);
    for (let f = late!.g0; f < late!.g0 + late!.nframes; f++) {
      for (let i = 0; i < late!.count; i++) {
        const alive = f >= late!.birthFrame[i]! && f < late!.deathFrame[i]!;
        expect(sampleCsgsGpuSection(packed, i, f).alive, `frame ${f} splat ${i}`).toBe(alive);
      }
    }
  });

  it('keeps millimetre position steps 10 m from the origin (position deltas)', () => {
    const near = proceduralCsgsSections({ sections: 1, count: 32 })[0]!;
    const far = proceduralCsgsSections({ sections: 1, count: 32, origin: [10, 1.5, -10] })[0]!;
    for (const section of [near, far]) {
      expect(csgsGpuHalfSafe(section)).toBe(true);
      const packed = packCsgsGpuSection(section);
      const buffers = createCsgsFrameBuffers(section.count);
      let worst = 0;
      for (let f = section.g0; f < section.g0 + section.nframes; f += 0.25) {
        const cpu = evaluateCsgsFrame(section, f, buffers, { allSlots: true });
        for (let i = 0; i < section.count; i++) {
          const gpu = sampleCsgsGpuSection(packed, i, f);
          if (!gpu.alive) continue;
          for (let c = 0; c < 3; c++) {
            worst = Math.max(worst, Math.abs(gpu.position[c]! - cpu.positions[i * 3 + c]!));
          }
        }
      }
      // Absolute half floats at 8 to 16 m step by ~8 mm (errors up to ~4 mm);
      // deltas of a few centimetres stay far below a tenth of a millimetre.
      expect(worst).toBeLessThan(1e-4);
    }
  });
});
