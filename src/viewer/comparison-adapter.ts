import type { PerspectiveCamera } from 'three';
import type { GpuPassSample, GpuSample, GpuSampleAccounting } from './comparison-gpu';

/** Viewer-only bridge; never exported by the published library. */
export interface ComparisonAdapter {
  canvas: HTMLCanvasElement;
  metadata: Record<string, unknown>;
  diagnostics?(): Record<string, unknown>;
  /** Captures the settled pose without relying on onscreen canvas serialization. */
  capture?(camera: PerspectiveCamera): Promise<string>;
  settle(camera: PerspectiveCamera): Promise<void>;
  frame(
    camera: PerspectiveCamera,
    frame: number,
    sampling: boolean,
  ): { cpuMs: number; draws: number; activeSplats: number };
  reset(): void;
  finish(): Promise<void>;
  gpu(): {
    render: GpuSample[];
    compute: GpuSample[];
    /** Per-submission timing is available for the WebGPU adapter only. */
    passes?: { render: GpuPassSample[]; compute: GpuPassSample[] };
    supported: boolean;
    coverage: string;
    rejected?: number;
    accounting?: GpuSampleAccounting;
  };
  dispose(): void;
}
