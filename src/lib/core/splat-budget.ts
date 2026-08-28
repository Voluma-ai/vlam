/**
 * Device profiling and the default active-splat budget.
 *
 * Streaming is splat-count budgeted rather than byte budgeted: every cost in
 * the renderer (pool textures, sort buffers) scales with the number of
 * resident splats - roughly 64 bytes of GPU memory per splat (three RGBA32F
 * data textures + one RGBA8, plus the sort index/order/bucket buffers), or
 * about 48 bytes when `poolFloatTextures: 'float16'` halves centers and
 * covarianceA; plus about 52 more bytes of CPU-side backing per splat of
 * pool capacity. Capping the active splat count therefore caps memory
 * directly, which is what matters on mobile GPUs.
 */

import type { StreamedSplatFormat } from '../loaders/loading';
import { shCoefficientCount } from './sh-pack';

/**
 * Desktop GPU capability class for budget / quality defaults.
 *
 * Mobile still keys off {@link SplatDeviceProfile.isMobile}; this splits
 * non-mobile machines that would otherwise share the ~8M workstation path.
 * Unset means "unknown" - keep the pre-existing desktop defaults (fail open).
 */
export type SplatGpuClass = 'discrete' | 'integrated' | 'fallback';

/** Browser/device signals used for deterministic budget selection. */
export interface SplatDeviceProfile {
  /** Coarse memory estimate in GiB, when exposed by the browser. */
  deviceMemoryGb?: number;
  /** Whether the runtime is an iOS/iPadOS-class device. */
  isIOS?: boolean;
  /** Whether the runtime is a phone/tablet-class device (includes iOS). */
  isMobile?: boolean;
  /**
   * Whether the runtime is a standalone XR headset browser (Quest, Pico, …).
   * Headsets are mobile-class GPUs asked to fill a stereo framebuffer larger
   * than a 4K desktop, so they get their own, tighter defaults.
   */
  isHeadset?: boolean;
  /**
   * Whether this is a *budget* phone rather than a flagship one.
   *
   * `isMobile` cannot tell a Galaxy A51 from an iPhone 15 Pro, and the memory
   * signal cannot either - Chrome privacy-caps `deviceMemory` at 8 GiB, so the
   * flagship and the mid-ranger both land on the same ceiling despite an order
   * of magnitude between their GPUs. A coarse signal, and a *downward* one: a
   * reading of ≤4 is trustworthy because the cap only ever lowers it, while a
   * reading of 8 says nothing. {@link hasWebGpu} is the sharper signal where it
   * applies, since it names a difference in how the sort runs rather than
   * guessing capability from RAM.
   */
  isLowPower?: boolean;
  /**
   * Whether the runtime exposes WebGPU at all.
   *
   * `false` means the renderer will take the WebGL2 fallback, where the depth
   * sort runs on the CPU rather than as a GPU compute pass - a different cost
   * curve, not just a slower one. See {@link resolveSplatBudget}.
   *
   * Detected from the presence of `navigator.gpu`, which is a *browser support*
   * signal rather than an adapter one: a runtime that exposes the API but whose
   * `requestAdapter` fails (driver blocklist) still reports `true` here and will
   * fall back to WebGL2 anyway. A host that knows its renderer's real backend
   * can correct this by passing its own profile.
   */
  hasWebGpu?: boolean;
  /**
   * Desktop GPU class from {@link probeSplatGpuClass} / {@link classifySplatGpuClass}.
   * Omit when unknown so workstations without adapter info keep the 8M path.
   */
  gpuClass?: SplatGpuClass;
}

/** Adapter identifying fields used by {@link classifySplatGpuClass}. */
export interface SplatGpuAdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  isFallbackAdapter?: boolean;
}

/**
 * How expensive a format's splats are *per splat*, which is not the same across
 * formats and is the reason one mobile budget cannot serve them all.
 *
 * - `'sampled'` - coarser LOD levels are subsamples of the same surface, so a
 *   splat costs about the same however deep the cut is. Streamed SOG.
 * - `'lcc'` - XGRIDS' levels are decimated *alternatives* whose splats merge
 *   into wide flat discs (see {@link liftBudgetToFinestLevel}). Cost per splat
 *   therefore *rises* as the budget falls, because a tighter budget serves
 *   coarser levels and each of their splats covers more pixels. `.rad`, `.lcc`,
 *   `.lcc2`.
 *
 * Measured on one iPhone 15 Pro, which is what the numbers below are worth:
 * `oldtimers-route` (`.rad`) ran 31-39 fps at 750k and 45-50 at 600k, while
 * `sandwijck` (streamed SOG) held 52-57 fps at 675k resident. Two streamed
 * scenes, near-identical splat counts, ~20 fps apart - splat count is a poor
 * proxy for cost, and the format is the only better signal available for free
 * before a single byte is fetched.
 */
export type SplatCostClass = 'lcc' | 'sampled';

