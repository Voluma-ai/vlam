import { describe, expect, it } from 'vitest';
import {
  ProvokingVertexBenchmark,
  type ProvokingVertexExtension,
} from '../provoking-vertex-benchmark';

function context(supported: boolean) {
  let state = 0x8e4e;
  const ext: ProvokingVertexExtension = {
    FIRST_VERTEX_CONVENTION_WEBGL: 0x8e4d,
    LAST_VERTEX_CONVENTION_WEBGL: 0x8e4e,
    PROVOKING_VERTEX_WEBGL: 0x8e4f,
    provokingVertexWEBGL(value) {
      state = value;
    },
  };
  const gl = {
    getExtension: () => (supported ? ext : null),
    getParameter: () => state,
  } as unknown as WebGL2RenderingContext;
  return { gl, state: () => state };
}

describe('benchmark provoking-vertex state', () => {
  it('selects first only inside the render and restores the prior state on error', () => {
    const { gl, state } = context(true);
    const adapter = new ProvokingVertexBenchmark(gl, true);
    expect(adapter.render(() => state())).toBe(0x8e4d);
    expect(state()).toBe(0x8e4e);
    expect(() =>
      adapter.render(() => {
        throw new Error('render failed');
      }),
    ).toThrow('render failed');
    expect(state()).toBe(0x8e4e);
    expect(adapter.diagnostics()).toMatchObject({ supported: true, appliedRenders: 2 });
  });

  it('leaves an unsupported context untouched and records the fallback', () => {
    const { gl, state } = context(false);
    const adapter = new ProvokingVertexBenchmark(gl, true);
    expect(adapter.render(() => state())).toBe(0x8e4e);
    expect(adapter.diagnostics()).toMatchObject({
      requested: true,
      supported: false,
      appliedRenders: 0,
    });
  });
});
