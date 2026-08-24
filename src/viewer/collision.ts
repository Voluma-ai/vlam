import * as THREE from 'three/webgpu';
import { MeshBVH } from 'three-mesh-bvh';
import type { CollisionMeshTile } from '../lib';

/**
 * Camera collision against a scene's collision meshes, for the demo.
 *
 * This is deliberately demo code, not library code: vlam hands back the
 * triangles an `.lcc2` capture ships (`StreamedSplatMesh.loadCollisionMeshes`)
 * and stops there, because what "collision" means - a sphere, a capsule, a
 * physics engine, nothing at all - is the host's decision. This file is one
 * such decision, using `three-mesh-bvh` for the queries.
 *
 * Tiles arrive in the capture's source-local frame; the world matrix is baked
 * into a **copy** of the geometry once here so every per-frame query is plain
 * world space. The original {@link CollisionMeshTile.data} buffers are left
 * untouched (source-local) for other consumers such as proxy relighting.
 */

/** Radians of slope still walkable; steeper counts as a wall. */
const MAX_GROUND_SLOPE = Math.cos(THREE.MathUtils.degToRad(50));
/** Push-out passes per resolve - enough for a corner to settle. */
const DEPENETRATION_PASSES = 4;
/**
 * Substeps one move is ever cut into.
 *
 * Substeps exist to stop a fast move tunnelling, so they scale with distance -
 * but distance scales with frame time, which means a hitch would order up more
 * collision work, which lengthens the next frame, which orders up more again.
 * The cap breaks that loop: past it a move may clip a thin wall, which is the
 * better failure than a viewer that stutters itself to a halt.
 */
const MAX_SUBSTEPS = 12;

/** A tile's world-space geometry, once its BVH exists. */
interface CollisionTile {
  readonly geometry: THREE.BufferGeometry;
  readonly bvh: MeshBVH;
  readonly bounds: THREE.Box3;
}

export interface CollisionWorld {
  /** True once at least one tile is queryable; more may still be building. */
  readonly ready: boolean;
  /** Tiles queryable so far, out of the total - for a progress hint. */
  readonly builtCount: number;
  readonly tileCount: number;
  /**
   * World-space extent of the geometry built so far. A capture's collision
   * usually covers less than its splats - the walkable part, not the skyline.
   */
  readonly bounds: THREE.Box3;
  /**
   * Moves `position` by `delta`, sliding along whatever it hits rather than
   * stopping dead. Mutates and returns `position`.
   */
  moveSphere(position: THREE.Vector3, delta: THREE.Vector3, radius: number): THREE.Vector3;
  /** Pushes `position` out of any geometry within `radius`. Mutates it. */
  depenetrate(position: THREE.Vector3, radius: number): THREE.Vector3;
  /**
   * Distance straight down from `origin` to the first walkable surface within
   * `maxDrop`, or null if there is none (a hole, or past the mesh's coverage).
   */
  groundDistance(origin: THREE.Vector3, maxDrop: number): number | null;
  dispose(): void;
}

const _hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
const _push = new THREE.Vector3();
const _step = new THREE.Vector3();
const _ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
const _probe = new THREE.Box3();
const _probeSize = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _triangle = new THREE.Triangle();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * Builds a collision world from loaded tiles, in the background.
 *
 * A BVH over ~70k triangles takes tens of milliseconds, and a capture ships
 * dozens of tiles, so building them all up front would freeze the frame for a
 * second or more. Instead one tile is built per macrotask, nearest to the
 * camera first: the ground underfoot becomes solid almost immediately and the
 * far side of the scene finishes while the user is still looking around.
 *
 * @param worldMatrix - The splat mesh's `matrixWorld`; baked into the geometry.
 */
