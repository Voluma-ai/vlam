import * as THREE from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { describe, expect, it, vi } from 'vitest';
import { renderSplatDepth } from '../effects';

type Draw = Parameters<THREE.WebGPURenderer['renderObject']>;
type RenderHook = NonNullable<ReturnType<THREE.WebGPURenderer['getRenderObjectFunction']>>;

/** Just enough renderer for RendererUtils' save/reset/restore and one traversal. */
function createRenderer() {
  const originalHook = vi.fn<RenderHook>();
  const state = {
    target: null as ReturnType<THREE.WebGPURenderer['getRenderTarget']>,
    hook: originalHook as RenderHook | null,
    color: new THREE.Color(0.2, 0.3, 0.4),
    alpha: 0.6,
    scissorTest: true,
    pixelRatio: 2,
    viewport: new THREE.Vector4(10, 20, 800, 600),
    scissor: new THREE.Vector4(30, 40, 500, 400),
    mrt: null as ReturnType<THREE.WebGPURenderer['getMRT']> | null,
  };
  const stub = {
    toneMapping: 0,
    toneMappingExposure: 0.8,
    outputColorSpace: 'srgb',
    autoClear: false,
    autoClearColor: false,
    autoClearDepth: false,
    autoClearStencil: true,
    opaque: true,
    transparent: true,
    shadowMap: { enabled: true },
    getRenderTarget: () => state.target,
    setRenderTarget: vi.fn((target: typeof state.target) => {
      state.target = target;
    }),
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getRenderObjectFunction: () => state.hook,
    setRenderObjectFunction: (hook: typeof state.hook) => {
      state.hook = hook;
    },
    getPixelRatio: () => state.pixelRatio,
    setPixelRatio: (ratio: number) => {
      state.pixelRatio = ratio;
    },
    getMRT: () => state.mrt,
    setMRT: (mrt: typeof state.mrt) => {
      state.mrt = mrt;
    },
    getClearColor: (target: THREE.Color) => target.copy(state.color),
    getClearAlpha: () => state.alpha,
    setClearColor: (color: THREE.Color | number, alpha: number) => {
      state.color.set(color);
      state.alpha = alpha;
    },
    getScissorTest: () => state.scissorTest,
    setScissorTest: (value: boolean) => {
      state.scissorTest = value;
    },
    getViewport: (target: THREE.Vector4) => target.copy(state.viewport),
    setViewport: (value: THREE.Vector4) => {
      state.viewport.copy(value);
    },
    getScissor: (target: THREE.Vector4) => target.copy(state.scissor),
    setScissor: (value: THREE.Vector4) => {
      state.scissor.copy(value);
    },
    renderObject: vi.fn<(...args: Draw) => void>(),
    render: vi.fn((scene: THREE.Scene, camera: THREE.PerspectiveCamera) => {
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      scene.traverseVisible((object) => {
        if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
        state.hook?.(
          object,
          scene,
          camera,
          object.geometry,
          object.material,
          null,
          {} as Draw[6],
          {} as NonNullable<Draw[7]>,
        );
      });
    }),
  };
  return { renderer: stub as unknown as THREE.WebGPURenderer, stub, state, originalHook };
}

/** A mesh carrying the shared splat-draw brand, with a display-like node material. */
function addSplat(scene: THREE.Scene) {
  const material = new THREE.NodeMaterial();
  material.vertexNode = vec4(0, 0, 0, 1);
  material.fragmentNode = vec4(1, 1, 1, 0.8);
  material.depthWrite = false;
  material.transparent = true;
  const mesh = Object.assign(new THREE.Mesh(new THREE.BufferGeometry(), material), {
    isSplatDraw: true as const,
  });
  scene.add(mesh);
  return { mesh, material };
}

const target = () => new THREE.RenderTarget(4, 4, { depthBuffer: true });

