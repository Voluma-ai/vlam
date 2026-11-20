import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import type { SplatData } from '../core/splat-data';
import { framePlan } from '../dynamic/frame-playback';
import type { SplatClip } from '../dynamic/splat-clip';
import type {
  ClipHost,
  SplatClipFrame,
  SplatClipFrameSource,
} from '../dynamic/splat-clip-playback';

/** A clip of `total` frames whose evaluations resolve when the test says so. */
function manualSource(parallel: number) {
  const pending: { frame: number; resolve: () => void }[] = [];
  const data = (frame: number): SplatData => ({
    count: 1,
    positions: new Float32Array([frame, 0, 0]),
    colors: new Uint8Array([255, 255, 255, 255]),
    covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
  });
  const source: SplatClipFrameSource = {
    parallel,
    sectionOf: () => 0,
    evaluate: (frame) =>
      new Promise<SplatClipFrame>((resolve) =>
        pending.push({
          frame,
          resolve: () => resolve({ frame, section: 0, alive: 1, data: data(frame), evalMs: 1 }),
        }),
      ),
  };
  return { source, pending };
}

function fakeHost(clip: SplatClip) {
  const shown: number[] = [];
  const host: ClipHost = {
    clip,
    renderer: {} as THREE.WebGPURenderer,
    reserveInactiveRange: () => ({}) as never,
    overwriteRangeData: (_range, data) => void shown.push(data.positions[0]!),
    overwriteRangeCore: (_range, data) => void shown.push(data.positions[0]!),
    setRangeActivePrefix: () => undefined,
    defineChannel: () => undefined,
    writeChannel: () => undefined,
    setModifiers: () => undefined,
    invalidateSort: () => undefined,
    invalidateSortDisplacement: () => undefined,
    sortInFlight: () => false,
    fail: (error) => {
      throw error;
    },
  };
  return { host, shown };
}

const clip = {
  format: 'test',
  name: 'test',
  fps: 10,
  totalFrames: 40,
  duration: 4,
  maxCount: 1,
  bounds: new THREE.Box3(),
  shBands: 0,
  frame: () => Promise.reject(new Error('unused')),
  dispose: () => undefined,
} satisfies SplatClip;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('frame path with several evaluators', () => {
  it('keeps one evaluation in flight per evaluator and shows frames in play order', async () => {
    const { source, pending } = manualSource(2);
    const { host, shown } = fakeHost(clip);
    const playback = framePlan(clip, source).create(host);
    playback.apply(0, 1, true);
    pending.shift()!.resolve();
    await settle();
    playback.apply(0, 1, true);
    expect(playback.shownFrame).toBe(0);
    // Playing: frames 1 and 2 are evaluated at once.
    playback.apply(0.5, 1, false);
    expect(pending.map((p) => p.frame)).toEqual([1, 2]);
    // Frame 2 arrives first; frame 1 still shows first.
    pending.pop()!.resolve();
    await settle();
    playback.apply(0.6, 1, false);
    expect(playback.shownFrame).toBe(0);
    pending.shift()!.resolve();
    await settle();
    playback.apply(1, 1, false);
    expect(playback.shownFrame).toBe(1);
    playback.apply(2, 1, false);
    expect(playback.shownFrame).toBe(2);
    expect(shown).toEqual([0, 1, 2]);
    // Two in flight again, never more than the prefetch window.
    expect(pending.map((p) => p.frame)).toEqual([3, 4]);
  });

  it('keeps a single evaluation in flight with one evaluator', async () => {
    const { source, pending } = manualSource(1);
    const { host } = fakeHost(clip);
    const playback = framePlan(clip, source).create(host);
    playback.apply(0, 1, true);
    pending.shift()!.resolve();
    await settle();
    playback.apply(0, 1, true);
    playback.apply(0.5, 1, false);
    expect(pending.map((p) => p.frame)).toEqual([1]);
  });
});