/** The mobile ceilings, per {@link SplatCostClass}. */
interface MobileClassBudget {
  /**
   * The most a mobile GPU is asked to keep resident, whatever its RAM says.
   *
   * `deviceMemory` is a *memory* signal, but a mobile GPU runs out of fill rate
   * and bandwidth long before memory: every splat is an alpha-blended quad, and
   * a busy view stacks hundreds of them per pixel. Chrome also privacy-caps
   * `deviceMemory` at 8 GiB, so every Android flagship reports 8 and would
   * otherwise land on the 8M desktop ceiling - measured at 5-24 fps on an
   * Adreno 750 (S24 Ultra), against 45 fps for the same scene on an iPhone at
   * 1M. Peer viewers land in the same band: SuperSplat budgets mobile at 1-2M,
   * Spark targets 1M on Android / 1.5M on iOS.
   */
  ceiling: number;
  /**
   * The budget for a mobile device that exposes no `deviceMemory` at all -
   * which is every iPhone, since mobile Safari does not implement it. This is
   * the branch the measurements above were taken on, so it is a separate number
   * rather than a fraction of {@link ceiling}.
   */
  withoutMemorySignal: number;
}

const MOBILE_BUDGETS: Readonly<Record<SplatCostClass, MobileClassBudget>> = {
  // Both measured: 600k held 45-50 fps where 750k managed 31-39. The ceiling
  // matches the default because the evidence is about the class, not the RAM -
  // an Android flagship reporting 8 GiB has no more fill rate for wide discs
  // than an iPhone that reports nothing.
  lcc: { ceiling: 600_000, withoutMemorySignal: 600_000 },
  // Today's numbers, unchanged. `sandwijck` on iPhone had visible headroom
  // (52-57 fps while losing centre detail). Galaxy S24 Ultra SD at ~827k was still
  // streaming (164k holes); do not raise this ceiling from that capture.
  sampled: { ceiling: 1_000_000, withoutMemorySignal: 750_000 },
};

/**
 * Desktop *integrated* / unified GPU ceilings (laptop iGPU, Apple Silicon).
 *
 * These machines report as desktop in the UA and often claim 8 GiB
 * `deviceMemory`, so without a GPU class they inherit the workstation 8M path.
 * LCC stays at 1M to match the demo performance-mode ceiling; streamed SOG can
 * hold a bit more because sampled levels do not inflate per-splat fill the way
 * XGRIDS coarse discs do.
 */
const INTEGRATED_BUDGETS: Readonly<Record<SplatCostClass, number>> = {
  lcc: 1_000_000,
  sampled: 2_000_000,
};

/**
 * Classifies a WebGPU adapter from its identifying strings.
 *
 * Heuristics only - browsers may blank fields for privacy. Prefer
 * {@link probeSplatGpuClass} when both power-preference adapters are available.
 */
export function classifySplatGpuClass(info: SplatGpuAdapterInfo | undefined): SplatGpuClass {
  if (info?.isFallbackAdapter === true) return 'fallback';
  const vendor = (info?.vendor ?? '').toLowerCase();
  const architecture = (info?.architecture ?? '').toLowerCase();
  const device = (info?.device ?? '').toLowerCase();
  const description = (info?.description ?? '').toLowerCase();
  const blob = `${vendor} ${architecture} ${device} ${description}`;

  // Apple Silicon is always unified memory / shared GPU.
  if (vendor === 'apple' || blob.includes('apple')) return 'integrated';

  // Intel integrated families commonly exposed by Chrome's adapter.info.
  if (
    vendor === 'intel' ||
    architecture.startsWith('gen-') ||
    /iris|uhd|xe-lp|xe-hpg|alderlake|tigerlake|meteorlake|arrowlake/.test(blob)
  ) {
    // Discrete Intel Arc often carries "arc" or dg2-class strings; treat those
    // as discrete when clearly named, otherwise Intel desktop WebGPU is usually iGPU.
    if (/\barc\b|dg2|battlemage|xe2-hpg/.test(blob) && !/iris|uhd|xe-lp/.test(blob)) {
      return 'discrete';
    }
    return 'integrated';
  }

  // AMD APUs / explicit iGPU architecture tokens.
  if (vendor === 'amd' || vendor.includes('amd')) {
    if (/igpu|vega-igpu|gfx1\d-igpu|radeon\s*graphics(?!\s*pro)/.test(blob)) {
      return 'integrated';
    }
    // Bare "amd" without a discrete cue still often means an APU on laptops;
    // Radeon RX / Radeon Pro name the discrete cards.
    if (/radeon\s*rx|radeon\s*pro|navi|rdna/.test(blob)) return 'discrete';
  }

  return 'discrete';
}

/** Minimal `navigator.gpu` surface for {@link probeSplatGpuClass}. */
export interface SplatGpuProbeEntry {
  requestAdapter(options?: {
    powerPreference?: 'low-power' | 'high-performance';
  }): Promise<SplatGpuProbeAdapter | null>;
}

/** Adapter handle with optional `.info` (WebGPU GPUAdapterInfo). */
export interface SplatGpuProbeAdapter {
  readonly info?: SplatGpuAdapterInfo;
}

function ambientProbeGpu(): SplatGpuProbeEntry | null {
  const nav = typeof navigator !== 'undefined' ? (navigator as { gpu?: unknown }) : undefined;
  const gpu = nav?.gpu;
  return gpu ? (gpu as SplatGpuProbeEntry) : null;
}

function adapterIdentityKey(info: SplatGpuAdapterInfo | undefined): string {
  return [
    info?.vendor ?? '',
    info?.architecture ?? '',
    info?.device ?? '',
    info?.description ?? '',
  ].join('\0');
}

