/** GPU samples retain their benchmark frame for attribution and coverage. */
export interface GpuSample {
  frame: number;
  ms: number;
}

/** Three r185's query pool surface, isolated from incomplete backend typings. */
export interface ComparisonQueryPool {
  queryOffsets: Map<string, number>;
  timestamps: Map<string, number>;
  frames: number[];
}

/** Collect each resolved frame, rather than treating a batch's last value as every frame. */
export class ComparisonWebGpuTimer {
  readonly samples = { render: [] as GpuSample[], compute: [] as GpuSample[] };
  private eligible = new Map<string, number>();
  private seen = new Set<string>();
  private generation = 0;
  private frames = 0;
  private pending: Promise<void> | null = null;

  constructor(
    readonly enabled: boolean,
    private readonly pools: () => Partial<Record<'render' | 'compute', ComparisonQueryPool | null>>,
    private readonly resolve: (kind: 'render' | 'compute') => Promise<unknown>,
  ) {}

  /** Associate newly submitted pass queries with the frame that submitted them. */
  frame(frame: number, sampling: boolean): void {
    if (!this.enabled) return;
    for (const kind of ['render', 'compute'] as const) {
      for (const key of this.pools()[kind]?.queryOffsets.keys() ?? []) {
        const id = `${kind}/${key}`;
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        if (sampling) this.eligible.set(id, frame);
      }
    }
    if (++this.frames >= 8 && !this.pending) void this.drain();
  }

  /** In-flight results cannot cross a visibility reset. */
  reset(): void {
    this.generation++;
    this.eligible.clear();
    this.samples.render.length = this.samples.compute.length = 0;
  }

  /** Readback is awaited only after timed rendering stops. */
  async finish(): Promise<void> {
    await this.pending;
    if (this.enabled) await this.drain();
  }

  private drain(): Promise<void> {
    this.frames = 0;
    const generation = this.generation;
    this.pending = Promise.allSettled(
      (['render', 'compute'] as const).map(async (kind) => {
        const pool = this.pools()[kind];
        if (!pool || pool.queryOffsets.size === 0) return;
        const keys = [...pool.queryOffsets.keys()];
        await this.resolve(kind);
        const totals = new Map<number, number>();
        const invalid = new Set<number>();
        for (const key of keys) {
          const id = `${kind}/${key}`;
          const frame = this.eligible.get(id);
          this.eligible.delete(id);
          this.seen.delete(id);
          if (frame === undefined || generation !== this.generation) continue;
          const backendFrame = Number(/:f(\d+)$/.exec(key)?.[1]);
          const ms = pool.timestamps.get(key);
          if (
            !pool.frames.includes(backendFrame) ||
            ms === undefined ||
            !Number.isFinite(ms) ||
            ms < 0
          ) {
            invalid.add(frame);
          } else totals.set(frame, (totals.get(frame) ?? 0) + ms);
        }
        for (const [frame, ms] of totals)
          if (!invalid.has(frame)) this.samples[kind].push({ frame, ms });
      }),
    )
      .then(() => undefined)
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}

/** Narrow WebGL timer extension surface (not provided by TypeScript's DOM lib). */
export interface DisjointTimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** Nonblocking elapsed queries around Spark's synchronous update/render work. */
export class ComparisonWebGlTimer {
  readonly samples: GpuSample[] = [];
  private queue: { query: WebGLQuery; frame: number; generation: number }[] = [];
  private active: WebGLQuery | null = null;
  private generation = 0;
  rejected = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly extension: DisjointTimerExtension | null,
  ) {}

  /** Keep a bounded queue and sample every eighth measured frame. */
  begin(frame: number, sampling: boolean): void {
    this.poll();
    if (!this.extension || !sampling || frame % 8 !== 0 || this.queue.length >= 8) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
    this.active = query;
    this.queue.push({ query, frame, generation: this.generation });
  }

  /** End the query without waiting for GPU completion. */
  end(): void {
    if (this.active && this.extension) this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.active = null;
  }

  /** Disjoint events invalidate every outstanding query and the run's GPU samples. */
  poll(): void {
    if (!this.extension) return;
    if (this.gl.getParameter(this.extension.GPU_DISJOINT_EXT) as boolean) {
      this.rejected += this.queue.length + this.samples.length;
      this.reset();
      return;
    }
    this.queue = this.queue.filter(({ query, frame, generation }) => {
      if (!(this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE) as boolean))
        return true;
      const ns = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) as number;
      if (generation === this.generation && Number.isFinite(ns) && ns >= 0)
        this.samples.push({ frame, ms: ns / 1e6 });
      else this.rejected++;
      this.gl.deleteQuery(query);
      return false;
    });
  }

  /** Also used for cleanup; old queries are deleted without blocking. */
  reset(): void {
    this.end();
    this.generation++;
    for (const { query } of this.queue) this.gl.deleteQuery(query);
    this.queue = [];
    this.samples.length = 0;
  }

  /** Allow delayed samples to arrive after the run, bounded to one second. */
  async finish(): Promise<void> {
    const deadline = performance.now() + 1000;
    while (this.queue.length && performance.now() < deadline) {
      this.poll();
      if (this.queue.length) await new Promise((resolve) => setTimeout(resolve, 16));
    }
    this.rejected += this.queue.length;
    for (const { query } of this.queue) this.gl.deleteQuery(query);
    this.queue = [];
  }
}
