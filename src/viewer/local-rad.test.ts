import { Scene } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplatMesh } from '../lib/core';
import { StreamedSplatMesh } from '../lib/streaming';
import { applyOwnedScene, loadLocalRad } from './local-rad';

afterEach(() => vi.restoreAllMocks());
const mesh = () => new SplatMesh({ capacity: 2048 });

describe('viewer local RAD ownership', () => {
  it('keeps a successfully loaded URL until repeated mesh disposal', async () => {
    const candidate = mesh();
    vi.spyOn(StreamedSplatMesh, 'load').mockResolvedValue(candidate as StreamedSplatMesh);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const loaded = await loadLocalRad(new File([], 'scene.rad'), {});
    expect(revoke).not.toHaveBeenCalled();
    loaded.dispose();
    loaded.dispose();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:local');
  });

  it('revokes a URL when loading fails', async () => {
    vi.spyOn(StreamedSplatMesh, 'load').mockRejectedValue(new Error('decode failed'));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await expect(loadLocalRad(new File([], 'scene.rad'), {})).rejects.toThrow('decode failed');
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:local');
  });

  it.each([false, true])('disposes failed adoption unless fully mounted (%s)', async (mounted) => {
    const candidate = mesh();
    const dispose = vi.spyOn(candidate, 'dispose');
    await expect(
      applyOwnedScene(
        candidate,
        async () => {
          throw new Error('framing');
        },
        () => mounted,
      ),
    ).rejects.toThrow('framing');
    expect(dispose).toHaveBeenCalledTimes(mounted ? 0 : 1);
    candidate.dispose();
  });

  it('releases URLs on supersession and replacement, while callers retain arbitrary URLs', async () => {
    const a = mesh();
    const b = mesh();
    vi.spyOn(StreamedSplatMesh, 'load')
      .mockResolvedValueOnce(a as StreamedSplatMesh)
      .mockResolvedValueOnce(b as StreamedSplatMesh);
    vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:a').mockReturnValueOnce('blob:b');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const first = await loadLocalRad(new File([], 'a.rad'), {});
    const next = await loadLocalRad(new File([], 'b.rad'), {});
    first.dispose();
    expect(revoke.mock.calls).toEqual([['blob:a']]);
    next.dispose();
    expect(revoke.mock.calls).toEqual([['blob:a'], ['blob:b']]);
    const caller = mesh();
    caller.dispose();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});

it('retains a mounted RAD after framing fails, and releases an unadopted candidate', async () => {
  const candidate = mesh();
  vi.spyOn(StreamedSplatMesh, 'load').mockResolvedValue(candidate as StreamedSplatMesh);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const loaded = await loadLocalRad(new File([], 'local.rad'), {});
  const scene = new Scene();
  let mounted = false;
  let current: SplatMesh | null = loaded;
  const isMounted = () => mounted && current === loaded && loaded.parent === scene;
  await expect(
    applyOwnedScene(
      loaded,
      async () => {
        scene.add(loaded);
        mounted = true;
        throw new Error('framing');
      },
      isMounted,
    ),
  ).rejects.toThrow('framing');
  expect(revoke).not.toHaveBeenCalled();
  expect(loaded.parent).toBe(scene);
  current = null;
  await expect(
    applyOwnedScene(
      loaded,
      async () => {
        throw new Error('superseded');
      },
      isMounted,
    ),
  ).rejects.toThrow('superseded');
  expect(loaded.parent).toBeNull();
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:local');
});
