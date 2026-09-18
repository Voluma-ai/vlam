import { StreamedSplatMesh } from '../../streaming/streamed-splat-mesh';

/**
 * Injects synthetic decoded scenes and workers for scheduler/state-machine tests.
 * These fixtures need impossible/intermediate states which HTTP loading cannot
 * supply. Keep the constructor bridge here; public loading has separate tests.
 */
export function createStreamedMeshFixture(
  scene: unknown,
  budget: number,
  capacity: number,
  options: unknown,
  worker?: unknown,
  neverRetireCoverageEarly?: boolean,
  radChunkResidency = false,
  radResidencyRequested = radChunkResidency,
  radResidencyFallbackReason: string | null = null,
): StreamedSplatMesh {
  const FixtureMesh = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
    worker?: unknown,
    neverRetireCoverageEarly?: boolean,
    sourceLabel?: string,
    radChunkResidency?: boolean,
    radResidencyRequested?: boolean,
    radResidencyFallbackReason?: string | null,
  ) => StreamedSplatMesh;
  return new FixtureMesh(
    scene,
    budget,
    capacity,
    options,
    worker,
    neverRetireCoverageEarly,
    undefined,
    radChunkResidency,
    radResidencyRequested,
    radResidencyFallbackReason,
  );
}
