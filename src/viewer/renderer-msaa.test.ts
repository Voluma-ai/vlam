import { describe, expect, it, vi } from 'vitest';

import { RENDERER_MSAA_SAMPLES, getRendererMsaaSamples, setRendererMsaa } from './renderer-msaa';

describe('setRendererMsaa', () => {
  it('writes the three.js default sample count and drops cached targets', () => {
    const dispose = vi.fn();
    const cached = new Map<string, { dispose(): void }>([['canvas', { dispose }]]);
    const renderer = { _samples: 0, _frameBufferTargets: cached };

    setRendererMsaa(renderer, true);

    expect(renderer._samples).toBe(RENDERER_MSAA_SAMPLES);
    expect(dispose).toHaveBeenCalledOnce();
    expect(cached.size).toBe(0);
  });

  it('turns MSAA off without reallocating when no target is cached yet', () => {
    const renderer = { _samples: RENDERER_MSAA_SAMPLES };

    setRendererMsaa(renderer, false);

    expect(renderer._samples).toBe(0);
  });

  it('does not dispose when the sample count is already the requested one', () => {
    const dispose = vi.fn();
    const cached = new Map<string, { dispose(): void }>([['canvas', { dispose }]]);
    const renderer = { _samples: 0, _frameBufferTargets: cached };

    setRendererMsaa(renderer, false);

    expect(dispose).not.toHaveBeenCalled();
    expect(cached.size).toBe(1);
  });
});

describe('getRendererMsaaSamples', () => {
  it('reads the live sample count', () => {
    expect(getRendererMsaaSamples({ _samples: 4 })).toBe(4);
    expect(getRendererMsaaSamples({ _samples: 0 })).toBe(0);
    expect(getRendererMsaaSamples({})).toBe(0);
  });
});
