import { loadSplatData } from '@voluma/vlam/loaders';

export async function openWithStatus(statusLabel: HTMLElement, progressLabel: HTMLElement) {
  return loadSplatData('/capture.splat', {
    onStatus: (status) => {
      statusLabel.textContent = status;
    },
    onProgress: (loaded, total) => {
      progressLabel.textContent = total > 0 ? `${loaded} / ${total}` : `${loaded} bytes`;
    },
  });
}
