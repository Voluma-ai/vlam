import { describe, expect, it } from 'vitest';
import { writeCovariance, type SplatData } from '../../lib/core/splat-data';
import {
  CsgsDecoder,
  createCsgsFrameBuffers,
  evaluateCsgsFrame,
  prepareCsgsSection,
} from '../../lib/formats/csgs';
import { csgsGpuHalfSafe } from '../../lib/formats/csgs/csgs-gpu-layout';
import { buildGooseWalk } from './goose-walk';

/** A stand-in goose: splats spread over the sprite's 12 × 16 pixel footprint. */
function fakeGoose(count: number): SplatData {
  let seed = 3;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    // 3DGS orientation: y down, the feet at the largest y.
    positions.set([(random() - 0.5) * 0.74, (random() - 0.5) * 1, (random() - 0.5) * 0.09], i * 3);
    colors.set([255 * random(), 255 * random(), 255 * random(), 40 + 215 * random()], i * 4);
    writeCovariance(
      covariances,
      i,
      0.004 + 0.01 * random(),
      0.004 + 0.01 * random(),
      0.004 + 0.01 * random(),
      random() - 0.5,
      random() - 0.5,
      random() - 0.5,
      random() - 0.5,
    );
  }
  return { count, positions, colors, covariances };
}

describe('buildGooseWalk', () => {
  const data = fakeGoose(600);
  const clip = buildGooseWalk(data);
  const decoder = new CsgsDecoder();
  const sections = clip.files.map((bytes) =>
    prepareCsgsSection(decoder.decode(bytes), decoder.params!),
  );

  it('writes a keyed section and deltas that decode, loop and fit the GPU path', () => {
    expect(clip.scene.sections.map((s) => [s.g0, s.nframes])).toEqual([
      [0, 16],
      [16, 16],
      [32, 16],
      [48, 16],
    ]);
    expect(sections.every((section) => section.count === data.count)).toBe(true);
    expect(sections.every(csgsGpuHalfSafe)).toBe(true);
    // Deltas carry no SH and no absolute knots.
    expect(clip.files[1]!.length).toBeLessThan(clip.files[0]!.length);
  });

  it('keeps every splat, upright, with its shape and color', () => {
    const frame = evaluateCsgsFrame(sections[0]!, 0, createCsgsFrameBuffers(data.count));
    expect(frame.count).toBe(data.count);
    // The clip is in Morton order; match splats by color and position.
    let floor = -Infinity;
    for (let i = 0; i < data.count; i++) floor = Math.max(floor, data.positions[i * 3 + 1]!);
    let matched = 0;
    for (let i = 0; i < data.count; i++) {
      const x = data.positions[i * 3]!;
      const y = floor - data.positions[i * 3 + 1]!;
      const z = -data.positions[i * 3 + 2]!;
      for (let j = 0; j < frame.count; j++) {
        // Within the walk's largest offsets (a lifted foot, the head bob).
        if (
          Math.abs(frame.positions[j * 3]! - x) > 0.07 ||
          Math.abs(frame.positions[j * 3 + 1]! - y) > 0.08 ||
          Math.abs(frame.positions[j * 3 + 2]! - z) > 0.001 ||
          Math.abs(frame.colors[j * 4]! - data.colors[i * 4]!) > 2 ||
          Math.abs(frame.colors[j * 4 + 1]! - data.colors[i * 4 + 1]!) > 2
        ) {
          continue;
        }
        // Half a turn about X: xy and xz change sign.
        const expected = [1, -1, -1, 1, 1, 1].map((sign, c) => sign * data.covariances[i * 6 + c]!);
        const scale = Math.max(...expected.map(Math.abs));
        const close = expected.every(
          (value, c) => Math.abs(frame.covariances[j * 6 + c]! - value) < 0.08 * scale,
        );
        if (close) {
          matched++;
          break;
        }
      }
    }
    expect(matched).toBeGreaterThan(data.count * 0.97);
  });

  it('ends each section on the pose the next one starts with', () => {
    const buffers = [createCsgsFrameBuffers(data.count), createCsgsFrameBuffers(data.count)];
    for (let s = 0; s < 4; s++) {
      const end = evaluateCsgsFrame(sections[s]!, s * 16 + 15, buffers[0]);
      const next = evaluateCsgsFrame(sections[(s + 1) % 4]!, ((s + 1) % 4) * 16, buffers[1]);
      let worst = 0;
      for (let i = 0; i < data.count * 3; i++) {
        worst = Math.max(worst, Math.abs(end.positions[i]! - next.positions[i]!));
      }
      // One frame of motion at most (a foot swings ~11 mm per frame).
      expect(worst, `section ${s}`).toBeLessThan(0.02);
    }
  });
});