/**
 * Probes WebGPU adapters to choose a {@link SplatGpuClass}.
 *
 * Requests both `low-power` and `high-performance` adapters when possible. A
 * hybrid laptop that exposes two different devices is `discrete`; a single
 * shared / unified GPU (Apple Silicon, many iGPU-only machines) is classified
 * from {@link classifySplatGpuClass}. Returns `undefined` when WebGPU is absent
 * or the probe fails, so budget resolution keeps the legacy desktop path.
 */
export async function probeSplatGpuClass(
  gpu: SplatGpuProbeEntry | null | undefined = typeof navigator !== 'undefined'
    ? ambientProbeGpu()
    : null,
): Promise<SplatGpuClass | undefined> {
  if (!gpu) return undefined;
  let low: SplatGpuProbeAdapter | null;
  let high: SplatGpuProbeAdapter | null;
  try {
    const adapters = await Promise.all([
      gpu.requestAdapter({ powerPreference: 'low-power' }),
      gpu.requestAdapter({ powerPreference: 'high-performance' }),
    ]);
    low = adapters[0] ?? null;
    high = adapters[1] ?? null;
  } catch {
    return undefined;
  }
  if (!low && !high) return undefined;

  const lowInfo = low?.info;
  const highInfo = high?.info;
  if (lowInfo?.isFallbackAdapter || highInfo?.isFallbackAdapter) return 'fallback';

  const lowKey = adapterIdentityKey(lowInfo);
  const highKey = adapterIdentityKey(highInfo);
  const both = low != null && high != null;
  // Distinct non-empty identities ⇒ hybrid dGPU available.
  if (both && lowKey.length > 3 && highKey.length > 3 && lowKey !== highKey) {
    return 'discrete';
  }

  const info = highInfo ?? lowInfo;
  return classifySplatGpuClass(info);
}

/**
 * Whether fill-rate / laptop-class defaults apply (mobile, or desktop
 * integrated / software fallback). Exported so hosts and the demo share one
 * predicate for performance-mode defaults and adaptive DPR.
 */
export function isFillConstrainedSplatDevice(
  profile: SplatDeviceProfile | undefined = detectSplatDeviceProfile(),
): boolean {
  return (
    profile?.isMobile === true ||
    profile?.gpuClass === 'integrated' ||
    profile?.gpuClass === 'fallback'
  );
}

/**
 * The cost class of a streamed format. Unknown and absent formats read as
 * `'sampled'`, which is the pre-existing behaviour for every caller that does
 * not name one.
 */
function splatCostClass(format?: StreamedSplatFormat): SplatCostClass {
  return format === 'rad' || format === 'lcc' || format === 'lcc2' ? 'lcc' : 'sampled';
}

/**
 * The headset ceiling, below the phone one.
 *
 * A headset is a phone-class GPU asked to fill a stereo framebuffer larger
 * than a 4K desktop (~1680×1760 *per eye* on a Quest 3), sharing the SoC with
 * a compositor that must hit 72 Hz. Every splat is drawn twice, so the
 * fill-rate wall that sets {@link MOBILE_BUDGET_MAX} arrives proportionally
 * sooner. This is a *cap*, not a floor: a genuinely small device still scales
 * below it on its memory signal.
 */
const HEADSET_BUDGET_MAX = 600_000;

/**
 * The ceiling for a budget phone, below the flagship one.
 *
 * A mid-range mobile GPU is not a slightly slower flagship: a Mali-G72 MP3
 * (Galaxy A51) has a small fraction of an Adreno 750's fill rate, while both
 * report the same privacy-capped 8 GiB `deviceMemory` and the same `isMobile`.
 * Starting such a device at the flagship ceiling means it thrashes from the
 * first frame. This is a *cap*: a device whose memory signal is lower still
 * scales below it.
 */
const LOW_POWER_BUDGET_MAX = 500_000;

/**
 * The ceiling for a mobile device with no WebGPU at all.
 *
 * This is the tightest tier, and the signal behind it is the most direct: with
 * no WebGPU there is no compute path, so the depth sort runs on the CPU in a
 * worker, and that cost scales with the splat count far worse than a GPU radix
 * sort does. A phone still on the WebGL2 fallback is also, in practice, old -
 * WebGPU has shipped on Android 12+ and iOS 18 - so the two costs arrive
 * together.
 *
 * Measured on a Galaxy S7 (2016, Mali-T880, WebGL2) at **750k**, which was the
 * low-power tier at the time: **5 fps, 194 ms frames**. That device is out of
 * scope as a target, but it is evidence that the memory-derived tier alone lands
 * far too high once the sort is on the CPU. The tiers have since been lowered
 * across the board, so the figure is the measurement's, not this constant's.
 *
 * Desktop is deliberately exempt: a desktop that falls back to WebGL2 is
 * sorting on a far stronger CPU, and capping it here would punish a
 * driver-blocklist fallback on capable hardware.
 */
const NO_WEBGPU_BUDGET_MAX = 400_000;

