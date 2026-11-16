import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkinnedSplatMesh, computeSplatSkinWeights, type SplatSkinData } from '../dynamic';
import { writeCovariance, type SplatData } from '../core/splat-data';
import type { SplatModifier } from '../core/splat-modifier';

/**
 * `SkinnedSplatMesh` against three's own skinning: the CPU twin
 * (`posedSplatData`, which mirrors the GPU modifier's math and quantized
 * weights) must land where `THREE.SkinnedMesh.applyBoneTransform` puts the
 * same points. The GPU modifier itself is checked in pixels by
 * `browser-tests/skinned-splat-mesh.spec.ts`.
 */

/** A three-bone chain along +y: root at 0, elbow at 1, wrist at 2. */
function chain(): { root: THREE.Bone; skeleton: THREE.Skeleton; bones: THREE.Bone[] } {
  const bones = [new THREE.Bone(), new THREE.Bone(), new THREE.Bone()];
  bones[1]!.position.set(0, 1, 0);
  bones[2]!.position.set(0, 1, 0);
  bones[0]!.add(bones[1]!);
  bones[1]!.add(bones[2]!);
  bones[0]!.updateMatrixWorld(true);
  return { root: bones[0]!, skeleton: new THREE.Skeleton(bones), bones };
}

/** Splats up the chain, each weighted over up to four bones in exact 1/255 steps. */
function splatsAlongChain(count: number): { data: SplatData; skin: SplatSkinData } {
  const positions = new Float32Array(count * 3);
  const covariances = new Float32Array(count * 6);
  const indices = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const y = (2.5 * i) / count;
    positions.set([0.2 * Math.sin(i), y, 0.2 * Math.cos(i)], i * 3);
    writeCovariance(covariances, i, 0.02, 0.05, 0.01, 1, 0, 0, 0);
    const a = Math.min(Math.floor(y), 2);
    const steps = [100 + (i % 60), 60, 0];
    steps[2] = 255 - steps[0]! - steps[1]!;
    indices.set([a, (a + 1) % 3, (a + 2) % 3, 0], i * 4);
    weights.set([steps[0]! / 255, steps[1]! / 255, steps[2] / 255, 0], i * 4);
  }
  return {
    data: { count, positions, colors: new Uint8Array(count * 4).fill(255), covariances },
    skin: { bonesPerSplat: 4, indices, weights },
  };
}

/** The same points as a three.js SkinnedMesh, for its reference skinning. */
function referenceMesh(data: SplatData, skin: SplatSkinData, skeleton: THREE.Skeleton) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute(Uint16Array.from(skin.indices), 4),
  );
  geometry.setAttribute(
    'skinWeight',
    new THREE.BufferAttribute(Float32Array.from(skin.weights), 4),
  );
  const reference = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  reference.bind(skeleton, new THREE.Matrix4());
  return reference;
}

function expectMatchesReference(mesh: SkinnedSplatMesh, reference: THREE.SkinnedMesh): void {
  const posed = mesh.posedSplatData();
  const v = new THREE.Vector3();
  let worst = 0;
  for (let i = 0; i < posed.count; i++) {
    reference.getVertexPosition(i, v);
    worst = Math.max(worst, v.distanceTo(new THREE.Vector3().fromArray(posed.positions, i * 3)));
  }
  expect(worst).toBeLessThan(1e-5);
}

const meshes: SkinnedSplatMesh[] = [];
afterEach(() => {
  for (const mesh of meshes.splice(0)) mesh.dispose();
});
function make(data: SplatData, skin: SplatSkinData): SkinnedSplatMesh {
  const mesh = new SkinnedSplatMesh(data, { skin });
  meshes.push(mesh);
  return mesh;
}

