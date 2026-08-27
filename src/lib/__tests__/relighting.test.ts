import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { SplatMesh } from '../splat-mesh';
import {
  clampRelightingSettings,
  createPlaceholderRelightTexture,
  DEFAULT_RELIGHT_BACKGROUND,
  DEFAULT_RELIGHT_BLEND,
  DEFAULT_RELIGHT_BRIGHTNESS,
} from '../relighting';
import {
  createRelightingProxy,
  createRelightingShadowFactorMaterial,
  MAX_RELIGHTING_SHADOW_LIGHTS,
  renderRelightingFactorMap,
} from '../effects';

function materialGraph(material: THREE.MeshStandardNodeMaterial): THREE.Node[] {
  const nodes: THREE.Node[] = [];
  material.outputNode?.traverse((node) => nodes.push(node));
  return nodes;
}

function graphNodesNamed(material: THREE.MeshStandardNodeMaterial, name: string): THREE.Node[] {
  return materialGraph(material).filter((node) => node.constructor.name === name);
}

function graphMathMethods(material: THREE.MeshStandardNodeMaterial): string[] {
  return graphNodesNamed(material, 'MathNode').flatMap((node) => {
    const method = (node as THREE.Node & { method?: unknown }).method;
    return typeof method === 'string' ? [method] : [];
  });
}

function graphConstants(material: THREE.MeshStandardNodeMaterial): unknown[] {
  return graphNodesNamed(material, 'ConstNode').map(
    (node) => (node as THREE.Node & { value?: unknown }).value,
  );
}

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

  it('builds with intensity-weighted independent lights', () => {
    const sun = new THREE.DirectionalLight();
    const fill = new THREE.DirectionalLight();
    const material = createRelightingShadowFactorMaterial(
      [
        { light: sun, intensity: 1 },
        { light: fill, intensity: 0.25 },
      ],
      { umbra: 0.5 },
    );
    expect(graphNodesNamed(material, 'ShadowNode')).toHaveLength(2);
    expect(graphConstants(material)).toContain(1.25);
    material.dispose();
  });

  it('builds with combine:min so independent umbras stay separate', () => {
    const sun = new THREE.DirectionalLight();
    const fill = new THREE.DirectionalLight();
    const material = createRelightingShadowFactorMaterial(
      [
        { light: sun, intensity: 1 },
        { light: fill, intensity: 2 },
      ],
      { umbra: 0.5, combine: 'min' },
    );
    expect(graphNodesNamed(material, 'ShadowNode')).toHaveLength(2);
    expect(graphMathMethods(material).filter((method) => method === 'min')).toHaveLength(2);
    expect(graphConstants(material)).toEqual(expect.arrayContaining([0.5, 0]));
    material.dispose();
  });

  it('builds with combine:min and fractional intensity for a soft umbra', () => {
    const sun = new THREE.DirectionalLight();
    const material = createRelightingShadowFactorMaterial([{ light: sun, intensity: 0.1 }], {
      umbra: 0.5,
      combine: 'min',
    });
    expect(graphNodesNamed(material, 'ShadowNode')).toHaveLength(1);
    expect(graphMathMethods(material).filter((method) => method === 'min')).toHaveLength(1);
    expect(graphConstants(material)).toContain(0.95);
    material.dispose();
  });

  it('builds with a spotlight as a secondary contribution', () => {
    const sun = new THREE.DirectionalLight();
    const spot = new THREE.SpotLight();
    const material = createRelightingShadowFactorMaterial([
      { light: sun, intensity: 1 },
      { light: spot, intensity: 0.6 },
    ]);
    expect(graphNodesNamed(material, 'ShadowNode')).toHaveLength(2);
    material.dispose();
  });

  it('builds punctual umbra fade when a spot has distance and decay', () => {
    const spot = new THREE.SpotLight(0xffffff, 1, 5, Math.PI / 4, 0.5, 2);
    const material = createRelightingShadowFactorMaterial([{ light: spot, intensity: 1 }], {
      combine: 'min',
      umbra: 0.5,
    });
    expect(graphNodesNamed(material, 'ShadowNode')).toHaveLength(1);
    material.dispose();
  });

  it('keeps cascades on the first directional when extra lights are present', () => {
    const inner = new THREE.DirectionalLight();
    const far = new THREE.DirectionalLight();
    const fill = new THREE.SpotLight();
    const material = createRelightingShadowFactorMaterial(
      [
        { light: inner, intensity: 1 },
        { light: fill, intensity: 0.4 },
      ],
      { farLight: far, nearRadius: 40 },
    );
    expect(graphNodesNamed(material, 'ShadowNode')).toHaveLength(3);
    material.dispose();
  });

  it('skips zero-intensity contributions and empty arrays', () => {
    const lit = new THREE.DirectionalLight();
    const dark = new THREE.DirectionalLight();
    const skipped = createRelightingShadowFactorMaterial([
      { light: dark, intensity: 0 },
      { light: lit, intensity: 2 },
    ]);
    expect(graphNodesNamed(skipped, 'ShadowNode')).toHaveLength(1);
    skipped.dispose();

    const empty = createRelightingShadowFactorMaterial([]);
    expect(graphNodesNamed(empty, 'ShadowNode')).toHaveLength(0);
    empty.dispose();
  });

  it('unrolls four independent lights without padding extra ShadowNodes', () => {
    const lights = Array.from({ length: 4 }, () => ({
      light: new THREE.DirectionalLight(),
      intensity: 1,
    }));
    const material = createRelightingShadowFactorMaterial(lights);
    expect(graphNodesNamed(material, 'ShadowNode')).toHaveLength(4);
    material.dispose();
  });

  it('caps independent lights at MAX_RELIGHTING_SHADOW_LIGHTS', () => {
    const lights = Array.from({ length: MAX_RELIGHTING_SHADOW_LIGHTS + 1 }, () => ({
      light: new THREE.DirectionalLight(),
      intensity: 1,
    }));
    const material = createRelightingShadowFactorMaterial(lights);
    expect(graphNodesNamed(material, 'ShadowNode')).toHaveLength(MAX_RELIGHTING_SHADOW_LIGHTS);
    material.dispose();
  });
});

