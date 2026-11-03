import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeCovariance } from '../lib/core/splat-data';
import {
  CsgsDecoder,
  createCsgsFrameBuffers,
  evaluateCsgsFrame,
  prepareCsgsSection,
} from '../lib/formats/csgs';
import {
  CSGS_BOUNDS_MARKERS,
  CSGS_HALF_MAX,
  csgsGpuHalfSafe,
  packCsgsGpuSection,
  sampleCsgsGpuSection,
} from './csgs-gpu-layout';

const FIXTURES = join(import.meta.dirname, '..', 'lib', '__tests__', 'fixtures', 'csgs');

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
      expect(packed.pool.count).toBe(prepared.count + CSGS_BOUNDS_MARKERS);
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
          const dims = [3, 4, 3, 1, 3];
          if (dims.some((d, g) => knots(g, i, d).largest > CSGS_HALF_MAX)) continue;
          compared++;
          const p = knots(0, i, 3).largest;
          for (let c = 0; c < 3; c++) {
            expect(Math.abs(gpu.position[c]! - cpu.positions[i * 3 + c]!), at).toBeLessThanOrEqual(
              2 * HALF * p + 1e-6,
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
      for (const values of prepared.knots) {
        for (const v of values) largest = Math.max(largest, Math.abs(v));
      }
      expect(csgsGpuHalfSafe(prepared), name).toBe(largest <= CSGS_HALF_MAX);
      if (!csgsGpuHalfSafe(prepared)) rejected++;
    }
    // The synthetic stress streams exceed it, so both outcomes are exercised.
    expect(rejected).toBeGreaterThan(0);
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

  it('keeps the pool bounds around every position knot', () => {
    for (const { prepared } of sections()) {
      const packed = packCsgsGpuSection(prepared);
      if (prepared.count === 0) continue;
      const markers = packed.pool.positions.subarray(prepared.count * 3);
      const knots = prepared.knots[0]!;
      for (let v = 0; v < knots.length; v += 3) {
        for (let c = 0; c < 3; c++) {
          expect(knots[v + c]!).toBeGreaterThanOrEqual(markers[c]!);
          expect(knots[v + c]!).toBeLessThanOrEqual(markers[3 + c]!);
        }
      }
      // The markers draw nothing.
      expect(packed.pool.colors[prepared.count * 4 + 3]).toBe(0);
      expect(packed.pool.colors[(prepared.count + 1) * 4 + 3]).toBe(0);
    }
  });
});
