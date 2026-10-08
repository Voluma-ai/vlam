import type * as THREE from 'three/webgpu';
import { dataTexturesUploaded } from './data-texture-mirror';

/** One resident range moving toward row 0 during pool compaction. */
export interface PoolRowMove {
  readonly fromRow: number;
  readonly toRow: number;
  readonly rowCount: number;
}

/** Rows per staged hop; 64 rows of a 2048-wide RGBA32 texture is 8 MiB. */
const RELOCATION_CHUNK_ROWS = 64;

const BYTES_PER_TEXEL: Readonly<Record<string, number>> = {
  rgba32float: 16,
  rgba32uint: 16,
  rgba16float: 8,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
};

// Minimal structural WebGPU types: the package does not depend on @webgpu/types.
interface GpuTextureLike {
  readonly format: string;
}
interface GpuBufferLike {
  destroy(): void;
}
interface GpuCopyBuffer {
  buffer: GpuBufferLike;
  bytesPerRow: number;
  rowsPerImage: number;
}
interface GpuCopyTexture {
  texture: GpuTextureLike;
  origin: { x: number; y: number };
}
interface GpuCopySize {
  width: number;
  height: number;
}
interface GpuDeviceLike {
  createBuffer(descriptor: { label?: string; size: number; usage: number }): GpuBufferLike;
  createCommandEncoder(descriptor?: { label?: string }): {
    copyTextureToBuffer(
      source: GpuCopyTexture,
      destination: GpuCopyBuffer,
      size: GpuCopySize,
    ): void;
    copyBufferToTexture(
      source: GpuCopyBuffer,
      destination: GpuCopyTexture,
      size: GpuCopySize,
    ): void;
    finish(): unknown;
  };
  readonly queue: { submit(commandBuffers: unknown[]): void };
}

interface WebGpuBackendLike {
  isWebGPUBackend?: boolean;
  device?: GpuDeviceLike;
  get?: (object: object) => { texture?: GpuTextureLike } | undefined;
}

const scratchBuffers = new WeakMap<GpuDeviceLike, { buffer: GpuBufferLike; size: number }>();

function scratchBuffer(device: GpuDeviceLike, size: number): GpuBufferLike {
  const existing = scratchBuffers.get(device);
  if (existing && existing.size >= size) return existing.buffer;
  existing?.buffer.destroy();
  const buffer = device.createBuffer({
    label: 'vlam-pool-relocation-scratch',
    size,
    // GpuBufferLikeUsage.COPY_SRC | COPY_DST, spelled out so Node tests need no WebGPU globals.
    usage: 0x4 | 0x8,
  });
  scratchBuffers.set(device, { buffer, size });
  return buffer;
}

/**
 * Resolves every pool texture to its live GPU texture, or `null` when any one
 * cannot be copied on the GPU (WebGL2 backend or an unexpected format).
 * Callers then keep the CPU re-upload path for all rows.
 */
export function resolvePoolGpuTextures(
  renderer: THREE.WebGPURenderer | null | undefined,
  textures: readonly THREE.DataTexture[],
): { device: GpuDeviceLike; textures: GpuTextureLike[] } | null {
  const backend = renderer?.backend as WebGpuBackendLike | undefined;
  if (backend?.isWebGPUBackend !== true || !backend.device || !backend.get) return null;
  // The GPU copy must read the pre-compaction layout, so any pending image
  // upload has to land first; this also confirms each backend texture exists.
  if (!dataTexturesUploaded(renderer as THREE.WebGPURenderer, textures)) return null;
  const gpuTextures: GpuTextureLike[] = [];
  for (const texture of textures) {
    const gpuTexture = backend.get(texture)?.texture;
    if (!gpuTexture || BYTES_PER_TEXEL[gpuTexture.format] === undefined) return null;
    gpuTextures.push(gpuTexture);
  }
  return { device: backend.device, textures: gpuTextures };
}

/**
 * Moves pool rows inside the GPU textures in one submission, so compaction
 * does not re-upload the moved rows from CPU backing. WebGPU forbids a copy
 * within one subresource, so each hop stages through a small scratch buffer.
 *
 * `moves` must be in ascending row order with `toRow <= fromRow` (as
 * `SplatPool.compact` produces); copying each range front to back then never
 * reads a row an earlier copy already overwrote. Commands in one encoder run
 * in order, so the shared scratch buffer is safe to reuse between hops.
 */
export function relocatePoolRowsOnGpu(
  device: GpuDeviceLike,
  textures: readonly GpuTextureLike[],
  width: number,
  moves: readonly PoolRowMove[],
): void {
  if (moves.length === 0 || textures.length === 0) return;
  let maxBytesPerRow = 0;
  for (const texture of textures) {
    maxBytesPerRow = Math.max(maxBytesPerRow, width * (BYTES_PER_TEXEL[texture.format] ?? 0));
  }
  const buffer = scratchBuffer(device, RELOCATION_CHUNK_ROWS * maxBytesPerRow);
  const encoder = device.createCommandEncoder({ label: 'vlam-pool-relocation' });
  for (const { fromRow, toRow, rowCount } of moves) {
    for (let offset = 0; offset < rowCount; offset += RELOCATION_CHUNK_ROWS) {
      const rows = Math.min(RELOCATION_CHUNK_ROWS, rowCount - offset);
      for (const texture of textures) {
        const bytesPerRow = width * (BYTES_PER_TEXEL[texture.format] as number);
        const layout = { buffer, bytesPerRow, rowsPerImage: rows };
        const size = { width, height: rows };
        encoder.copyTextureToBuffer(
          { texture, origin: { x: 0, y: fromRow + offset } },
          layout,
          size,
        );
        encoder.copyBufferToTexture(layout, { texture, origin: { x: 0, y: toRow + offset } }, size);
      }
    }
  }
  device.queue.submit([encoder.finish()]);
}
