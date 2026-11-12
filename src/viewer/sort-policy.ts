import type { SplatPerformanceProfile, SplatSortStrategy } from '../lib/core';
import { sortStrategyFromName } from '../lib/sorting/radix';

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
  if (
    override === 'counting' ||
    override === 'worker' ||
    override === 'radix' ||
    override === 'exact'
  ) {
    return sortStrategyFromName(override);
  }
  const lcc = /\.lcc2?$/i.test(new URL(scene, 'https://viewer.invalid').pathname);
  return sortStrategyFromName(
    lcc && !options.constrainedDevice && !options.sd && options.profile !== 'smooth'
      ? 'radix'
      : 'counting',
  );
}
