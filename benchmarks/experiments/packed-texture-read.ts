import * as THREE from 'three/webgpu';
import { textureLoad, uint, uintBitsToFloat, vec4 } from 'three/tsl';
import { asNode } from '../../src/lib/core/splat-material-types';
import { experiments } from './config';

function decodeSplatCenter(
  texture: THREE.DataTexture,
  sample: THREE.Node<'vec4'>,
): THREE.Node<'vec3'> {
  return texture.format === THREE.RGBAIntegerFormat
    ? asNode<'vec3'>(uintBitsToFloat(asNode<'uvec3'>(sample.xyz)))
    : sample.xyz;
}

function decodeSplatColor(sample: THREE.Node<'vec4'>): THREE.Node<'vec4'> {
  const bits = asNode<'uint'>(sample.w);
  return vec4(
    bits.bitAnd(uint(255)).toFloat().div(255),
    bits.shiftRight(uint(8)).bitAnd(uint(255)).toFloat().div(255),
    bits.shiftRight(uint(16)).bitAnd(uint(255)).toFloat().div(255),
    bits.shiftRight(uint(24)).toFloat().div(255),
  );
}

/** Decodes float32 center bits only for the benchmark's integer textures. */
export function readSplatCenter(
  texture: THREE.DataTexture,
  texel: THREE.Node<'ivec2'>,
): THREE.Node<'vec3'> {
  return decodeSplatCenter(texture, textureLoad(texture, texel));
}

/** Shares the packed sample between standalone position and color reads. */
export function readSplatMaterialInputs(
  centersTexture: THREE.DataTexture,
  colorsTexture: THREE.DataTexture,
  texel: THREE.Node<'ivec2'>,
  cachedColor?: THREE.Texture,
): { center: THREE.Node<'vec3'>; color: THREE.Node<'vec4'> } {
  const sample = textureLoad(centersTexture, texel).toVar();
  return {
    center: decodeSplatCenter(centersTexture, sample),
    color: cachedColor
      ? textureLoad(cachedColor, texel)
      : centersTexture.format === THREE.RGBAIntegerFormat
        ? decodeSplatColor(sample)
        : textureLoad(colorsTexture, texel),
  };
}

/** Retains the separate unified color-reuse A/B variant. */
export function readSplatGatherInputs(
  centersTexture: THREE.DataTexture,
  colorsTexture: THREE.DataTexture,
  texel: THREE.Node<'ivec2'>,
): { center: THREE.Node<'vec3'>; color: THREE.Node<'vec4'> } {
  const sample =
    experiments.unifiedPackedColorReuse && centersTexture.format === THREE.RGBAIntegerFormat
      ? textureLoad(centersTexture, texel).toVar()
      : null;
  return {
    center: sample
      ? decodeSplatCenter(centersTexture, sample)
      : readSplatCenter(centersTexture, texel),
    color: sample ? decodeSplatColor(sample) : textureLoad(colorsTexture, texel),
  };
}
