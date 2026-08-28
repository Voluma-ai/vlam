/** @role Bridge - Builds and traverses static splat LOD hierarchies off-thread. */
import type { SplatData } from '../core/splat-data';
import { handleStaticLodWorkerRequest } from './static-lod-worker-handler';
import type { StaticLodWorkerRequest, StaticLodWorkerResponse } from './static-lod-worker-protocol';

const transferablesForData = (data: SplatData): Transferable[] => {
  const transferables: Transferable[] = [
    data.positions.buffer as ArrayBuffer,
    data.colors.buffer as ArrayBuffer,
    data.covariances.buffer as ArrayBuffer,
  ];
  if (data.sh) transferables.push(data.sh.labels.buffer as ArrayBuffer);
  if (data.shPacked) transferables.push(data.shPacked.packed.buffer as ArrayBuffer);
  return transferables;
};

const post = (response: StaticLodWorkerResponse, transferables: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(response, transferables);
};

self.onmessage = (event: MessageEvent<StaticLodWorkerRequest>): void => {
  handleStaticLodWorkerRequest(event.data, (response) => {
    if (response.type === 'built') {
      post(response, transferablesForData(response.data));
      return;
    }
    if (response.type === 'selection') {
      post(response, [response.indices.buffer as ArrayBuffer]);
      return;
    }
    post(response);
  });
};
