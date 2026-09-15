import type { ExperimentConfiguration } from './experiments';

declare const __VLAM_EXPERIMENT__: string;

/** Benchmark-server replacement for the library's disabled controls. */
export const experiments: ExperimentConfiguration = {
  initialPoolUpload: __VLAM_EXPERIMENT__ === 'skip-empty' ? 'skip-empty' : 'existing',
  radTraversal: __VLAM_EXPERIMENT__ === 'bounded-threshold' ? 'bounded-threshold' : 'heap',
  radPager: __VLAM_EXPERIMENT__ === 'rad-indexed' ? 'indexed' : 'classic',
  radDemand: __VLAM_EXPERIMENT__ === 'rad-focus' ? 'focus' : 'legacy',
  remotePly:
    __VLAM_EXPERIMENT__ === 'exact-stream'
      ? 'exact-stream'
      : __VLAM_EXPERIMENT__ === 'approximate-sh-stream'
        ? 'approximate-sh-stream'
        : 'buffered',
  webglProvokingVertex: __VLAM_EXPERIMENT__ === 'first-vertex' ? 'first-vertex' : 'existing',
};