describe('renderRelightingFactorMap', () => {
  const createRenderer = () => {
    const storedClear = new THREE.Color(0.1, 0.2, 0.3);
    return {
      autoClear: false,
      shadowMap: { enabled: false, autoUpdate: false },
      contextNode: { id: 'gamma' } as unknown,
      getDrawingBufferSize: (target: THREE.Vector2) => target.set(64, 48),
      getRenderTarget: () => null,
      getActiveCubeFace: () => 3,
      getActiveMipmapLevel: () => 2,
      getMRT: () => ({ id: 'host-mrt' }) as unknown as THREE.MRTNode,
      setMRT: vi.fn(),
      setRenderTarget: vi.fn(),
      getClearColor: (target: THREE.Color) => target.copy(storedClear),
      getClearAlpha: () => 0.5,
      setClearColor: vi.fn(),
      clear: vi.fn(),
      render: vi.fn(),
    };
  };

  it('isolates autoClear, shadow maps, and contextNode then restores them', () => {
    const renderer = createRenderer();
    renderer.render.mockImplementation(() => {
      expect(renderer.autoClear).toBe(true);
      expect(renderer.shadowMap.enabled).toBe(true);
      expect(renderer.shadowMap.autoUpdate).toBe(true);
      expect(renderer.setMRT).toHaveBeenLastCalledWith(null);
      // Must keep a real ContextNode (WebGPURenderer reads contextNode.id).
      expect(renderer.contextNode).not.toBeUndefined();
      expect(renderer.contextNode).not.toEqual({ id: 'gamma' });
    });
    const target = {
      setSize: vi.fn(),
    } as unknown as THREE.RenderTarget;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();

    renderRelightingFactorMap(renderer, scene, camera, target);

    expect(target.setSize).toHaveBeenCalledWith(64, 48);
    expect(renderer.setClearColor).toHaveBeenCalledWith(0xffffff, 0);
    expect(renderer.clear).toHaveBeenCalled();
    expect(renderer.render).toHaveBeenCalledWith(scene, camera);
    expect(renderer.setRenderTarget).toHaveBeenNthCalledWith(1, target);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null, 3, 2);
    expect(renderer.setMRT).toHaveBeenLastCalledWith({ id: 'host-mrt' });
    expect(renderer.autoClear).toBe(false);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(renderer.shadowMap.autoUpdate).toBe(false);
    expect(renderer.contextNode).toEqual({ id: 'gamma' });
    expect(renderer.setClearColor).toHaveBeenLastCalledWith(expect.any(THREE.Color), 0.5);
  });
});
