import type { SplatData } from '../core/splat-data';
import type { RemotePlyMetrics } from '../formats/ply/parse-splat-ply-remote';

const metrics = new WeakMap<SplatData, RemotePlyMetrics>();

export function recordRemotePlyMetrics(data: SplatData, value: RemotePlyMetrics): void {
  metrics.set(data, value);
}

/** Internal benchmark observation; it does not add fields to SplatData. */
export function remotePlyMetrics(data: SplatData): RemotePlyMetrics | null {
  return metrics.get(data) ?? null;
}
