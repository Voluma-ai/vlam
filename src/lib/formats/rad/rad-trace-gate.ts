/**
 * Heartbeat gate for the per-plan `[vlam:rad-*]` console traces.
 *
 * A streamed `.rad` mesh re-plans on every camera change, so with a moving
 * camera each mesh can emit several hundred trace lines per second even when
 * every plan is a no-op (nothing wanted, nothing moved, nothing evicted). That
 * volume stalls the page once DevTools or a CDP client is attached, which is
 * exactly when the traces are wanted. The gate keeps every notable line and
 * lets an uneventful line through at most once per heartbeat per tag, so the
 * console still shows that the pipeline is alive without flooding it.
 */
export const RAD_TRACE_HEARTBEAT_MS = 1000;

export interface RadTraceGate {
  /**
   * Whether a trace for `tag` should be emitted now. A `notable` trace always
   * passes and restarts the tag's heartbeat; an uneventful one passes only
   * when the previous line for that tag is at least a heartbeat old.
   */
  allow(tag: string, notable: boolean, now: number): boolean;
  reset(): void;
}

export function createRadTraceGate(heartbeatMs = RAD_TRACE_HEARTBEAT_MS): RadTraceGate {
  const lastAt = new Map<string, number>();
  return {
    allow(tag, notable, now) {
      if (!notable) {
        const last = lastAt.get(tag);
        if (last !== undefined && now - last < heartbeatMs) return false;
      }
      lastAt.set(tag, now);
      return true;
    },
    reset() {
      lastAt.clear();
    },
  };
}
