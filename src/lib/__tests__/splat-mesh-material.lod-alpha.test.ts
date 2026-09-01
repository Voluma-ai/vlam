import * as THREE from 'three/webgpu';
import { uniform, vec4 } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import {
  applySplatMaterialGraph,
  type SplatMaterialBuildInputs,
} from '../core/splat-mesh-material';
import type { SplatContext, SplatModifier } from '../core/splat-modifier';

const WIDTH = 4;

function makeInputs(
  mode: 'display' | 'pick',
  modifiers: readonly SplatModifier[],
): SplatMaterialBuildInputs {
  return {
    textures: {
      centersTexture: new THREE.DataTexture(new Float32Array(WIDTH * 4), WIDTH, 1),
      colorsTexture: new THREE.DataTexture(new Uint8Array(WIDTH * 4), WIDTH, 1),
      covarianceATexture: new THREE.DataTexture(new Float32Array(WIDTH * 4), WIDTH, 1),
      covarianceBTexture: new THREE.DataTexture(new Float32Array(WIDTH * 4), WIDTH, 1),
    },
    sh: null,
    sourcePlacement: null,
    uniforms: {
      focal: uniform(new THREE.Vector2(1, 1)),
      viewport: uniform(new THREE.Vector2(1, 1)),
      localCameraPosition: uniform(new THREE.Vector3()),
      pixelScaleLimit: uniform(0),
      dofFocusDistance: uniform(1),
      dofAperture: uniform(0),
      screenBandMin: uniform(0),
      screenBandMax: uniform(0),
      relightMap: new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1),
      relightBlend: uniform(0),
      relightBrightness: uniform(2),
      relightBackground: uniform(1),
      relightSoftness: uniform(0),
    },
    pick:
      mode === 'pick'
        ? { alphaThreshold: uniform(0.3), near: uniform(0.1), far: uniform(100) }
        : null,
    settings: {
      maxStdDev: 3,
      antialias: false,
      projectedFilterProfile: 'default',
      srgbOutput: false,
      performanceProfile: 'quality',
      lodAlpha: true,
    },
    channels: new Map(),
    modifiers,
  };
}

const fade: SplatModifier = (ctx: SplatContext) => ({
  color: vec4(ctx.color.rgb, ctx.color.a.mul(0.25)),
});

describe('material graph - RAD lodAlpha vs visual opacity', () => {
  for (const mode of ['display', 'pick'] as const) {
    it(`builds the ${mode} graph with lodAlpha and an alpha fade modifier`, () => {
      const material = new THREE.NodeMaterial();
      expect(() => applySplatMaterialGraph(material, mode, makeInputs(mode, [fade]))).not.toThrow();
      expect(material.vertexNode).not.toBeUndefined();
      expect(material.fragmentNode).not.toBeUndefined();
    });
  }
});
