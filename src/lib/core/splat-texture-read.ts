import type * as THREE from 'three/webgpu';
import { textureLoad } from 'three/tsl';

/** Reads a pool-local center for sorting, projection, or SH evaluation. */
export function readSplatCenter(
  texture: THREE.DataTexture,
  texel: THREE.Node<'ivec2'>,
): THREE.Node<'vec3'> {
  return textureLoad(texture, texel).xyz;
}

/** Reads standalone material inputs, preferring the display's resolved SH cache. */
export function readSplatMaterialInputs(
  centersTexture: THREE.DataTexture,
  colorsTexture: THREE.DataTexture,
  texel: THREE.Node<'ivec2'>,
  cachedColor?: THREE.Texture,
): { center: THREE.Node<'vec3'>; color: THREE.Node<'vec4'> } {
  return {
    center: textureLoad(centersTexture, texel).toVar().xyz,
    color: textureLoad(cachedColor ?? colorsTexture, texel),
  };
}

/** Reads the source attributes consumed by the unified gather pass. */
export function readSplatGatherInputs(
  centersTexture: THREE.DataTexture,
  colorsTexture: THREE.DataTexture,
  texel: THREE.Node<'ivec2'>,
): { center: THREE.Node<'vec3'>; color: THREE.Node<'vec4'> } {
  return {
    center: readSplatCenter(centersTexture, texel),
    color: textureLoad(colorsTexture, texel),
  };
}