describe('SkinnedSplatMesh', () => {
  it('rests in the bind pose until a bone moves', () => {
    const { skeleton } = chain();
    const { data, skin } = splatsAlongChain(32);
    const mesh = make(data, skin);
    // Before bind: no modifiers, the data as captured.
    expect(mesh.modifiers).toHaveLength(0);
    expect(mesh.posedSplatData().positions).toBe(data.positions);
    mesh.bind(skeleton, new THREE.Matrix4());
    expect(mesh.modifiers).toHaveLength(1);
    expect(mesh.sortDisplacement).toHaveLength(1);
    const posed = mesh.posedSplatData();
    for (let i = 0; i < data.positions.length; i++) {
      expect(posed.positions[i]).toBeCloseTo(data.positions[i]!, 5);
    }
  });

  it('poses its splats exactly as THREE.SkinnedMesh poses the same points', () => {
    const { skeleton, bones } = chain();
    const { data, skin } = splatsAlongChain(64);
    const mesh = make(data, skin);
    mesh.bind(skeleton, new THREE.Matrix4());
    const reference = referenceMesh(data, skin, skeleton);
    bones[0]!.rotation.set(0.2, 0, 0.3);
    bones[1]!.rotation.set(0, 0.5, -0.8);
    bones[2]!.position.set(0.1, 1.2, 0);
    bones[2]!.scale.set(1, 1.5, 1);
    expectMatchesReference(mesh, reference);
  });

  it('carries a splat shape with its bone: Σ becomes R·Σ·Rᵀ', () => {
    const { skeleton, bones } = chain();
    const data: SplatData = {
      count: 1,
      positions: new Float32Array([0, 0.5, 0]),
      colors: new Uint8Array([255, 255, 255, 255]),
      covariances: new Float32Array(6),
    };
    writeCovariance(data.covariances, 0, 0.1, 0.01, 0.01, 1, 0, 0, 0);
    const mesh = make(data, { bonesPerSplat: 1, indices: [0], weights: [1] });
    mesh.bind(skeleton, new THREE.Matrix4());
    bones[0]!.rotation.set(0, 0, Math.PI / 2);
    const [xx, , , yy] = mesh.posedSplatData().covariances;
    // The long x axis now points along y.
    expect(xx).toBeCloseTo(0.01 ** 2, 6);
    expect(yy).toBeCloseTo(0.1 ** 2, 6);
  });

  it('follows bone clips under an AnimationMixer, cross-fades included', () => {
    const { root, skeleton, bones } = chain();
    bones[1]!.name = 'elbow';
    const { data, skin } = splatsAlongChain(48);
    const mesh = make(data, skin);
    mesh.bind(skeleton, new THREE.Matrix4());
    const reference = referenceMesh(data, skin, skeleton);
    const bend = (name: string, angle: number) =>
      new THREE.AnimationClip(name, 1, [
        new THREE.QuaternionKeyframeTrack(
          'elbow.quaternion',
          [0, 1],
          [
            ...new THREE.Quaternion().toArray(),
            ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle).toArray(),
          ],
        ),
      ]);
    const mixer = new THREE.AnimationMixer(root);
    const wave = mixer.clipAction(bend('wave', 1.2));
    const reach = mixer.clipAction(bend('reach', -0.9));
    wave.play();
    mixer.update(0.5);
    expectMatchesReference(mesh, reference);
    const waved = mesh.posedSplatData().positions.slice();
    // Halfway through a cross-fade the pose is a blend of both clips.
    reach.play();
    wave.crossFadeTo(reach, 0.5, false);
    mixer.update(0.25);
    expectMatchesReference(mesh, reference);
    const blended = mesh.posedSplatData().positions;
    expect(blended.some((value, i) => Math.abs(value - waved[i]!) > 1e-3)).toBe(true);
  });

  it('binds like SkinnedMesh.bind without a matrix: the current pose becomes the bind pose', () => {
    const { skeleton, bones } = chain();
    bones[1]!.rotation.set(0, 0, 0.7);
    bones[0]!.updateMatrixWorld(true);
    const { data, skin } = splatsAlongChain(16);
    const mesh = make(data, skin);
    mesh.bind(skeleton);
    const posed = mesh.posedSplatData();
    for (let i = 0; i < data.positions.length; i++) {
      expect(posed.positions[i]).toBeCloseTo(data.positions[i]!, 5);
    }
  });

  it('grows its bounds when the pose leaves them, root motion included', () => {
    const { skeleton, bones } = chain();
    const { data, skin } = splatsAlongChain(16);
    const mesh = make(data, skin);
    mesh.bind(skeleton, new THREE.Matrix4());
    bones[0]!.position.set(20, 0, 0);
    mesh.refreshSkin();
    const bounds = mesh.computeSplatBounds();
    expect(bounds.containsPoint(new THREE.Vector3(20, 2, 0))).toBe(true);
    // A small move inside them leaves them be.
    const before = mesh.displacementBounds!;
    bones[0]!.position.set(20.05, 0, 0);
    mesh.refreshSkin();
    expect(mesh.displacementBounds!.equals(before)).toBe(true);
  });

  it('shrinks its own bounds back once the pose returns, but never an app-set box', () => {
    const { skeleton, bones } = chain();
    const { data, skin } = splatsAlongChain(16);
    const mesh = make(data, skin);
    mesh.bind(skeleton, new THREE.Matrix4());
    const far = new THREE.Vector3(20, 2, 0);
    bones[0]!.position.set(20, 0, 0);
    mesh.refreshSkin();
    expect(mesh.displacementBounds!.containsPoint(far)).toBe(true);
    // Root motion back home: the sort range follows, instead of staying 20 m wide.
    bones[0]!.position.set(0, 0, 0);
    mesh.refreshSkin();
    expect(mesh.displacementBounds!.containsPoint(far)).toBe(false);
    expect(mesh.displacementBounds!.containsPoint(new THREE.Vector3(0, 2.4, 0))).toBe(true);
    // A box the app declares is the floor: grown when needed, never shrunk.
    const stage = new THREE.Box3(new THREE.Vector3(-30, -1, -30), new THREE.Vector3(30, 5, 30));
    mesh.displacementBounds = stage;
    bones[0]!.rotation.z = 0.2;
    mesh.refreshSkin();
    expect(mesh.displacementBounds.equals(stage)).toBe(true);
    bones[0]!.position.set(0, 40, 0);
    mesh.refreshSkin();
    expect(mesh.displacementBounds.containsBox(stage)).toBe(true);
    expect(mesh.displacementBounds.max.y).toBeGreaterThan(42);
  });

  it('re-bounds rarely while walking, and settles once the walk stops', () => {
    const { skeleton, bones } = chain();
    const { data, skin } = splatsAlongChain(16);
    const mesh = make(data, skin);
    mesh.bind(skeleton, new THREE.Matrix4());
    let changes = 0;
    let last = mesh.displacementBounds;
    // Three metres at 1 cm a frame: 300 frames of root motion.
    for (let step = 1; step <= 300; step++) {
      bones[0]!.position.x = step * 0.01;
      mesh.refreshSkin();
      const now = mesh.displacementBounds;
      if (!now || !last || !now.equals(last)) changes++;
      last = now;
      expect(now!.containsPoint(new THREE.Vector3(step * 0.01, 2.4, 0))).toBe(true);
    }
    // Each change forces a sort; growing along the motion keeps them rare.
    expect(changes).toBeLessThan(30);
    // Standing still: the bounds hold, no oscillation.
    bones[0]!.rotation.y = 0.01;
    mesh.refreshSkin();
    const settled = mesh.displacementBounds!;
    bones[0]!.rotation.y = 0.02;
    mesh.refreshSkin();
    expect(mesh.displacementBounds!.equals(settled)).toBe(true);
  });

  it('keeps palette SH (a .sog with SH) by packing it per splat', () => {
    const { data, skin } = splatsAlongChain(8);
    const palette = new Float32Array(192 * 4);
    palette[4] = 0.5;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mesh = make(
        {
          ...data,
          sh: {
            bands: 1,
            labels: new Uint32Array(8),
            palette,
            paletteWidth: 192,
            paletteHeight: 1,
          },
        },
        skin,
      );
      expect((mesh as unknown as { packedShBands: number }).packedShBands).toBe(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps modifiers a host stacks after the skin across a rebind', () => {
    const { skeleton } = chain();
    const { data, skin } = splatsAlongChain(8);
    const mesh = make(data, skin);
    mesh.bind(skeleton, new THREE.Matrix4());
    const tint: SplatModifier = (ctx) => ({ color: ctx.color });
    mesh.modifiers = [...mesh.modifiers, tint];
    mesh.bind(chain().skeleton, new THREE.Matrix4());
    expect(mesh.modifiers).toHaveLength(2);
    expect(mesh.modifiers[0]).toBe(mesh.skinModifier);
    expect(mesh.modifiers[1]).toBe(tint);
  });

  it('rejects a skin that names bones the skeleton lacks, or too few weights', () => {
    const { data } = splatsAlongChain(4);
    expect(() => make(data, { bonesPerSplat: 1, indices: [0, 0], weights: [1, 1] })).toThrow(
      /needs 4 indices/,
    );
    const mesh = make(data, { bonesPerSplat: 1, indices: [0, 1, 2, 5], weights: [1, 1, 1, 1] });
    expect(() => mesh.bind(chain().skeleton)).toThrow(/uses bone 5/);
  });
});

