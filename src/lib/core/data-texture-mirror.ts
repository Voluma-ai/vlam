/** Internal helpers for releasing uploaded DataTexture CPU images on WebGPU. */
import type * as THREE from 'three/webgpu';

type DataTextureArray = Float32Array | Uint8Array | Uint16Array | Uint32Array;

interface TextureBackend {
  readonly isWebGPUBackend?: boolean;
  has?(object: object): boolean;
  get?(object: object): { texture?: unknown };
}

function textureArray(texture: THREE.DataTexture): DataTextureArray {
  const data = (texture.image as { data?: unknown }).data;
  if (
    data instanceof Float32Array ||
    data instanceof Uint8Array ||
    data instanceof Uint16Array ||
    data instanceof Uint32Array
  ) {
    return data;
  }
  throw new Error('SplatMesh: unsupported DataTexture CPU image type.');
}

function emptyLike(data: DataTextureArray): DataTextureArray {
  if (data instanceof Float32Array) return new Float32Array(0);
  if (data instanceof Uint16Array) return new Uint16Array(0);
  if (data instanceof Uint32Array) return new Uint32Array(0);
  return new Uint8Array(0);
}

/** Whether every texture has a created WebGPU texture behind it. */
export function dataTexturesUploaded(
  renderer: THREE.WebGPURenderer,
  textures: readonly THREE.DataTexture[],
): boolean {
  const backend = (renderer as unknown as { backend?: TextureBackend }).backend;
  if (!backend || backend.isWebGPUBackend !== true) return false;
  if (typeof backend.has !== 'function' || typeof backend.get !== 'function') return false;
  return textures.every(
    (texture) => backend.has?.(texture) === true && backend.get?.(texture)?.texture !== undefined,
  );
}

/**
 * Replaces uploaded texture images with zero-length arrays of the same type.
 * Returns unique bytes released; pool backing often aliases the image arrays.
 */
export function releaseDataTextureMirrors(textures: readonly THREE.DataTexture[]): number {
  const released = new Set<DataTextureArray>();
  for (const texture of textures) {
    const data = textureArray(texture);
    if (data.byteLength > 0) released.add(data);
    (texture.image as { data: DataTextureArray }).data = emptyLike(data);
  }
  let bytes = 0;
  for (const data of released) bytes += data.byteLength;
  return bytes;
}
