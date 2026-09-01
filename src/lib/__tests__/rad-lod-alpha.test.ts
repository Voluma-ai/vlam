import { describe, expect, it } from 'vitest';
import {
  decodeRadLodAlpha,
  isRadMergedNode,
  radLodFalloff,
  radLodRemap,
  radLodStdDev,
  unifiedDisplayOpacity,
  unifiedGatheredRadSlot,
  visualOpacityMultiplier,
} from './helpers/rad-lod-alpha';

const MAX_STD_DEV = 3;
const MERGED_ENCODED = 0.8;
const MERGED_DECODED = decodeRadLodAlpha(MERGED_ENCODED);
const LEAF_ENCODED = 0.35;
const LEAF_DECODED = decodeRadLodAlpha(LEAF_ENCODED);
const FADES = [1, 0.75, 0.5, 0.25, 0] as const;

describe('RAD LOD alpha vs visual opacity', () => {
  it('treats a decoded alpha around 1.6 as a merged node', () => {
    expect(MERGED_DECODED).toBeCloseTo(1.6, 10);
    expect(isRadMergedNode(MERGED_DECODED)).toBe(true);
  });

  it.each(FADES)('keeps merged classification, remap, and cutoff at opacity %s', (fade) => {
    const resolved = MERGED_ENCODED * fade;
    const decoded = decodeRadLodAlpha(MERGED_ENCODED);
    expect(isRadMergedNode(decoded)).toBe(true);
    expect(radLodRemap(decoded)).toBe(radLodRemap(MERGED_DECODED));
    expect(radLodStdDev(decoded, MAX_STD_DEV)).toBe(radLodStdDev(MERGED_DECODED, MAX_STD_DEV));
    expect(visualOpacityMultiplier(MERGED_ENCODED, resolved)).toBeCloseTo(fade, 10);
  });

  it('keeps merged center-to-edge falloff shape while only intensity changes', () => {
    const q2 = 0.25;
    const ratios: number[] = [];
    const intensities: number[] = [];
    const footprints: number[] = [];
    for (const fade of FADES) {
      const mul = visualOpacityMultiplier(MERGED_ENCODED, MERGED_ENCODED * fade);
      const center = radLodFalloff(0, MERGED_DECODED, MAX_STD_DEV) * mul;
      const edge = radLodFalloff(q2, MERGED_DECODED, MAX_STD_DEV) * mul;
      ratios.push(center === 0 ? ratios[0]! : edge / center);
      intensities.push(center);
      footprints.push(radLodStdDev(MERGED_DECODED, MAX_STD_DEV));
    }
    for (const ratio of ratios) expect(ratio).toBeCloseTo(ratios[0]!, 10);
    for (const footprint of footprints) expect(footprint).toBe(footprints[0]);
    for (let i = 1; i < intensities.length; i++) {
      expect(intensities[i]!).toBeLessThan(intensities[i - 1]!);
    }
  });

  it.each(FADES)(
    'fades a RAD leaf linearly without merged classification at opacity %s',
    (fade) => {
      expect(isRadMergedNode(LEAF_DECODED)).toBe(false);
      const mul = visualOpacityMultiplier(LEAF_ENCODED, LEAF_ENCODED * fade);
      expect(mul).toBeCloseTo(fade, 10);
      const center = radLodFalloff(0, LEAF_DECODED, MAX_STD_DEV);
      expect(center * mul).toBeCloseTo(LEAF_DECODED * fade, 10);
    },
  );

  it('uses multiplier 1 when no alpha modifier is present', () => {
    expect(visualOpacityMultiplier(MERGED_ENCODED, MERGED_ENCODED)).toBe(1);
    expect(visualOpacityMultiplier(0, 0)).toBe(1);
  });

  it('keeps final opacity zero when the original encoded alpha is zero', () => {
    expect(visualOpacityMultiplier(0, 0.5)).toBe(1);
    expect(radLodFalloff(0, decodeRadLodAlpha(0), MAX_STD_DEV)).toBe(0);
  });

  it('keeps a zero fade at zero intensity without changing cutoff', () => {
    const mul = visualOpacityMultiplier(MERGED_ENCODED, 0);
    expect(mul).toBe(0);
    expect(radLodStdDev(MERGED_DECODED, MAX_STD_DEV)).toBeGreaterThan(MAX_STD_DEV);
    expect(radLodFalloff(0, MERGED_DECODED, MAX_STD_DEV) * mul).toBe(0);
  });

  it('keeps original decoded alpha in colors.a and display opacity in centers.w', () => {
    for (const fade of FADES) {
      const slot = unifiedGatheredRadSlot(MERGED_ENCODED, fade, 1);
      expect(slot.colorsA).toBeCloseTo(MERGED_DECODED, 10);
      expect(slot.centersW).toBeCloseTo(fade, 10);
    }
    const zeroOriginal = unifiedGatheredRadSlot(0, 0.5, visualOpacityMultiplier(0, 0.5));
    expect(zeroOriginal.colorsA).toBe(0);
    expect(zeroOriginal.centersW).toBeCloseTo(0.5, 10);
    expect(visualOpacityMultiplier(0, 0.5)).toBe(1);
    const modifierMul = visualOpacityMultiplier(MERGED_ENCODED, MERGED_ENCODED * 0.5);
    expect(unifiedDisplayOpacity(true, 0.5, modifierMul, true)).toBeCloseTo(0.25, 10);
    expect(unifiedDisplayOpacity(true, 0.5, modifierMul, false)).toBeCloseTo(0.5, 10);
    expect(unifiedDisplayOpacity(false, 1, modifierMul, true)).toBe(0);
  });

  it('does not classify a non-RAD source as merged', () => {
    expect(isRadMergedNode(1)).toBe(false);
    expect(isRadMergedNode(0.9)).toBe(false);
    expect(unifiedDisplayOpacity(true, 0.4, 0.2, false)).toBeCloseTo(0.4, 10);
  });
});
