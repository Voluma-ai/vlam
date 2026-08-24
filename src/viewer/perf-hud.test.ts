import { describe, expect, it } from 'vitest';
import { formatHud, type PerfHudSample } from './perf-hud';

/**
 * The panel's DOM half is verified visually (the browser pane cannot paint it ÔÇö
 * its tab stays hidden, so rAF never fires). Its formatting is pure, and is
 * where a wrong number would quietly mislead a whole on-device session, so it
 * is pinned here.
 */

const SAMPLE: PerfHudSample = {
  cpuFrameMs: 5.2,
  activeSplats: 1_234_567,
  budget: 1_500_000,
  chunks: 42,
  shBands: 0,
  pixelRatio: 1,
  backend: 'WebGPU',
  physicalSize: { width: 1179, height: 2556 },
  sort: { hz: 30.1, ageMs: 12.4 },
};

describe('formatHud', () => {
  it('reports fps and frame time from the rolling window', () => {
    const text = formatHud(SAMPLE, [10, 10, 10, 10]);
    expect(text).toContain('100 rAF');
    expect(text).toContain('10.0 ms');
    expect(text).toContain('cpu submit 5.2 ms');
    expect(text).toContain('sort 30.1 Hz  age 12 ms');
  });

  it('reports the 1% low from the slow end, not the fast end', () => {
    // The number that matters on a splat scene: one 100 ms swap frame among 99
    // good ones is invisible in the mean and is exactly what reads as stutter.
    const frames = [...Array<number>(99).fill(10), 100];
    const text = formatHud(SAMPLE, frames);
    // The 100 ms frame is the worst 1%, so the 1% low is 10 fps ÔÇö not the 100
    // fps that indexing forward to the 99th *fastest* frame would report.
    expect(text).toContain('p99 10 fps');
    // ...and the mean stays healthy at 10.9 ms, which is the point of showing
    // both: on its own the mean says this window was fine.
    expect(text).toContain('10.9 ms');
  });

  it('names the GPU split when timestamps are on', () => {
    const text = formatHud({ ...SAMPLE, computeGpuMs: 3.5, renderGpuMs: 9.25 }, [16.7]);
    expect(text).toContain('compute 3.50 ms');
    expect(text).toContain('render 9.25 ms');
  });

  it('says how to enable the GPU split when it is off', () => {
    expect(formatHud(SAMPLE, [16.7])).toContain('?gpuTimestamps=1');
  });

  it('shows one side of the GPU split when only one resolved', () => {
    const text = formatHud({ ...SAMPLE, renderGpuMs: 9.25 }, [16.7]);
    expect(text).toContain('compute ÔÇö');
    expect(text).toContain('render 9.25 ms');
  });

  it('renders splat, chunk and SH state', () => {
    const text = formatHud(SAMPLE, [16.7]);
    expect(text).toContain('1,234,567 / 1,500,000 splats');
    expect(text).toContain('42 chunks');
    expect(text).toContain('SH off');
    expect(text).toContain('WebGPU');
    expect(text).toContain('buffer 1179×2556');
  });

  it('names the band count when SH is on', () => {
    expect(formatHud({ ...SAMPLE, shBands: 3 }, [16.7])).toContain('SH 3');
  });

  it('omits the chunk count for a non-streamed mesh', () => {
    const text = formatHud({ ...SAMPLE, chunks: undefined }, [16.7]);
    expect(text).not.toContain('chunks');
  });

  it('survives an empty window rather than printing NaN', () => {
    // The first frames after a scene switch, and any frame where the delta was
    // not finite. A panel showing NaN is worse than one showing a dash.
    const text = formatHud(SAMPLE, []);
    expect(text).not.toContain('NaN');
    expect(text).toContain('ÔÇö');
    expect(text).toContain('rAF');
  });
});

describe('formatHud plan-apply line', () => {
  it('surfaces the worst page-table plan application when there has been one', () => {
    // Applying a plan runs off the render loop's timing, so it never appears in
    // frame attribution even though it stalls the same thread ÔÇö it shows up
    // only as a collapsed 1% low.
    const text = formatHud({ ...SAMPLE, worstPlanApplyMs: 412.5 }, [16.7]);
    expect(text).toContain('worst plan apply 412.5 ms');
  });

  it('omits the line for a scene that has never applied a plan', () => {
    expect(formatHud({ ...SAMPLE, worstPlanApplyMs: 0 }, [16.7])).not.toContain('plan apply');
    expect(formatHud(SAMPLE, [16.7])).not.toContain('plan apply');
  });
});

describe('formatHud stall block', () => {
  const worstUpdate = { cpuMs: 42.5, uploadMs: 31.2, sortSubmitMs: 2.1, activeListMs: 5.4 };

  it('reports the worst frame in the window, not the mean', () => {
    // The whole point of the block: one 500 ms freeze among good frames is the
    // problem, and it is what a mean or a short window hides.
    const text = formatHud(SAMPLE, [16, 16, 500, 16]);
    expect(text).toContain('worst frame 500 ms');
  });

  it('breaks the worst update down by stage so a stall can be attributed', () => {
    const text = formatHud({ ...SAMPLE, worstUpdate }, [16.7]);
    expect(text).toContain('worst cpu 42.5');
    expect(text).toContain('up 31.2');
    expect(text).toContain('sort 2.1');
    expect(text).toContain('list 5.4');
  });

  it('omits the breakdown before any update has been measured', () => {
    const zero = { cpuMs: 0, uploadMs: 0, sortSubmitMs: 0, activeListMs: 0 };
    expect(formatHud({ ...SAMPLE, worstUpdate: zero }, [16.7])).not.toContain('worst cpu');
    expect(formatHud(SAMPLE, [16.7])).not.toContain('worst cpu');
  });
});

