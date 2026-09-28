import * as THREE from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from './test-utils';

const f = vi.hoisted(() => ({
  effect: undefined as (() => void | (() => void)) | undefined,
  host: { clientWidth: 640, clientHeight: 480, appendChild: vi.fn() },
  setState: vi.fn(),
  createRenderer: vi.fn(),
  load: vi.fn(),
  controls: [] as { dispose: ReturnType<typeof vi.fn> }[],
  meshes: [] as { dispose: ReturnType<typeof vi.fn> }[],
  observers: [] as { disconnect: ReturnType<typeof vi.fn> }[],
}));

// Exercise the sample's actual effect with deferred renderer/load promises.
// Hook scheduling is supplied by the harness; no GPU or DOM is needed here.
vi.mock('react', () => ({
  useRef: () => ({ current: f.host }),
  useState: () => [{ src: '', status: 'loading' }, f.setState],
  useEffect: (effect: typeof f.effect) => {
    f.effect = effect;
  },
}));
vi.mock('@voluma/vlam', () => ({
  createWebGPURenderer: f.createRenderer,
  SplatMesh: class extends THREE.Group {
    dispose = vi.fn();
    update = vi.fn();
    constructor() {
      super();
      f.meshes.push(this);
    }
  },
}));
vi.mock('@voluma/vlam/loaders', () => ({
  loadSplatData: f.load,
  isAbortError: (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
}));
vi.mock('three/addons/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    dispose = vi.fn();
    update = vi.fn();
    constructor() {
      f.controls.push(this);
    }
  },
}));

function renderer() {
  return {
    domElement: { remove: vi.fn() },
    setSize: vi.fn(),
    setAnimationLoop: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
}
const cleanups: (() => void)[] = [];
async function mount(src = '/first.sog') {
  const { SplatViewer } = await import('../react-viewer');
  SplatViewer({ src });
  const cleanup = f.effect?.();
  if (!cleanup) throw new Error('The viewer must register synchronous effect cleanup');
  cleanups.push(cleanup);
  return cleanup;
}

beforeEach(() => {
  vi.clearAllMocks();
  f.controls.length = f.meshes.length = f.observers.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor() {
        f.observers.push(this);
      }
    },
  );
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe('React sample effect lifecycle', () => {
  it('disposes a renderer that finishes after unmount', async () => {
    const pending = deferred<ReturnType<typeof renderer>>();
    const gpu = renderer();
    f.createRenderer.mockReturnValueOnce(pending.promise);
    const cleanup = await mount();
    cleanup();
    pending.resolve(gpu);
    await vi.waitFor(() => expect(gpu.dispose).toHaveBeenCalledOnce());
    expect(f.load).not.toHaveBeenCalled();
    expect(f.host.appendChild).not.toHaveBeenCalled();
  });

  it('aborts a pending load and ignores a late result', async () => {
    const pending = deferred<object>();
    const gpu = renderer();
    f.createRenderer.mockResolvedValueOnce(gpu);
    f.load.mockReturnValueOnce(pending.promise);
    const cleanup = await mount();
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    const options = f.load.mock.calls[0]![1] as { signal: AbortSignal };
    cleanup();
    expect(options.signal.aborted).toBe(true);
    pending.resolve({});
    await pending.promise;
    expect(f.meshes).toHaveLength(0);
    expect(gpu.dispose).toHaveBeenCalledOnce();
    expect(gpu.domElement.remove).toHaveBeenCalledOnce();
    expect(f.controls[0]!.dispose).toHaveBeenCalledOnce();
    expect(f.setState).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
  });

  it('reports renderer initialization failure without starting a load', async () => {
    f.createRenderer.mockRejectedValueOnce(new Error('GPU unavailable'));
    await mount();
    await vi.waitFor(() =>
      expect(f.setState).toHaveBeenLastCalledWith({ src: '/first.sog', status: 'failed' }),
    );
    expect(f.load).not.toHaveBeenCalled();
    expect(f.host.appendChild).not.toHaveBeenCalled();
  });

  it('cleans up failed loads and reports failure', async () => {
    const gpu = renderer();
    f.createRenderer.mockResolvedValueOnce(gpu);
    f.load.mockRejectedValueOnce(new Error('fetch failed'));
    await mount();
    await vi.waitFor(() =>
      expect(f.setState).toHaveBeenLastCalledWith({ src: '/first.sog', status: 'failed' }),
    );
    expect(gpu.dispose).toHaveBeenCalledOnce();
    expect(gpu.domElement.remove).toHaveBeenCalledOnce();
    expect(f.controls[0]!.dispose).toHaveBeenCalledOnce();
  });

  it('isolates source replacement from the previous pending load', async () => {
    const oldLoad = deferred<object>();
    const oldGpu = renderer();
    const nextGpu = renderer();
    f.createRenderer.mockResolvedValueOnce(oldGpu).mockResolvedValueOnce(nextGpu);
    f.load.mockReturnValueOnce(oldLoad.promise).mockResolvedValueOnce({});
    const unmountOld = await mount();
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    unmountOld();
    const unmountNext = await mount('/next.sog');
    await vi.waitFor(() =>
      expect(f.setState).toHaveBeenLastCalledWith({ src: '/next.sog', status: 'ready' }),
    );
    oldLoad.resolve({});
    await oldLoad.promise;
    expect(f.meshes).toHaveLength(1);
    expect(f.setState).toHaveBeenLastCalledWith({ src: '/next.sog', status: 'ready' });
    expect(nextGpu.dispose).not.toHaveBeenCalled();
    unmountNext();
    expect(nextGpu.setAnimationLoop).toHaveBeenLastCalledWith(null);
    expect(nextGpu.dispose).toHaveBeenCalledOnce();
    expect(f.meshes[0]!.dispose).toHaveBeenCalledOnce();
    expect(f.observers[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it('survives an immediate setup/cleanup/setup cycle', async () => {
    const first = deferred<ReturnType<typeof renderer>>();
    const oldGpu = renderer();
    const nextGpu = renderer();
    f.createRenderer.mockReturnValueOnce(first.promise).mockResolvedValueOnce(nextGpu);
    f.load.mockResolvedValueOnce({});
    (await mount())();
    await mount();
    await vi.waitFor(() =>
      expect(f.setState).toHaveBeenLastCalledWith({ src: '/first.sog', status: 'ready' }),
    );
    first.resolve(oldGpu);
    await vi.waitFor(() => expect(oldGpu.dispose).toHaveBeenCalledOnce());
    expect(nextGpu.dispose).not.toHaveBeenCalled();
    expect(f.load).toHaveBeenCalledOnce();
  });
});
