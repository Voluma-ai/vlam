import type { ExperimentConfiguration } from './experiments';

declare const __VLAM_EXPERIMENT__: string;

/** Benchmark-server replacement for the library's disabled controls. */
export const experiments: ExperimentConfiguration = {
  initialPoolUpload: __VLAM_EXPERIMENT__ === 'skip-empty' ? 'skip-empty' : 'existing',
  radTraversal:
    __VLAM_EXPERIMENT__ === 'bounded-threshold'
      ? 'bounded-threshold'
      : __VLAM_EXPERIMENT__ === 'heap'
        ? 'heap'
        : 'one-pass',
  radDecodeWorkers:
    __VLAM_EXPERIMENT__ === 'rad-decode-2' ? 2 : __VLAM_EXPERIMENT__ === 'rad-decode-4' ? 4 : 1,
  remotePly:
    __VLAM_EXPERIMENT__ === 'exact-stream'
      ? 'exact-stream'
      : __VLAM_EXPERIMENT__ === 'approximate-sh-stream'
        ? 'approximate-sh-stream'
        : 'buffered',
  webglProvokingVertex: __VLAM_EXPERIMENT__ === 'first-vertex' ? 'first-vertex' : 'existing',
};
