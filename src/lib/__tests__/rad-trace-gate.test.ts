import { describe, expect, it } from 'vitest';
import { createRadTraceGate, RAD_TRACE_HEARTBEAT_MS } from '../formats/rad/rad-trace-gate';

describe('rad trace gate', () => {
  it('always passes notable traces and restarts the heartbeat', () => {
    const gate = createRadTraceGate();
    expect(gate.allow('plan', true, 0)).toBe(true);
    expect(gate.allow('plan', true, 1)).toBe(true);
    expect(gate.allow('plan', false, 2)).toBe(false);
    expect(gate.allow('plan', false, 1 + RAD_TRACE_HEARTBEAT_MS)).toBe(true);
  });

  it('lets an uneventful trace through once per heartbeat per tag', () => {
    const gate = createRadTraceGate(100);
    expect(gate.allow('demand', false, 0)).toBe(true);
    for (let now = 1; now < 100; now += 16) expect(gate.allow('demand', false, now)).toBe(false);
    expect(gate.allow('demand', false, 100)).toBe(true);
    // Tags are independent.
    expect(gate.allow('plan', false, 101)).toBe(true);
    expect(gate.allow('demand', false, 101)).toBe(false);
  });

  it('forgets every tag on reset', () => {
    const gate = createRadTraceGate(100);
    expect(gate.allow('demand', false, 0)).toBe(true);
    gate.reset();
    expect(gate.allow('demand', false, 1)).toBe(true);
  });
});
