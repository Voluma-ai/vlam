/** Build-time-only research controls. The published library uses these defaults. */
export interface ExperimentConfiguration {
  initialPoolUpload: 'existing' | 'skip-empty';
  radTraversal: 'heap' | 'bounded-threshold';
  remotePly: 'buffered' | 'exact-stream' | 'approximate-sh-stream';
  webglProvokingVertex: 'existing' | 'first-vertex';
}

export const experiments: ExperimentConfiguration = {
  initialPoolUpload: 'skip-empty',
  radTraversal: 'heap',
  remotePly: 'buffered',
  webglProvokingVertex: 'existing',
} as const;
