import type * as THREE from 'three/webgpu';
import { toRequestInit, type SplatRequestOptions } from '../../loading';
import { parseMeshPly, type TriangleMeshData } from './parse-mesh-ply';
import { parseCollisionLci } from './parse-collision-lci';
import type { CollisionMeshDescriptor, SceneCollision } from '../../lod-source';
import { warn } from '../../logging';

/**
 * Fetches the collision-mesh tiles a streamed scene declares.
 *
 * VLAM! is not a physics engine: this hands back plain triangle geometry and
 * stops there. Building an acceleration structure, resolving a character
 * against it, and deciding what "collision" means for the host's camera are
 * all the host's business (see the demo's `collision.ts` for one answer).
 *
 * Descriptors may point at `.lcc2` mesh PLYs or a classic-LCC `collision.lci`
 * (one file → many per-cell tiles).
 */

/** One loaded collision tile, in the scene's source-local frame. */
export interface CollisionMeshTile {
  /** The URL it came from - a stable identity for caching or debugging. */
  readonly url: string;
  readonly data: TriangleMeshData;
  /** Source-local bounds from the manifest, when it declared them. */
  readonly bounds?: THREE.Box3;
}

/**
 * Fetches and parses every tile in `collision`, concurrently.
 *
 * A tile that fails to fetch or parse is warned about and skipped rather than
 * failing the batch: collision degrades to partial coverage, which is what the
 * rest of the streaming pipeline does with a bad chunk too. A classic-LCC
 * `.lci` descriptor expands into one tile per cell mesh inside the file.
 *
 * @throws a `DOMException` named `AbortError` when cancelled.
 */
export async function loadCollisionMeshTiles(
  collision: SceneCollision,
  options: { request?: SplatRequestOptions; signal?: AbortSignal } = {},
): Promise<CollisionMeshTile[]> {
  const settled = await Promise.allSettled(
    collision.meshes.map((descriptor) => loadDescriptor(descriptor, options)),
  );

  options.signal?.throwIfAborted();

  const tiles: CollisionMeshTile[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') tiles.push(...result.value);
    else warn('Skipping a collision mesh that failed to load:', result.reason);
  }
  return tiles;
}

async function loadDescriptor(
  descriptor: CollisionMeshDescriptor,
  options: { request?: SplatRequestOptions; signal?: AbortSignal },
): Promise<CollisionMeshTile[]> {
  const response = await fetch(descriptor.url, toRequestInit(options.request, options.signal));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for collision mesh ${descriptor.url}`);
  }
  const buffer = await response.arrayBuffer();

  if (isLciUrl(descriptor.url)) {
    const parsed = parseCollisionLci(buffer);
    return parsed.tiles.map((tile) => ({
      url: `${descriptor.url}#c${tile.cellX}_${tile.cellY}`,
      data: tile.data,
      bounds: tile.bounds,
    }));
  }

  const data = parseMeshPly(buffer);
  return [
    {
      url: descriptor.url,
      data,
      ...(descriptor.bounds ? { bounds: descriptor.bounds } : {}),
    },
  ];
}

/** True when the descriptor points at a classic-LCC `collision.lci`. */
function isLciUrl(url: string): boolean {
  try {
    return new URL(url, 'https://example.invalid/').pathname.toLowerCase().endsWith('.lci');
  } catch {
    return url.toLowerCase().includes('.lci');
  }
}
