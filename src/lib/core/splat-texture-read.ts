/** Internal readers for the benchmark's lossless center/color integer texels. */
import * as THREE from 'three/webgpu';
import { textureLoad, uint, uintBitsToFloat, vec4 } from 'three/tsl';
import { asNode } from './splat-material-types';

export function decodeSplatCenter(
  texture: THREE.DataTexture,
  sample: THREE.Node<'vec4'>,
): THREE.Node<'vec3'> {
  return texture.format === THREE.RGBAIntegerFormat
    ? asNode<'vec3'>(uintBitsToFloat(asNode<'uvec3'>(sample.xyz)))
    : sample.xyz;
}

export function readSplatCenter(
  texture: THREE.DataTexture,
  texel: THREE.Node<'ivec2'>,
): THREE.Node<'vec3'> {
  return decodeSplatCenter(texture, textureLoad(texture, texel));
}

export function decodeSplatColor(sample: THREE.Node<'vec4'>): THREE.Node<'vec4'> {
  const bits = asNode<'uint'>(sample.w);
  return vec4(
    bits.bitAnd(uint(255)).toFloat().div(255),
    bits.shiftRight(uint(8)).bitAnd(uint(255)).toFloat().div(255),
    bits.shiftRight(uint(16)).bitAnd(uint(255)).toFloat().div(255),
    bits.shiftRight(uint(24)).toFloat().div(255),
  );
}