/** Reads the available browser device signals without requiring a DOM runtime. */
export function detectSplatDeviceProfile(): SplatDeviceProfile | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const isIOS =
    /iPhone|iPad|iPod/.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  // UA first (it names the platform outright); the coarse-pointer probe then
  // catches mobile browsers that hide or reword their UA.
  const isMobile =
    isIOS ||
    /Android/i.test(nav.userAgent) ||
    (nav.maxTouchPoints > 0 &&
      typeof matchMedia === 'function' &&
      matchMedia('(pointer: coarse)').matches);
  // Best-effort *hint* only - see `resolveXrSplatBudget`, which is what
  // actually sizes an XR session. Most standalone headsets are Android under
  // the hood (Quest, Pico, Vive, Android XR), so `isMobile` already catches
  // them even when this misses; the named flag just lets first paint start at
  // a headset-appropriate size instead of resizing after the session opens.
  //
  // It cannot be relied on. visionOS Safari presents as *desktop* Safari, so
  // Apple Vision Pro matches neither this nor `isMobile` and would take the
  // desktop budget; and every new headset misses until its string is added.
  // That is the whole reason budgets key off presentation state instead.
  const isHeadset = /OculusBrowser|Quest|Pico(?: Neo)?[ /]|Wolvic|VRBrowser|Vive|XRBrowser/i.test(
    nav.userAgent,
  );
  // A budget phone, best-effort. `deviceMemory` is privacy-capped at 8 GiB but
  // *not* raised, so a device reporting ≤4 really does have ≤4 - that makes a
  // low reading trustworthy even though a high one says nothing. Deliberately
  // not `hardwareConcurrency`: it would get this exactly backwards, since the
  // Galaxy A51 this exists for is octa-core while an iPhone 15 Pro reports 6.
  const isLowPower =
    (isMobile || isHeadset) && nav.deviceMemory !== undefined && nav.deviceMemory <= 4;
  return {
    ...(nav.deviceMemory === undefined ? {} : { deviceMemoryGb: nav.deviceMemory }),
    isIOS,
    isMobile: isMobile || isHeadset,
    isHeadset,
    isLowPower,
    hasWebGpu: 'gpu' in nav,
  };
}

/** Scene-side signals for {@link resolveSplatBudget}. */
export interface SplatBudgetOptions {
  /**
   * The format about to be loaded, which selects the {@link SplatCostClass}
   * whose mobile tier applies. Omit when it is not yet known - the `'sampled'`
   * numbers are what every caller resolved before cost classes existed.
   */
  format?: StreamedSplatFormat;
  /**
   * A ceiling on the resolved default, for callers that want to tighten without
   * overriding what this function knows.
   *
   * `override` is absolute: it wins over the device tier, the cost class and
   * everything else, because a caller who names a number has said they know
   * better. That is the right contract and the wrong tool for "the same as
   * usual, but no more than N" - which is what a performance toggle or a host
   * default actually means. Pinning a number there has twice shipped as a bug:
   * a demo performance mode that *raised* the load on the weakest device tested,
   * and a host default that bypassed every device tier.
   *
   * Applied only when `override` is omitted, and only downward.
   */
  cap?: number;
}

/**
 * Chooses a default active-splat budget for the current device.
 *
 * The default is derived from the coarsest device-memory signal the platform
 * exposes; callers who know better (or want a hard cap for a mobile test on
 * desktop) should pass an explicit override.
 *
 * @param override - Explicit budget in splats; wins over device detection when
 * positive. Throws `RangeError` if it is not a positive finite number.
 * @param profile - Device signals to decide from; defaults to detecting them.
 * @param options - Scene signals. `format` selects the {@link SplatCostClass}
 * whose mobile tier applies; omitting it keeps the `'sampled'` numbers, which
 * are what every caller resolved before cost classes existed. `cap` is a
 * ceiling on the *resolved default*, for callers who want to tighten without
 * overriding - see {@link SplatBudgetOptions.cap}.
 * @returns A splat-count budget, clamped to a sensible range.
 */
