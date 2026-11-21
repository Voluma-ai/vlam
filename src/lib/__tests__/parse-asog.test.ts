import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASOG_MOTION,
  ASOG_MOTION_FLOATS,
  asogClipWeight,
  asogMotionBounds,
  createAsogFrameBuffers,
  evaluateAsogFrame,
  evaluateAsogSplat,
  isAsogFile,
  parseAsog,
  writeAsogCanonical,
  type AsogData,
} from '../formats/asog';
import { encodeAsog, syntheticAsog, syntheticAsogStreams } from '../../tools/asog/encode-asog';
import { decodeAsog, type ReferenceAsogData } from './fixtures/animated-sog/decode.js';
import {
  createMotion,
  evaluateSplat,
  clipWeight,
  readMotion,
} from './fixtures/animated-sog/motion.js';
import { getHalfTable } from './fixtures/animated-sog/half.js';

/**
 * The `.asog` port against the vendored animated-sog reference decoder
 * (`fixtures/animated-sog`, MIT): decode a synthetic file with both, then
 * compare every attribute and the motion at many times. The reference keeps
 * anchor, Ω and G in half floats, so motion agrees to half precision.
 */

/** `bytes` with its JSON manifest edited by `edit` (the payload moves after it). */
function withManifest(
  bytes: Uint8Array,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- edits write invalid values on purpose
  edit: (manifest: any) => unknown,
): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const field = (offset: number) => Number(view.getBigUint64(offset, true));
  const manifestOffset = field(16);
  const manifestLength = field(24);
  const payloadOffset = field(32);
  const payloadLength = field(40);
  const manifest: unknown = JSON.parse(
    new TextDecoder().decode(bytes.subarray(manifestOffset, manifestOffset + manifestLength)),
  );
  edit(manifest);
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const payload = bytes.subarray(payloadOffset, payloadOffset + payloadLength);
  const out = new Uint8Array(64 + json.length + payload.length);
  out.set(bytes.subarray(0, 64));
  out.set(json, 64);
  out.set(payload, 64 + json.length);
  const header = new DataView(out.buffer);
  header.setBigUint64(16, 64n, true);
  header.setBigUint64(24, BigInt(json.length), true);
  header.setBigUint64(32, BigInt(64 + json.length), true);
  header.setBigUint64(40, BigInt(payload.length), true);
  return out;
}

async function both(bytes: Uint8Array): Promise<{ ours: AsogData; ref: ReferenceAsogData }> {
  const ours = await parseAsog(bytes.slice());
  const ref = await decodeAsog(bytes.slice().buffer);
  return { ours, ref };
}

