import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CsgsDecoder,
  csgsCrc32,
  type CsgsParams,
  type CsgsSection,
} from '../formats/csgs/parse-csgs';
import {
  createCsgsFrameBuffers,
  evaluateCsgsFrame,
  prepareCsgsSection,
  sampleCsgsCurve,
} from '../formats/csgs/csgs-frame';

/**
 * Synthetic version-1 streams from Faltwerk's own decoder tests (MIT; random
 * content, no scene data), with the Python reference decoder's output: every
 * integer array as a CRC over its int32 image (`ref.json`) plus the raw arrays
 * (`ref.bin`) for pinpointing a mismatch, and float64 curve samples.
 */
const FIXTURES = join(import.meta.dirname, 'fixtures', 'csgs');

interface Reference {
  n: number;
  n_cont: number;
  key: boolean;
  g0: number;
  nframes: number;
  arrays: { name: string; len: number; crc32: number }[];
  curve: {
    times: number[];
    splats: { i: number; vals: Record<string, number[][]>; sn: number[] }[];
  };
}

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, `${name}.csgs`)));
}

function decodedArrays(section: CsgsSection, params: CsgsParams): Record<string, Int32Array> {
  const out: Record<string, Int32Array> = {
    ids: new Int32Array(section.ids.buffer.slice(0)),
    birth: Int32Array.from(section.birth),
    death: Int32Array.from(section.death),
  };
  params.groups.forEach(([tag], g) => {
    out[`k_${tag}`] = Int32Array.from(section.k[g] as Uint8Array);
    out[`knots_${tag}`] = section.knots[g] as Int32Array;
  });
  out.sn = Int32Array.from(section.sn);
  return out;
}

function checkStream(names: string[]): void {
  const decoder = new CsgsDecoder();
  for (const name of names) {
    const reference = JSON.parse(
      new TextDecoder().decode(readFileSync(join(FIXTURES, `${name}.ref.json`))),
    ) as Reference;
    const raw = readFileSync(join(FIXTURES, `${name}.ref.bin`));
    const section = decoder.decode(readFixture(name));
    const params = decoder.params!;
    expect(section.n, `${name}: n`).toBe(reference.n);
    expect(section.nCont).toBe(reference.n_cont);
    expect(section.key).toBe(reference.key);
    expect(section.g0).toBe(reference.g0);
    expect(section.nframes).toBe(reference.nframes);
    const mine = decodedArrays(section, params);
    let offset = 0;
    for (const array of reference.arrays) {
      const got = mine[array.name];
      expect(got, `${name}: missing ${array.name}`).toBeDefined();
      expect(got!.length, `${name}.${array.name} length`).toBe(array.len);
      const want = new Int32Array(
        raw.buffer.slice(raw.byteOffset + offset * 4, raw.byteOffset + (offset + array.len) * 4),
      );
      expect(Array.from(got!), `${name}.${array.name}`).toEqual(Array.from(want));
      expect(csgsCrc32(new Uint8Array(got!.buffer, got!.byteOffset, got!.byteLength))).toBe(
        array.crc32,
      );
      offset += array.len;
    }
    // The float64 oracle versus float32 knots: relative error well under 1e-5.
    const prepared = prepareCsgsSection(section, params);
    const value = new Float32Array(4);
    for (const splat of reference.curve.splats) {
      reference.curve.times.forEach((t, ti) => {
        ['P', 'R', 'S', 'O', 'D'].forEach((tag, g) => {
          sampleCsgsCurve(prepared, g, splat.i, t, value);
          const want = splat.vals[tag]![ti]!;
          if (tag === 'R') {
            const norm = Math.hypot(value[0]!, value[1]!, value[2]!, value[3]!) || 1;
            for (let c = 0; c < 4; c++) value[c] = value[c]! / norm;
          }
          want.forEach((w, c) => {
            expect(
              Math.abs(value[c]! - w) / Math.max(1, Math.abs(w)),
              `${name} ${tag}`,
            ).toBeLessThan(2e-6);
          });
        });
      });
      const snBase = params.offsets.length - params.nSn;
      splat.sn.forEach((w, c) => {
        const v =
          params.offsets[snBase + c]! +
          section.sn[splat.i * params.nSn + c]! * params.scales[snBase + c]!;
        expect(Math.abs(v - w) / Math.max(1, Math.abs(w))).toBeLessThan(2e-6);
      });
    }
  }
}

