import type { SplatPerformanceProfile, SplatSortStrategy } from '../lib/core';
import { exactSort, radixSort } from '../lib/sorting/radix';

const RADIX_SORT = radixSort();
const EXACT_SORT = exactSort();

/** Demo policy: stable LCC ordering on desktop HD, with explicit A/B overrides. */
export function demoSortStrategy(
  scene: string,
  options: {
    override: string | null;
    constrainedDevice: boolean;
    sd: boolean;
    profile: SplatPerformanceProfile | undefined;
  },
): SplatSortStrategy {
  const { override } = options;
  if (override === 'counting' || override === 'worker') return override;
  if (override === 'radix') return RADIX_SORT;
  if (override === 'exact') return EXACT_SORT;
  const lcc = /\.lcc2?$/i.test(new URL(scene, 'https://viewer.invalid').pathname);
  return lcc && !options.constrainedDevice && !options.sd && options.profile !== 'smooth'
    ? RADIX_SORT
    : 'counting';
}