describe('computeSplatSkinWeights', () => {
  it('gives each splat the weights of the proxy vertex nearest it', () => {
    // A two-bone proxy: a lower box on bone 0, an upper box on bone 1, a seam blended.
    const lower = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2).translate(0, 0.5, 0);
    const upper = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2).translate(0, 1.5, 0);
    const position = new Float32Array([
      ...lower.attributes.position!.array,
      ...upper.attributes.position!.array,
    ]);
    const vertices = position.length / 3;
    const skinIndex = new Uint16Array(vertices * 4);
    const skinWeight = new Float32Array(vertices * 4);
    for (let v = 0; v < vertices; v++) {
      const y = position[v * 3 + 1]!;
      skinIndex.set([y < 1 ? 0 : 1, y < 1 ? 1 : 0, 0, 0], v * 4);
      skinWeight.set(y === 1 ? [0.5, 0.5, 0, 0] : [1, 0, 0, 0], v * 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    const proxy = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    const splats = {
      count: 3,
      positions: new Float32Array([0.1, 0.1, 0.1, 0.1, 1.9, 0.1, 0.5, 1.02, 0.5]),
    };
    const skin = computeSplatSkinWeights(splats, proxy, { bonesPerSplat: 2 });
    expect(skin.bonesPerSplat).toBe(2);
    expect(Array.from(skin.indices).slice(0, 2)).toEqual([0, 1]);
    expect(Array.from(skin.weights).slice(0, 2)).toEqual([1, 0]);
    expect(skin.indices[2]).toBe(1);
    expect(skin.weights[2]).toBe(1);
    // The seam splat takes the seam vertex: half and half.
    expect(Array.from(skin.weights).slice(4, 6)).toEqual([0.5, 0.5]);
  });

  it('matches in the proxy frame when the splat was made in another', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 2, 0]), 3),
    );
    geometry.setAttribute(
      'skinIndex',
      new THREE.Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0], 4),
    );
    geometry.setAttribute(
      'skinWeight',
      new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]), 4),
    );
    const proxy = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    // The splat sits 5 m along x and upside down (3DGS axes) against the proxy.
    const splats = { count: 2, positions: new Float32Array([5, -1.9, 0, 5, -0.1, 0]) };
    const splatToProxy = new THREE.Matrix4()
      .makeRotationX(Math.PI)
      .multiply(new THREE.Matrix4().makeTranslation(-5, 0, 0));
    const skin = computeSplatSkinWeights(splats, proxy, { bonesPerSplat: 1, splatToProxy });
    expect(Array.from(skin.indices)).toEqual([1, 0]);
    // Without the matrix, both match the same vertex.
    expect(
      Array.from(computeSplatSkinWeights(splats, proxy, { bonesPerSplat: 1 }).indices),
    ).toEqual([0, 0]);
  });

  it('needs a skinned proxy', () => {
    const proxy = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    expect(() =>
      computeSplatSkinWeights({ count: 0, positions: new Float32Array() }, proxy),
    ).toThrow(/skinIndex and skinWeight/);
  });
});