export function createCollisionWorld(
  tiles: readonly CollisionMeshTile[],
  worldMatrix: THREE.Matrix4,
  options: { buildOrderOrigin?: THREE.Vector3 } = {},
): CollisionWorld {
  const built: CollisionTile[] = [];
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pending = tiles.filter((tile) => tile.data.triangleCount > 0);
  const origin = options.buildOrderOrigin;
  if (origin) {
    // Order by the tile's own bounds when the manifest gave them; a tile
    // without bounds sorts last rather than pretending to be at the origin.
    const distance = new Map<CollisionMeshTile, number>(
      pending.map((tile) => [
        tile,
        tile.bounds
          ? tile.bounds.clone().applyMatrix4(worldMatrix).distanceToPoint(origin)
          : Infinity,
      ]),
    );
    pending.sort((a, b) => (distance.get(a) as number) - (distance.get(b) as number));
  }

  let next = 0;
  let idle: number | undefined;
  /**
   * Queues the next build for a moment the frame is not busy.
   *
   * One BVH costs tens of milliseconds - several frames' worth - so building
   * on a timer lands those costs squarely in whatever frame comes next and
   * stutters visibly. requestIdleCallback spends the browser's own slack
   * instead, with a timeout so a permanently busy page still finishes.
   */
  const queueBuild = (): void => {
    if (typeof requestIdleCallback === 'function') {
      idle = requestIdleCallback(() => buildOne(), { timeout: 2000 });
    } else {
      timer = setTimeout(buildOne, 0); // Safari
    }
  };

  const buildOne = (): void => {
    if (disposed || next >= pending.length) return;
    const tile = pending[next++] as CollisionMeshTile;
    const geometry = new THREE.BufferGeometry();
    // Copy positions — `applyMatrix4` mutates the attribute buffer in place.
    // Shared `tile.data` must stay source-local for other consumers (e.g. proxy
    // relighting), which bake `matrixWorld` themselves from the raw frame.
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(tile.data.positions.slice(), 3),
    );
    geometry.setIndex(new THREE.BufferAttribute(tile.data.indices.slice(), 1));
    geometry.applyMatrix4(worldMatrix); // source-local → world, once
    geometry.computeBoundingBox();
    built.push({
      geometry,
      bvh: new MeshBVH(geometry),
      bounds: geometry.boundingBox ?? new THREE.Box3(),
    });
    queueBuild();
  };
  queueBuild();

  // Reused across frames: this runs several times per frame, and a fresh array
  // per call is pure garbage for the collector to chase.
  const nearby: CollisionTile[] = [];

  /** Tiles whose bounds could hold something within `radius` of `point`. */
  const near = (point: THREE.Vector3, radius: number): CollisionTile[] => {
    _probe.setFromCenterAndSize(point, _probeSize.setScalar(radius * 2));
    nearby.length = 0;
    for (const tile of built) if (tile.bounds.intersectsBox(_probe)) nearby.push(tile);
    return nearby;
  };

  const depenetrate = (position: THREE.Vector3, radius: number): THREE.Vector3 => {
    for (let pass = 0; pass < DEPENETRATION_PASSES; pass++) {
      let moved = false;
      for (const tile of near(position, radius)) {
        _hit.distance = 0;
        const hit = tile.bvh.closestPointToPoint(position, _hit, 0, radius);
        if (!hit || hit.distance >= radius) continue;
        _push.subVectors(position, hit.point);
        // Dead centre on a triangle gives no direction to escape along, so
        // fall back to the face's own normal.
        if (_push.lengthSq() < 1e-12) {
          faceNormal(tile, hit.faceIndex, _push);
          if (_push.lengthSq() < 1e-12) continue;
        }
        position.addScaledVector(_push.normalize(), radius - hit.distance);
        moved = true;
      }
      if (!moved) break;
    }
    return position;
  };

  return {
    get ready() {
      return built.length > 0;
    },
    get builtCount() {
      return built.length;
    },
    get tileCount() {
      return pending.length;
    },
    get bounds() {
      const box = new THREE.Box3();
      for (const tile of built) box.union(tile.bounds);
      return box;
    },

    moveSphere(position, delta, radius) {
      const distance = delta.length();
      if (distance === 0) return position;
      // Never advance more than half a radius at once: a single big step (the
      // shift boost, or a long frame) would otherwise jump clean through a
      // wall between one push-out and the next.
      const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(distance / (radius * 0.5))));
      _step.copy(delta).divideScalar(steps);
      for (let i = 0; i < steps; i++) {
        position.add(_step);
        // Push-out removes only the component into the surface, which is what
        // makes a blocked move slide along the wall instead of stopping.
        depenetrate(position, radius);
      }
      return position;
    },

    depenetrate,

    groundDistance(origin, maxDrop) {
      _ray.origin.copy(origin);
      _ray.direction.set(0, -1, 0);
      let nearest: number | null = null;
      for (const tile of built) {
        // A ray straight down can only hit tiles whose column contains it.
        if (
          origin.x < tile.bounds.min.x ||
          origin.x > tile.bounds.max.x ||
          origin.z < tile.bounds.min.z ||
          origin.z > tile.bounds.max.z ||
          origin.y - maxDrop > tile.bounds.max.y
        ) {
          continue;
        }
        // DoubleSide: a capture's floor is triangulated however the exporter
        // felt like, and a floor facing away is still a floor.
        const hit = tile.bvh.raycastFirst(_ray, THREE.DoubleSide);
        if (!hit || hit.distance > maxDrop) continue;
        // Ignore walls: standing on a vertical face is not standing.
        if (hit.face) {
          _normal.copy(hit.face.normal);
          if (Math.abs(_normal.y) < MAX_GROUND_SLOPE) continue;
        }
        if (nearest === null || hit.distance < nearest) nearest = hit.distance;
      }
      return nearest;
    },

    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      if (idle !== undefined) cancelIdleCallback(idle);
      for (const tile of built) tile.geometry.dispose();
      built.length = 0;
    },
  };
}

/** The normal of one triangle of a tile, for the degenerate push-out case. */
function faceNormal(tile: CollisionTile, faceIndex: number, out: THREE.Vector3): THREE.Vector3 {
  const index = tile.geometry.getIndex();
  const position = tile.geometry.getAttribute('position');
  if (!index) return out.set(0, 0, 0);
  _a.fromBufferAttribute(position, index.getX(faceIndex * 3));
  _b.fromBufferAttribute(position, index.getX(faceIndex * 3 + 1));
  _c.fromBufferAttribute(position, index.getX(faceIndex * 3 + 2));
  _triangle.set(_a, _b, _c);
  return _triangle.getNormal(out);
}
