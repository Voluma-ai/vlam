import type { SplatPerformanceProfile, SplatSortStrategy } from '../lib/core';

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
    override === 'radix' ||
    override === 'exact' ||
    override === 'worker'
  )
    return override;
  const lcc = /\.lcc2?$/i.test(new URL(scene, 'https://viewer.invalid').pathname);
  return lcc && !options.constrainedDevice && !options.sd && options.profile !== 'smooth'
    ? 'radix'
    : 'counting';
}
