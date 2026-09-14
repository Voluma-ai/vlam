import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import {
  applySplatMaterialGraph,
  splatDisplayColorSource,
  type SplatMaterialBuildInputs,
  type SplatShInputs,
} from '../core/splat-mesh-material';

const WIDTH = 4;

function makeInputs(overrides: Partial<SplatMaterialBuildInputs> = {}): SplatMaterialBuildInputs {
  return {
    textures: {
      centersTexture: new THREE.DataTexture(new Float32Array(WIDTH * 4), WIDTH, 1),
      colorsTexture: new THREE.DataTexture(new Uint8Array(WIDTH * 4), WIDTH, 1),
      covarianceATexture: new THREE.DataTexture(new Float32Array(WIDTH * 4), WIDTH, 1),
      covarianceBTexture: new THREE.DataTexture(new Float32Array(WIDTH * 4), WIDTH, 1),
    },
    sh: null,
    sourcePlacement: null,
    displayColorModifier: null,
    uniforms: {
      focal: uniform(new THREE.Vector2(1, 1)),
      viewport: uniform(new THREE.Vector2(1, 1)),
      frustumMargin: uniform(new THREE.Vector2(3, 3)),
      localCameraPosition: uniform(new THREE.Vector3()),
      pixelScaleLimit: uniform(0),
      dofFocusDistance: uniform(1),
      dofAperture: uniform(0),
      screenBandMin: uniform(0),
      screenBandMax: uniform(0),
    },
    pick: null,
    settings: {
      maxStdDev: 3,
      antialias: false,
      projectedFilterProfile: 'default',
      srgbOutput: false,
      performanceProfile: 'quality',
    },
    channels: new Map(),
    modifiers: [],
    ...overrides,
  };
}

function makeSh(): SplatShInputs {
  return {
    mode: 'palette',
    bands: 1,
    paletteTexture: new THREE.DataTexture(new Float32Array(64 * 4), 64, 1),
  };
}

function makeProjected(packedColor: boolean) {
  return {
    clipCenters: new THREE.StorageBufferAttribute(new Float32Array(16), 4),
    axes: new THREE.StorageBufferAttribute(new Float32Array(16), 4),
    parameters: new THREE.StorageBufferAttribute(new Float32Array(16), 4),
    capacity: 4,
    packedColor,
  };
}

describe('splat display color source', () => {
  it('selects cache, packed projector color, vertex SH, then DC', () => {
    expect(
      splatDisplayColorSource({ hasCachedColor: true, packedProjectedColor: true, hasSh: true }),
    ).toBe('cached');
    expect(
      splatDisplayColorSource({ hasCachedColor: false, packedProjectedColor: true, hasSh: true }),
    ).toBe('packed');
    expect(
      splatDisplayColorSource({ hasCachedColor: false, packedProjectedColor: false, hasSh: true }),
    ).toBe('vertex-sh');
    expect(
      splatDisplayColorSource({ hasCachedColor: false, packedProjectedColor: false, hasSh: false }),
    ).toBe('base');
  });

  it('builds the three standalone color combinations', () => {
    const cached = new THREE.DataTexture(new Uint8Array(WIDTH * 4), WIDTH, 1);
    const cases: SplatMaterialBuildInputs[] = [
      makeInputs({ sh: makeSh(), shFinalColor: cached, projected: makeProjected(false) }),
      makeInputs({ sh: makeSh(), projected: makeProjected(true) }),
      makeInputs({ sh: makeSh() }),
    ];
    for (const inputs of cases) {
      const material = new THREE.NodeMaterial();
      expect(() => applySplatMaterialGraph(material, 'display', inputs)).not.toThrow();
      expect(material.vertexNode).not.toBeUndefined();
      material.dispose();
    }
    cached.dispose();
  });
});
