import * as THREE from 'three/webgpu';
import { createSelectionVolume } from '../selection';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sdfEffects,
  lightingPreset,
  revealPreset,
  depthOfFieldPreset,
  worldWarpPreset,
} from '../effects';

describe('effects module (M7.4 / M7.5)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sdfEffects exposes a modifier, setShapes and maxShapes', () => {
    const fx = sdfEffects([{ kind: 'sphere', radius: 1, mode: 'tint' }], { maxShapes: 8 });
    expect(typeof fx.modifier).toBe('function');
    expect(typeof fx.setShapes).toBe('function');
    expect(fx.maxShapes).toBe(8);
  });

  it('sdfEffects defaults maxShapes to 32 and clamps to at least 1', () => {
    expect(sdfEffects().maxShapes).toBe(32);
    expect(sdfEffects([], { maxShapes: 0 }).maxShapes).toBe(1);
  });

  it('warns once when more shapes than maxShapes are set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fx = sdfEffects([], { maxShapes: 2 });
    const many = Array.from({ length: 5 }, () => ({
      kind: 'sphere' as const,
      radius: 1,
      mode: 'tint' as const,
    }));
    fx.setShapes(many);
    fx.setShapes(many);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/exceeds maxShapes=2/);
  });

  it('accepts every shape kind and mode without throwing', () => {
    const fx = sdfEffects([], { maxShapes: 8 });
    expect(() =>
      fx.setShapes([
        {
          kind: 'sphere',
          center: [0, 1, 2],
          radius: 0.5,
          color: [1, 0, 0],
          falloff: 0.1,
          mode: 'tint',
        },
        { kind: 'box', halfExtents: [1, 1, 1], rotation: [0, 0, 0, 1], mode: 'desaturate' },
        { kind: 'sphere', radius: 2, invert: true, strength: 0.5, mode: 'hide' },
        { kind: 'box', halfExtents: [0.2, 0.2, 0.2], mode: 'rim' },
        { kind: 'cylinder', radius: 0.75, height: 3, rotation: [0, 0, 0, 1], mode: 'tint' },
      ]),
    ).not.toThrow();
  });

  // Three inverse-affine rows, dimensions/falloff, color/mode, kind/invert/strength.
  const STRIDE = 6;

  it('allocates maxShapes × stride vec4 slots', () => {
    const fx = sdfEffects([], { maxShapes: 4 });
    expect(fx._uniforms.slots.length).toBe(4 * STRIDE);
    expect(fx._uniforms.count.value).toBe(0);
  });

  it('packs a full sphere shape into its uniform slots', () => {
    const fx = sdfEffects([], { maxShapes: 4 });
    fx.setShapes([
      {
        kind: 'sphere',
        center: [1, 2, 3],
        radius: 0.5,
        color: [0.1, 0.2, 0.3],
        falloff: 0.25,
        invert: true,
        strength: 0.75,
        mode: 'tint',
      },
    ]);
    const s = fx._uniforms.slots;
    expect(s[0]!.toArray()).toEqual([1, 0, 0, -1]);
    expect(s[1]!.toArray()).toEqual([0, 1, 0, -2]);
    expect(s[2]!.toArray()).toEqual([0, 0, 1, -3]);
    expect(s[3]!.toArray()).toEqual([0.5, 0, 0, 0.25]); // radius + falloff
    expect(s[4]!.toArray()).toEqual([0.1, 0.2, 0.3, 0]); // color + mode 'tint'
    expect(s[5]!.toArray()).toEqual([0, 1, 0.75, 0]); // invert + strength
    expect(fx._uniforms.count.value).toBe(1);
  });

  it('packs a rotated box into the second shape slot group', () => {
    const fx = sdfEffects([], { maxShapes: 4 });
    fx.setShapes([
      { kind: 'sphere', radius: 1, mode: 'tint' },
      {
        kind: 'box',
        center: [-1, 0, 4],
        halfExtents: [0.5, 1.5, 2.5],
        rotation: [0.1, 0.2, 0.3, 0.9],
        color: [1, 0, 1],
        falloff: 0.05,
        mode: 'hide',
      },
    ]);
    const s = fx._uniforms.slots;
    const b = 1 * STRIDE;
    const sample = new THREE.Vector4(2, -1, 5, 1);
    const actual = new THREE.Vector3(
      s[b]!.dot(sample),
      s[b + 1]!.dot(sample),
      s[b + 2]!.dot(sample),
    );
    // Independent expression used by the legacy shader, including non-unit q.
    const v = new THREE.Vector3(3, -1, 1);
    const u = new THREE.Vector3(0.1, 0.2, 0.3);
    const t = u.clone().cross(v).multiplyScalar(2);
    const expected = v.clone().addScaledVector(t, -0.9).add(u.clone().cross(t));
    expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
    expect(s[b + 3]!.toArray()).toEqual([0.5, 1.5, 2.5, 0.05]); // halfExtents + falloff
    expect(s[b + 4]!.toArray()).toEqual([1, 0, 1, 2]); // color + mode 'hide'
    expect(s[b + 5]!.toArray()).toEqual([1, 0, 1, 0]); // defaults: no invert, strength 1
    expect(fx._uniforms.count.value).toBe(2);
  });

  it('packs each mode to its documented index', () => {
    const fx = sdfEffects([], { maxShapes: 4 });
    fx.setShapes([
      { kind: 'sphere', radius: 1, mode: 'tint' },
      { kind: 'sphere', radius: 1, mode: 'desaturate' },
      { kind: 'sphere', radius: 1, mode: 'hide' },
      { kind: 'sphere', radius: 1, mode: 'rim' },
    ]);
    const modes = [0, 1, 2, 3].map((i) => fx._uniforms.slots[i * STRIDE + 4]!.w);
    expect(modes).toEqual([0, 1, 2, 3]);
  });

  it('applies defaults for omitted optional fields', () => {
    const fx = sdfEffects([], { maxShapes: 2 });
    fx.setShapes([{ kind: 'sphere', radius: 2, mode: 'rim' }]);
    const s = fx._uniforms.slots;
    expect(s[0]!.toArray()).toEqual([1, 0, 0, -0]);
    expect(s[3]!.toArray()).toEqual([2, 0, 0, 0]); // falloff defaults to 0
    expect(s[4]!.toArray()).toEqual([1, 1, 1, 3]); // color defaults to white
    expect(s[5]!.toArray()).toEqual([0, 0, 1, 0]); // invert 0, strength 1
  });

  it('throws on a sphere without a positive radius', () => {
    const fx = sdfEffects([], { maxShapes: 4 });
    expect(() => fx.setShapes([{ kind: 'sphere', mode: 'tint' }])).toThrow(/positive\s+radius/);
    expect(() => fx.setShapes([{ kind: 'sphere', radius: 0, mode: 'tint' }])).toThrow(/shape 0/);
    expect(() => fx.setShapes([{ kind: 'sphere', radius: -1, mode: 'tint' }])).toThrow(Error);
  });

  it('throws on a box without positive halfExtents', () => {
    const fx = sdfEffects([], { maxShapes: 4 });
    expect(() => fx.setShapes([{ kind: 'box', mode: 'hide' }])).toThrow(/halfExtents/);
    expect(() => fx.setShapes([{ kind: 'box', halfExtents: [1, 0, 1], mode: 'hide' }])).toThrow(
      /three positive components/,
    );
    expect(() => fx.setShapes([{ kind: 'box', halfExtents: [1, 1, -1], mode: 'hide' }])).toThrow(
      /shape 0/,
    );
  });

  it('packs a cylinder as radius + half-height under kind index 2', () => {
    const fx = sdfEffects([], { maxShapes: 4 });
    fx.setShapes([
      {
        kind: 'cylinder',
        center: [0, 2, 0],
        radius: 0.5,
        height: 3,
        rotation: [0, 0.7071, 0, 0.7071],
        color: [0, 1, 0],
        falloff: 0.2,
        mode: 'rim',
      },
    ]);
    const s = fx._uniforms.slots;
    expect(s[1]!.toArray()).toEqual([0, 1, 0, -2]);
    // The shader wants a half-height (sdCappedCylinder), the API takes a full
    // height - the halving happens here, so it must be asserted here.
    expect(s[3]!.toArray()).toEqual([0.5, 1.5, 0, 0.2]);
    expect(s[4]!.toArray()).toEqual([0, 1, 0, 3]); // color + mode 'rim'
    expect(s[5]!.x).toBe(2);
    expect(fx._uniforms.count.value).toBe(1);
  });

  it('throws on a cylinder without a positive radius or height', () => {
    const fx = sdfEffects([], { maxShapes: 4 });
    expect(() => fx.setShapes([{ kind: 'cylinder', height: 1, mode: 'tint' }])).toThrow(
      /positive\s+radius/,
    );
    expect(() => fx.setShapes([{ kind: 'cylinder', radius: 1, mode: 'tint' }])).toThrow(
      /positive\s+height/,
    );
    expect(() => fx.setShapes([{ kind: 'cylinder', radius: 1, height: 0, mode: 'tint' }])).toThrow(
      /shape 0/,
    );
  });

  it('keeps sphere and box kind indices stable now that a third kind exists', () => {
    // The in-shader kind is a 3-valued index folded with mix(), not a boolean
    // flag; a regression there would silently change box rendering too.
    const fx = sdfEffects([], { maxShapes: 4 });
    fx.setShapes([
      { kind: 'sphere', radius: 1, mode: 'tint' },
      { kind: 'box', halfExtents: [1, 1, 1], mode: 'tint' },
      { kind: 'cylinder', radius: 1, height: 2, mode: 'tint' },
    ]);
    const kinds = [0, 1, 2].map((i) => fx._uniforms.slots[i * STRIDE + 5]!.x);
    expect(kinds).toEqual([0, 1, 2]);
  });

  it('reports the offending shape index and validates before writing', () => {
    const fx = sdfEffects([], { maxShapes: 4 });
    fx.setShapes([{ kind: 'sphere', center: [9, 9, 9], radius: 3, mode: 'tint' }]);
    expect(() =>
      fx.setShapes([
        { kind: 'sphere', center: [5, 5, 5], radius: 1, mode: 'tint' },
        { kind: 'box', mode: 'hide' },
      ]),
    ).toThrow(/shape 1/);
    // The failed call must not have half-updated the uniform state.
    expect(fx._uniforms.slots[0]!.toArray()).toEqual([1, 0, 0, -9]);
    expect(fx._uniforms.count.value).toBe(1);
  });

  it('throws from the constructor for invalid initial shapes', () => {
    expect(() => sdfEffects([{ kind: 'sphere', mode: 'tint' }])).toThrow(/positive\s+radius/);
  });

  it('lightingPreset exposes a live direction uniform', () => {
    const preset = lightingPreset({ direction: [0, 1, 0], ambient: 0.2, diffuse: 0.9 });
    expect(typeof preset.modifier).toBe('function');
    expect(preset.direction.value).toBeDefined();
    preset.direction.value.set(1, 0, 0); // mutable, no throw
  });

  it('revealPreset exposes a progress uniform', () => {
    const preset = revealPreset({ frequency: 4, edge: 0.1 });
    expect(typeof preset.modifier).toBe('function');
    preset.progress.value = 0.5;
    expect(preset.progress.value).toBe(0.5);
  });

  it('depthOfFieldPreset exposes live focus and aperture uniforms', () => {
    const preset = depthOfFieldPreset({ focusDistance: 12, aperture: 0.8 });
    expect(typeof preset.modifier).toBe('function');
    expect(preset.focusDistance.value).toBe(12);
    expect(preset.aperture.value).toBe(0.8);
    preset.focusDistance.value = 20; // mutable, no throw
    expect(preset.focusDistance.value).toBe(20);
  });

  it('depthOfFieldPreset clamps a non-positive focus distance and aperture', () => {
    const preset = depthOfFieldPreset({ focusDistance: 0, aperture: -1 });
    expect(preset.focusDistance.value).toBeGreaterThan(0); // no divide-by-zero
    expect(preset.aperture.value).toBe(0);
  });

  it('worldWarpPreset exposes live intensity and radius uniforms', () => {
    const preset = worldWarpPreset({
      intensity: 0.4,
      radius: 5,
    });
    expect(typeof preset.modifier).toBe('function');
    expect(preset.intensity.value).toBe(0.4);
    expect(preset.radius.value).toBe(5);
    preset.intensity.value = -0.7;
    expect(preset.intensity.value).toBe(-0.7);
  });

  it('worldWarpPreset clamps constructor intensity and a non-positive radius', () => {
    const preset = worldWarpPreset({ intensity: 4, radius: 0 });
    expect(preset.intensity.value).toBe(1);
    expect(preset.radius.value).toBeGreaterThan(0);
    const neg = worldWarpPreset({ intensity: -3 });
    expect(neg.intensity.value).toBe(-1);
  });
});

