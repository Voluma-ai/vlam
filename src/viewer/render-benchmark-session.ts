/** Visible-time measurement state shared by the benchmark and its regression tests. */
export class RenderBenchmarkSession {
  readonly frameTimes: number[] = [];
  private startedAt: number | null = null;
  private samplingAt: number | null = null;
  private previousAt: number | null = null;

  constructor(
    private readonly warmupMs: number,
    private readonly sampleMs: number,
  ) {}

  /** A hidden interval invalidates the entire run, including its warm-up. */
  reset(): void {
    this.startedAt = null;
    this.samplingAt = null;
    this.previousAt = null;
    this.frameTimes.length = 0;
  }

  /** Call once per visible animation frame, before submitting the draw. */
  frame(timestamp: number): { elapsedMs: number; sampling: boolean; complete: boolean } {
    this.startedAt ??= timestamp;
    const elapsedMs = timestamp - this.startedAt;
    const sampling = elapsedMs >= this.warmupMs;
    if (sampling) {
      this.samplingAt ??= timestamp;
      if (this.previousAt !== null) this.frameTimes.push(timestamp - this.previousAt);
      this.previousAt = timestamp;
    }
    return {
      elapsedMs,
      sampling,
      complete: this.samplingAt !== null && timestamp - this.samplingAt >= this.sampleMs,
    };
  }
}

type TimestampKind = 'render' | 'compute';
type ResolveTimestamp = (kind: TimestampKind) => Promise<number | undefined>;

/** Drains both query pools without blocking rendering or overlapping readbacks. */
export class BenchmarkGpuSampler {
  readonly samples: Record<TimestampKind, number[]> = { render: [], compute: [] };
  private generation = 0;
  private frames = 0;
  private pending: Promise<void> | null = null;
  private queried = { render: false, compute: false };

  constructor(
    readonly enabled: boolean,
    private readonly resolve: ResolveTimestamp,
  ) {}

  /** Discard samples and any in-flight result from a previous visible run. */
  reset(): void {
    this.generation++;
    this.frames = 0;
    this.samples.render.length = 0;
    this.samples.compute.length = 0;
    this.queried = { render: false, compute: false };
  }

  /** Count frames during warm-up too, so queries cannot accumulate indefinitely. */
  frame(sampling: boolean, renderCalls: number, computeCalls: number): void {
    if (!this.enabled) return;
    this.queried.render ||= sampling && renderCalls > 0;
    this.queried.compute ||= sampling && computeCalls > 0;
    this.frames++;
    if (this.frames >= 30 && this.pending === null) this.drain(sampling);
  }

  /** Flush the last partial batch before GPU resources are disposed. */
  async finish(): Promise<void> {
    await this.pending;
    if (this.enabled && this.frames > 0) await this.drain(true);
  }

  private drain(sampling: boolean): Promise<void> {
    const generation = this.generation;
    const queried = this.queried;
    this.queried = { render: false, compute: false };
    this.frames = 0;
    this.pending = Promise.allSettled([this.resolve('render'), this.resolve('compute')])
      .then((results) => {
        if (!sampling || generation !== this.generation) return;
        const kinds = ['render', 'compute'] as const;
        results.forEach((result, index) => {
          const kind = kinds[index]!;
          // A pool with no new queries can return a stale cached value.
          if (queried[kind] && result.status === 'fulfilled') {
            const value = result.value;
            if (value !== undefined && Number.isFinite(value) && value >= 0) {
              this.samples[kind].push(value);
            }
          }
        });
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}
