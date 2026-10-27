import { afterEach, describe, expect, it, vi } from 'vitest';
import { radChunkResidencyPages } from '../streaming/streamed-splat-mesh';
import type { StreamedScene } from '../streaming/lod-source';
import { estimateSplatPoolBytes } from '../core/splat-budget';

/**
 * Chunk-page residency sizes the pool from the page target, not the budget, so
 * it must see the device even when the host passes no `deviceProfile`. Hosts
 * usually omit it; an iPhone then reserved 141 pages (~1.2 GB) for a 1M budget.
 */

const PAGE = 65_536;
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1';

const scene = (chunks: number) =>
  ({
    chunkSize: PAGE,
    chunkUrls: Array.from({ length: chunks }, (_, i) => `c${i}.rad`),
  }) as unknown as StreamedScene;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('radChunkResidencyPages', () => {
  it('bounds a detected phone to a small chunk-page pool when the host passes no profile', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, platform: 'iPhone', maxTouchPoints: 5 });

    const decision = radChunkResidencyPages(scene(141), undefined, {}, 1_000_000);
    if (!('pages' in decision)) throw new Error(`unexpected fallback ${decision.fallback}`);
    // At least the 1M draw budget, nowhere near the 141-page (~1.2 GB) desktop target.
    expect(decision.pages).toBeGreaterThanOrEqual(Math.ceil(1_000_000 / PAGE));
    expect(
      estimateSplatPoolBytes(decision.pages * PAGE, { capacityFactor: 1 }),
    ).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it('keeps a small shared-pool capture whole on a phone', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, platform: 'iPhone', maxTouchPoints: 5 });

    expect(radChunkResidencyPages(scene(3), undefined, {}, 100_000)).toEqual({
      pages: 3,
      chunkSize: PAGE,
    });
  });

  it('keeps the page target on a detected desktop', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      maxTouchPoints: 0,
    });

    expect(radChunkResidencyPages(scene(141), undefined, {}, 1_000_000)).toEqual({
      pages: 141,
      chunkSize: PAGE,
    });
  });

  it('honours an explicit profile over detection', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, platform: 'iPhone', maxTouchPoints: 5 });

    expect(radChunkResidencyPages(scene(141), { isMobile: false }, {}, 1_000_000)).toEqual({
      pages: 141,
      chunkSize: PAGE,
    });
  });
});
