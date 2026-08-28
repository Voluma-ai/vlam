import { frontierView, traverseFrontier } from './formats/rad/rad-frontier';
import type { SplatData } from './splat-data';
import { buildStaticLod, validateStaticLodSource } from './static-lod';
import type { StaticLodWorkerRequest, StaticLodWorkerResponse } from './static-lod-worker-protocol';

let traversalData: SplatData | undefined;
let roots = new Uint32Array();

/**
 * Clones hierarchy attributes for a transferable GPU upload.
 * Omits `radTree` - traversal keeps the worker-owned original.
 */
const cloneHierarchyForGpu = (data: SplatData): SplatData => {
  validateStaticLodSource(data);
  return {
    count: data.count,
    positions: data.positions.slice(),
    colors: data.colors.slice(),
    covariances: data.covariances.slice(),
    ...(data.sh ? { sh: { ...data.sh, labels: data.sh.labels.slice() } } : {}),
    ...(data.shPacked
      ? { shPacked: { ...data.shPacked, packed: data.shPacked.packed.slice() } }
      : {}),
    ...(data.antialias === undefined ? {} : { antialias: data.antialias }),
    ...(data.format === undefined ? {} : { format: data.format }),
  };
};

/** Processes one worker message; kept separate so the complete transfer path is unit-testable. */
export function handleStaticLodWorkerRequest(
  message: StaticLodWorkerRequest,
  post: (response: StaticLodWorkerResponse) => void,
): void {
  try {
    if (message.type === 'build') {
      validateStaticLodSource(message.source);
      const result = buildStaticLod(message.source, message.maxBudget, (progress) => {
        post({ type: 'progress', progress });
      });
      if (!result.data.radTree) throw new Error('Static LOD builder did not produce a hierarchy.');
      traversalData = result.data;
      roots = new Uint32Array(result.roots);
      post({
        type: 'built',
        data: cloneHierarchyForGpu(result.data),
        contentSplatCount: result.contentSplatCount,
        finestSplatCount: result.finestSplatCount,
      });
      return;
    }

    if (!traversalData) throw new Error('Static LOD selection requested before build completed.');
    const view = frontierView(
      { x: message.cameraLocal[0], y: message.cameraLocal[1], z: message.cameraLocal[2] },
      { x: message.cameraForward[0], y: message.cameraForward[1], z: message.cameraForward[2] },
    );
    const result = traverseFrontier(
      new Map([[0, traversalData]]),
      [...roots],
      traversalData.count,
      view,
      0,
      message.budget,
    );
    post({
      type: 'selection',
      sequence: message.sequence,
      indices: Uint32Array.from(result.selection.get(0) ?? []),
    });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}
