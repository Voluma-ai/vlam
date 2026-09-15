/** Build-time-only research controls. The published library uses these defaults. */
export interface ExperimentConfiguration {
  initialPoolUpload: 'existing' | 'skip-empty';
  radTraversal: 'heap' | 'bounded-threshold';
  /** Stable-slot candidate pager; benchmark-only until the RAD gate passes. */
  radPager: 'classic' | 'indexed';
  /** Candidate only until the large-scene visual/performance gate passes. */
  radDemand: 'legacy' | 'focus';
  remotePly: 'buffered' | 'exact-stream' | 'approximate-sh-stream';
  webglProvokingVertex: 'existing' | 'first-vertex';
}

export const experiments: ExperimentConfiguration = {
  initialPoolUpload: 'skip-empty',
  radTraversal: 'heap',
  radPager: 'classic',
  radDemand: 'legacy',
  remotePly: 'buffered',
  webglProvokingVertex: 'existing',
} as const;
