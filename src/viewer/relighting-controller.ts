/** Adaptive relighting quality used by the viewer only. */

/** Effective relighting quality tier. */
export type RelightingTier = 'high' | 'balanced' | 'performance';

/** Reason the adaptive controller changed relighting quality. */
export type RelightingTierTransitionReason = 'pressure';

/** Per-cascade shadow-map dimensions, from near to far. */
export type RelightingShadowMapSizes = readonly [number, number, number, number];

/** Effective viewer-only settings for the current relighting tier. */
export interface RelightingTierSettings {
  readonly tier: RelightingTier;
  readonly shadowMapSizes: RelightingShadowMapSizes;
  readonly factorMapScale: number;
}

/** An adaptive relighting tier transition. */
export interface RelightingTierTransition {
  readonly oldTier: RelightingTier;
  readonly newTier: RelightingTier;
  readonly reason: RelightingTierTransitionReason;
  readonly atMs: number;
}

/** Viewer-only relighting controller inputs. */
export interface RelightingControllerOptions {
  readonly constrainedDevice: boolean;
  readonly pinnedTier?: RelightingTier;
  readonly shadowMapSizes?: RelightingShadowMapSizes;
  readonly factorMapScale?: number;
}

/** Diagnostic snapshot exposed by the viewer and benchmark harness. */
export interface RelightingControllerDiagnostics {
  readonly enabled: true;
  readonly tier: RelightingTier;
  readonly pinnedTier: RelightingTier | null;
  readonly shadowMapSizes: RelightingShadowMapSizes;
  readonly factorMapScale: number;
  readonly pressureMs: number;
}

/** Existing relighting shadow-map dimensions, from near to far. */
export const DEFAULT_RELIGHTING_SHADOW_MAP_SIZES: RelightingShadowMapSizes = [
  2048, 2048, 4096, 2048,
];

/** Frame-time dwell required before reducing quality. */
export const RELIGHTING_PRESSURE_DWELL_MS = 1_000;

const TIER_SCALES: Readonly<Record<RelightingTier, { shadow: number; factor: number }>> = {
  high: { shadow: 1, factor: 1 },
  balanced: { shadow: 1, factor: 1 },
  performance: { shadow: 0.5, factor: 1 },
};

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function mapShadowMapSizes(
  sizes: RelightingShadowMapSizes,
  map: (size: number) => number,
): RelightingShadowMapSizes {
  return [map(sizes[0]), map(sizes[1]), map(sizes[2]), map(sizes[3])];
}

function copyMapSizes(sizes: RelightingShadowMapSizes): RelightingShadowMapSizes {
  return mapShadowMapSizes(sizes, (size) => Math.max(1, Math.floor(size)));
}

/** Viewer-local adaptive relighting controller. */
export class RelightingController {
  private readonly pinnedTier: RelightingTier | null;
  private readonly shadowMapOverride: RelightingShadowMapSizes | null;
  private readonly factorMapOverride: number | null;
  private currentTier: RelightingTier;
  private pressureMs = 0;
  private lastObserveAtMs: number | undefined;

  constructor(options: RelightingControllerOptions) {
    this.pinnedTier = options.pinnedTier ?? null;
    this.shadowMapOverride = options.shadowMapSizes ? copyMapSizes(options.shadowMapSizes) : null;
    this.factorMapOverride = options.factorMapScale
      ? finitePositive(options.factorMapScale, 1)
      : null;
    this.currentTier = this.pinnedTier ?? (options.constrainedDevice ? 'balanced' : 'high');
  }

  /** Current effective tier. */
  get tier(): RelightingTier {
    return this.currentTier;
  }

  /** Current effective shadow-map and factor-map settings. */
  get settings(): RelightingTierSettings {
    const scales = TIER_SCALES[this.currentTier];
    const shadowMapSizes =
      this.shadowMapOverride ??
      mapShadowMapSizes(DEFAULT_RELIGHTING_SHADOW_MAP_SIZES, (size) => size * scales.shadow);
    return {
      tier: this.currentTier,
      shadowMapSizes,
      factorMapScale: this.factorMapOverride ?? scales.factor,
    };
  }

  /** Applies a tier change. */
  private setTier(tier: RelightingTier): boolean {
    if (this.pinnedTier !== null || tier === this.currentTier) return false;
    this.currentTier = tier;
    this.pressureMs = 0;
    return true;
  }

  /** Feeds visible frame cadence into the adaptive tier policy. */
  observe(frameMs: number, nowMs: number): RelightingTierTransition | undefined {
    const previous = this.lastObserveAtMs;
    this.lastObserveAtMs = nowMs;
    if (this.pinnedTier !== null) return undefined;
    const gap = previous === undefined ? 0 : Math.max(0, nowMs - previous);
    const activeMs = gap > 250 ? 0 : Math.min(gap, 100);
    const pressure = Number.isFinite(frameMs) && frameMs > 17.5;
    // A GPU hovering around the 30 Hz deadline can still receive occasional
    // 16.7 ms callbacks between 33 ms frames. Clearing pressure on each one
    // prevents the lower shadow-resolution tier from ever engaging. Sustained
    // healthy cadence drains pressure; isolated fast callbacks only decay it.
    this.pressureMs = pressure
      ? Math.min(RELIGHTING_PRESSURE_DWELL_MS, this.pressureMs + activeMs)
      : Math.max(0, this.pressureMs - activeMs * 0.25);

    if (this.currentTier !== 'performance' && this.pressureMs >= RELIGHTING_PRESSURE_DWELL_MS) {
      const oldTier = this.currentTier;
      this.setTier('performance');
      return {
        oldTier,
        newTier: 'performance',
        reason: 'pressure',
        atMs: nowMs,
      };
    }
    return undefined;
  }

  /** Snapshot for the viewer HUD, benchmark JSON, and CDP inspection. */
  diagnostics(): RelightingControllerDiagnostics {
    return {
      enabled: true,
      tier: this.currentTier,
      pinnedTier: this.pinnedTier,
      shadowMapSizes: this.settings.shadowMapSizes,
      factorMapScale: this.settings.factorMapScale,
      pressureMs: this.pressureMs,
    };
  }
}
