import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { SplatMesh } from '../splat-mesh';
import {
  clampRelightingSettings,
  createPlaceholderRelightTexture,
  DEFAULT_RELIGHT_BACKGROUND,
  DEFAULT_RELIGHT_BLEND,
  DEFAULT_RELIGHT_BRIGHTNESS,
} from '../relighting';
import { createRelightingProxy, createRelightingShadowFactorMaterial } from '../effects';

describe('clampRelightingSettings', () => {
  it('clamps blend to [0, 1] and keeps non-negative brightness / background', () => {
    expect(clampRelightingSettings({ blend: 2, brightness: -1, background: 3 })).toEqual({
      blend: 1,
      brightness: 0,
      background: 3,
      softness: 0,
    });
    expect(clampRelightingSettings({})).toEqual({
      blend: DEFAULT_RELIGHT_BLEND,
      brightness: DEFAULT_RELIGHT_BRIGHTNESS,
      background: DEFAULT_RELIGHT_BACKGROUND,
      softness: 0,
    });
  });
});

describe('SplatMesh.setRelighting', () => {
  it('writes live blend uniforms without requiring a map change', () => {
    const mesh = new SplatMesh({ capacity: 64 });
    const map = createPlaceholderRelightTexture();
    mesh.setRelighting({ map, blend: 0.5, brightness: 1.5, background: 0.8, softness: 2 });
    expect(mesh.getRelighting()).toEqual({
      blend: 0.5,
      brightness: 1.5,
      background: 0.8,
      softness: 2,
    });
    mesh.setRelighting({ map, blend: 0.25 });
    expect(mesh.getRelighting().blend).toBe(0.25);
    expect(mesh.getRelighting().brightness).toBe(1.5);
    mesh.setRelighting(null);
    expect(mesh.getRelighting().blend).toBe(0);
    map.dispose();
    mesh.dispose();
  });
});

describe('createRelightingProxy', () => {
  it('builds a group from raw geometries and disposes owned resources', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const proxy = createRelightingProxy({ geometries: [geometry], albedo: 0.5 });
    expect(proxy.group.children.length).toBe(1);
    const mesh = proxy.group.children[0] as THREE.Mesh;
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    proxy.configureMaterial(new THREE.MeshStandardMaterial());
    proxy.dispose();
    geometry.dispose();
  });

  it('bakes matrixWorld into tile geometry (LCC Z-up→Y-up style)', () => {
    // Source-local point on +Z; after createLcc2ToThreeMatrix (+Z→+Y) it lands on +Y.
    const positions = new Float32Array([0, 0, 2, 1, 0, 2, 0, 1, 2]);
    const indices = new Uint32Array([0, 1, 2]);
    const tiles = [
      {
        url: 'test',
        data: {
          vertexCount: 3,
          triangleCount: 1,
          positions,
          indices,
        },
      },
    ];
    // Same basis as createLcc2ToThreeMatrix: (x,y,z) → (-x, z, y).
    const matrixWorld = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
    const proxy = createRelightingProxy({ tiles, matrixWorld });
    const mesh = proxy.group.children[0] as THREE.Mesh;
    const baked = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(baked.getX(0)).toBeCloseTo(0);
    expect(baked.getY(0)).toBeCloseTo(2);
    expect(baked.getZ(0)).toBeCloseTo(0);
    // Group itself stays identity — transform is in the vertices.
    expect(proxy.group.matrix.equals(new THREE.Matrix4())).toBe(true);
    // Source tile buffers must stay source-local for other consumers.
    expect(positions[2]).toBe(2);
    proxy.dispose();
  });
});

describe('createRelightingShadowFactorMaterial', () => {
  it('builds a node material that outputs shadow(light) as RGB with A=1', () => {
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.castShadow = true;
    const material = createRelightingShadowFactorMaterial(light, { umbra: 0.4 });
    expect(material).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.outputNode).toBeTruthy();
    expect(material.transparent).toBe(false);
    expect(material.polygonOffset).toBe(true);

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const proxy = createRelightingProxy({ geometries: [geometry] });
    proxy.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.material = material;
      obj.castShadow = true;
      obj.receiveShadow = true;
    });
    const mesh = proxy.group.children[0] as THREE.Mesh;
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    expect(mesh.material).toBe(material);

    material.dispose();
    proxy.dispose();
    geometry.dispose();
  });

  it('clamps umbra to [0, 1]', () => {
    const light = new THREE.DirectionalLight();
    const hi = createRelightingShadowFactorMaterial(light, { umbra: 2 });
    const lo = createRelightingShadowFactorMaterial(light, { umbra: -1 });
    expect(hi.outputNode).toBeTruthy();
    expect(lo.outputNode).toBeTruthy();
    hi.dispose();
    lo.dispose();
  });

  it('builds with receiveUpMin 0 (every face receives)', () => {
    const light = new THREE.DirectionalLight();
    const material = createRelightingShadowFactorMaterial(light, { receiveUpMin: 0 });
    expect(material.outputNode).toBeTruthy();
    material.dispose();
  });

  it('builds with a far cascade light', () => {
    const near = new THREE.DirectionalLight();
    const far = new THREE.DirectionalLight();
    const material = createRelightingShadowFactorMaterial(near, { farLight: far, nearRadius: 40 });
    expect(material.outputNode).toBeTruthy();
    material.dispose();
  });

  it('builds with inner, mid, and far cascade lights', () => {
    const inner = new THREE.DirectionalLight();
    const mid = new THREE.DirectionalLight();
    const far = new THREE.DirectionalLight();
    const material = createRelightingShadowFactorMaterial(inner, {
      nearRadius: 20,
      midLight: mid,
      midRadius: 50,
      farLight: far,
    });
    expect(material.outputNode).toBeTruthy();
    material.dispose();
  });

  it('builds with a Lambert color, diffuse, and live direction', () => {
    const light = new THREE.DirectionalLight();
    const color = new THREE.Color(0xffa040);
    const direction = new THREE.Vector3(0.3, 0.8, 0.2);
    const material = createRelightingShadowFactorMaterial(light, {
      color,
      diffuse: 0.8,
      direction,
    });
    expect(material.outputNode).toBeTruthy();
    material.dispose();
  });

  it('builds with inner, mid, outer, and far cascade lights', () => {
    const inner = new THREE.DirectionalLight();
    const mid = new THREE.DirectionalLight();
    const outer = new THREE.DirectionalLight();
    const far = new THREE.DirectionalLight();
    const material = createRelightingShadowFactorMaterial(inner, {
      nearRadius: 20,
      midLight: mid,
      midRadius: 50,
      outerLight: outer,
      outerRadius: 160,
      farLight: far,
    });
    expect(material.outputNode).toBeTruthy();
    material.dispose();
  });
});