describe('affine SDF placement', () => {
  it.each(['sphere', 'box', 'cylinder'] as const)(
    'matches CPU %s membership through shear and reflection',
    (kind) => {
      const transform = new THREE.Matrix4().set(
        -2,
        0.7,
        0,
        3,
        0,
        0.4,
        0.2,
        -1,
        0,
        0,
        1.5,
        2,
        0,
        0,
        0,
        1,
      );
      const shape = { kind, transform, radius: 1, height: 2, halfExtents: [1, 1, 1] as const };
      const volume = createSelectionVolume(shape);
      const fx = sdfEffects([{ ...shape, mode: 'tint' }]);
      const rows = fx._uniforms.slots;
      for (let x = -2; x <= 6; x += 0.3)
        for (let y = -3; y <= 2; y += 0.3) {
          const p = new THREE.Vector4(x, y, 2.4, 1);
          const q = new THREE.Vector3(rows[0]!.dot(p), rows[1]!.dot(p), rows[2]!.dot(p));
          const inside =
            kind === 'sphere'
              ? q.length() <= 1
              : kind === 'box'
                ? Math.max(Math.abs(q.x), Math.abs(q.y), Math.abs(q.z)) <= 1
                : Math.hypot(q.x, q.z) <= 1 && Math.abs(q.y) <= 1;
          expect(inside).toBe(volume.containsPoint(x, y, 2.4));
        }
      const before = rows.map((v) => v.toArray());
      transform.identity();
      expect(rows.map((v) => v.toArray())).toEqual(before);
      expect(() => fx.setShapes([{ ...shape, center: [0, 0, 0], mode: 'tint' }])).toThrow(
        /combined/,
      );
      expect(() =>
        fx.setShapes([
          { ...shape, transform: new THREE.Matrix4().makeScale(0, 1, 1), mode: 'tint' },
        ]),
      ).toThrow(/invertible/);
      expect(rows.map((v) => v.toArray())).toEqual(before);
    },
  );
});