export function resolveSplatBudget(
  override?: number,
  profile: SplatDeviceProfile | undefined = detectSplatDeviceProfile(),
  options: SplatBudgetOptions = {},
): number {
  const cap = options.cap;
  if (cap !== undefined && (!Number.isFinite(cap) || cap <= 0)) {
    throw new RangeError('Splat budget cap must be a positive finite number.');
  }
  if (override !== undefined) {
    if (!Number.isFinite(override) || override <= 0) {
      throw new RangeError('Splat budget must be a positive finite number.');
    }
    // Deliberately *not* capped: `override` is the caller saying they know
    // better than every default, and `cap` is a ceiling on a default. Applying
    // it here would make it a second, quieter override.
    return Math.floor(override);
  }
  const capped = (budget: number): number =>
    cap === undefined ? budget : Math.min(budget, Math.floor(cap));

  // The device ceiling, tightest signal first. Expressed as a cap rather than
  // a flat headset default so a low-memory headset still scales *below* it
  // instead of being pinned up to it - and so the memory validation below
  // still runs for headsets.
  // Every applicable cap, then the tightest of them. A ternary chain would make
  // this order-dependent, and the order is not obvious - a device can be mobile
  // *and* low-power *and* on the WebGL2 fallback at once, and the answer must be
  // the smallest cap regardless of which test happens to run first.
  //
  // Only the mobile cap is per-format. The headset, low-power and no-WebGPU
  // tiers were each measured on their own hardware against a limit the format
  // cannot move - stereo fill, a mid-range GPU, a CPU-side sort - so they stay
  // absolute, and a raised `'sampled'` tier never reaches those devices.
  const mobile = MOBILE_BUDGETS[splatCostClass(options.format)];
  const costClass = splatCostClass(options.format);
  const caps: number[] = [];
  if (profile?.isHeadset) caps.push(HEADSET_BUDGET_MAX);
  if (profile?.isLowPower) caps.push(LOW_POWER_BUDGET_MAX);
  if (profile?.isMobile) caps.push(mobile.ceiling);
  // Mobile only: a desktop on the WebGL2 fallback sorts on a far stronger CPU.
  if (profile?.isMobile && profile.hasWebGpu === false) caps.push(NO_WEBGPU_BUDGET_MAX);
  // Desktop GPU class: laptop / unified / software must not inherit the 8M path.
  if (!profile?.isMobile && profile?.gpuClass === 'integrated') {
    caps.push(INTEGRATED_BUDGETS[costClass]);
  }
  if (!profile?.isMobile && profile?.gpuClass === 'fallback') {
    caps.push(NO_WEBGPU_BUDGET_MAX);
  }
  const ceiling = caps.length === 0 ? Infinity : Math.min(...caps);

  // `deviceMemory` (Chrome/Edge/Android) reports GiB, spec-capped at 8.
  const deviceMemoryGb = profile?.deviceMemoryGb;
  if (deviceMemoryGb !== undefined) {
    if (!Number.isFinite(deviceMemoryGb) || deviceMemoryGb <= 0) {
      throw new RangeError('Device memory must be a positive finite number.');
    }
    // 1M splats per reported GiB → Chrome's 8 GiB privacy cap yields the 8M
    // desktop default. Mobile/headset/integrated caps above still win when tighter.
    const scaled = clamp(Math.round(deviceMemoryGb * 1_000_000), 500_000, 8_000_000);
    return capped(Math.min(scaled, ceiling));
  }

  // No `deviceMemory`: mobile Safari (iOS) and privacy-restricted mobile
  // browsers land here, and must not fall through to the desktop default.
  if (profile?.isMobile) return capped(Math.min(mobile.withoutMemorySignal, ceiling));

  // Integrated / fallback desktop without a memory signal still needs the class
  // ceiling (Apple Silicon Safari often omits deviceMemory entirely).
  if (profile?.gpuClass === 'integrated') {
    return capped(Math.min(INTEGRATED_BUDGETS[costClass], ceiling));
  }
  if (profile?.gpuClass === 'fallback') {
    return capped(Math.min(NO_WEBGPU_BUDGET_MAX, ceiling));
  }

  // An absent profile can mean SSR, Node tooling, or a privacy-restricted
  // browser. Known non-iOS desktop without a memory signal still gets the
  // 8M default; everything else stays on the conservative portable floor.
  return capped(profile?.isIOS === false ? 8_000_000 : 1_000_000);
}

/**
 * The budget to run at **while an immersive session presents**, given whatever
 * budget the page is using outside one.
 *
 * Stereo is the cost, and stereo is a property of the *session*, not of the
 * device: every splat is drawn twice, into two eye viewports that together
 * exceed a 4K desktop, on a GPU that must hold 72–90 Hz or the compositor
 * reprojects. That is true of a standalone headset and equally true of a
 * desktop machine driving a tethered one - which is exactly the case device
 * sniffing cannot see, since such a machine is a desktop right up until the
 * moment it is not.
 *
 * Keying off presentation instead of identity is also the only approach that
 * survives new hardware. `detectSplatDeviceProfile`'s `isHeadset` is a
 * user-agent guess: it misses Apple Vision Pro outright (visionOS Safari
 * presents as desktop Safari, so a headset would otherwise take the multi-
 * million desktop budget) and misses every headset released after it is
 * written. This function needs to know none of that.
 *
 * Apply it on `sessionstart` and restore the original on `sessionend` - via
 * `BudgetGovernor.setBudget` when several meshes share a pool, or a streamed
 * mesh's own budget setter otherwise.
 *
 * @param pageBudget - The budget in use outside the session, typically from
 * {@link resolveSplatBudget}. Throws `RangeError` if not a positive finite
 * number.
 * @returns `pageBudget` lowered to the stereo ceiling; never raised - a device
 * already rendering below the ceiling stays where it is.
 */
export function resolveXrSplatBudget(pageBudget: number): number {
  if (!Number.isFinite(pageBudget) || pageBudget <= 0) {
    throw new RangeError('Splat budget must be a positive finite number.');
  }
  return Math.min(Math.floor(pageBudget), HEADSET_BUDGET_MAX);
}

/**
 * The largest finest-level scene taken whole rather than streamed. At ~64 B
 * of GPU pool per splat this is ~380 MB - affordable on a desktop, and far
 * cheaper than it looks next to the alternative, since a scene held whole
 * never swaps, never compacts and never re-fetches.
 */
const FINEST_LEVEL_BUDGET_MAX = 8_000_000;