describe('parseAsog', () => {
  it('reads the container and agrees with the reference on static attributes', async () => {
    const bytes = await syntheticAsog({ count: 3000, coeffs: 8 });
    expect(isAsogFile(bytes)).toBe(true);
    const { ours, ref } = await both(bytes);
    expect(ours.count).toBe(3000);
    expect(ours.shBands).toBe(2);
    expect(ref.shBands).toBe(2);
    // Centres: the reference's own float32 centres.
    expect(Array.from(ours.centers)).toEqual(Array.from(ref.centers!));

    const quats = ref.sog.quats as Uint8Array;
    const scales = ref.sog.scales as Uint8Array;
    const sh0 = ref.sog.sh0 as Uint8Array;
    const { manifest } = ours;
    for (let i = 0; i < ours.count; i++) {
      // The rotation's three stored components, in the reference's SOG texel.
      const mode = quats[i * 4 + 3]! - 252;
      const q = Array.from(ours.rotations.subarray(i * 4, i * 4 + 4));
      const stored = q.filter((_, k) => k !== mode);
      for (let k = 0; k < 3; k++) {
        expect(stored[k]).toBeCloseTo((quats[i * 4 + k]! / 255 - 0.5) * Math.SQRT2, 6);
      }
      // Smallest-three quantisation keeps the rotation close to unit length.
      expect(Math.abs(Math.hypot(...q) - 1)).toBeLessThan(0.02);
      for (let c = 0; c < 3; c++) {
        expect(ours.scales[i * 3 + c]).toBeCloseTo(
          Math.exp(manifest.scales.codebook[scales[i * 4 + c]!]!),
          5,
        );
        const color = 0.5 + 0.28209479177387814 * manifest.sh0.codebook[sh0[i * 4 + c]!]!;
        expect(ours.colors[i * 4 + c]).toBe(Math.round(Math.min(1, Math.max(0, color)) * 255));
      }
      expect(ours.colors[i * 4 + 3]).toBe(sh0[i * 4 + 3]);
    }

    // SH: labels and the palette in the SOG centroids layout.
    const labels = ref.sog.sh_labels as Uint8Array;
    const centroids = ref.sog.sh_centroids as Uint8Array;
    for (let i = 0; i < ours.count; i++) {
      expect(ours.sh!.labels[i]).toBe(labels[i * 4]! | (labels[i * 4 + 1]! << 8));
    }
    for (let texel = 0; texel < centroids.length / 4; texel++) {
      for (let c = 0; c < 3; c++) {
        expect(ours.sh!.palette[texel * 4 + c]).toBeCloseTo(
          manifest.shN!.codebook[centroids[texel * 4 + c]!]!,
          6,
        );
      }
    }
  });

  it('decodes the motion and evaluates it like the reference', async () => {
    const bytes = await syntheticAsog({ count: 2000, coeffs: 0, clips: 2 });
    const { ours, ref } = await both(bytes);
    const A = ref.motion.A!;
    const Af = new Float32Array(A.buffer);
    const half = getHalfTable();
    const m = createMotion();
    const outRef = new Float64Array(7);
    const out = new Float64Array(7);
    let moving = 0;
    let largestAngle = 0;
    for (let i = 0; i < ours.count; i++) {
      readMotion(A, Af, ref.motion.B!, half, ref.centers!, i, m);
      const at = i * ASOG_MOTION_FLOATS;
      expect(ours.motion[at + ASOG_MOTION.mu]).toBe(Math.fround(m.mu));
      expect(ours.motion[at + ASOG_MOTION.sigma]).toBe(Math.fround(m.sigma));
      expect(ours.motion[at + ASOG_MOTION.flags]! % 2 === 1).toBe(m.isStatic);
      expect(Math.floor(ours.motion[at + ASOG_MOTION.flags]! / 2)).toBe(m.clip);
      for (let k = 0; k < 9; k++) {
        const ourOmega = ours.motion[at + ASOG_MOTION.omega + k]!;
        expect(Math.abs(ourOmega - m.omega[k]!)).toBeLessThanOrEqual(
          1e-3 * Math.abs(ourOmega) + 1e-4,
        );
      }
      for (let s = 0; s <= 8; s++) {
        const t = m.mu + (s / 4 - 1) * 2.4 * m.sigma;
        const wRef = evaluateSplat(m, t, outRef);
        const w = evaluateAsogSplat(ours.motion, ours.centers, i, t, out);
        expect(w).toBeCloseTo(wRef, 5);
        if (wRef <= 0) continue;
        if (!m.isStatic) moving++;
        largestAngle = Math.max(largestAngle, 2 * Math.acos(Math.min(1, Math.abs(outRef[6]!))));
        // Half-float anchors and control points: a few tenths of a millimetre.
        for (let c = 0; c < 3; c++) expect(Math.abs(out[c]! - outRef[c]!)).toBeLessThan(2e-3);
        const dot =
          out[3]! * outRef[3]! + out[4]! * outRef[4]! + out[5]! * outRef[5]! + out[6]! * outRef[6]!;
        expect(Math.abs(dot)).toBeGreaterThan(1 - 1e-5);
      }
    }
    // The comparison has teeth: real motion with real rotation.
    expect(moving).toBeGreaterThan(5000);
    expect(largestAngle).toBeGreaterThan(1);

    // Clip weights, through fades.
    for (let c = 0; c < 2; c++) {
      for (let t = 0; t < 2; t += 0.01) {
        expect(asogClipWeight(ours.clips, c, t)).toBeCloseTo(clipWeight(ref.clips, c, t), 6);
      }
    }
  });

  it('evaluates frames: invisible splats get opacity 0, compact keeps the visible', async () => {
    const data = await parseAsog(await syntheticAsog({ count: 1500, coeffs: 0 }));
    const buffers = createAsogFrameBuffers(data.count);
    const slots = evaluateAsogFrame(data, 0.7, buffers);
    expect(slots.count).toBe(data.count);
    expect(slots.alive).toBeGreaterThan(0);
    expect(slots.alive).toBeLessThan(data.count);
    let opaque = 0;
    for (let i = 0; i < data.count; i++) if (buffers.colors[i * 4 + 3]! > 0) opaque++;
    expect(opaque).toBeLessThanOrEqual(slots.alive);
    const compact = createAsogFrameBuffers(data.count);
    const packed = evaluateAsogFrame(data, 0.7, compact, { compact: true });
    expect(packed.count).toBe(slots.alive);
    // Every centre of every frame stays inside the motion bounds.
    const { min, max } = asogMotionBounds(data);
    for (let frame = 0; frame < 60; frame++) {
      evaluateAsogFrame(data, frame / 30, buffers);
      for (let i = 0; i < data.count; i++) {
        for (let c = 0; c < 3; c++) {
          const x = buffers.positions[i * 3 + c]!;
          if (!(min[c]! <= x && x <= max[c]!)) {
            expect.fail(
              `Frame ${frame}, splat ${i}, axis ${c}: ${x} outside [${min[c]}, ${max[c]}]`,
            );
          }
        }
      }
    }
  });

  it('keepInvisible writes the visible splats exactly and only opacity for the rest', async () => {
    const data = await parseAsog(await syntheticAsog({ count: 2000, coeffs: 0, clips: 2 }));
    const full = createAsogFrameBuffers(data.count);
    const kept = createAsogFrameBuffers(data.count);
    writeAsogCanonical(data, kept);
    for (let frame = 0; frame < 60; frame += 7) {
      const t = frame / 30;
      const a = evaluateAsogFrame(data, t, full);
      const b = evaluateAsogFrame(data, t, kept, { keepInvisible: true });
      expect(b).toEqual(a);
      let invisible = 0;
      for (let i = 0; i < data.count; i++) {
        expect(kept.colors[i * 4 + 3]).toBe(full.colors[i * 4 + 3]);
        if (full.colors[i * 4 + 3] === 0 && a.alive < data.count) {
          invisible++;
          continue;
        }
        for (let k = 0; k < 3; k++)
          expect(kept.positions[i * 3 + k]).toBe(full.positions[i * 3 + k]);
        for (let k = 0; k < 6; k++) {
          expect(kept.covariances[i * 6 + k]).toBe(full.covariances[i * 6 + k]);
        }
      }
      expect(invisible).toBeGreaterThan(0);
    }
  });

  it('rejects other files and broken streams with a clear error', async () => {
    await expect(parseAsog(new Uint8Array(64))).rejects.toThrow(/not an \.asog file/);
    const { manifest, streams } = syntheticAsogStreams({ count: 64, coeffs: 0 });
    const withoutG = await encodeAsog(
      manifest,
      streams.filter((s) => s.name !== 'g'),
    );
    await expect(parseAsog(withoutG)).rejects.toThrow(/no "g" stream/);
    const reordered = await encodeAsog(manifest, [
      ...streams.filter((s) => s.name === 'omega'),
      ...streams.filter((s) => s.name !== 'omega'),
    ]);
    await expect(parseAsog(reordered)).rejects.toThrow(/"omega" comes before "anchor"/);
    const bytes = await encodeAsog(manifest, streams);
    await expect(parseAsog(bytes.subarray(0, bytes.length - 10))).rejects.toThrow(/truncated/);
  });

  it('rejects a manifest that would divide by zero or allocate past its streams', async () => {
    const { manifest, streams } = syntheticAsogStreams({ count: 64, coeffs: 0 });
    const bytes = await encodeAsog(manifest, streams);
    // A splat count no compressed stream of this size can hold: refused
    // before anything is allocated for it.
    const huge = withManifest(bytes, (m) => {
      m.count = 2 ** 30;
      for (const s of m.streams) if (s.count === 64) s.count = 2 ** 30;
    });
    await expect(parseAsog(huge)).rejects.toThrow(/can inflate to/);
    const zeroScale = withManifest(bytes, (m) => (m.mu.scale = 0));
    await expect(parseAsog(zeroScale)).rejects.toThrow(/mu\.scale must be positive/);
    const zeroRadius = withManifest(bytes, (m) => (m.motion.r_min = 0));
    await expect(parseAsog(zeroRadius)).rejects.toThrow(/motion\.r_min must be positive/);
    const badClip = withManifest(bytes, (m) => (m.clips[0].global.activeTimeEnd = 'end'));
    await expect(parseAsog(badClip)).rejects.toThrow(/clips\[0\]\.global\.activeTimeEnd/);
    // The untouched file still parses.
    await expect(parseAsog(withManifest(bytes, () => undefined))).resolves.toBeTruthy();
  });
});

