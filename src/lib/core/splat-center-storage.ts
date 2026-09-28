import * as THREE from 'three/webgpu';

/** Creates the pool's float32 or half-float center texture. */
export function createSplatCenterTexture(
  data: Float32Array | Uint16Array,
  width: number,
  height: number,
  type: THREE.TextureDataType,
): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, type);
  texture.needsUpdate = true;
  return texture;
}

/** Writes colors for a contiguous range of pool splats. */
export function writeSplatColors(
  _centersTexture: THREE.DataTexture,
  colors: Uint8Array,
  destination: number,
  source: Uint8Array,
  _count: number,
): void {
  colors.set(source, destination * 4);
}

/** Keeps uploads tied to the supplied live backing or immutable publication snapshot. */
export function splatCenterUploadData(
  _texture: THREE.DataTexture,
  centers: Float32Array,
): Float32Array | Uint32Array {
  return centers;
}
