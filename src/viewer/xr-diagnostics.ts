export interface XrSortDiagnosticsSnapshot {
  readonly submittedCount: number;
  readonly completedCount: number;
  readonly lastSubmittedAt: number;
  readonly lastCompletedAt: number;
  readonly lastLatencyMs: number;
}

export interface XrDiagnosticReport {
  readonly kind: 'vlam-xr-diagnostics';
  readonly final: boolean;
  readonly runtimeFrameRate: number | null;
  readonly supportedFrameRates: readonly number[];
  readonly frames: number;
  readonly callbackMs: { readonly p50: number; readonly p95: number; readonly p99: number };
  readonly cpuFrameMs: { readonly p50: number; readonly p95: number; readonly p99: number };
  readonly missedFramePercent: number | null;
  readonly sort: {
    readonly submitted: number;
    readonly completed: number;
    readonly completionAgeMs: number | null;
    readonly lastLatencyMs: number | null;
  };
}

/** One minute at 120 Hz; enough for the A/B while bounding long-session memory. */
const MAX_FRAME_SAMPLES = 120 * 60;

/** Low-overhead per-session sampler for Quest remote-debug A/B runs. */
export class XrDiagnostics {
  private readonly reportIntervalMs: number;
  private readonly callbackDeltas: number[] = [];
  private readonly cpuFrames: number[] = [];
  private callbackCursor = 0;
  private cpuCursor = 0;
  private runtimeFrameRate: number | null = null;
  private supportedFrameRates: number[] = [];
  private lastFrameAt: number | null = null;
  private lastReportAt = 0;
  private sortSubmittedBase = 0;
  private sortCompletedBase = 0;

  constructor(reportIntervalMs = 10_000) {
    this.reportIntervalMs = reportIntervalMs;
  }

  /** Starts a fresh XR session sample window. */
  begin(session: XRSession, now: number, sort: XrSortDiagnosticsSnapshot | null = null): void {
    this.callbackDeltas.length = 0;
    this.cpuFrames.length = 0;
    this.callbackCursor = 0;
    this.cpuCursor = 0;
    const frameRate = session.frameRate;
    this.runtimeFrameRate = finitePositive(frameRate) ? frameRate : null;
    this.supportedFrameRates = Array.from(session.supportedFrameRates ?? []).filter(finitePositive);
    this.lastFrameAt = null;
    this.lastReportAt = now;
    this.sortSubmittedBase = sort?.submittedCount ?? 0;
    this.sortCompletedBase = sort?.completedCount ?? 0;
  }

  /** Records one completed animation-loop callback without allocating. */
  recordFrame(timestamp: number, cpuFrameMs: number): void {
    if (this.lastFrameAt !== null) {
      const delta = timestamp - this.lastFrameAt;
      if (finitePositive(delta)) {
        this.callbackCursor = pushBounded(this.callbackDeltas, this.callbackCursor, delta);
      }
    }
    this.lastFrameAt = timestamp;
    if (Number.isFinite(cpuFrameMs) && cpuFrameMs >= 0) {
      this.cpuCursor = pushBounded(this.cpuFrames, this.cpuCursor, cpuFrameMs);
    }
  }

  /** Whether the periodic remote-debug report is due. */
  shouldReport(now: number): boolean {
    if (now - this.lastReportAt < this.reportIntervalMs) return false;
    this.lastReportAt = now;
    return true;
  }

  /** Builds a report; sorting copies happen only at the reporting boundary. */
  report(now: number, sort: XrSortDiagnosticsSnapshot | null, final = false): XrDiagnosticReport {
    const callback = percentiles(this.callbackDeltas);
    const cpu = percentiles(this.cpuFrames);
    const submitted = Math.max(0, (sort?.submittedCount ?? 0) - this.sortSubmittedBase);
    const completed = Math.max(0, (sort?.completedCount ?? 0) - this.sortCompletedBase);
    const targetMs = this.runtimeFrameRate === null ? null : 1000 / this.runtimeFrameRate;
    let missed: number | null = null;
    if (targetMs !== null && this.callbackDeltas.length > 0) {
      let missedCount = 0;
      for (const delta of this.callbackDeltas) {
        if (delta > targetMs * 1.5) missedCount++;
      }
      missed = (missedCount * 100) / this.callbackDeltas.length;
    }
    return {
      kind: 'vlam-xr-diagnostics',
      final,
      runtimeFrameRate: this.runtimeFrameRate,
      supportedFrameRates: this.supportedFrameRates,
      frames: this.cpuFrames.length,
      callbackMs: callback,
      cpuFrameMs: cpu,
      missedFramePercent: missed,
      sort: {
        submitted,
        completed,
        completionAgeMs:
          completed > 0 && sort && Number.isFinite(sort.lastCompletedAt)
            ? Math.max(0, now - sort.lastCompletedAt)
            : null,
        lastLatencyMs:
          completed > 0 && sort && Number.isFinite(sort.lastLatencyMs)
            ? Math.max(0, sort.lastLatencyMs)
            : null,
      },
    };
  }
}

function finitePositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function pushBounded(samples: number[], cursor: number, value: number): number {
  if (samples.length < MAX_FRAME_SAMPLES) {
    samples.push(value);
    return cursor;
  }
  samples[cursor] = value;
  return (cursor + 1) % MAX_FRAME_SAMPLES;
}

function percentiles(values: readonly number[]): { p50: number; p95: number; p99: number } {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as number;
}
