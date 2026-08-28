// Host-side collision helper for site/examples/collision-walk.md.
import * as THREE from 'three/webgpu';
import { MeshBVH } from 'three-mesh-bvh';
import type { CollisionMeshTile } from '@voluma/vlam/streaming';

/** Radians of slope still walkable; steeper triangles count as walls. */
const MAX_GROUND_SLOPE = Math.cos(THREE.MathUtils.degToRad(50));
/** Push-out passes per resolve, enough for a corner to settle. */
const DEPENETRATION_PASSES = 4;
/** Caps hitch-time work; past this, clipping a thin wall is preferable to stalling. */
const MAX_SUBSTEPS = 12;

interface CollisionTile {
  readonly geometry: THREE.BufferGeometry;
  readonly bvh: MeshBVH;
  readonly bounds: THREE.Box3;
}

/** The collision operations this particular walking controller needs. */
export interface CollisionWorld {
  /** True once at least one tile is queryable; more may still be building. */
  readonly ready: boolean;
  /** Tiles queryable so far, out of the total. */
  readonly builtCount: number;
  readonly tileCount: number;
  /** Moves a sphere through the world and slides it along blocking surfaces. */
  moveSphere(position: THREE.Vector3, delta: THREE.Vector3, radius: number): THREE.Vector3;
  /** Pushes a sphere out of any geometry it overlaps. */
  depenetrate(position: THREE.Vector3, radius: number): THREE.Vector3;
  /** Finds the first walkable surface straight down, or `null` outside coverage. */
  groundDistance(origin: THREE.Vector3, maxDrop: number): number | null;
  dispose(): void;
}

const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
const push = new THREE.Vector3();
const step = new THREE.Vector3();
const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
const probe = new THREE.Box3();
const probeSize = new THREE.Vector3();
const normal = new THREE.Vector3();
const triangle = new THREE.Triangle();
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();

/**
 * Builds a queryable world from format-provided triangle tiles.
 *
 * BVHs are built one at a time during browser idle periods, nearest the camera
 * first. A large capture becomes walkable quickly without freezing one frame
 * while every tile is indexed.
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
    // Missing bounds sort last rather than pretending to be at the origin.
    const distances = new Map<CollisionMeshTile, number>(
      pending.map((tile) => [
        tile,
        tile.bounds
          ? tile.bounds.clone().applyMatrix4(worldMatrix).distanceToPoint(origin)
          : Infinity,
      ]),
    );
    pending.sort(
      (left, right) => (distances.get(left) as number) - (distances.get(right) as number),
    );
  }

  let next = 0;
  let idle: number | undefined;

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
    // `applyMatrix4` mutates the attribute, so keep the format data source-local.
    geometry.setAttribute('position', new THREE.BufferAttribute(tile.data.positions.slice(), 3));
    geometry.setIndex(new THREE.BufferAttribute(tile.data.indices.slice(), 1));
    geometry.applyMatrix4(worldMatrix);
    geometry.computeBoundingBox();
    built.push({
      geometry,
      bvh: new MeshBVH(geometry),
      bounds: geometry.boundingBox ?? new THREE.Box3(),
    });
    queueBuild();
  };
  queueBuild();

  // Reuse this array because collision runs several times per frame.
  const nearby: CollisionTile[] = [];
  const near = (point: THREE.Vector3, radius: number): CollisionTile[] => {
    probe.setFromCenterAndSize(point, probeSize.setScalar(radius * 2));
    nearby.length = 0;
    for (const tile of built) if (tile.bounds.intersectsBox(probe)) nearby.push(tile);
    return nearby;
  };

  const depenetrate = (position: THREE.Vector3, radius: number): THREE.Vector3 => {
    for (let pass = 0; pass < DEPENETRATION_PASSES; pass++) {
      let moved = false;
      for (const tile of near(position, radius)) {
        hit.distance = 0;
        const closest = tile.bvh.closestPointToPoint(position, hit, 0, radius);
        if (!closest || closest.distance >= radius) continue;
        push.subVectors(position, closest.point);
        // Dead centre on a triangle has no escape direction; use its normal.
        if (push.lengthSq() < 1e-12) {
          faceNormal(tile, closest.faceIndex, push);
          if (push.lengthSq() < 1e-12) continue;
        }
        position.addScaledVector(push.normalize(), radius - closest.distance);
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

    moveSphere(position, delta, radius) {
      const distance = delta.length();
      if (distance === 0) return position;
      // A step no longer than half the radius cannot skip a normal wall.
      const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(distance / (radius * 0.5))));
      step.copy(delta).divideScalar(steps);
      for (let index = 0; index < steps; index++) {
        position.add(step);
        depenetrate(position, radius);
      }
      return position;
    },

    depenetrate,

    groundDistance(originPoint, maxDrop) {
      ray.origin.copy(originPoint);
      ray.direction.set(0, -1, 0);
      let nearest: number | null = null;
      for (const tile of built) {
        if (
          originPoint.x < tile.bounds.min.x ||
          originPoint.x > tile.bounds.max.x ||
          originPoint.z < tile.bounds.min.z ||
          originPoint.z > tile.bounds.max.z ||
          originPoint.y - maxDrop > tile.bounds.max.y
        ) {
          continue;
        }
        const floorHit = tile.bvh.raycastFirst(ray, THREE.DoubleSide);
        if (!floorHit || floorHit.distance > maxDrop) continue;
        if (floorHit.face) {
          normal.copy(floorHit.face.normal);
          if (Math.abs(normal.y) < MAX_GROUND_SLOPE) continue;
        }
        if (nearest === null || floorHit.distance < nearest) nearest = floorHit.distance;
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

function faceNormal(tile: CollisionTile, faceIndex: number, out: THREE.Vector3): THREE.Vector3 {
  const index = tile.geometry.getIndex();
  const position = tile.geometry.getAttribute('position');
  if (!index) return out.set(0, 0, 0);
  a.fromBufferAttribute(position, index.getX(faceIndex * 3));
  b.fromBufferAttribute(position, index.getX(faceIndex * 3 + 1));
  c.fromBufferAttribute(position, index.getX(faceIndex * 3 + 2));
  triangle.set(a, b, c);
  return triangle.getNormal(out);
}