describe('renderSplatDepth', () => {
  it('draws splat draws through depth-only proxies and leaves other meshes and display materials alone', () => {
    const { renderer, stub } = createRenderer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    camera.position.z = 5;
    const main = addSplat(scene);
    const marker = addSplat(scene);
    marker.mesh.position.set(2, 3, 4);
    const displayCallback = vi.fn();
    marker.mesh.onAfterRender = displayCallback;
    scene.add(new THREE.Mesh());
    const depthTarget = target();

    renderSplatDepth(renderer, scene, camera, depthTarget);

    expect(stub.renderObject).toHaveBeenCalledTimes(2);
    const draw = stub.renderObject.mock.calls[1]!;
    const proxy = draw[0] as THREE.Mesh;
    const depthMaterial = draw[4] as THREE.NodeMaterial;
    expect(proxy).not.toBe(marker.mesh);
    expect(proxy.geometry).toBe(marker.mesh.geometry);
    expect(proxy.matrixWorld.elements).toEqual(marker.mesh.matrixWorld.elements);
    expect(proxy.modelViewMatrix.elements[14]).toBeCloseTo(-1);
    expect(depthMaterial.vertexNode).toBe(marker.material.vertexNode);
    expect(depthMaterial.fragmentNode).not.toBe(marker.material.fragmentNode);
    expect(depthMaterial).toMatchObject({
      depthWrite: true,
      depthTest: true,
      transparent: false,
      colorWrite: false,
      blending: THREE.NoBlending,
    });
    expect(marker.mesh.material).toBe(marker.material);
    expect(marker.material.depthWrite).toBe(false);
    expect(main.material.depthWrite).toBe(false);
    // The proxy keeps the draw's own onAfterRender (publication acknowledgement) out of it.
    expect(displayCallback).not.toHaveBeenCalled();
    expect(stub.setRenderTarget).toHaveBeenCalledWith(depthTarget);
  });

  it('skips hidden draws and staged draws with color writes off', () => {
    const { renderer, stub } = createRenderer();
    const scene = new THREE.Scene();
    addSplat(scene).mesh.visible = false;
    addSplat(scene).material.colorWrite = false;
    const shown = addSplat(scene);
    renderSplatDepth(renderer, scene, new THREE.PerspectiveCamera(), target());
    expect(stub.renderObject).toHaveBeenCalledTimes(1);
    expect(stub.renderObject.mock.calls[0]![3]).toBe(shown.mesh.geometry);
  });

  it('reuses a depth material until the draw graph changes, and releases it with its source', () => {
    const { renderer, stub } = createRenderer();
    const scene = new THREE.Scene();
    const { mesh, material } = addSplat(scene);
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const camera = new THREE.PerspectiveCamera();
    renderSplatDepth(renderer, scene, camera, target());
    const first = stub.renderObject.mock.calls[0]![4];
    const firstDispose = vi.spyOn(first, 'dispose');
    renderSplatDepth(renderer, scene, camera, target(), { alphaThreshold: 0.3 });
    expect(stub.renderObject.mock.calls[1]![4]).toBe(first);

    material.fragmentNode = vec4(1, 1, 1, 0.3);
    renderSplatDepth(renderer, scene, camera, target());
    const second = stub.renderObject.mock.calls[2]![4];
    expect(second).not.toBe(first);
    expect(firstDispose).toHaveBeenCalledOnce();

    const secondDispose = vi.spyOn(second, 'dispose');
    material.dispose();
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(geometryDispose).not.toHaveBeenCalled();
  });

  it('restores renderer and scene state even when a depth draw throws', () => {
    const { renderer, stub, state, originalHook } = createRenderer();
    const scene = new THREE.Scene();
    const background = new THREE.Color(0.4, 0.5, 0.6);
    const override = new THREE.MeshBasicMaterial();
    scene.background = background;
    scene.overrideMaterial = override;
    addSplat(scene);
    stub.renderObject.mockImplementation(() => {
      expect(stub.shadowMap.enabled).toBe(false);
      expect(scene.background).toBeNull();
      expect(scene.overrideMaterial).toBeNull();
      throw new Error('depth draw failed');
    });
    expect(() =>
      renderSplatDepth(renderer, scene, new THREE.PerspectiveCamera(), target()),
    ).toThrow('depth draw failed');
    expect(state.hook).toBe(originalHook);
    expect(state.target).toBeNull();
    expect(state.scissorTest).toBe(true);
    expect(state.viewport.toArray()).toEqual([10, 20, 800, 600]);
    expect(stub.shadowMap.enabled).toBe(true);
    expect(stub.autoClear).toBe(false);
    expect(stub.autoClearDepth).toBe(false);
    expect(stub.autoClearColor).toBe(false);
    expect(stub.autoClearStencil).toBe(true);
    expect(scene.background).toBe(background);
    expect(scene.overrideMaterial).toBe(override);
  });
});
