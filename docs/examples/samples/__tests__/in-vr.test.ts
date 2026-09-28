import * as THREE from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, SessionEvents } from './test-utils';

const f = vi.hoisted(() => ({
  createRenderer: vi.fn(),
  meshes: [] as { update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[],
  controls: [] as { enabled: boolean; dispose: ReturnType<typeof vi.fn> }[],
}));
vi.mock('@voluma/vlam', () => ({
  createWebGPURenderer: f.createRenderer,
  recommendedXrFramebufferScale: () => 0.8,
  xrSessionInit: (_renderer: unknown, options: unknown) => options,
  SplatMesh: class extends THREE.Group {
    update = vi.fn();
    dispose = vi.fn();
    constructor() {
      super();
      f.meshes.push(this);
    }
  },
}));
vi.mock('@voluma/vlam/loaders', () => ({ loadSplatData: async () => ({}) }));
vi.mock('three/addons/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    enabled = true;
    target = new THREE.Vector3();
    update = vi.fn();
    dispose = vi.fn();
    constructor() {
      f.controls.push(this);
    }
  },
}));

function fixture() {
  const button = Object.assign(new EventTarget(), { disabled: true });
  const status = { textContent: '' };
  const windowEvents = new EventTarget();
  const controllers = [new THREE.Group(), new THREE.Group()];
  const localHead = new THREE.Vector3(0.35, 1.7, -0.2);
  const head = new THREE.PerspectiveCamera();
  let loop: (() => void) | null = null;
  let savedLoop: (() => void) | null = null;
  const gates: { setup?: Promise<void>; end?: Promise<void> } = {};
  const xr = Object.assign(new SessionEvents(), {
    enabled: false,
    isPresenting: false,
    setReferenceSpaceType: vi.fn(),
    setFramebufferScaleFactor: vi.fn(),
    getController: (index: number) => controllers[index]!,
    getCamera: () => head,
    updateCamera: (camera: THREE.Camera) => {
      camera.parent?.updateMatrixWorld(true);
      head.position.copy(localHead);
      if (camera.parent) head.position.applyMatrix4(camera.parent.matrixWorld);
      head.updateMatrixWorld(true);
      camera.position.copy(localHead);
      camera.updateMatrixWorld(true);
    },
    setSession: vi.fn(async () => {
      savedLoop = loop;
      await gates.setup;
      xr.isPresenting = true;
      xr.emit('sessionstart');
    }),
  });
  const session = {
    end: vi.fn(async () => {
      await gates.end;
      xr.isPresenting = false;
      // Three restores and immediately invokes the pre-session callback before
      // emitting sessionend, even if setAnimationLoop(null) was called in XR.
      loop = savedLoop;
      loop?.();
      xr.emit('sessionend');
    }),
  };
  const requestSession = vi.fn(async () => session);
  const renderer = {
    xr,
    domElement: { remove: vi.fn() },
    setSize: vi.fn(),
    setAnimationLoop: vi.fn((callback: (() => void) | null) => {
      loop = callback;
    }),
    render: vi.fn((scene: THREE.Scene, camera: THREE.Camera) => {
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
    }),
    dispose: vi.fn(),
  };
  f.createRenderer.mockResolvedValue(renderer);
  vi.stubGlobal('document', {
    querySelector: (selector: string) => (selector === '#enter-vr' ? button : status),
    body: { appendChild: vi.fn() },
  });
  vi.stubGlobal('navigator', {
    xr: { isSessionSupported: async () => true, requestSession },
  });
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('innerWidth', 640);
  vi.stubGlobal('innerHeight', 480);
  vi.stubGlobal('addEventListener', windowEvents.addEventListener.bind(windowEvents));
  vi.stubGlobal('removeEventListener', windowEvents.removeEventListener.bind(windowEvents));
  return {
    button,
    status,
    controllers,
    head,
    gates,
    xr,
    session,
    requestSession,
    renderer,
    tick: () => {
      loop?.();
    },
    hide: () => windowEvents.dispatchEvent(new Event('pagehide')),
    enter: async () => {
      button.dispatchEvent(new Event('click'));
      await vi.waitFor(() => expect(status.textContent).toContain('In VR.'));
    },
  };
}
let app: ReturnType<typeof fixture>;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  f.meshes.length = f.controls.length = 0;
  app = fixture();
  await import('../in-vr');
  app.tick();
});
afterEach(async () => {
  app.hide();
  await vi.waitFor(() => expect(app.renderer.dispose).toHaveBeenCalledOnce());
  vi.unstubAllGlobals();
});

