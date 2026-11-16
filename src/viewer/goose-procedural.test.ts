import { describe, expect, it } from 'vitest';
import { createProceduralGoose, gooseBoneMatrices, gooseSkinMatrices } from './goose-procedural';

/** Axis-aligned extent of the goose (not its ground), optionally only of bones matching `bones`. */
function extent(goose: ReturnType<typeof createProceduralGoose>, bones: RegExp = /^(?!ground$)/) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < goose.data.count; i++) {
    if (!bones.test(goose.rig.bones[goose.rig.splatBones[i * 2] as number] as string)) {
      continue;
    }
    for (let c = 0; c < 3; c++) {
      const value = goose.data.positions[i * 3 + c] as number;
      min[c] = Math.min(min[c] as number, value);
      max[c] = Math.max(max[c] as number, value);
    }
  }
  return { min, max };
}

/** Element-wise equality without the cost of a matcher per element. */
function sameValues(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Each createProceduralGoose() is ~0.8 s idle and several times that on a loaded CI runner.
const BUILD_TIMEOUT = 30_000;

describe('goose-procedural', { timeout: BUILD_TIMEOUT }, () => {
  const goose = createProceduralGoose();

  it('builds valid splat data', () => {
    const { data } = goose;
    expect(data.count).toBeGreaterThan(100_000);
    expect(data.count).toBeLessThan(500_000);
    expect(data.positions).toHaveLength(data.count * 3);
    expect(data.colors).toHaveLength(data.count * 4);
    expect(data.covariances).toHaveLength(data.count * 6);
    expect(data.positions.every(Number.isFinite)).toBe(true);
    for (let i = 0; i < data.count; i++) {
      const [m00, m01, m02, m11, m12, m22] = data.covariances.subarray(i * 6, i * 6 + 6);
      // Positive definite: every leading principal minor is positive.
      const minor = m00! * m11! - m01! * m01!;
      const det =
        m00! * (m11! * m22! - m12! * m12!) -
        m01! * (m01! * m22! - m12! * m02!) +
        m02! * (m01! * m12! - m11! * m02!);
      if (!(m00! > 0 && minor > 0 && det > 0)) {
        throw new Error(`splat ${i} has a degenerate covariance`);
      }
    }
  });

  it('stands on the ground at goose size, symmetric left to right', () => {
    const { min, max } = extent(goose);
    expect(min[1]).toBeGreaterThan(-0.005);
    expect(min[1]).toBeLessThan(0.01);
    expect(max[1]).toBeGreaterThan(0.6);
    expect(max[1]).toBeLessThan(0.8);
    expect((max[0] as number) - (min[0] as number)).toBeGreaterThan(0.5);
    expect((max[2] as number) + (min[2] as number)).toBeCloseTo(0, 3);
  });

  it('is deterministic for a seed', () => {
    const again = createProceduralGoose();
    expect(sameValues(again.data.positions, goose.data.positions)).toBe(true);
    expect(sameValues(again.data.colors, goose.data.colors)).toBe(true);
    const other = createProceduralGoose({ seed: 2 });
    expect(sameValues(other.data.positions, goose.data.positions)).toBe(false);
  });

  it('carries a rig that covers every splat', () => {
    const { rig, data } = goose;
    expect(rig.parents).toHaveLength(rig.bones.length);
    expect(rig.boneMatrices).toHaveLength(rig.bones.length * 12);
    expect(rig.splatBones).toHaveLength(data.count * 2);
    expect(rig.splatWeights).toHaveLength(data.count);
    expect(rig.splatBones.reduce((a, b) => Math.max(a, b), 0)).toBeLessThan(rig.bones.length);
    expect(rig.bones).toContain('head');
    expect(rig.bones).toContain('primary9.L');
    // Two roots: the body, and the ground it stands on.
    expect(rig.parents.filter((parent) => parent < 0)).toHaveLength(2);
    expect(createProceduralGoose({ ground: false }).data.count).toBeLessThan(data.count);
    // No bone is there for nothing: each one has splats of its own.
    expect(new Set(rig.splatBones).size).toBe(rig.bones.length);
  });

  it('spreads the wings from the same splats', () => {
    const spread = createProceduralGoose({ pose: { wingFold: 0 } });
    expect(spread.data.count).toBe(goose.data.count);
    const folded = extent(goose);
    const open = extent(spread);
    expect((folded.max[2] as number) - (folded.min[2] as number)).toBeLessThan(0.3);
    expect((open.max[2] as number) - (open.min[2] as number)).toBeGreaterThan(1.2);
    // The pose only moves what is bound to the wings.
    const wing = /^(humerus|forearm|hand|primary|secondary|tertial)/;
    const isWing = goose.rig.bones.map((name) => wing.test(name));
    let strays = 0;
    for (let i = 0; i < goose.data.count; i++) {
      if (isWing[goose.rig.splatBones[i * 2] as number]) continue;
      for (let c = 0; c < 3; c++) {
        if (spread.data.positions[i * 3 + c] !== goose.data.positions[i * 3 + c]) strays++;
      }
    }
    expect(strays).toBe(0);
  });

  it('opens the bill by moving only the lower mandible', () => {
    const open = createProceduralGoose({ pose: { billOpen: 0.4 } });
    const jawBone = goose.rig.bones.indexOf('jaw');
    let moved = 0;
    let wrong = 0;
    for (let i = 0; i < goose.data.count; i++) {
      const jaw = goose.rig.splatBones[i * 2] === jawBone;
      const same =
        open.data.positions[i * 3] === goose.data.positions[i * 3] &&
        open.data.positions[i * 3 + 1] === goose.data.positions[i * 3 + 1];
      if (same === jaw) wrong++;
      if (jaw) moved++;
    }
    expect(wrong).toBe(0);
    expect(moved).toBeGreaterThan(100);
    // The tip of the lower mandible drops.
    expect(extent(open, /^jaw$/).min[1]).toBeLessThan(
      (extent(goose, /^jaw$/).min[1] as number) - 0.01,
    );
  });

  it('reposes the baked splats through the skin matrices, as the GPU rig does', () => {
    expect(sameValues(gooseBoneMatrices(), goose.rig.boneMatrices)).toBe(true);
    const pose = { wingFold: 0, wingRaise: 0.3, neckCurl: 0.1, neckTwist: -0.1, billOpen: 0.3 };
    const direct = createProceduralGoose({ pose });
    const skins = gooseSkinMatrices(gooseBoneMatrices(pose), goose.rig.boneMatrices);
    let worst = 0;
    for (let i = 0; i < goose.data.count; i++) {
      const a = (goose.rig.splatBones[i * 2] as number) * 12;
      const b = (goose.rig.splatBones[i * 2 + 1] as number) * 12;
      const w = goose.rig.splatWeights[i] as number;
      const p = goose.data.positions.subarray(i * 3, i * 3 + 3);
      for (let row = 0; row < 3; row++) {
        let value = 0;
        for (let k = 0; k < 4; k++) {
          const m =
            (skins[a + row * 4 + k] as number) * w + (skins[b + row * 4 + k] as number) * (1 - w);
          value += m * (k < 3 ? (p[k] as number) : 1);
        }
        worst = Math.max(worst, Math.abs(value - (direct.data.positions[i * 3 + row] as number)));
      }
    }
    // Float32 round-off only: the bake and the rig are the same skinning.
    expect(worst).toBeLessThan(1e-5);
  });

  it('keeps what the lighting was baked from', () => {
    const { surface, data } = goose;
    expect(surface.albedo).toHaveLength(data.count * 4);
    expect(surface.gloss).toHaveLength(data.count);
    // The folded wings shade some of the flank, and never a wing or the ground.
    const shaded = new Set<string>();
    surface.wingShade.forEach((shade, i) => {
      if (shade > 0) shaded.add(goose.rig.bones[goose.rig.splatBones[i * 2] as number] as string);
    });
    expect(shaded.has('body')).toBe(true);
    expect(
      [...shaded].filter((name) => /^(ground|humerus|primary|secondary|tertial)/.test(name)),
    ).toEqual([]);
    let wrong = 0;
    for (let i = 0; i < data.count; i++) {
      const n = surface.normals.subarray(i * 3, i * 3 + 3);
      if (Math.abs(Math.hypot(n[0] as number, n[1] as number, n[2] as number) - 1) > 1e-4) wrong++;
      if (surface.albedo[i * 4 + 3] !== data.colors[i * 4 + 3]) wrong++;
    }
    expect(wrong).toBe(0);
    // The lit colors differ from the albedo: the bake did light them.
    expect(sameValues(surface.albedo, data.colors)).toBe(false);
  });
});