/**
 * Raises `budget` far enough to hold a scene's finest level in full, when
 * that level is small enough to be worth taking whole.
 *
 * The LOD budget assumes coarser levels are cheap *approximations* of the
 * same surface, so trading detail for memory is nearly free. XGRIDS' LCC
 * LCC breaks that assumption: its five levels are decimated alternatives
 * whose splats merge into wide flat discs (correct at distance, streaked up
 * close), so any budget shortfall costs visible quality - sub-chunking gives
 * the scheduler ~128k-splat granularity to thin cells with, but a thinned
 * fine level is still sparser than the capture intends. A capture whose
 * finest level fits under the desktop ceiling is better shown whole: Casino's
 * level 0 is 4.74M splats and sits under the 8M default.
 *
 * Mobile and fill-constrained desktops (integrated / fallback GPU class) are
 * exempt: their cap is a fill-rate limit, not a sizing accident.
 *
 * @param budget - The resolved device budget.
 * @param finestLevelSplats - Splats in the scene's finest level.
 * @returns `budget`, or the finest level's size when that is the better fit.
 */
export function liftBudgetToFinestLevel(
  budget: number,
  finestLevelSplats: number,
  profile: SplatDeviceProfile | undefined = detectSplatDeviceProfile(),
): number {
  if (isFillConstrainedSplatDevice(profile)) return budget;
  if (!Number.isFinite(finestLevelSplats) || finestLevelSplats <= budget) return budget;
  if (finestLevelSplats > FINEST_LEVEL_BUDGET_MAX) return budget;
  return Math.floor(finestLevelSplats);
}

/** Options for {@link estimateSplatPoolBytes}. */
export interface SplatPoolBytesOptions {
  /**
   * Pool texture precision, matching `SplatMeshOptions.poolFloatTextures`.
   * `'float16'` halves centers and covarianceA. Default `'float32'`.
   */
  floatTextures?: 'float32' | 'float16';
  /** Per-splat SH bands the pool allocates for. Default `0`. */
  shBands?: 0 | 1 | 2 | 3;
  /**
   * Pool capacity as a multiple of `splats`. `StreamedSplatMesh` allocates
   * 1.5× (the default here) so per-run row alignment and the
   * append-before-remove window during LOD swaps have somewhere to go; pass
   * `1.4` to model `experimentalStagedSwaps: false`, or `1` for a static mesh.
   */
  capacityFactor?: number;
  /**
   * Whether to include the CPU-side backing arrays. Default `true` - they are
   * real host memory a device has to find, so the honest answer to "can I
   * afford this ceiling" includes them.
   */
  includeCpuBacking?: boolean;
}

/**
 * Estimates the memory a splat pool of `splats` costs.
 *
 * This exists to make a streamed mesh's `maxBudget` a computation rather than a
 * guess. A pool is allocated **once, from the ceiling** and never
 * grows, so several governed meshes cost the sum of their ceilings whatever the
 * shared budget is set to - a `BudgetGovernor` redistributes *sharpness* within
 * that envelope, it does not shrink it. Price the ceilings before choosing them:
 *
 * ```js
 * // 1 main + 4 additional meshes, each able to reach 1.5M splats
 * const bytes = estimateSplatPoolBytes(4_000_000) + 4 * estimateSplatPoolBytes(1_500_000);
 * ```
 *
 * Per splat of *capacity* (`splats × capacityFactor`), counted from what the
 * constructor actually allocates:
 *
 * - **Pool textures** 52 B - centers RGBA32F 16, colors RGBA8 4,
 *   covarianceA RGBA32F 16, covarianceB RGBA32F 16. `'float16'` drops centers
 *   and covarianceA to 8 each (36 B); covarianceB stays float32 because it
 *   packs integer IDs.
 * - **Packed SH** 16 B per `RGBA32UI` texture, `ceil(coefficients / 4)` of them
 *   - so 16 / 32 / 64 B at 1 / 2 / 3 bands.
 * - **Sort storage** 16 B - the radix sorter's ping-pong key/value buffers.
 * - **CPU backing** 68 B - the float32/uint8 arrays kept for partial uploads
 *   (always full precision, even under `'float16'`): centers 16, colors 4,
 *   covarianceA 16, covarianceB 16, plus four u32-per-splat arrays - draw-order
 *   indices, the active-list source index, the pool-slot map, and the picker's
 *   pool-index template (allocated lazily, counted because a picked scene pays
 *   it). Under `'float16'` add a further 16 B: the half-encoded texture images
 *   are held alongside the float32 backing, not instead of it, so that
 *   precision saves GPU bytes only. Included unless `includeCpuBacking` is
 *   `false`.
 *
 * The module header's "roughly 64 bytes per splat" rounds the GPU side of this.
 *
 * @param splats - The ceiling in splats (e.g. a mesh's `maxBudget`).
 * @returns Estimated bytes. Indicative, not a device-memory guarantee: driver
 * texture padding, staging allocations and the decoded-chunk CPU cache
 * ({@link resolveCpuCacheBytes}) sit outside it.
 * @throws {RangeError} if `splats` is not a positive finite number, or
 * `capacityFactor` is not a finite number `>= 1`.
 */
