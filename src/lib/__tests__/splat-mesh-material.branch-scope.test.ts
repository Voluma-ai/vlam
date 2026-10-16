/**
 * Branch scoping of the standalone material's vertex graph.
 *
 * Builds the vertex WGSL headlessly and checks every TSL temp read against
 * its enclosing blocks, for modifiers that read one context field only
 * inside sibling `If`s (see `helpers/branch-modifiers.ts`). three r186 let a
 * shared node first emitted in such a branch keep that branch's var: the
 * splat center then read zero wherever the branch did not run.
 */
import * as THREE from 'three/webgpu';
import { uniform, uniformArray } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import {
  applySplatMaterialGraph,
  type SplatMaterialBuildInputs,
  type SplatSourcePlacement,
} from '../core/splat-mesh-material';
import type { SplatModifier } from '../core/splat-modifier';
import { BRANCHES, branchShapes, contextReads, tint } from './helpers/branch-modifiers';
import { buildMaterialWgsl, findOutOfScopeReads } from './helpers/wgsl-scope';

const WIDTH = 4;

function dataTexture(array: Float32Array | Uint8Array): THREE.DataTexture {
  return new THREE.DataTexture(array, WIDTH, 1);
}

function placement(): SplatSourcePlacement {
  return {
    sourceIdTexture: new THREE.DataTexture(new Float32Array(WIDTH), WIDTH, 1, THREE.RedFormat),
    columns: uniformArray(
      Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 1)),
      'vec4',
    ),
  };
}

interface Variant {
  readonly name: string;
  readonly mode: 'display' | 'pick';
  readonly placed?: boolean;
  readonly settings?: Partial<SplatMaterialBuildInputs['settings']>;
}

const variants: Variant[] = [
  { name: 'display', mode: 'display' },
  { name: 'pick', mode: 'pick' },
  { name: 'placed source', mode: 'display', placed: true },
  { name: 'RAD LOD alpha', mode: 'display', settings: { lodAlpha: true } },
  // Reads the modifier color again inside the contribution test's branches.
  { name: 'balanced profile', mode: 'display', settings: { performanceProfile: 'balanced' } },
];

function vertexWgsl(variant: Variant, modifiers: readonly SplatModifier[]): string {
  const inputs: SplatMaterialBuildInputs = {
    textures: {
      centersTexture: dataTexture(new Float32Array(WIDTH * 4)),
      colorsTexture: dataTexture(new Uint8Array(WIDTH * 4)),
      covarianceATexture: dataTexture(new Float32Array(WIDTH * 4)),
      covarianceBTexture: dataTexture(new Float32Array(WIDTH * 4)),
    },
    sh: null,
    sourcePlacement: variant.placed ? placement() : null,
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
    pick:
      variant.mode === 'pick'
        ? { alphaThreshold: uniform(0.3), near: uniform(0.1), far: uniform(100) }
        : null,
    settings: {
      maxStdDev: 3,
      antialias: false,
      projectedFilterProfile: 'default',
      srgbOutput: false,
      performanceProfile: 'quality',
      ...variant.settings,
    },
    channels: new Map([['mask', { texture: dataTexture(new Float32Array(WIDTH * 4)) }]]),
    modifiers,
  };
  const material = new THREE.NodeMaterial();
  applySplatMaterialGraph(material, variant.mode, inputs);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  geometry.setAttribute(
    'splatIndex',
    new THREE.InstancedBufferAttribute(new Float32Array(WIDTH), 1),
  );
  const { vertex } = buildMaterialWgsl(new THREE.Mesh(geometry, material));
  geometry.dispose();
  material.dispose();
  return vertex;
}

describe('material graph - modifier branch scoping', () => {
  for (const [field, read] of Object.entries(contextReads)) {
    for (const [shape, modifier] of Object.entries(branchShapes)) {
      for (const variant of variants) {
        it(`keeps the vertex graph independent of a branch-only ${field} read (${shape}, ${variant.name})`, () => {
          const wgsl = vertexWgsl(variant, [tint, modifier(read)]);
          // Guard the harness itself: the last sibling must be in the shader.
          expect(wgsl).toContain(`if ( ( ${BRANCHES - 1} < `);
          expect(findOutOfScopeReads(wgsl)).toEqual([]);
        });
      }
    }
  }

  it('builds ctx.normal only for a modifier that reads it', () => {
    const display = variants[0]!;
    // The normal is the only inverse in an unplaced, SH-free graph.
    expect(vertexWgsl(display, [tint])).not.toContain('tsl_inverse_mat3(');
    expect(vertexWgsl(display, [branchShapes['read per branch']!(contextReads.normal!)])).toContain(
      'tsl_inverse_mat3(',
    );
  });

  it('emits the modifier stack once, however often the vertex graph reads its color', () => {
    // The balanced profile reads the color's alpha again in both arms of the
    // contribution test; tint's 0.5 factor appears once per emitted copy.
    const wgsl = vertexWgsl(variants[4]!, [tint]);
    expect(wgsl.match(/\* vec3<f32>\( 0\.5 \)/g)).toHaveLength(1);
  });
});
