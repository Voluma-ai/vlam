import { describe, expect, it, vi } from 'vitest';
import { BenchmarkGpuSampler, RenderBenchmarkSession } from '../render-benchmark-session';

describe('visible render benchmark session', () => {
  it('collects a full sampling interval after the first post-warm-up frame', () => {
    const session = new RenderBenchmarkSession(100, 200);
    expect(session.frame(0).sampling).toBe(false);
    expect(session.frame(110).sampling).toBe(true);
    expect(session.frame(300).complete).toBe(false);
    expect(session.frame(310).complete).toBe(true);
    expect(session.frameTimes).toEqual([190, 10]);
  });

  it('restarts warm-up and measurements after a hidden interval', () => {
    const session = new RenderBenchmarkSession(100, 200);
    session.frame(0);
    session.frame(100);
    session.frame(150);
    session.reset();
    expect(session.frameTimes).toEqual([]);
    expect(session.frame(5000)).toEqual({ elapsedMs: 0, sampling: false, complete: false });
    session.frame(5100);
    expect(session.frame(5300).complete).toBe(true);
    expect(session.frameTimes).toEqual([200]);
  });
});

describe('benchmark GPU sampler', () => {
  it('drains both pools every 30 frames, excludes warm-up and stale compute values', async () => {
    const resolve = vi.fn(async () => 2);
    const sampler = new BenchmarkGpuSampler(true, resolve);
    for (let i = 0; i < 30; i++) sampler.frame(false, 1, 8);
    await sampler.finish();
    expect(resolve.mock.calls).toHaveLength(2);
    expect(sampler.samples).toEqual({ render: [], compute: [] });
    for (let i = 0; i < 30; i++) sampler.frame(true, 1, 0);
    await sampler.finish();
    expect(resolve.mock.calls).toHaveLength(4);
    expect(sampler.samples).toEqual({ render: [2], compute: [] });
  });

  it('does not label a warm-up-only compute query as a measured sample', async () => {
    const sampler = new BenchmarkGpuSampler(true, async () => 3);
    sampler.frame(false, 1, 8);
    for (let i = 0; i < 29; i++) sampler.frame(true, 1, 0);
    await sampler.finish();
    expect(sampler.samples).toEqual({ render: [3], compute: [] });
  });

  it('keeps one readback batch in flight and discards results after a restart', async () => {
    let release!: (value: number) => void;
    const pending = new Promise<number>((resolve) => {
      release = resolve;
    });
    const resolve = vi.fn(() => pending);
    const sampler = new BenchmarkGpuSampler(true, resolve);
    for (let i = 0; i < 90; i++) sampler.frame(true, 1, 1);
    expect(resolve).toHaveBeenCalledTimes(2);
    sampler.reset();
    release(7);
    await sampler.finish();
    expect(sampler.samples).toEqual({ render: [], compute: [] });
  });

  it('reports no samples for unsupported or failed timing and flushes partial batches', async () => {
    const sampler = new BenchmarkGpuSampler(true, async (kind) => {
      if (kind === 'compute') throw new Error('unsupported');
      return undefined;
    });
    sampler.frame(true, 1, 1);
    await sampler.finish();
    expect(sampler.samples).toEqual({ render: [], compute: [] });
    const disabledResolve = vi.fn(async () => 1);
    const disabled = new BenchmarkGpuSampler(false, disabledResolve);
    for (let i = 0; i < 40; i++) disabled.frame(true, 1, 1);
    await disabled.finish();
    expect(disabledResolve).not.toHaveBeenCalled();
  });
});