export function estimateSplatPoolBytes(
  splats: number,
  options: SplatPoolBytesOptions = {},
): number {
  if (!Number.isFinite(splats) || splats <= 0) {
    throw new RangeError('Splat count must be a positive finite number.');
  }
  const capacityFactor = options.capacityFactor ?? 1.5;
  if (!Number.isFinite(capacityFactor) || capacityFactor < 1) {
    throw new RangeError('Pool capacityFactor must be a finite number >= 1.');
  }
  const float16 = options.floatTextures === 'float16';
  const shTextures = Math.ceil(shCoefficientCount(options.shBands ?? 0) / 4);
  const shBytes = shTextures * 16;

  const centers = float16 ? 8 : 16;
  const covarianceA = float16 ? 8 : 16;
  const poolTextures = centers + 4 /* colors */ + covarianceA + 16 /* covarianceB */ + shBytes;
  const sortBuffers = 16; // radix ping-pong: keys A/B + values A/B, u32 each
  // Backing arrays are float32/uint32 regardless of the texture precision, and
  // under 'float16' the half-encoded texture images are held *in addition* to
  // them (the constructor keeps both), so that precision saves GPU bytes only.
  const halfImages = float16 ? 8 + 8 : 0; /* centersImage + covarianceAImage */
  const cpuBacking =
    options.includeCpuBacking === false
      ? 0
      : 16 /* centers */ +
        4 /* colors */ +
        16 /* covarianceA */ +
        16 /* covarianceB */ +
        shBytes +
        4 /* draw order (splatIndexes) */ +
        4 /* active-list source index */ +
        4 /* activeSlotByPoolIndex */ +
        4 /* picker pool-index template */ +
        halfImages;

  const capacity = Math.ceil(splats * capacityFactor);
  return capacity * (poolTextures + sortBuffers + cpuBacking);
}

/**
 * Suggested ceiling for the renderer's pixel ratio on this device.
 *
 * Splat rendering is fragment-bound, so render resolution is one of the
 * largest costs on a high-DPI phone: a 2.6x display renders ~7x the pixels of
 * a 1x one, and every one of them blends the full depth-sorted splat stack.
 * The library cannot apply this itself (it draws into a renderer the app
 * owns), so it exports the policy - pass it to `renderer.setPixelRatio`:
 *
 * ```js
 * renderer.setPixelRatio(Math.min(window.devicePixelRatio, recommendedMaxPixelRatio()));
 * ```
 *
 * This is the *quality* ceiling. Viewers that offer a performance mode
 * (SuperSplat halves mobile resolution in its own) should go lower still when
 * it is on.
 */
export function recommendedMaxPixelRatio(
  profile: SplatDeviceProfile | undefined = detectSplatDeviceProfile(),
): number {
  return isFillConstrainedSplatDevice(profile) ? 1.5 : 2;
}

/**
 * The Gaussian cutoff a `.rad` renders at, in standard deviations, or
 * `undefined` to accept the device-wide default.
 *
 * Spark hard-codes `sqrt(8)` (≈2.83σ) for every device, and matching it is what
 * makes a `.rad` look like Spark's render on a desktop. On a phone it is the
 * wrong trade: rendering is fill-bound on mobile, so a format override bypasses
 * the device policy that every other format accepts.
 *
 * Returning `undefined` on mobile lets `SplatMesh` apply its own 3σ cutoff and
 * undersized-splat floor; `.rad` must not escape that mobile policy.
 *
 * @returns √8 on discrete desktop; `undefined` on fill-constrained devices,
 * meaning "no format override".
 */
export function recommendedRadMaxStdDev(
  profile: SplatDeviceProfile | undefined = detectSplatDeviceProfile(),
): number | undefined {
  return isFillConstrainedSplatDevice(profile) ? undefined : Math.SQRT2 * 2;
}

/**
 * Suggested WebXR framebuffer scale for this device. On three 0.185.x this is
 * a **WebGL XR** policy: apply it once before the session starts with
 * `renderer.xr.setFramebufferScaleFactor`. three's WebGPU XR path creates its
 * `XRGPUBinding` projection layer at native scale and does not consume that
 * setting, so WebGPU hosts should leave the native scale and use the presenting
 * splat budget plus fixed foveation for runtime headroom instead.
 *
 * Splat rendering is fill-bound, and a headset's default framebuffer is
 * already supersampled past its panels (~1680×1760 per eye on Quest 3):
 * 0.8 cuts fragment work ~36% for a barely visible softening. Non-headset
 * XR (desktop-tethered) keeps the native 1.0.
 */
export function recommendedXrFramebufferScale(
  profile: SplatDeviceProfile | undefined = detectSplatDeviceProfile(),
): number {
  return profile?.isHeadset ? 0.8 : 1;
}

/**
 * Host-threaded samples to ignore before the EMA starts.
 *
 * First `renderer.compute` and first `copyTextureToTexture` each compile a
 * WebGPU pipeline (~200 ms). Seeding the EMA from those drops the ratio to
 * the floor, and a 60 Hz display's 16.7 ms vsync never beats the raise bar
 * (`targetFrameMs * 0.85` ≈ 15.3 ms), so the drop is permanent. Pass the
 * returned {@link AdaptivePixelRatioResult.warmupRemaining} back each frame.
 */
export const ADAPTIVE_PIXEL_RATIO_WARMUP_FRAMES = 5;

