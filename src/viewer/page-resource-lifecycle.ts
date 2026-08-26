export interface PageLifecycleEvent {
  readonly persisted: boolean;
}

export interface PageLifecycleTarget {
  addEventListener(
    type: 'pagehide' | 'pageshow',
    listener: (event: PageLifecycleEvent) => void,
  ): void;
}

/**
 * Releases heavyweight page resources even when the browser chooses bfcache.
 * A restored page reloads because its GPU renderer has been disposed.
 */
export function installPageResourceLifecycle(
  target: PageLifecycleTarget,
  dispose: () => void,
  reload: () => void,
): void {
  let disposed = false;

  target.addEventListener('pagehide', () => {
    if (disposed) return;
    disposed = true;
    dispose();
  });

  target.addEventListener('pageshow', (event) => {
    if (event.persisted && disposed) reload();
  });
}