describe('VR example sessions and controller input', () => {
  it('reports rejection, retries, restores the desktop camera, and re-enters', async () => {
    const camera = app.renderer.render.mock.calls[0]![1] as THREE.PerspectiveCamera;
    const position = camera.position.clone();
    const projection = camera.projectionMatrix.clone();
    app.requestSession.mockRejectedValueOnce(new Error('permission denied'));
    app.button.dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(app.status.textContent).toContain('permission denied'));
    expect(app.button.disabled).toBe(false);
    await app.enter();
    app.tick();
    expect(camera.parent).not.toBeNull();
    expect(f.controls[0]!.enabled).toBe(false);
    expect(f.meshes[0]!.update).toHaveBeenLastCalledWith(camera, app.renderer);
    await app.session.end();
    expect(camera.parent).toBeNull();
    expect(camera.position.equals(position)).toBe(true);
    expect(camera.projectionMatrix.equals(projection)).toBe(true);
    expect(f.controls[0]!.enabled).toBe(true);
    expect(app.button.disabled).toBe(false);
    await app.enter();
    expect(app.xr.setSession).toHaveBeenCalledTimes(2);
  });

  it('teleports on the floor and snap-turns about the head once per deflection', async () => {
    await app.enter();
    app.tick();
    const controller = app.controllers[1]!;
    const axes = [0, 0, 0, 0];
    const source = { handedness: 'right', gamepad: { mapping: 'xr-standard', axes } };
    controller.dispatchEvent({ type: 'connected', data: source } as never);
    controller.position.set(0, 1.4, -0.2);
    controller.rotation.x = -Math.PI / 4;
    controller.dispatchEvent({ type: 'selectstart' } as never);
    controller.dispatchEvent({ type: 'selectend' } as never);
    app.tick();
    expect(app.head.position.x).toBeCloseTo(-0.35);
    expect(app.head.position.y).toBeCloseTo(1.7);
    expect(app.head.position.z).toBeCloseTo(1.3);
    const before = app.head.position.clone();
    // Aim through the pedestal footprint: the floor has a hole there.
    const direction = controller.getWorldPosition(new THREE.Vector3()).negate().normalize();
    controller.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction);
    controller.dispatchEvent({ type: 'selectstart' } as never);
    controller.dispatchEvent({ type: 'selectend' } as never);
    app.tick();
    expect(app.head.position.distanceTo(before)).toBeLessThan(1e-8);
    const rig = controller.parent!;
    axes[2] = 0.9;
    app.tick();
    expect(rig.rotation.y).toBeCloseTo(-Math.PI / 6);
    app.tick();
    expect(app.head.position.distanceTo(before)).toBeLessThan(1e-8);
    expect(rig.rotation.y).toBeCloseTo(-Math.PI / 6);
    axes[2] = 0;
    app.tick();
    axes[2] = 0.9;
    app.tick();
    expect(rig.rotation.y).toBeCloseTo(-Math.PI / 3);
    controller.dispatchEvent({ type: 'disconnected' } as never);
    app.tick();
    expect(rig.rotation.y).toBeCloseTo(-Math.PI / 3);
  });

  it('waits for session end and ignores the saved loop before disposing resources', async () => {
    await app.enter();
    const end = deferred<void>();
    app.gates.end = end.promise;
    app.hide();
    await vi.waitFor(() => expect(app.session.end).toHaveBeenCalledOnce());
    expect(app.renderer.dispose).not.toHaveBeenCalled();
    expect(f.meshes[0]!.dispose).not.toHaveBeenCalled();
    app.renderer.render.mockClear();
    end.resolve(undefined);
    await vi.waitFor(() => expect(app.renderer.dispose).toHaveBeenCalledOnce());
    expect(app.renderer.render).not.toHaveBeenCalled();
    expect(app.renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
    expect(f.meshes[0]!.dispose).toHaveBeenCalledOnce();
    expect(f.controls[0]!.dispose).toHaveBeenCalledOnce();
  });

  it('waits for pending setSession before ending and disposing', async () => {
    const setup = deferred<void>();
    app.gates.setup = setup.promise;
    app.button.dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(app.xr.setSession).toHaveBeenCalledOnce());
    app.hide();
    expect(app.session.end).not.toHaveBeenCalled();
    expect(app.renderer.dispose).not.toHaveBeenCalled();
    setup.resolve(undefined);
    await vi.waitFor(() => expect(app.renderer.dispose).toHaveBeenCalledOnce());
    expect(app.session.end).toHaveBeenCalledOnce();
    expect(app.button.disabled).toBe(true);
  });

  it('ends a session granted after pagehide without attaching it to the renderer', async () => {
    const request = deferred<typeof app.session>();
    app.requestSession.mockReturnValueOnce(request.promise);
    app.button.dispatchEvent(new Event('click'));
    app.hide();
    request.resolve(app.session);
    await vi.waitFor(() => expect(app.renderer.dispose).toHaveBeenCalledOnce());
    expect(app.xr.setSession).not.toHaveBeenCalled();
    expect(app.session.end).toHaveBeenCalledOnce();
  });
});
