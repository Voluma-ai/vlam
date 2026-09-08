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
): StreamedSplatMesh {
  const FixtureMesh = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
    worker?: unknown,
    neverRetireCoverageEarly?: boolean,
  ) => StreamedSplatMesh;
  return new FixtureMesh(scene, budget, capacity, options, worker, neverRetireCoverageEarly);
}
