import type { PerspectiveCamera } from 'three';
import type { GpuSample } from './comparison-gpu';

/** Viewer-only bridge; never exported by the published library. */
export interface ComparisonAdapter {
  canvas: HTMLCanvasElement;
  metadata: Record<string, unknown>;
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
    supported: boolean;
    coverage: string;
    rejected?: number;
  };
  dispose(): void;
}
