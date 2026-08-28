import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { StreamedSplatMesh } from '../streaming/streamed-splat-mesh';

/**
 * LOD scheduling under XR. The application camera does not move while a
 * session presents - three drives an internal array camera instead - so a
 * scheduler fed the app camera resolves detail wherever that camera was left
 * standing and frustum-culls whatever the viewer turns to face. It must
 * schedule from the head, whose union projection also spans both eyes.
 */

const WIDTH = 2048;

beforeAll(() => {
  if (typeof (globalThis as { Worker?: unknown }).Worker === 'undefined') {
    (globalThis as { Worker: unknown }).Worker = class {
      postMessage(): void {}
      terminate(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
      onmessage: unknown = null;
      onerror: unknown = null;
    };
  }
});

function makeStreamedMesh(): StreamedSplatMesh {
  const scene = {
    source: { budget: 4 * WIDTH } as unknown,
    chunkUrls: [] as string[],
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: 4 * WIDTH,
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
  ) => StreamedSplatMesh;
  return new Ctor(scene, 4 * WIDTH, 4 * WIDTH, {});
}

/** A renderer presenting a head placed well away from the app camera. */
function xrRenderer(): { renderer: THREE.WebGPURenderer; head: THREE.ArrayCamera } {
  const eye = new THREE.PerspectiveCamera();
  (eye as { viewport?: THREE.Vector4 }).viewport = new THREE.Vector4(0, 0, 1680, 1760);
  const head = new THREE.ArrayCamera([eye]);
  // three decomposes the viewer pose into the head's position/quaternion, so
  // mirror that rather than writing `matrix` (which matrixAutoUpdate rebuilds).
  head.position.set(42, 1.6, -17);
  head.updateMatrix();
  const renderer = {
    backend: { isWebGPUBackend: true },
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(3360, 1760),
    xr: {
      isPresenting: true,
      getCamera: () => head,
      updateCamera: () => {
        head.matrixWorld.copy(head.matrix);
        head.matrixWorldInverse.copy(head.matrixWorld).invert();
      },
    },
  } as unknown as THREE.WebGPURenderer;
  return { renderer, head };
}

describe('StreamedSplatMesh LOD scheduling under XR', () => {
  it('reschedules from the head pose, not the stationary application camera', () => {
    const mesh = makeStreamedMesh();
    const { renderer } = xrRenderer();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 0);
    camera.updateMatrixWorld(true);

    const internals = mesh as unknown as {
      reschedule: (camera: THREE.Camera, now: number) => unknown;
    };
    const seen: THREE.Vector3[] = [];
    vi.spyOn(internals, 'reschedule').mockImplementation((scheduleCamera) => {
      seen.push(scheduleCamera.getWorldPosition(new THREE.Vector3()));
      return null;
    });

    mesh.update(camera, renderer);

    expect(seen).toHaveLength(1);
    // The head, 42 m away - not the app camera sitting at the origin.
    expect(seen[0]!.x).toBeCloseTo(42);
    expect(seen[0]!.z).toBeCloseTo(-17);
    mesh.dispose();
  });

  it('still schedules from the application camera outside a session', () => {
    const mesh = makeStreamedMesh();
    const { renderer } = xrRenderer();
    (renderer as unknown as { xr: { isPresenting: boolean } }).xr.isPresenting = false;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(3, 0, 5);
    camera.updateMatrixWorld(true);

    const internals = mesh as unknown as {
      reschedule: (camera: THREE.Camera, now: number) => unknown;
    };
    const seen: THREE.Vector3[] = [];
    vi.spyOn(internals, 'reschedule').mockImplementation((scheduleCamera) => {
      seen.push(scheduleCamera.getWorldPosition(new THREE.Vector3()));
      return null;
    });

    mesh.update(camera, renderer);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.x).toBeCloseTo(3);
    expect(seen[0]!.z).toBeCloseTo(5);
    mesh.dispose();
  });
});
