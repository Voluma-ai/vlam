import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifySplatGpuClass,
  detectSplatDeviceProfile,
  estimateSplatPoolBytes,
  isFillConstrainedSplatDevice,
  liftBudgetToFinestLevel,
  probeSplatGpuClass,
  recommendedMaxPixelRatio,
  recommendedRadMaxStdDev,
  recommendedXrFramebufferScale,
  resolveSplatBudget,
  resolveXrSplatBudget,
  resolveCpuCacheBytes,
  suggestAdaptivePixelRatio,
  ADAPTIVE_PIXEL_RATIO_WARMUP_FRAMES,
  type SplatDeviceProfile,
  type SplatGpuProbeAdapter,
  type SplatGpuProbeEntry,
} from '../core/splat-budget';
import { resolveSplatPerformanceProfile } from '../core/splat-mesh';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 16; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
/** What visionOS Safari reports - indistinguishable from a Mac by user agent. */
const DESKTOP_MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

/** Installs a minimal navigator/matchMedia pair for detection tests. */
function stubBrowser(options: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  deviceMemory?: number;
  coarsePointer?: boolean;
}): void {
  vi.stubGlobal('navigator', {
    userAgent: options.userAgent,
    platform: options.platform ?? '',
    maxTouchPoints: options.maxTouchPoints ?? 0,
    ...(options.deviceMemory === undefined ? {} : { deviceMemory: options.deviceMemory }),
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('coarse') && options.coarsePointer === true,
  }));
}

describe('detectSplatDeviceProfile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads Android as mobile with its (privacy-capped) device memory', () => {
    stubBrowser({ userAgent: ANDROID_UA, maxTouchPoints: 5, deviceMemory: 8, coarsePointer: true });
    expect(detectSplatDeviceProfile()).toEqual({
      deviceMemoryGb: 8,
      isIOS: false,
      isMobile: true,
      isHeadset: false,
      isLowPower: false,
      hasWebGpu: false,
    });
  });

  it('reads an iPhone as mobile and iOS, with no memory signal', () => {
    stubBrowser({ userAgent: IPHONE_UA, maxTouchPoints: 5, coarsePointer: true });
    expect(detectSplatDeviceProfile()).toEqual({
      isIOS: true,
      isMobile: true,
      isHeadset: false,
      isLowPower: false,
      hasWebGpu: false,
    });
  });

  it('reads an iPad reporting itself as MacIntel as mobile', () => {
    stubBrowser({ userAgent: DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 5 });
    expect(detectSplatDeviceProfile()).toMatchObject({ isIOS: true, isMobile: true });
  });

  it('reads desktop as neither mobile nor iOS', () => {
    stubBrowser({ userAgent: DESKTOP_UA, platform: 'Win32', deviceMemory: 8 });
    expect(detectSplatDeviceProfile()).toEqual({
      deviceMemoryGb: 8,
      isIOS: false,
      isMobile: false,
      isHeadset: false,
      isLowPower: false,
      hasWebGpu: false,
    });
  });

  it('does NOT recognize Apple Vision Pro, which is why budgets key off presentation', () => {
    // visionOS Safari presents as desktop Safari with no touch points, so it
    // misses both signals and takes the desktop budget on a mobile-class GPU
    // driving two eyes. No regex fixes this class of problem - the session
    // does, via `resolveXrSplatBudget` on `sessionstart`. Pinned as a
    // reminder of *why* that path exists, not as desired behavior.
    stubBrowser({ userAgent: DESKTOP_MAC_UA, platform: 'MacIntel', deviceMemory: 8 });
    const profile = detectSplatDeviceProfile();
    expect(profile).toMatchObject({ isHeadset: false, isMobile: false });
    expect(resolveSplatBudget(undefined, profile)).toBe(8_000_000);
    // ...and the session-driven path rescues it regardless.
    expect(resolveXrSplatBudget(resolveSplatBudget(undefined, profile))).toBe(600_000);
  });

  it('reads Quest Browser as a headset (and therefore mobile-class)', () => {
    // Quest Browser's UA carries both Android and OculusBrowser; a headset
    // must never fall through to desktop sizing, even without a touch signal.
    stubBrowser({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/33.0 Chrome/126.0.0.0 VR Safari/537.36',
      deviceMemory: 8,
    });
    expect(detectSplatDeviceProfile()).toEqual({
      deviceMemoryGb: 8,
      isIOS: false,
      isMobile: true,
      isHeadset: true,
      isLowPower: false,
      hasWebGpu: false,
    });
  });

  it('catches a UA-less mobile browser through its coarse pointer', () => {
    stubBrowser({ userAgent: 'Mozilla/5.0', maxTouchPoints: 5, coarsePointer: true });
    expect(detectSplatDeviceProfile()).toMatchObject({ isMobile: true });
  });

  it('does not call a touchscreen laptop mobile', () => {
    stubBrowser({ userAgent: DESKTOP_UA, platform: 'Win32', maxTouchPoints: 10 });
    expect(detectSplatDeviceProfile()).toMatchObject({ isMobile: false });
  });
});