/** Inputs for {@link suggestAdaptivePixelRatio}. */
export interface AdaptivePixelRatioInput {
  /** Latest wall-frame time in milliseconds. */
  frameMs: number;
  /** Currently applied pixel ratio. */
  current: number;
  /** Quality ceiling (typically {@link recommendedMaxPixelRatio}). */
  max: number;
  /** Floor; defaults to `1`. */
  min?: number;
  /** EMA of frame time from the previous call; omit on the first sample. */
  emaMs?: number;
  /**
   * Samples still ignored before the EMA starts. Omit or `0` to start
   * immediately. Thread the result's `warmupRemaining` when using
   * {@link ADAPTIVE_PIXEL_RATIO_WARMUP_FRAMES}.
   */
  warmupRemaining?: number;
  /**
   * Comfortable frame time (ms). Below this (with headroom) the helper may
   * step the ratio up. Default `18` (~55 fps).
   */
  targetFrameMs?: number;
  /**
   * Sustained frame time (ms) that triggers a step down. Default `22`
   * (~45 fps) so brief spikes do not thrash the canvas size.
   */
  pressureFrameMs?: number;
}

/** Result of {@link suggestAdaptivePixelRatio}. */
export interface AdaptivePixelRatioResult {
  /** Suggested pixel ratio after hysteresis (quarter steps). */
  pixelRatio: number;
  /** Updated EMA to pass back on the next call. Unset while warming up. */
  emaMs: number | undefined;
  /** Remaining warmup samples; pass back as `warmupRemaining`. */
  warmupRemaining: number;
}

/**
 * Suggests a pixel ratio under frame-time pressure.
 *
 * The library cannot call `renderer.setPixelRatio` (the host owns the
 * renderer); this is a pure policy helper. Pass the previous result's
 * `emaMs` and `warmupRemaining` each frame, and only re-size the canvas when
 * `pixelRatio` changes.
 *
 * Steps are quarter-units with asymmetric thresholds (pressure to lower,
 * comfortable headroom to raise) so the ratio does not oscillate. One-off
 * hitches (pipeline compiles, tab resume) that are several times the EMA do
 * not count as pressure.
 */
export function suggestAdaptivePixelRatio(
  input: AdaptivePixelRatioInput,
): AdaptivePixelRatioResult {
  const min = input.min ?? 1;
  const max = Math.max(min, input.max);
  const targetFrameMs = input.targetFrameMs ?? 18;
  const pressureFrameMs = input.pressureFrameMs ?? 22;
  const frameMs = Number.isFinite(input.frameMs) ? Math.max(0, input.frameMs) : targetFrameMs;
  const pixelRatio = clamp(input.current, min, max);
  const warmupRaw = input.warmupRemaining;
  const warmupRemaining =
    warmupRaw !== undefined && Number.isFinite(warmupRaw) && warmupRaw > 0
      ? Math.floor(warmupRaw)
      : 0;
  if (warmupRemaining > 0) {
    return { pixelRatio, emaMs: input.emaMs, warmupRemaining: warmupRemaining - 1 };
  }
  if (
    input.emaMs !== undefined &&
    Number.isFinite(input.emaMs) &&
    frameMs > Math.max(input.emaMs * 4, pressureFrameMs * 4)
  ) {
    return { pixelRatio, emaMs: input.emaMs, warmupRemaining: 0 };
  }
  const alpha = 0.15;
  const emaMs = input.emaMs === undefined ? frameMs : input.emaMs * (1 - alpha) + frameMs * alpha;

  let next = pixelRatio;
  if (emaMs > pressureFrameMs && next > min) {
    next = Math.max(min, roundPixelRatio(next - 0.25));
  } else if (emaMs < targetFrameMs * 0.85 && next < max) {
    next = Math.min(max, roundPixelRatio(next + 0.25));
  }
  return { pixelRatio: clamp(next, min, max), emaMs, warmupRemaining: 0 };
}

/** Quarter-step pixel ratios (1, 1.25, 1.5, …) keep canvas resizes coarse. */
function roundPixelRatio(value: number): number {
  return Math.round(value * 4) / 4;
}

/**
 * Chooses a decoded-chunk CPU cache cap from the same safe device profile.
 *
 * **The unknown-memory fallback must not read as "tiny".** iOS Safari does not
 * implement `navigator.deviceMemory` at all, so every iPhone lands on this
 * branch - and an earlier version resolved it to 1 GiB, i.e. the 32 MiB floor,
 * on hardware with 8 GiB. That is not a conservative guess, it is a wrong one,
 * and it is invisible on `.rad`, whose page-table cache has its own floor.
 *
 * On streamed SOG there is no such floor and the cost is immediate: measured on
 * an iPhone 15 Pro against `sandwijck`, the scheduler asked for 539,734 splats
 * and the mesh could only hold 466,499 of them across 3 chunk files (desktop:
 * 5), evicting continuously. The finest level is wanted *nearest the camera* and
 * lives in the largest files, so those are what fail to stay resident - the
 * middle of the view drops out and the scene renders as a donut.
 *
 * A device that declines to report its memory is far likelier to be a modern
 * phone withholding a fingerprinting signal than an actual 1 GiB device, so the
 * fallback assumes 4 GiB (128 MiB of cache). The floor stays for the genuinely
 * profile-less case - SSR and Node tooling, which never stream a scene anyway.
 */
export function resolveCpuCacheBytes(
  profile: SplatDeviceProfile | undefined = detectSplatDeviceProfile(),
): number {
  const gb = profile === undefined ? 1 : (profile.deviceMemoryGb ?? 4);
  const mib = 1024 * 1024;
  return Math.min(256 * mib, Math.max(32 * mib, gb * 32 * mib));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
