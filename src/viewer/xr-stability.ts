import * as THREE from 'three/webgpu';

export interface XrStabilityOptions {
  /** Whether the recognized-headset stability defaults are active. */
  readonly enabled: boolean;
  /** WebGL XR framebuffer scale to set before the session starts. */
  readonly framebufferScale: number;
  /** Maximum WebGL worker-sort attempt rate; null leaves it unrestricted. */
  readonly sortHz: number | null;
  /** Experimental alpha threshold paired with depth writes; null disables it. */
  readonly depthAlphaThreshold: number | null;
  /** Whether to collect and print the Quest A/B report. */
  readonly diagnostics: boolean;
}

export interface ResolveXrStabilityOptions {
  readonly isHeadset: boolean;
  readonly backend: 'WebGPU' | 'WebGL2';
  readonly recommendedFramebufferScale: number;
}

/** Resolved viewer-only XR policy, including validated URL overrides. */
export function resolveXrStabilityOptions(
  params: URLSearchParams,
  environment: ResolveXrStabilityOptions,
): XrStabilityOptions {
  const enabled = parseBooleanOverride(params.get('xrStability'), environment.isHeadset);
  const defaultScale =
    enabled && environment.backend === 'WebGL2' ? 0.7 : environment.recommendedFramebufferScale;
  const framebufferScale = finiteNumberInRange(params.get('xrScale'), 0.25, 1) ?? defaultScale;
  const defaultSortHz = enabled && environment.backend === 'WebGL2' ? 30 : null;
  const requestedSortHz = finiteNumberInRange(params.get('xrSortHz'), 0, 240);
  const sortHz =
    requestedSortHz === null ? defaultSortHz : requestedSortHz === 0 ? null : requestedSortHz;

  return {
    enabled,
    framebufferScale,
    sortHz,
    depthAlphaThreshold: parseDepthThreshold(params.get('xrDepth')),
    diagnostics: params.get('xrDiagnostics') === '1',
  };
}

/** Fixed-foveation level from `?foveation=0..1`; absent or malformed means maximum. */
export function resolveXrFoveation(raw: string | null): number {
  const value = finiteNumberInRange(raw, 0, 1);
  return value ?? 1;
}

function parseBooleanOverride(raw: string | null, fallback: boolean): boolean {
  if (raw === '0') return false;
  if (raw === '1') return true;
  return fallback;
}

function finiteNumberInRange(raw: string | null, minimum: number, maximum: number): number | null {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

function parseDepthThreshold(raw: string | null): number | null {
  if (raw === null || raw === 'off' || raw === '0') return null;
  if (raw === 'on') return 0.15;
  return finiteNumberInRange(raw, Number.EPSILON, 1);
}

/** Allocation-free gate for attempting asynchronous WebGL sorts at a fixed rate. */
export class XrSortCadence {
  private readonly intervalMs: number;
  private lastAttemptAt = -Infinity;

  constructor(hz: number | null) {
    this.intervalMs = hz === null ? 0 : 1000 / hz;
  }

  /** Clears timing at an XR lifecycle discontinuity. */
  reset(): void {
    this.lastAttemptAt = -Infinity;
  }

  /** Whether this frame may attempt a sort. The first frame always may. */
  shouldAttempt(now: number): boolean {
    if (this.intervalMs === 0) return true;
    if (now - this.lastAttemptAt < this.intervalMs) return false;
    if (!Number.isFinite(this.lastAttemptAt)) {
      this.lastAttemptAt = now;
    } else {
      // Preserve the requested average rate on displays whose frame period is
      // not an integer divisor (72 Hz versus 30 Hz alternates 2/3 frames).
      const intervals = Math.max(1, Math.floor((now - this.lastAttemptAt) / this.intervalMs));
      this.lastAttemptAt += intervals * this.intervalMs;
    }
    return true;
  }
}

interface XrMaterialEntryState {
  readonly material: THREE.Material;
  readonly depthWrite: boolean;
  readonly alphaTest: number;
}

export interface XrMaterialState {
  readonly entries: readonly XrMaterialEntryState[];
}

/** Enables the experimental depth-writing A/B mode and captures exact prior state. */
export function applyXrDepthMode(mesh: THREE.Mesh, alphaThreshold: number): XrMaterialState {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const entries = materials.map((material) => ({
    material,
    depthWrite: material.depthWrite,
    alphaTest: material.alphaTest,
  }));
  for (const material of materials) {
    material.depthWrite = true;
    material.alphaTest = alphaThreshold;
    material.needsUpdate = true;
  }
  return { entries };
}

/** Restores every material property changed by {@link applyXrDepthMode}. */
export function restoreXrDepthMode(state: XrMaterialState | null): void {
  if (!state) return;
  for (const entry of state.entries) {
    entry.material.depthWrite = entry.depthWrite;
    entry.material.alphaTest = entry.alphaTest;
    entry.material.needsUpdate = true;
  }
}