describe('resolveSplatBudget', () => {
  const android: SplatDeviceProfile = { deviceMemoryGb: 8, isIOS: false, isMobile: true };
  const ios: SplatDeviceProfile = { isIOS: true, isMobile: true };
  const desktop: SplatDeviceProfile = { deviceMemoryGb: 8, isIOS: false, isMobile: false };

  it('caps an Android flagship well below the desktop ceiling', () => {
    // The regression this cap exists for: `deviceMemory` is capped at 8 for
    // privacy, so every Android flagship claimed the full desktop budget.
    expect(resolveSplatBudget(undefined, android)).toBe(1_000_000);
  });

  it('keeps iOS at its conservative memory-less default', () => {
    expect(resolveSplatBudget(undefined, ios)).toBe(750_000);
  });

  it('leaves desktop budgets scaled by memory', () => {
    expect(resolveSplatBudget(undefined, desktop)).toBe(8_000_000);
    expect(resolveSplatBudget(undefined, { ...desktop, deviceMemoryGb: 4 })).toBe(4_000_000);
    expect(resolveSplatBudget(undefined, { ...desktop, deviceMemoryGb: 0.5 })).toBe(500_000);
  });

  it('gives a memory-less desktop browser the portable default', () => {
    expect(resolveSplatBudget(undefined, { isIOS: false, isMobile: false })).toBe(8_000_000);
  });

  it('does not hand a memory-less Android the desktop default', () => {
    // Without the isMobile guard this fell through to the desktop branch.
    expect(resolveSplatBudget(undefined, { isIOS: false, isMobile: true })).toBe(750_000);
  });

  it('keeps a low-memory mobile device under the cap rather than at it', () => {
    expect(resolveSplatBudget(undefined, { ...android, deviceMemoryGb: 2 })).toBe(1_000_000);
  });

  const quest: SplatDeviceProfile = {
    deviceMemoryGb: 8,
    isIOS: false,
    isMobile: true,
    isHeadset: true,
  };

  it('caps a headset below the phone ceiling - stereo doubles fill cost', () => {
    expect(resolveSplatBudget(undefined, quest)).toBe(600_000);
  });

  it('lets a low-memory headset fall below the cap rather than pinning it up', () => {
    // The headset limit is a ceiling, not a default: a sub-GiB device is not
    // made more capable by being a headset (1 GiB × 1M/GiB would hit the cap).
    expect(resolveSplatBudget(undefined, { ...quest, deviceMemoryGb: 0.5 })).toBe(500_000);
  });

  it('still validates a headset device-memory reading', () => {
    // A flat early return skipped this, so a corrupt reading passed silently.
    expect(() => resolveSplatBudget(undefined, { ...quest, deviceMemoryGb: Number.NaN })).toThrow(
      RangeError,
    );
  });

  it('gives a memory-less headset the conservative default', () => {
    expect(resolveSplatBudget(undefined, { isMobile: true, isHeadset: true })).toBe(600_000);
  });

  it('gives SSR and Node the conservative default', () => {
    // `undefined` as an argument would hit the detecting default parameter, so
    // reproduce the real case: no navigator at all, hence no profile.
    vi.stubGlobal('navigator', undefined);
    try {
      expect(detectSplatDeviceProfile()).toBeUndefined();
      expect(resolveSplatBudget()).toBe(1_000_000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lets an explicit override win over every device signal', () => {
    expect(resolveSplatBudget(9_000_000, android)).toBe(9_000_000);
    expect(resolveSplatBudget(250_000.7, android)).toBe(250_000);
  });

  it('rejects invalid overrides and memory readings', () => {
    for (const invalid of [0, -1, Number.NaN, Infinity]) {
      expect(() => resolveSplatBudget(invalid, desktop)).toThrow(RangeError);
    }
    for (const invalid of [0, -1, Number.NaN, Infinity]) {
      expect(() => resolveSplatBudget(undefined, { deviceMemoryGb: invalid })).toThrow(RangeError);
    }
  });
});

/**
 * Splat count is a poor proxy for cost. Measured on one iPhone 15 Pro:
 * `oldtimers-route` (`.rad`) ran 31-39 fps at 750k and 45-50 at 600k, while
 * `sandwijck` (streamed SOG) held 52-57 fps at 675k resident - two streamed
 * scenes, near-identical counts, ~20 fps apart. LCC's LOD levels are decimated
 * *alternatives* whose splats merge into wide discs, so cost per splat rises as
 * the budget falls; a SOG level is a subsample of the same surface at roughly
 * the same splat size.
 */
describe('per-format mobile budgets', () => {
  const ios: SplatDeviceProfile = { isIOS: true, isMobile: true };
  const android: SplatDeviceProfile = { deviceMemoryGb: 8, isIOS: false, isMobile: true };
  const desktop: SplatDeviceProfile = { deviceMemoryGb: 8, isIOS: false, isMobile: false };

  it('gives an LCC-class format the lower measured tier', () => {
    // iOS exposes no `deviceMemory`, so this is the memory-less branch - the
    // one the measurements above were actually taken on.
    for (const format of ['rad', 'lcc', 'lcc2'] as const) {
      expect(resolveSplatBudget(undefined, ios, { format })).toBe(600_000);
    }
  });

  it('leaves a sampled format where it was', () => {
    expect(resolveSplatBudget(undefined, ios, { format: 'streamed-sog' })).toBe(750_000);
  });

  it('applies the class to the memory-derived ceiling too, not just iOS', () => {
    // An Android flagship reporting the privacy-capped 8 GiB has no more fill
    // rate for wide discs than an iPhone that reports nothing.
    expect(resolveSplatBudget(undefined, android, { format: 'rad' })).toBe(600_000);
    expect(resolveSplatBudget(undefined, android, { format: 'streamed-sog' })).toBe(1_000_000);
  });

  it('reproduces the pre-existing numbers when no format is named', () => {
    // Every caller that predates cost classes - `BudgetGovernor`, the host -
    // must keep resolving exactly what it did before.
    expect(resolveSplatBudget(undefined, ios, {})).toBe(resolveSplatBudget(undefined, ios));
    expect(resolveSplatBudget(undefined, ios)).toBe(750_000);
    expect(resolveSplatBudget(undefined, android)).toBe(1_000_000);
    expect(resolveSplatBudget(undefined, ios, { format: 'auto' })).toBe(750_000);
  });

  it('keeps the tighter device tiers absolute, whatever the format', () => {
    // These were each measured against a limit the format cannot move - stereo
    // fill, a mid-range GPU, a CPU-side sort. A raised sampled tier must not
    // reach them, and the low LCC tier must not be *raised* to them either.
    const lowPower: SplatDeviceProfile = { ...android, isLowPower: true };
    const noWebGpu: SplatDeviceProfile = { ...android, hasWebGpu: false };
    const headset: SplatDeviceProfile = { ...android, isHeadset: true };
    for (const format of ['rad', 'streamed-sog'] as const) {
      expect(resolveSplatBudget(undefined, lowPower, { format })).toBe(500_000);
      expect(resolveSplatBudget(undefined, noWebGpu, { format })).toBe(400_000);
      expect(resolveSplatBudget(undefined, headset, { format })).toBe(600_000);
    }
  });

  it('leaves desktop untouched by the cost class', () => {
    // The tiers are a mobile fill-rate policy. A desktop that can hold 8M of
    // one format can hold 8M of the other.
    for (const format of ['rad', 'streamed-sog'] as const) {
      expect(resolveSplatBudget(undefined, desktop, { format })).toBe(8_000_000);
    }
  });

  it('still lets an explicit override win over the class', () => {
    expect(resolveSplatBudget(2_000_000, ios, { format: 'rad' })).toBe(2_000_000);
  });
});

/**
 * `cap` is the missing verb between "use the default" and "use exactly N".
 * Pinning a number for what was meant as a ceiling has shipped as a bug twice -
 * a demo performance mode that raised the load on the weakest device tested,
 * and a host default that bypassed every device tier.
 */
describe('resolveSplatBudget cap', () => {
  const ios: SplatDeviceProfile = { isIOS: true, isMobile: true };
  const desktop: SplatDeviceProfile = { deviceMemoryGb: 8, isIOS: false, isMobile: false };

  it('lowers a resolved default', () => {
    expect(resolveSplatBudget(undefined, desktop, { cap: 1_000_000 })).toBe(1_000_000);
  });

  it('never raises one', () => {
    // The whole point: a cap above the device tier changes nothing, so a
    // performance mode cannot make a weak device do *more* work.
    expect(resolveSplatBudget(undefined, ios, { cap: 5_000_000 })).toBe(750_000);
  });

  it('does not touch an explicit override', () => {
    // `override` is the caller claiming to know better than every default;
    // `cap` is a ceiling on a default. Capping here would make it a second,
    // quieter override.
    expect(resolveSplatBudget(2_000_000, ios, { cap: 500_000 })).toBe(2_000_000);
  });

  it('composes with the format tier, taking whichever is tighter', () => {
    expect(resolveSplatBudget(undefined, ios, { format: 'rad', cap: 1_000_000 })).toBe(600_000);
    expect(resolveSplatBudget(undefined, ios, { format: 'rad', cap: 400_000 })).toBe(400_000);
  });

  it('caps the memory-less desktop and portable defaults too', () => {
    expect(resolveSplatBudget(undefined, { isIOS: false, isMobile: false }, { cap: 900_000 })).toBe(
      900_000,
    );
  });

  it('rejects a nonsense cap even when an override would win', () => {
    // Validated before the override short-circuit, so a typo is not silently
    // ignored on the one call that happens to pin a budget.
    for (const invalid of [0, -1, Number.NaN, Infinity]) {
      expect(() => resolveSplatBudget(undefined, ios, { cap: invalid })).toThrow(RangeError);
      expect(() => resolveSplatBudget(1_000, ios, { cap: invalid })).toThrow(RangeError);
    }
  });
});

describe('recommendedMaxPixelRatio', () => {
  it('caps mobile lower than desktop', () => {
    expect(recommendedMaxPixelRatio({ isMobile: true })).toBe(1.5);
    expect(recommendedMaxPixelRatio({ isMobile: false })).toBe(2);
  });

  it('falls back to the desktop ceiling without a profile', () => {
    expect(recommendedMaxPixelRatio(undefined)).toBe(2);
  });
});

describe('low-power mobile tier', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('detects a budget phone from a trustworthy low memory reading', () => {
    // `deviceMemory` is capped downward at 8 but never inflated, so ≤4 is real.
    stubBrowser({ userAgent: ANDROID_UA, maxTouchPoints: 5, deviceMemory: 4, coarsePointer: true });
    expect(detectSplatDeviceProfile()).toMatchObject({ isMobile: true, isLowPower: true });
  });

  it('does not flag an Android flagship', () => {
    stubBrowser({ userAgent: ANDROID_UA, maxTouchPoints: 5, deviceMemory: 8, coarsePointer: true });
    expect(detectSplatDeviceProfile()).toMatchObject({ isLowPower: false });
  });

  it('does not flag a low-memory desktop', () => {
    // The tier is about mobile GPUs, not about RAM: a 4 GiB desktop still has a
    // discrete-class fill rate.
    stubBrowser({ userAgent: DESKTOP_UA, platform: 'Win32', deviceMemory: 4 });
    expect(detectSplatDeviceProfile()).toMatchObject({ isMobile: false, isLowPower: false });
  });

  it('starts a budget phone below the flagship ceiling', () => {
    const low: SplatDeviceProfile = {
      deviceMemoryGb: 4,
      isIOS: false,
      isMobile: true,
      isLowPower: true,
    };
    // Without the tier this device scaled to 4 × 500k = 2M, clamped to the 1.5M
    // flagship ceiling - the same starting point as an iPhone 15 Pro.
    expect(resolveSplatBudget(undefined, low)).toBe(500_000);
  });

  it('still lets an explicit override win', () => {
    const low: SplatDeviceProfile = { isMobile: true, isLowPower: true };
    expect(resolveSplatBudget(2_000_000, low)).toBe(2_000_000);
  });

  it('takes the tightest cap when a device is both a headset and low-power', () => {
    // This previously asserted 1M, on the reasoning that "stereo is the tighter
    // constraint and its ceiling is checked first". The second half was true of
    // the old ternary chain and the first half is simply wrong: 750k is tighter
    // than 1M, so checking the headset first *raised* a low-power headset above
    // a low-power phone. That was an artifact of evaluation order, not a
    // decision - which is why the caps are now a minimum rather than a chain.
    const lowHeadset: SplatDeviceProfile = {
      deviceMemoryGb: 4,
      isMobile: true,
      isHeadset: true,
      isLowPower: true,
    };
    expect(resolveSplatBudget(undefined, lowHeadset)).toBe(500_000);
  });
});

describe('no-WebGPU mobile tier', () => {
  afterEach(() => vi.unstubAllGlobals());

  const s7: SplatDeviceProfile = {
    deviceMemoryGb: 4,
    isIOS: false,
    isMobile: true,
    isLowPower: true,
    hasWebGpu: false,
  };

  it('caps a phone on the WebGL2 fallback below the low-power tier', () => {
    // The Galaxy S7 case. Without WebGPU the depth sort runs on the CPU, which
    // scales with splat count far worse than a GPU radix sort - 750k measured
    // 5 fps / 194 ms frames there.
    expect(resolveSplatBudget(undefined, s7)).toBe(400_000);
  });

  it('leaves a phone that has WebGPU on its memory-derived tier', () => {
    expect(resolveSplatBudget(undefined, { ...s7, hasWebGpu: true })).toBe(500_000);
  });

  it('treats an unknown WebGPU state as "has it", not as the tightest cap', () => {
    // `undefined` means nobody looked. Only an explicit `false` should tighten,
    // or a host that builds its own partial profile silently loses budget.
    const { hasWebGpu: _omitted, ...unknown } = s7;
    expect(resolveSplatBudget(undefined, unknown)).toBe(500_000);
  });

  it('does not cap a desktop that fell back to WebGL2', () => {
    // A desktop on the fallback sorts on a far stronger CPU, and a driver
    // blocklist on capable hardware should not cost it 8× its budget.
    const desktopNoWebGpu: SplatDeviceProfile = {
      deviceMemoryGb: 8,
      isIOS: false,
      isMobile: false,
      hasWebGpu: false,
    };
    expect(resolveSplatBudget(undefined, desktopNoWebGpu)).toBe(8_000_000);
  });

  it('detects the absence of navigator.gpu', () => {
    stubBrowser({ userAgent: ANDROID_UA, maxTouchPoints: 5, deviceMemory: 4, coarsePointer: true });
    expect(detectSplatDeviceProfile()).toMatchObject({ hasWebGpu: false, isLowPower: true });
  });

  it('detects its presence', () => {
    stubBrowser({ userAgent: ANDROID_UA, maxTouchPoints: 5, deviceMemory: 8, coarsePointer: true });
    // `stubBrowser` builds a bare navigator; add the property the same way a
    // WebGPU-capable browser would expose it.
    vi.stubGlobal('navigator', { ...navigator, gpu: {} });
    expect(detectSplatDeviceProfile()).toMatchObject({ hasWebGpu: true });
  });

  it('still lets an explicit override win', () => {
    expect(resolveSplatBudget(2_000_000, s7)).toBe(2_000_000);
  });
});

describe('recommendedRadMaxStdDev', () => {
  it('matches Spark exactly on desktop', () => {
    expect(recommendedRadMaxStdDev({ isMobile: false })).toBe(Math.SQRT2 * 2);
    expect(recommendedRadMaxStdDev(undefined)).toBe(Math.SQRT2 * 2);
  });

  it('declines the format override on mobile so the device ceiling applies', () => {
    // `.rad` was the only format escaping the mobile cutoff; returning
    // undefined lets SplatMesh apply its mobile maxStdDev (3) instead of Spark's
    // √8, on the one class of device where splat rendering is fill-bound.
    expect(recommendedRadMaxStdDev({ isMobile: true })).toBeUndefined();
  });

  it('treats a headset as mobile', () => {
    // `detectSplatDeviceProfile` folds headsets into `isMobile`; a stereo
    // framebuffer is the last place to spend 28% more fragments.
    expect(recommendedRadMaxStdDev({ isMobile: true, isHeadset: true })).toBeUndefined();
  });
});

describe('resolveXrSplatBudget', () => {
  it('caps the page budget to the stereo ceiling', () => {
    // The case device sniffing cannot see: a desktop machine driving a
    // tethered headset is a desktop right up until it starts presenting.
    expect(resolveXrSplatBudget(4_000_000)).toBe(600_000);
    expect(resolveXrSplatBudget(1_500_000)).toBe(600_000);
  });

  it('never raises a budget that is already below the ceiling', () => {
    // A device rendering at 500k has its own reason to; entering a session is
    // not a reason to ask more of it.
    expect(resolveXrSplatBudget(500_000)).toBe(500_000);
  });

  it('rejects a nonsense page budget', () => {
    for (const invalid of [0, -1, Number.NaN, Infinity]) {
      expect(() => resolveXrSplatBudget(invalid)).toThrow(RangeError);
    }
  });

  it('agrees with the headset ceiling the profile path applies', () => {
    // The two must not drift: a Quest recognized by its user agent and a
    // headset recognized only once it presents should land on one budget.
    const byUserAgent = resolveSplatBudget(undefined, {
      deviceMemoryGb: 8,
      isMobile: true,
      isHeadset: true,
    });
    expect(resolveXrSplatBudget(4_000_000)).toBe(byUserAgent);
  });
});

describe('recommendedXrFramebufferScale', () => {
  it('undersamples standalone headsets and leaves tethered XR native', () => {
    expect(recommendedXrFramebufferScale({ isMobile: true, isHeadset: true })).toBe(0.8);
    expect(recommendedXrFramebufferScale({ isMobile: false })).toBe(1);
    expect(recommendedXrFramebufferScale(undefined)).toBe(1);
  });
});

describe('suggestAdaptivePixelRatio', () => {
  it('clamps to min/max and initializes the EMA from the first sample', () => {
    const first = suggestAdaptivePixelRatio({
      frameMs: 20,
      current: 2,
      max: 2,
      min: 1,
    });
    expect(first.emaMs).toBe(20);
    expect(first.pixelRatio).toBe(2);
  });

  it('steps down under sustained pressure and up only with headroom', () => {
    let state = suggestAdaptivePixelRatio({
      frameMs: 30,
      current: 2,
      max: 2,
      min: 1,
    });
    // Drive EMA above the 22 ms pressure threshold.
    for (let i = 0; i < 20; i++) {
      state = suggestAdaptivePixelRatio({
        frameMs: 30,
        current: state.pixelRatio,
        max: 2,
        min: 1,
        emaMs: state.emaMs,
      });
    }
    expect(state.pixelRatio).toBeLessThan(2);
    expect(state.pixelRatio).toBeGreaterThanOrEqual(1);

    const afterPressure = state.pixelRatio;
    // Healthy frames: must stay put until EMA clears the raise threshold.
    state = suggestAdaptivePixelRatio({
      frameMs: 16,
      current: state.pixelRatio,
      max: 2,
      min: 1,
      emaMs: state.emaMs,
    });
    // One healthy sample is not enough to raise (hysteresis).
    expect(state.pixelRatio).toBe(afterPressure);

    for (let i = 0; i < 40; i++) {
      state = suggestAdaptivePixelRatio({
        frameMs: 10,
        current: state.pixelRatio,
        max: 2,
        min: 1,
        emaMs: state.emaMs,
      });
    }
    expect(state.pixelRatio).toBeGreaterThan(afterPressure);
  });

  it('never leaves the [min, max] band', () => {
    let state = suggestAdaptivePixelRatio({
      frameMs: 50,
      current: 1,
      max: 1.5,
      min: 1,
    });
    for (let i = 0; i < 30; i++) {
      state = suggestAdaptivePixelRatio({
        frameMs: 50,
        current: state.pixelRatio,
        max: 1.5,
        min: 1,
        emaMs: state.emaMs,
      });
    }
    expect(state.pixelRatio).toBe(1);

    state = suggestAdaptivePixelRatio({
      frameMs: 8,
      current: 1.5,
      max: 1.5,
      min: 1,
      emaMs: 8,
    });
    for (let i = 0; i < 30; i++) {
      state = suggestAdaptivePixelRatio({
        frameMs: 8,
        current: state.pixelRatio,
        max: 1.5,
        min: 1,
        emaMs: state.emaMs,
      });
    }
    expect(state.pixelRatio).toBe(1.5);
  });

  it('uses quarter-step ratios', () => {
    const result = suggestAdaptivePixelRatio({
      frameMs: 40,
      current: 1.5,
      max: 2,
      min: 1,
      emaMs: 40,
    });
    expect(result.pixelRatio * 4).toBe(Math.round(result.pixelRatio * 4));
  });

  it('ignores warmup samples instead of seeding the EMA from a compile spike', () => {
    let warmupRemaining = ADAPTIVE_PIXEL_RATIO_WARMUP_FRAMES;
    let emaMs: number | undefined;
    let pixelRatio = 1.5;
    for (let i = 0; i < ADAPTIVE_PIXEL_RATIO_WARMUP_FRAMES; i++) {
      const state = suggestAdaptivePixelRatio({
        frameMs: 200,
        current: pixelRatio,
        max: 1.5,
        min: 1,
        emaMs,
        warmupRemaining,
      });
      expect(state.pixelRatio).toBe(1.5);
      expect(state.emaMs).toBeUndefined();
      warmupRemaining = state.warmupRemaining;
      emaMs = state.emaMs;
      pixelRatio = state.pixelRatio;
    }
    expect(warmupRemaining).toBe(0);
    const after = suggestAdaptivePixelRatio({
      frameMs: 16.7,
      current: pixelRatio,
      max: 1.5,
      min: 1,
      emaMs,
      warmupRemaining,
    });
    expect(after.pixelRatio).toBe(1.5);
    expect(after.emaMs).toBeCloseTo(16.7);
  });

  it('ignores a hitch several times the EMA without stepping down', () => {
    const state = suggestAdaptivePixelRatio({
      frameMs: 200,
      current: 1.5,
      max: 1.5,
      min: 1,
      emaMs: 16.7,
    });
    expect(state.pixelRatio).toBe(1.5);
    expect(state.emaMs).toBe(16.7);
  });
});

describe('resolveCpuCacheBytes', () => {
  it('still scales with device memory, clamped both ends', () => {
    const mib = 1024 * 1024;
    expect(resolveCpuCacheBytes({ deviceMemoryGb: 8 })).toBe(256 * mib);
    expect(resolveCpuCacheBytes({ deviceMemoryGb: 4 })).toBe(128 * mib);
    expect(resolveCpuCacheBytes({ deviceMemoryGb: 0.5 })).toBe(32 * mib);
  });

  it('does not read a memory-less device as a tiny one', () => {
    const mib = 1024 * 1024;
    // iOS never reports `deviceMemory`, so this is the iPhone path - and an
    // earlier version of this function resolved it to the 32 MiB floor on the
    // theory that a missing reading warrants the most conservative guess.
    //
    // Measured, that is simply wrong hardware modelling: on an iPhone 15 Pro
    // (8 GiB) loading `sandwijck`, the LOD scheduler asked for 539,734 splats
    // and the mesh held only 466,499 across 3 chunk files where desktop held 5,
    // evicting continuously. The finest level is wanted nearest the camera and
    // lives in the largest files, so the middle of the view is exactly what
    // fails to stay resident - the scene renders as a donut. It is invisible on
    // `.rad`, whose page-table cache has its own floor, which is why this
    // survived a round of testing.
    expect(resolveCpuCacheBytes({ isIOS: true, isMobile: true })).toBe(128 * mib);
  });

  it('treats a memory-less non-iOS device the same way', () => {
    // Platform is not the signal here - a withheld `deviceMemory` means the same
    // thing everywhere, so both branches resolve alike rather than iOS taking
    // the pessimistic one.
    const mib = 1024 * 1024;
    expect(resolveCpuCacheBytes({ isIOS: false, isMobile: false })).toBe(128 * mib);
    expect(resolveCpuCacheBytes({ isIOS: false, isMobile: true })).toBe(128 * mib);
  });

  it('keeps the floor for a context with no profile at all', () => {
    // SSR and Node tooling, which never stream a scene - the one case where
    // "assume nothing" is the right reading rather than a guess about hardware.
    // Passing `undefined` would hit the detecting default parameter, so remove
    // the navigator instead and reproduce the real case.
    const mib = 1024 * 1024;
    vi.stubGlobal('navigator', undefined);
    try {
      expect(detectSplatDeviceProfile()).toBeUndefined();
      expect(resolveCpuCacheBytes()).toBe(32 * mib);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still lets a device that *does* report low memory get the floor', () => {
    // The fallback changed; the measured path did not. A real 1 GiB device
    // still says so and is still believed.
    const mib = 1024 * 1024;
    expect(resolveCpuCacheBytes({ deviceMemoryGb: 1, isMobile: true })).toBe(32 * mib);
  });
});

describe('liftBudgetToFinestLevel', () => {
  const DESKTOP = { deviceMemoryGb: 8, isIOS: false, isMobile: false };

  it('lifts a desktop budget to hold a finest level that just misses fitting', () => {
    // Casino's level 0 is 4,741,968 - under today's 8M default it already fits,
    // but a tighter override still lifts rather than deleting whole cells.
    expect(liftBudgetToFinestLevel(4_000_000, 4_741_968, DESKTOP)).toBe(4_741_968);
  });

  it('leaves a budget that already fits the finest level alone', () => {
    expect(liftBudgetToFinestLevel(4_000_000, 1_200_000, DESKTOP)).toBe(4_000_000);
  });

  it('does not lift past the ceiling: a genuinely large scene still streams', () => {
    expect(liftBudgetToFinestLevel(4_000_000, 8_000_001, DESKTOP)).toBe(4_000_000);
    expect(liftBudgetToFinestLevel(4_000_000, 8_000_000, DESKTOP)).toBe(8_000_000);
  });

  it('never lifts on mobile, whose cap is a fill-rate limit not a sizing one', () => {
    const mobile = { deviceMemoryGb: 8, isIOS: false, isMobile: true };
    expect(liftBudgetToFinestLevel(1_500_000, 4_741_968, mobile)).toBe(1_500_000);
  });

  it('never lifts on integrated desktop either', () => {
    const integrated = { ...DESKTOP, gpuClass: 'integrated' as const };
    expect(liftBudgetToFinestLevel(1_000_000, 4_741_968, integrated)).toBe(1_000_000);
  });
});

describe('classifySplatGpuClass', () => {
  it('marks fallback adapters', () => {
    expect(classifySplatGpuClass({ isFallbackAdapter: true })).toBe('fallback');
  });

  it('treats Apple Silicon as integrated', () => {
    expect(classifySplatGpuClass({ vendor: 'apple', architecture: 'metal-3' })).toBe('integrated');
  });

  it('treats common Intel iGPU strings as integrated', () => {
    expect(classifySplatGpuClass({ vendor: 'intel', architecture: 'gen-12lp' })).toBe('integrated');
    expect(classifySplatGpuClass({ vendor: 'intel', description: 'Intel Iris Xe' })).toBe(
      'integrated',
    );
  });

  it('treats Intel Arc as discrete when clearly named', () => {
    expect(classifySplatGpuClass({ vendor: 'intel', description: 'Intel Arc A770' })).toBe(
      'discrete',
    );
  });

  it('treats NVIDIA / unnamed adapters as discrete', () => {
    expect(classifySplatGpuClass({ vendor: 'nvidia', architecture: 'ampere' })).toBe('discrete');
    expect(classifySplatGpuClass({})).toBe('discrete');
    expect(classifySplatGpuClass(undefined)).toBe('discrete');
  });
});

describe('probeSplatGpuClass', () => {
  function stubGpu(
    low: SplatGpuProbeAdapter | null,
    high: SplatGpuProbeAdapter | null,
  ): SplatGpuProbeEntry {
    return {
      requestAdapter: async (options) => {
        if (options?.powerPreference === 'low-power') return low;
        return high;
      },
    };
  }

  it('returns undefined when WebGPU is absent', async () => {
    expect(await probeSplatGpuClass(null)).toBeUndefined();
  });

  it('returns integrated when both preferences resolve to the same Apple GPU', async () => {
    const apple = { info: { vendor: 'apple', architecture: 'metal-3' } };
    expect(await probeSplatGpuClass(stubGpu(apple, apple))).toBe('integrated');
  });

  it('returns discrete when low-power and high-performance are different devices', async () => {
    const igpu = { info: { vendor: 'intel', architecture: 'gen-12lp', device: '0x9a49' } };
    const dgpu = { info: { vendor: 'nvidia', architecture: 'ampere', device: '0x2206' } };
    expect(await probeSplatGpuClass(stubGpu(igpu, dgpu))).toBe('discrete');
  });

  it('returns fallback when either adapter is a software fallback', async () => {
    const soft = { info: { isFallbackAdapter: true, vendor: 'swiftshader' } };
    const hard = { info: { vendor: 'nvidia', architecture: 'ampere' } };
    expect(await probeSplatGpuClass(stubGpu(soft, hard))).toBe('fallback');
  });
});

describe('desktop GPU class budgets', () => {
  const desktop = { deviceMemoryGb: 8, isIOS: false, isMobile: false };

  it('caps integrated desktops per format cost class', () => {
    const integrated = { ...desktop, gpuClass: 'integrated' as const };
    expect(resolveSplatBudget(undefined, integrated, { format: 'lcc' })).toBe(1_000_000);
    expect(resolveSplatBudget(undefined, integrated, { format: 'rad' })).toBe(1_000_000);
    expect(resolveSplatBudget(undefined, integrated, { format: 'streamed-sog' })).toBe(2_000_000);
    expect(resolveSplatBudget(undefined, integrated)).toBe(2_000_000);
  });

  it('caps fallback desktops tightly', () => {
    const fallback = { ...desktop, gpuClass: 'fallback' as const };
    expect(resolveSplatBudget(undefined, fallback)).toBe(400_000);
  });

  it('leaves discrete desktops on the workstation path', () => {
    const discrete = { ...desktop, gpuClass: 'discrete' as const };
    expect(resolveSplatBudget(undefined, discrete)).toBe(8_000_000);
  });

  it('applies integrated defaults without a memory signal', () => {
    // Safari on Apple Silicon often omits deviceMemory entirely.
    expect(
      resolveSplatBudget(
        undefined,
        {
          isIOS: false,
          isMobile: false,
          gpuClass: 'integrated',
        },
        { format: 'lcc' },
      ),
    ).toBe(1_000_000);
  });

  it('shares fill-constrained helpers with mobile', () => {
    const integrated = { ...desktop, gpuClass: 'integrated' as const };
    expect(isFillConstrainedSplatDevice(integrated)).toBe(true);
    expect(recommendedMaxPixelRatio(integrated)).toBe(1.5);
    expect(recommendedRadMaxStdDev(integrated)).toBeUndefined();
    expect(resolveSplatPerformanceProfile(undefined, integrated)).toBe('smooth');
    expect(isFillConstrainedSplatDevice({ ...desktop, gpuClass: 'discrete' })).toBe(false);
    expect(recommendedMaxPixelRatio({ ...desktop, gpuClass: 'discrete' })).toBe(2);
  });
});

describe('estimateSplatPoolBytes', () => {
  const MIB = 1024 * 1024;

  it('prices a plain float32 pool from its components', () => {
    const all = estimateSplatPoolBytes(1_000_000);
    const gpu = estimateSplatPoolBytes(1_000_000, { includeCpuBacking: false });
    // Pool textures round to a whole 2048-wide row; CPU mirrors remain
    // conservative while counting-sort storage stays on the GPU.
    expect(all - gpu).toBe(Math.ceil(1_500_000 / 2048) * 2048 * 68);
  });

  it('drops the CPU backing when asked', () => {
    expect(estimateSplatPoolBytes(1_000_000, { includeCpuBacking: false })).toBeLessThan(
      estimateSplatPoolBytes(1_000_000),
    );
  });

  it('float16 halves centers and covarianceA on the GPU only', () => {
    const gpu32 = estimateSplatPoolBytes(1_000_000, { includeCpuBacking: false });
    const gpu16 = estimateSplatPoolBytes(1_000_000, {
      includeCpuBacking: false,
      floatTextures: 'float16',
    });
    // 16 B saved per splat: centers 16→8 and covarianceA 16→8.
    expect(gpu32 - gpu16).toBe(Math.ceil(1_500_000 / 2048) * 2048 * 16);
    // CPU-side, float16 is a net *cost*: the backing stays float32 and the
    // half-encoded texture images (8 + 8) are held alongside it, so the 16 B of
    // GPU saving is exactly cancelled and the total is unchanged.
    const all32 = estimateSplatPoolBytes(1_000_000);
    const all16 = estimateSplatPoolBytes(1_000_000, { floatTextures: 'float16' });
    expect(all32 - all16).toBe(0);
  });

  it('adds one RGBA32UI texture per four SH coefficients, both sides', () => {
    const base = estimateSplatPoolBytes(1_000_000, { capacityFactor: 1 });
    // 3 / 8 / 15 coefficients → 1 / 2 / 4 textures, 16 B each on GPU and CPU.
    for (const [bands, textures] of [
      [1, 1],
      [2, 2],
      [3, 4],
    ] as const) {
      const withSh = estimateSplatPoolBytes(1_000_000, { capacityFactor: 1, shBands: bands });
      expect(withSh - base).toBe(Math.ceil(1_000_000 / 2048) * 2048 * textures * 16 * 2);
    }
  });

  it('matches the documented ~64 B/splat of SH pool textures', () => {
    // `StreamedSplatMeshOptions.shBands` quotes "up to 64 B/splat of pool
    // textures (~384 MB over a 6M-splat pool at 3 bands)" for the SH textures
    // alone. That figure is decimal MB, not MiB.
    const shOnly =
      estimateSplatPoolBytes(6_000_000, {
        capacityFactor: 1,
        includeCpuBacking: false,
        shBands: 3,
      }) - estimateSplatPoolBytes(6_000_000, { capacityFactor: 1, includeCpuBacking: false });
    expect(shOnly / 6_000_000).toBeCloseTo(64, 1);
    expect(Math.round(shOnly / 1e6)).toBe(384);
  });

  it('scales with capacityFactor', () => {
    const staged = estimateSplatPoolBytes(1_000_000);
    const legacy = estimateSplatPoolBytes(1_000_000, { capacityFactor: 1.4 });
    const exact = estimateSplatPoolBytes(1_000_000, { capacityFactor: 1 });
    expect(staged).toBeGreaterThan(legacy);
    expect(legacy).toBeGreaterThan(exact);
    expect(staged / exact).toBeCloseTo(1.5, 1);
  });

  it('accounts for each sorter allocation strategy', () => {
    const counting = estimateSplatPoolBytes(200_000, { sortStrategy: 'counting' });
    const radix = estimateSplatPoolBytes(200_000, { sortStrategy: 'radix' });
    const worker = estimateSplatPoolBytes(200_000, { sortStrategy: 'worker' });
    expect(radix).toBeGreaterThan(counting);
    expect(worker).toBeGreaterThan(counting);
  });

  it('includes the worker path draw-order GPU buffer without CPU backing', () => {
    expect(
      estimateSplatPoolBytes(2048, {
        capacityFactor: 1,
        includeCpuBacking: false,
        sortStrategy: 'worker',
      }),
    ).toBe(2048 * (52 + 4));
  });

  it('makes the multi-mesh envelope the sum of the ceilings', () => {
    // The guide's recipe: one main plus four additional meshes, each with headroom to
    // 1.5M - this is what has to fit, whatever the shared budget is set to.
    const total = estimateSplatPoolBytes(4_000_000) + 4 * estimateSplatPoolBytes(1_500_000);
    expect(Math.round(total / MIB)).toBeGreaterThan(1000); // over a gigabyte
    // Halving the additional-mesh ceilings roughly halves their contribution.
    const leaner = estimateSplatPoolBytes(4_000_000) + 4 * estimateSplatPoolBytes(750_000);
    expect(total - leaner).toBeGreaterThan(4 * estimateSplatPoolBytes(750_000) * 0.99);
  });

  it('validates its inputs', () => {
    expect(() => estimateSplatPoolBytes(0)).toThrow(RangeError);
    expect(() => estimateSplatPoolBytes(-1)).toThrow(RangeError);
    expect(() => estimateSplatPoolBytes(Number.NaN)).toThrow(RangeError);
    expect(() => estimateSplatPoolBytes(1000, { capacityFactor: 0.9 })).toThrow(RangeError);
    expect(() => estimateSplatPoolBytes(1000, { capacityFactor: Infinity })).toThrow(RangeError);
  });
});
