/** Build-time-only research controls. The published library uses these defaults. */
export interface ExperimentConfiguration {
  initialPoolUpload: 'existing' | 'skip-empty';
  /**
   * `one-pass` matches Spark 2.1: one best-first walk that stops at the pixel
   * threshold or draw budget. `heap` keeps main's extra budget-filling walks
   * for A/B. `bounded-threshold` is the DFS candidate.
   */
  radTraversal: 'one-pass' | 'heap' | 'bounded-threshold';
  /** Decode workers shared by streamed RAD. Benchmarks may try 1, 2, or 4. */
  radDecodeWorkers: 1 | 2 | 4;
  /** RAD GPU residency strategy; chunk-pages keeps whole authored chunks resident. */
  radResidency: 'indexed' | 'chunk-pages';
  remotePly: 'buffered' | 'exact-stream' | 'approximate-sh-stream';
  webglProvokingVertex: 'existing' | 'first-vertex';
}

export const experiments: ExperimentConfiguration = {
  initialPoolUpload: 'skip-empty',
  radTraversal: 'one-pass',
  radDecodeWorkers: 1,
  radResidency: 'chunk-pages',
  remotePly: 'buffered',
  webglProvokingVertex: 'existing',
} as const;
