/**
 * Clip worker of `.asog` playback: decodes a file once, keeps it, and
 * evaluates frames on request (`asog-worker-handler.ts`), so neither the
 * inflate and dequantisation nor the per-frame motion evaluation runs on the
 * page's main thread.
 *
 * A frame reply transfers its buffers, and the page hands them back with a
 * later request, so steady playback allocates nothing.
 */
import type { AsogWorkerRequest } from './asog-worker-protocol';
import { createAsogWorkerHandler } from './asog-worker-handler';

const scope = self as unknown as Worker;
const handle = createAsogWorkerHandler((reply, transfer = []) =>
  scope.postMessage(reply, transfer),
);
scope.onmessage = (event: MessageEvent<AsogWorkerRequest>): void => handle(event.data);
