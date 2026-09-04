import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera } from 'three';
import {
  applyComparisonCamera,
  comparisonConfig,
  comparisonSuite,
  comparisonUrl,
  summarize,
} from '../comparison-config';
import {
  ComparisonWebGlTimer,
  ComparisonWebGpuTimer,
  type ComparisonQueryPool,
} from '../comparison-gpu';

describe('shared comparison configuration', () => {
  it('pins resolution, timing and actual renderer selection', () => {
    expect(comparisonConfig('/vlam-benchmark.html', new URLSearchParams())).toMatchObject({
      engine: 'vlam',
      backend: 'webgpu',
      width: 1280,
      height: 720,
      warmup: 5,
      seconds: 15,
      preset: 'defaults',
    });
    expect(
      comparisonConfig('/spark-benchmark.html', new URLSearchParams('preset=matched&sh=0')),
    ).toMatchObject({ engine: 'spark', preset: 'matched', sh: 0, backend: 'webgl' });
    expect(
      comparisonConfig('/vlam-benchmark.html', new URLSearchParams('backend=webgl&preset=matched')),
    ).toMatchObject({ engine: 'vlam', backend: 'webgl', preset: 'matched' });
  });
  it('rejects invalid or ambiguous camera and measurement inputs', () => {
    for (const query of [
      'width=0',
      'seconds=NaN',
      'position=1,2,3',
      'position=1,2,3&target=1,2,3',
      'position=a,2,3&target=0,0,0',
      'preset=unknown',
      'backend=metal',
    ])
      expect(() => comparisonConfig('/vlam-benchmark.html', new URLSearchParams(query))).toThrow();
    expect(() =>
      comparisonConfig('/spark-benchmark.html', new URLSearchParams('backend=webgpu')),
    ).toThrow();
  });
  it('reproduces camera matrices and preserves poses in comparison links', () => {
    const pose = { position: [4, 2, 8], target: [1, 0, 1] } as const;
    const mutable = {
      position: [...pose.position] as [number, number, number],
      target: [...pose.target] as [number, number, number],
    };
    const first = new PerspectiveCamera(45, 16 / 9, 0.01, 10000);
    const second = first.clone();
    applyComparisonCamera(first, mutable, 12000, true);
    applyComparisonCamera(second, mutable, 2000, true);
    applyComparisonCamera(second, mutable, 12000, true);
    expect(second.matrixWorld.elements).toEqual(first.matrixWorld.elements);
    const url = comparisonUrl('spark', new URLSearchParams('mode=orbit'), mutable);
    expect(
      comparisonConfig('/spark-benchmark.html', new URL(url, 'http://localhost').searchParams)
        .position,
    ).toEqual(pose.position);
  });
  it('keeps 24 baseline runs and eight isolated probes with alternating order', () => {
    const suite = comparisonSuite();
    expect(suite).toHaveLength(32);
    expect(suite.slice(0, 24).every((run) => run.get('probe') === 'baseline')).toBe(true);
    expect(suite[0]!.get('engine')).toBe('spark');
    expect(suite[8]!.get('engine')).toBe('vlam');
    expect(suite.slice(24).every((run) => run.get('sh') !== '0' || !run.has('width'))).toBe(true);
    expect(summarize([]).medianMs).toBeNull();
  });
});

describe('WebGPU sample attribution', () => {
  it('sums all passes per submitted frame and excludes warm-up and stale values', async () => {
    const pool: ComparisonQueryPool = {
      queryOffsets: new Map(),
      timestamps: new Map(),
      frames: [],
    };
    const resolve = vi.fn(async () => {
      pool.frames = [10, 11];
      pool.timestamps.set('a:f10', 90);
      pool.timestamps.set('a:f11', 2);
      pool.timestamps.set('b:f11', 3);
      pool.queryOffsets.clear();
      return 5;
    });
    const timer = new ComparisonWebGpuTimer(true, () => ({ render: pool }), resolve);
    pool.queryOffsets.set('a:f10', 0);
    timer.frame(1, false);
    pool.queryOffsets.set('a:f11', 2);
    pool.queryOffsets.set('b:f11', 4);
    timer.frame(2, true);
    await timer.finish();
    expect(timer.samples.render).toEqual([{ frame: 2, ms: 5 }]);
    await timer.finish();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(timer.samples.compute).toEqual([]);
  });
  it('discards in-flight results after a visibility reset and unsupported timing', async () => {
    const pool: ComparisonQueryPool = {
      queryOffsets: new Map([['a:f1', 0]]),
      timestamps: new Map([['a:f1', 3]]),
      frames: [1],
    };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timer = new ComparisonWebGpuTimer(
      true,
      () => ({ render: pool }),
      async () => {
        pool.queryOffsets.clear();
        await pending;
      },
    );
    for (let i = 0; i < 8; i++) timer.frame(i, true);
    timer.reset();
    release();
    await timer.finish();
    expect(timer.samples.render).toEqual([]);
    const resolve = vi.fn();
    const unsupported = new ComparisonWebGpuTimer(false, () => ({}), resolve);
    unsupported.frame(1, true);
    await unsupported.finish();
    expect(resolve).not.toHaveBeenCalled();
  });
  it('does not report cached values when a query resolve did not publish that frame', async () => {
    const pool: ComparisonQueryPool = {
      queryOffsets: new Map([['a:f2', 0]]),
      timestamps: new Map([['a:f1', 9]]),
      frames: [1],
    };
    const timer = new ComparisonWebGpuTimer(
      true,
      () => ({ render: pool }),
      async () => {
        pool.queryOffsets.clear();
      },
    );
    timer.frame(2, true);
    await timer.finish();
    expect(timer.samples.render).toEqual([]);
  });
});

describe('WebGL asynchronous timing', () => {
  function fixture() {
    const state = { disjoint: false, ready: false };
    const gl = {
      QUERY_RESULT_AVAILABLE: 1,
      QUERY_RESULT: 2,
      createQuery: vi.fn(() => ({})),
      beginQuery: vi.fn(),
      endQuery: vi.fn(),
      deleteQuery: vi.fn(),
      getParameter: vi.fn(() => state.disjoint),
      getQueryParameter: vi.fn((_query, parameter) => (parameter === 1 ? state.ready : 2500000)),
    };
    const timer = new ComparisonWebGlTimer(gl as unknown as WebGL2RenderingContext, {
      TIME_ELAPSED_EXT: 3,
      GPU_DISJOINT_EXT: 4,
    });
    return { timer, gl, state };
  }
  it('never measures warm-up or waits for unavailable results', () => {
    const { timer, gl, state } = fixture();
    timer.begin(8, false);
    timer.end();
    expect(gl.beginQuery).not.toHaveBeenCalled();
    timer.begin(16, true);
    timer.end();
    timer.poll();
    expect(timer.samples).toEqual([]);
    state.ready = true;
    timer.poll();
    expect(timer.samples).toEqual([{ frame: 16, ms: 2.5 }]);
  });
  it('rejects disjoint queries and deletes pending work on visibility reset', () => {
    const { timer, gl, state } = fixture();
    timer.begin(8, true);
    timer.end();
    state.disjoint = true;
    timer.poll();
    expect(timer.samples).toEqual([]);
    expect(timer.rejected).toBe(1);
    expect(gl.deleteQuery).toHaveBeenCalledTimes(1);
    state.disjoint = false;
    timer.begin(16, true);
    timer.end();
    timer.reset();
    state.ready = true;
    timer.poll();
    expect(timer.samples).toEqual([]);
    expect(gl.deleteQuery).toHaveBeenCalledTimes(2);
  });
});
