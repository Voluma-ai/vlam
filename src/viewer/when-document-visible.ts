/**
 * Waits until the document is visible, with a timeout so hidden embeds do not hang.
 *
 * Mobile browsers often open `target=_blank` tabs in the background. WebGPU
 * `requestAdapter` and the first streamed fetch then fail or no-op; a refresh
 * works because the tab is focused. Call this before GPU/scene work when the
 * page was opened via a deep link (`?scene=`).
 */
export function whenDocumentVisible(timeoutMs = 3_000): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  if (document.visibilityState === 'visible') return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('visibilitychange', onChange);
      globalThis.clearTimeout(timer);
      resolve();
    };
    const onChange = (): void => {
      if (document.visibilityState === 'visible') finish();
    };
    document.addEventListener('visibilitychange', onChange);
    const timer = globalThis.setTimeout(finish, timeoutMs);
  });
}
