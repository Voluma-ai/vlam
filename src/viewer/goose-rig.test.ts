import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createProceduralGoose } from './goose-procedural';
import { createGooseRig, packGooseSurface, unpackGooseNormal } from './goose-rig';

describe('goose-rig', () => {
  it('packs the surface into a value a float32 holds exactly', () => {
    const packed = packGooseSurface(0, -1, 0, 1);
    expect(Number.isInteger(packed)).toBe(true);
    expect(packed).toBeLessThan(2 ** 24);
    expect(Math.fround(packed)).toBe(packed);
  });

  it('round-trips normals within half a degree, in every octant', () => {
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      // A Fibonacci sphere, plus the axes where the octahedron folds.
      const y = 1 - (2 * (i + 0.5)) / 2000;
      const r = Math.sqrt(1 - y * y);
      const n = [r * Math.cos(i * 2.399963), y, r * Math.sin(i * 2.399963)] as const;
      const back = unpackGooseNormal(packGooseSurface(n[0], n[1], n[2], 0.5));
      worst = Math.max(
        worst,
        Math.acos(Math.min(1, n[0] * back[0] + n[1] * back[1] + n[2] * back[2])),
      );
    }
    for (const axis of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const) {
      const back = unpackGooseNormal(packGooseSurface(axis[0], axis[1], axis[2], 0));
      worst = Math.max(
        worst,
        Math.acos(Math.min(1, axis[0] * back[0] + axis[1] * back[1] + axis[2] * back[2])),
      );
    }
    expect(worst).toBeLessThan((0.5 * Math.PI) / 180);
  });

  it('builds a skinned mesh: the library skin, then the goose light, sorted where drawn', () => {
    const goose = createProceduralGoose();
    const rig = createGooseRig(goose);
    expect(rig.mesh.modifiers).toEqual(rig.modifiers);
    expect(rig.modifiers[0]).toBe(rig.mesh.skinModifier);
    expect(rig.mesh.sortDisplacement).toHaveLength(1);
    expect(rig.skeleton.bones.map((bone) => bone.name)).toEqual(goose.rig.bones);
    expect(() => rig.setPose({ wingFold: 0, billOpen: 0.3 })).not.toThrow();
    rig.mesh.dispose();
  });

  it('grows its sort bounds when the wings spread past the folded goose', () => {
    const goose = createProceduralGoose();
    const rig = createGooseRig(goose);
    const folded = rig.mesh.computeSplatBounds();
    rig.setPose({ wingFold: 0, wingRaise: 0.8 });
    rig.mesh.refreshSkin();
    const spread = rig.mesh.computeSplatBounds();
    expect(spread.containsBox(folded)).toBe(true);
    const posed = rig.posedData();
    const reach = new THREE.Box3().setFromArray(posed.positions);
    expect(spread.containsBox(reach)).toBe(true);
    rig.mesh.dispose();
  });

  it('reports the posed goose, not the baked one, once a pose moves it', () => {
    const goose = createProceduralGoose();
    const rig = createGooseRig(goose);
    const baked = rig.posedData();
    expect(baked.count).toBe(goose.data.count);
    let rest = 0;
    for (let i = 0; i < baked.positions.length; i++) {
      rest = Math.max(rest, Math.abs(baked.positions[i]! - goose.data.positions[i]!));
    }
    expect(rest).toBeLessThan(1e-4);
    rig.setPose({ wingFold: 0, billOpen: 0.3 });
    const posed = rig.posedData();
    let moved = 0;
    for (let i = 0; i < posed.positions.length; i++) {
      moved = Math.max(moved, Math.abs(posed.positions[i]! - goose.data.positions[i]!));
    }
    expect(moved).toBeGreaterThan(0.01);
    rig.mesh.dispose();
  });
});
