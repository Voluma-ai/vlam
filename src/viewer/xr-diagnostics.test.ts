import { describe, expect, it } from 'vitest';
import { XrDiagnostics } from './xr-diagnostics';

describe('XrDiagnostics', () => {
  it('aggregates callback, CPU, missed-deadline and worker-sort timing', () => {
    const diagnostics = new XrDiagnostics(1000);
    diagnostics.begin(
      { frameRate: 100, supportedFrameRates: new Float32Array([72, 90, 100]) } as XRSession,
      0,
    );
    diagnostics.recordFrame(0, 2);
    diagnostics.recordFrame(10, 3);
    diagnostics.recordFrame(20, 4);
    diagnostics.recordFrame(40, 8);

    const report = diagnostics.report(45, {
      submittedCount: 4,
      completedCount: 3,
      lastSubmittedAt: 40,
      lastCompletedAt: 35,
      lastLatencyMs: 6,
    });
    expect(report.frames).toBe(4);
    expect(report.callbackMs).toEqual({ p50: 10, p95: 20, p99: 20 });
    expect(report.cpuFrameMs).toEqual({ p50: 4, p95: 8, p99: 8 });
    expect(report.missedFramePercent).toBeCloseTo(100 / 3);
    expect(report.sort).toEqual({
      submitted: 4,
      completed: 3,
      completionAgeMs: 10,
      lastLatencyMs: 6,
    });
  });

  it('resets between sessions and schedules bounded periodic reports', () => {
    const diagnostics = new XrDiagnostics(1000);
    diagnostics.begin({} as XRSession, 100);
    diagnostics.recordFrame(100, 2);
    expect(diagnostics.shouldReport(1099)).toBe(false);
    expect(diagnostics.shouldReport(1100)).toBe(true);
    expect(diagnostics.report(1100, null).missedFramePercent).toBeNull();

    diagnostics.begin({ frameRate: 72 } as XRSession, 2000);
    expect(diagnostics.report(2000, null).frames).toBe(0);
  });

  it('reports sort counts relative to the current XR session', () => {
    const diagnostics = new XrDiagnostics();
    const before = {
      submittedCount: 20,
      completedCount: 18,
      lastSubmittedAt: 90,
      lastCompletedAt: 80,
      lastLatencyMs: 4,
    };
    diagnostics.begin({ frameRate: 72 } as XRSession, 100, before);
    expect(
      diagnostics.report(150, { ...before, submittedCount: 23, completedCount: 20 }).sort,
    ).toMatchObject({ submitted: 3, completed: 2 });
  });
});
