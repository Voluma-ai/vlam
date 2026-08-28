/**
 * The per-source placement branch of the material graph (M16).
 *
 * These are graph-*build* tests: they compile the TSL node graph in Node and
 * assert it assembles, which is the only headless signal available for shader
 * work here. TSL shape errors (`mat3.inverse()`, chained `mat3.mul`, a `vec4`
 * where a `vec3` is expected) type-check cleanly and only surface when the
 * graph is built, so a build that does not throw is worth pinning. Whether the
 * placed splat lands in the right *pixel* is a browser check.
 */
import * as THREE from 'three/webgpu';
import { uniform, uniformArray } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import {
  applySplatMaterialGraph,
  foldSplatModifierStack,
  type SplatMaterialBuildInputs,
  type SplatSourcePlacement,
} from '../splat-mesh-material';
import { worldWarpPreset } from '../effects';
import type { SplatContext, SplatModifier } from '../splat-modifier';

const WIDTH = 4;

function makeTextures() {
  return {
    centersTexture: new THREE.DataTexture(new Float32Array(WIDTH * 4), WIDTH, 1),
    colorsTexture: new THREE.DataTexture(new Uint8Array(WIDTH * 4), WIDTH, 1),
    covarianceATexture: new THREE.DataTexture(new Float32Array(WIDTH * 4), WIDTH, 1),
    covarianceBTexture: new THREE.DataTexture(new Float32Array(WIDTH * 4), WIDTH, 1),
  };
}

function makePlacement(): SplatSourcePlacement {
  return {
    sourceIdTexture: new THREE.DataTexture(new Float32Array(WIDTH), WIDTH, 1, THREE.RedFormat),
    columns: uniformArray(
      Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 1)),
      'vec4',
    ),
  };
}

function makeInputs(
  sourcePlacement: SplatSourcePlacement | null,
  modifiers: readonly SplatModifier[],
  mode: 'display' | 'pick',
): SplatMaterialBuildInputs {
  return {
    textures: makeTextures(),
    sh: null,
    sourcePlacement,
    uniforms: {
      focal: uniform(new THREE.Vector2(1, 1)),
      viewport: uniform(new THREE.Vector2(1, 1)),
      localCameraPosition: uniform(new THREE.Vector3()),
      pixelScaleLimit: uniform(0),
      dofFocusDistance: uniform(1),
      dofAperture: uniform(0),
      // Band bounds are uniforms so a foveated mesh can follow its LOD cut; 0
      // here because this fixture builds no screen-radius cull.
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
    },
    channels: new Map(),
    modifiers,
  };
}

/** Reads every positional context field, so all of them must compile. */
const readsEveryFrame: SplatModifier = (ctx) => ({
  color: ctx.color,
  offset: ctx.localCenter
    .add(ctx.sourceCenter)
    .add(ctx.sourceToLocal.mul(ctx.sourceCenter))
    .add(ctx.worldCenter)
    .add(ctx.viewCenter)
    .add(ctx.normal)
    .mul(0),
});

describe('material graph - per-source placement', () => {
  for (const mode of ['display', 'pick'] as const) {
    for (const placed of [false, true]) {
      it(`builds in ${mode} mode ${placed ? 'with' : 'without'} a source placement`, () => {
        const material = new THREE.NodeMaterial();
        expect(() =>
          applySplatMaterialGraph(
            material,
            mode,
            makeInputs(placed ? makePlacement() : null, [readsEveryFrame], mode),
          ),
        ).not.toThrow();
        expect(material.vertexNode).not.toBeUndefined();
      });
    }
  }

  it('builds the unhooked graph with a placement and no modifiers', () => {
    // Newly reachable: before M16 a MergedSplatMesh always carried the placement
    // modifier, so its stack was never empty. The placement must survive the
    // `stack.offset === null` fast path.
    const material = new THREE.NodeMaterial();
    expect(() =>
      applySplatMaterialGraph(material, 'display', makeInputs(makePlacement(), [], 'display')),
    ).not.toThrow();
    expect(material.vertexNode).not.toBeUndefined();
  });
});

describe('foldSplatModifierStack - sourceCenter', () => {
  const capture = (): { modifier: SplatModifier; seen: SplatContext[] } => {
    const seen: SplatContext[] = [];
    return {
      seen,
      modifier: (ctx) => {
        seen.push(ctx);
        return {};
      },
    };
  };
  const baseInputs = () => ({
    index: uniform(0).toInt() as unknown as THREE.Node<'int'>,
    color: uniform(new THREE.Vector4()) as unknown as THREE.Node<'vec4'>,
    makeNormal: () => uniform(new THREE.Vector3()) as unknown as THREE.Node<'vec3'>,
    makeChannel: () => uniform(0) as unknown as THREE.Node<'float'>,
  });

  it('defaults sourceCenter to localCenter when the caller supplies none', () => {
    const localCenter = uniform(new THREE.Vector3(1, 2, 3)) as unknown as THREE.Node<'vec3'>;
    const { modifier, seen } = capture();
    foldSplatModifierStack([modifier], uniform(new THREE.Vector3()), {
      ...baseInputs(),
      localCenter,
    });
    expect(seen[0]?.sourceCenter).toBe(seen[0]?.localCenter);
    expect(seen[0]?.sourceCenter).toBe(localCenter);
  });

  it('keeps sourceCenter distinct from a placed localCenter', () => {
    const localCenter = uniform(new THREE.Vector3(1, 2, 3)) as unknown as THREE.Node<'vec3'>;
    const sourceCenter = uniform(new THREE.Vector3(4, 5, 6)) as unknown as THREE.Node<'vec3'>;
    const sourceToLocal = uniform(new THREE.Matrix3()) as unknown as THREE.Node<'mat3'>;
    const { modifier, seen } = capture();
    foldSplatModifierStack([modifier], uniform(new THREE.Vector3()), {
      ...baseInputs(),
      localCenter,
      sourceCenter,
      sourceToLocal,
    });
    expect(seen[0]?.localCenter).toBe(localCenter);
    expect(seen[0]?.sourceCenter).toBe(sourceCenter);
    expect(seen[0]?.sourceToLocal).toBe(sourceToLocal);
  });
});

describe('foldSplatModifierStack - worldWarpPreset', () => {
  it('builds a display graph with the warp modifier', () => {
    const material = new THREE.NodeMaterial();
    const warp = worldWarpPreset({ intensity: 0.55, radius: 1 });
    expect(() =>
      applySplatMaterialGraph(material, 'display', makeInputs(null, [warp.modifier], 'display')),
    ).not.toThrow();
    expect(material.vertexNode).not.toBeUndefined();
  });
});
