import * as THREE from 'three/webgpu';
import { experiments } from './config';

/** Benchmark replacement: float32 centers and RGBA8 share one RGBA32UI texel. */
export function createSplatCenterTexture(
  data: Float32Array | Uint16Array,
  width: number,
  height: number,
  type: THREE.TextureDataType,
): THREE.DataTexture {
  const packed = experiments.packedCenterColors && type === THREE.FloatType;
  const image = packed ? new Uint32Array(data.buffer, data.byteOffset, data.length) : data;
  const texture = new THREE.DataTexture(
    image,
    width,
    height,
    packed ? THREE.RGBAIntegerFormat : THREE.RGBAFormat,
    packed ? THREE.UnsignedIntType : type,
  );
  if (packed) {
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
  }
  texture.needsUpdate = true;
  return texture;
}

/** Reuses the integer image alias so sparse writes allocate no additional views. */
export function writeSplatColors(
  centersTexture: THREE.DataTexture,
  colors: Uint8Array,
  destination: number,
  source: Uint8Array,
  count: number,
): void {
  const start = destination * 4;
  colors.set(source, start);
  if (centersTexture.format !== THREE.RGBAIntegerFormat) return;
  const packed = centersTexture.image.data as Uint32Array;
  for (let p = start; p < start + count * 4; p += 4) {
    packed[p + 3] =
      (colors[p] as number) |
      ((colors[p + 1] as number) << 8) |
      ((colors[p + 2] as number) << 16) |
      ((colors[p + 3] as number) << 24);
  }
}

/** Reinterprets the supplied bytes, including snapshot offsets, without reading live textures. */
export function splatCenterUploadData(
  texture: THREE.DataTexture,
  centers: Float32Array,
): Float32Array | Uint32Array {
  return texture.format === THREE.RGBAIntegerFormat
    ? new Uint32Array(centers.buffer, centers.byteOffset, centers.length)
    : centers;
}