describe('formatHud fetch diagnosis line', () => {
  const base = {
    priority: 12,
    base: 3,
    sweep: 0,
    evicted: 0,
    uncovered: 0,
    retiredEarly: 0,
    cacheFull: false,
    cacheBytes: 0,
    cacheLimitBytes: 0,
  };

  it('separates the three reasons a scene keeps streaming', () => {
    const converging = formatHud({ ...SAMPLE, fetchCounts: base }, [16.7]);
    expect(converging).toContain('fetch pri 12  base 3  sweep 0  evict 0');
    expect(converging).not.toContain('FULL');

    // Cache thrash: the cut does not fit, so chunks are refetched as fast as
    // they are dropped and streaming can never end.
    const thrashing = formatHud(
      { ...SAMPLE, fetchCounts: { ...base, evicted: 240, cacheFull: true } },
      [16.7],
    );
    expect(thrashing).toContain('evict 240 FULL');

    // Speculative pre-warming of the whole capture.
    const sweeping = formatHud({ ...SAMPLE, fetchCounts: { ...base, sweep: 87 } }, [16.7]);
    expect(sweeping).toContain('sweep 87');
  });

  it('separates the two ways coverage goes missing', () => {
    // Same visible symptom - splats that should be drawn are not - from two
    // unrelated paths, which is exactly why they need separate counters: the
    // substitute failing to find a coarse stand-in, versus the swap path
    // retiring coverage before its replacement landed.
    expect(formatHud({ ...SAMPLE, fetchCounts: base }, [16.7])).toContain('hole 0  late 0');
    expect(formatHud({ ...SAMPLE, fetchCounts: { ...base, uncovered: 1843 } }, [16.7])).toContain(
      'hole 1843  late 0',
    );
    expect(formatHud({ ...SAMPLE, fetchCounts: { ...base, retiredEarly: 27 } }, [16.7])).toContain(
      'hole 0  late 27',
    );
  });

  it('names the cache cap actually in effect', () => {
    // The distinction this exists for: a cut the mesh is not *allowed* to keep
    // looks identical, from the resident count alone, to one it was never asked
    // to keep. iOS reports no `deviceMemory`, so the cap there comes from a
    // fallback rather than a measurement, and it needs to be visible on device.
    const mib = 1024 * 1024;
    const text = formatHud(
      { ...SAMPLE, fetchCounts: { ...base, cacheBytes: 119 * mib, cacheLimitBytes: 128 * mib } },
      [16.7],
    );
    expect(text).toContain('cache 119/128 MiB');
  });

  it('omits the cache line when no limit has been reported', () => {
    expect(formatHud({ ...SAMPLE, fetchCounts: base }, [16.7])).not.toContain('cache ');
  });

  it('omits the line for a mesh with no page table', () => {
    expect(formatHud(SAMPLE, [16.7])).not.toContain('fetch pri');
  });
});

describe('formatHud device line', () => {
  it('names the signals the budget was chosen from', () => {
    const text = formatHud(
      { ...SAMPLE, device: { memoryGb: 4, mobile: true, lowPower: true } },
      [16.7],
    );
    expect(text).toContain('mem 4');
    expect(text).toContain('mobile low-power');
  });

  it('shows a dash when the device reports no memory at all', () => {
    // The Galaxy S7 case: Chrome there exposes no `navigator.deviceMemory`, so
    // the low-power tier - which keys off it alone - cannot fire, and the budget
    // falls back to the generic mobile 1M. Indistinguishable from a wrong tier
    // without this line.
    const text = formatHud({ ...SAMPLE, device: { mobile: true, lowPower: false } }, [16.7]);
    expect(text).toContain('mem -');
    expect(text).toContain('mobile');
    expect(text).not.toContain('low-power');
  });

  it('includes the GPU class when probed', () => {
    const text = formatHud(
      {
        ...SAMPLE,
        device: { memoryGb: 8, mobile: false, lowPower: false, gpuClass: 'integrated' },
      },
      [16.7],
    );
    expect(text).toContain('desktop integrated');
  });

  it('omits the line when no profile was supplied', () => {
    expect(formatHud(SAMPLE, [16.7])).not.toContain('mem ');
  });
});

describe('formatHud gpu line on a backend without timestamps', () => {
  it('does not tell a WebGL2 device to set a flag that cannot help it', () => {
    // WebGL2 has no timestamp queries, so advising ?gpuTimestamps=1 is useless.
    const text = formatHud({ ...SAMPLE, backend: 'WebGL2' }, [16.7]);
    expect(text).toContain('timestamps need WebGPU');
    expect(text).not.toContain('add ?gpuTimestamps=1');
  });

  it('still offers the flag on WebGPU, where it works', () => {
    expect(formatHud(SAMPLE, [16.7])).toContain('add ?gpuTimestamps=1');
  });
});
