/** Internal helpers for releasing uploaded DataTexture CPU images on WebGPU. */
import type * as THREE from 'three/webgpu';

type DataTextureArray = Float32Array | Uint8Array | Uint16Array | Uint32Array;

interface TextureBackend {
  readonly isWebGPUBackend?: boolean;
  has?(object: object): boolean;
  get?(object: object): { texture?: unknown };
}

interface TextureUploadRecord {
  initialized?: boolean;
  version?: number;
}

interface TextureUploadMap {
  has?(object: object): boolean;
  get?(object: object): TextureUploadRecord;
}

function textureUploadMap(renderer: THREE.WebGPURenderer): TextureUploadMap | undefined {
  return (renderer as unknown as { _textures?: TextureUploadMap })._textures;
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
  if (
    !textures.every(
      (texture) => backend.has?.(texture) === true && backend.get?.(texture)?.texture !== undefined,
    )
  ) {
    return false;
  }
  // Compute can create a GPU texture before three's texture manager records a
  // matching version. Emptying the CPU image then lets a later material compile
  // writeTexture a 0-byte image and poison the device; pick readback reports
  // that as mapAsync "external Instance reference no longer exists".
  const uploads = textureUploadMap(renderer);
  if (!uploads || typeof uploads.has !== 'function' || typeof uploads.get !== 'function') {
    return true;
  }
  return textures.every((texture) => {
    if (uploads.has?.(texture) !== true) return false;
    const data = uploads.get?.(texture);
    return data?.initialized === true && data.version === texture.version;
  });
}

/**
 * Replaces uploaded texture images with zero-length arrays of the same type.
 * Returns unique bytes released; pool backing often aliases the image arrays.
 */
export function releaseDataTextureMirrors(
  textures: readonly THREE.DataTexture[],
  renderer?: THREE.WebGPURenderer,
): number {
  const released = new Set<DataTextureArray>();
  for (const texture of textures) {
    const data = textureArray(texture);
    if (data.byteLength > 0) released.add(data);
    (texture.image as { data: DataTextureArray }).data = emptyLike(data);
  }
  const uploads = renderer === undefined ? undefined : textureUploadMap(renderer);
  if (uploads && typeof uploads.has === 'function' && typeof uploads.get === 'function') {
    for (const texture of textures) {
      if (uploads.has(texture) !== true) continue;
      const record = uploads.get(texture);
      if (record === undefined) continue;
      record.initialized = true;
      record.version = texture.version;
    }
  }
  let bytes = 0;
  for (const data of released) bytes += data.byteLength;
  return bytes;
}
