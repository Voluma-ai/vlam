// Guide sample: docs/guide/loading-scenes.md - structured errors,
// cancellation, and progress.
import { SplatMesh } from '@voluma/vlam';
import { SplatLoadError, isAbortError, loadScene } from '@voluma/vlam/loaders';

const controller = new AbortController();
// e.g. cancel when the user navigates away:
// controller.abort();

export async function loadWithFeedback(url: string): Promise<SplatMesh | null> {
  try {
    const data = await loadScene(url, {
      signal: controller.signal,
      onProgress: (loaded, total) => {
        // total is 0 when the response has no Content-Length → show a spinner.
        if (total > 0) console.log(`${Math.round((loaded / total) * 100)}%`);
      },
    });
    return new SplatMesh(data);
  } catch (error) {
    if (isAbortError(error)) return null; // deliberate cancellation, not a failure
    if (error instanceof SplatLoadError) {
      // phase: 'resolve' | 'manifest' | 'fetch' | 'decode' | 'worker'
      console.error(`load failed during ${error.phase} of ${error.url}`, error.status);
      if (error.retryable) {
        // transient (network hiccup, 5xx, 429) - offer a retry
      }
      return null;
    }
    throw error; // not a loading error - do not swallow it
  }
}