/**
 * A real captured clip, when `VLAM_ASOG_SAMPLE=<path to an .asog>` names a
 * local copy. Captures are not committed; the check skips without one.
 */
const SAMPLE = process.env.VLAM_ASOG_SAMPLE ?? '';
describe.skipIf(!SAMPLE || !existsSync(SAMPLE))('parseAsog on a local real clip', () => {
  it('agrees with the reference across the whole file', async () => {
    const bytes = new Uint8Array(readFileSync(SAMPLE));
    const { ours, ref } = await both(bytes);
    expect(ours.count).toBe(ref.count);
    expect(Array.from(ours.centers)).toEqual(Array.from(ref.centers!));
    const A = ref.motion.A!;
    const Af = new Float32Array(A.buffer);
    const half = getHalfTable();
    const m = createMotion();
    const outRef = new Float64Array(7);
    const out = new Float64Array(7);
    let worst = 0;
    const diffs: number[] = [];
    const stride = Math.max(1, Math.floor(ours.count / 20000));
    for (let i = 0; i < ours.count; i += stride) {
      readMotion(A, Af, ref.motion.B!, half, ref.centers!, i, m);
      for (let s = 0; s <= 4; s++) {
        const t = m.mu + (s / 2 - 1) * 2 * m.sigma;
        if (evaluateSplat(m, t, outRef) <= 0) continue;
        evaluateAsogSplat(ours.motion, ours.centers, i, t, out);
        const d = Math.hypot(out[0]! - outRef[0]!, out[1]! - outRef[1]!, out[2]! - outRef[2]!);
        diffs.push(d);
        worst = Math.max(worst, d);
      }
    }
    diffs.sort((a, b) => a - b);
    const p = (q: number) => diffs[Math.floor(q * (diffs.length - 1))]!;
    console.log(
      JSON.stringify({
        count: ours.count,
        samples: diffs.length,
        p50: p(0.5),
        p99: p(0.99),
        p999: p(0.999),
        worst,
      }),
    );
    // The reference keeps anchor, Ω and G in half floats, VLAM in float32: the
    // centres agree to a few µm typically, under a millimetre for 99.9 % of
    // samples, and the fastest splats differ by up to about a centimetre.
    expect(p(0.5)).toBeLessThan(1e-4);
    expect(p(0.999)).toBeLessThan(1e-3);
    expect(worst).toBeLessThan(2e-2);
  }, 120_000);
});
