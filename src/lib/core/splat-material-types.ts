/** Internal shared shader inputs and uniform constructors. */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

/**
 * Optional display-fragment RGB transform. It receives the unpremultiplied
 * splat RGB, screen UV, and drawing-buffer viewport nodes. The hook is never
 * used by picking or the vertex/gather paths.
 */
export type DisplayColorModifier = (
  rgb: THREE.Node<'vec3'>,
  screenUv: THREE.Node<'vec2'>,
  viewport: THREE.Node<'vec2'>,
) => THREE.Node<'vec3'>;

/** Narrow a TSL expression to the typed {@link THREE.Node} our hook contract
 * expects. Identity at runtime - satisfies TypeScript only. */
export function asNode<T extends string>(node: unknown): THREE.Node<T> {
  return node as THREE.Node<T>;
}

/** A `vec3` uniform, named so its type can be referred to in field decls. */
export function vec3Uniform() {
  return uniform(new THREE.Vector3());
}
export type Vec3Uniform = ReturnType<typeof vec3Uniform>;

/** A boolean uniform, named for optional graph inputs. */
export function boolUniform() {
  return uniform(false);
}
export type BoolUniform = ReturnType<typeof boolUniform>;

function vec2Uniform() {
  return uniform(new THREE.Vector2());
}
/** A `vec2` uniform (focal, viewport). */
export type Vec2Uniform = ReturnType<typeof vec2Uniform>;

function floatUniform() {
  return uniform(0);
}
/** A scalar uniform (pick thresholds and planes). */
export type FloatUniform = ReturnType<typeof floatUniform>;

/**
 * How the material reads a splat's higher-order SH coefficients. The two
 * sources differ only in where a coefficient comes from - the band
 * accumulation and view-direction math are shared:
 *
 *  - `palette`: SOG/`.lcc2` shN. Coefficients live in a per-file codebook and
 *    each splat stores a label; only a static mesh can use it, because two
 *    files' palettes cannot be merged into one pool.
 *  - `packed`: LCC `Quality`, `.rad`, etc. Each splat carries its own coefficients as packed
 *    words in pool-shaped textures, so appended ranges keep their SH.
 */
export type SplatShInputs =
  | { mode: 'palette'; bands: number; paletteTexture: THREE.DataTexture }
  | {
      mode: 'packed';
      bands: 1 | 2 | 3;
      textures: readonly THREE.DataTexture[];
      range: { min: Vec3Uniform; max: Vec3Uniform };
    };
