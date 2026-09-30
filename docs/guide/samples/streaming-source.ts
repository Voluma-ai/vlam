import { StreamedSplatMesh, type SplatDatasetSource } from '@voluma/vlam/streaming';

export function openSource(source: SplatDatasetSource, signal: AbortSignal) {
  return StreamedSplatMesh.loadSource(source, {
    format: 'rad',
    sourceOwnership: 'borrowed',
    signal,
    budget: 2_000_000,
  });
}