describe('parseCsgs', () => {
  it('decodes a shared-knot key/delta/key stream bit-exactly', () => {
    checkStream(['synth_shared_s0000', 'synth_shared_s0001', 'synth_shared_s0002']);
  });

  it('decodes a residual-first-knot stream bit-exactly', () => {
    checkStream(['synth_res_s0000', 'synth_res_s0001']);
  });

  it('allows random access at a key section and refuses a delta section alone', () => {
    expect(() => new CsgsDecoder().decode(readFixture('synth_shared_s0001'))).toThrow(
      /seek to a key section/,
    );
    expect(new CsgsDecoder().decode(readFixture('synth_shared_s0002')).key).toBe(true);
  });

  it('rejects later container versions and unknown flags', () => {
    for (const flag of [4, 8, 16, 32, 64]) {
      const bytes = readFixture('synth_res_s0000');
      bytes[5] = bytes[5]! | flag;
      expect(() => new CsgsDecoder().decode(bytes), `flag ${flag}`).toThrow(/not supported/);
    }
    const unknown = readFixture('synth_res_s0000');
    unknown[5] = unknown[5]! | 128;
    expect(() => new CsgsDecoder().decode(unknown)).toThrow(/CRC mismatch|unknown flags/);
    const v2 = readFixture('synth_res_s0000');
    v2[4] = 2;
    expect(() => new CsgsDecoder().decode(v2)).toThrow(/CRC mismatch|not supported/);
  });

  it('detects corruption through the CRC', () => {
    const bytes = readFixture('synth_res_s0000');
    bytes[bytes.length >> 1] = bytes[bytes.length >> 1]! ^ 0x40;
    expect(() => new CsgsDecoder().decode(bytes)).toThrow(/CRC mismatch/);
  });

  it('evaluates a frame into SplatData with only the alive splats', () => {
    const decoder = new CsgsDecoder();
    const section = decoder.decode(readFixture('synth_shared_s0000'));
    const prepared = prepareCsgsSection(section, decoder.params!);
    const buffers = createCsgsFrameBuffers(prepared.count);
    const frames: number[] = [];
    for (let f = section.g0; f < section.g0 + section.nframes; f++) {
      const data = evaluateCsgsFrame(prepared, f, buffers);
      let alive = 0;
      for (let i = 0; i < prepared.count; i++) {
        if (f >= prepared.birthFrame[i]! && f < prepared.deathFrame[i]!) alive++;
      }
      expect(data.count).toBe(alive);
      expect(data.positions.length).toBe(alive * 3);
      expect(data.colors.length).toBe(alive * 4);
      expect(data.covariances.length).toBe(alive * 6);
      expect(data.shPacked?.packed.length).toBe(alive * 15);
      expect(data.shPacked?.bands).toBe(3);
      // Every alive splat keeps its own SH words after compaction.
      let j = 0;
      for (let i = 0; i < prepared.count; i++) {
        if (f < prepared.birthFrame[i]! || f >= prepared.deathFrame[i]!) continue;
        expect(
          Array.from(data.shPacked!.packed.subarray(j * 15, (j + 1) * 15)),
          `frame ${f} splat ${i}`,
        ).toEqual(Array.from(prepared.shPacked.packed.subarray(i * 15, (i + 1) * 15)));
        j++;
      }
      expect(Array.from(data.positions).every(Number.isFinite)).toBe(true);
      expect(Array.from(data.covariances).every(Number.isFinite)).toBe(true);
      frames.push(alive);
    }
    expect(Math.max(...frames)).toBeGreaterThan(0);
    // Half a frame later interpolates: a moving splat's position changes.
    const whole = evaluateCsgsFrame(prepared, section.g0, createCsgsFrameBuffers(prepared.count));
    const half = evaluateCsgsFrame(
      prepared,
      section.g0 + 0.5,
      createCsgsFrameBuffers(prepared.count),
    );
    expect(whole.count).toBe(half.count);
    expect(Array.from(whole.positions)).not.toEqual(Array.from(half.positions));
  });

  it('keeps every splat in its own slot with allSlots, dead ones drawing nothing', () => {
    const decoder = new CsgsDecoder();
    const section = decoder.decode(readFixture('synth_shared_s0000'));
    const prepared = prepareCsgsSection(section, decoder.params!);
    let sawDead = false;
    for (let f = section.g0; f < section.g0 + section.nframes; f++) {
      const packed = evaluateCsgsFrame(prepared, f, createCsgsFrameBuffers(prepared.count));
      const slots = evaluateCsgsFrame(prepared, f, createCsgsFrameBuffers(prepared.count), {
        allSlots: true,
      });
      expect(slots.count).toBe(prepared.count);
      // The section's own SH words, in slot order.
      expect(slots.shPacked?.packed).toBe(prepared.shPacked.packed);
      let j = 0;
      for (let i = 0; i < prepared.count; i++) {
        const alive = f >= prepared.birthFrame[i]! && f < prepared.deathFrame[i]!;
        if (!alive) {
          sawDead = true;
          expect(slots.colors[i * 4 + 3], `frame ${f} slot ${i}`).toBe(0);
          expect(Array.from(slots.covariances.subarray(i * 6, i * 6 + 6))).toEqual([
            0, 0, 0, 0, 0, 0,
          ]);
          expect(
            Array.from(slots.positions.subarray(i * 3, i * 3 + 3)).every(Number.isFinite),
          ).toBe(true);
          continue;
        }
        // An alive slot holds exactly what the packed frame holds for it.
        expect(Array.from(slots.positions.subarray(i * 3, i * 3 + 3))).toEqual(
          Array.from(packed.positions.subarray(j * 3, j * 3 + 3)),
        );
        expect(Array.from(slots.colors.subarray(i * 4, i * 4 + 4))).toEqual(
          Array.from(packed.colors.subarray(j * 4, j * 4 + 4)),
        );
        expect(Array.from(slots.covariances.subarray(i * 6, i * 6 + 6))).toEqual(
          Array.from(packed.covariances.subarray(j * 6, j * 6 + 6)),
        );
        j++;
      }
      expect(j).toBe(packed.count);
    }
    expect(sawDead).toBe(true);
  });
});
