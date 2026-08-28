import { SplatLoadError } from '../lib/loaders';

/** A button shown on the error card (e.g. Retry / Reload). */
export interface ErrorAction {
  readonly label: string;
  readonly onClick: () => void;
}

/** Content of a failure card. */
export interface ErrorInfo {
  readonly title: string;
  readonly message: string;
  readonly action?: ErrorAction;
}

let card: HTMLElement | null = null;

/**
 * Shows a centered failure card, replacing any previous one. Use for
 * unrecoverable-in-place states (load failure, lost GPU device) so the viewer
 * sees a clear message and a way forward instead of a frozen canvas.
 */
export function showError(info: ErrorInfo): void {
  const overlay = document.querySelector<HTMLElement>('#overlay');
  if (overlay) overlay.textContent = '';

  if (!card) {
    card = document.createElement('div');
    card.id = 'error';
    document.body.appendChild(card);
  }
  card.replaceChildren();

  const title = document.createElement('h2');
  title.textContent = info.title;
  const message = document.createElement('p');
  message.textContent = info.message;
  card.append(title, message);

  if (info.action) {
    const button = document.createElement('button');
    button.textContent = info.action.label;
    button.addEventListener('click', info.action.onClick);
    card.append(button);
  }
  card.classList.add('visible');
}

/** Removes the failure card, if any. */
export function hideError(): void {
  card?.classList.remove('visible');
}

/** Whether a failure card is currently on screen. */
export function isErrorVisible(): boolean {
  return card?.classList.contains('visible') === true;
}

/**
 * Maps a load failure to a viewer-facing card. Understands the package's
 * {@link SplatLoadError} (phase, HTTP status, retryable) and falls back to a
 * generic message for anything else.
 */
export function describeLoadError(
  error: unknown,
  sceneLabel: string,
): ErrorInfo & { retryable: boolean } {
  if (error instanceof SplatLoadError) {
    const where = shortUrl(error.url);
    if (error.phase === 'resolve') {
      return {
        title: 'Invalid scene URL',
        message: `Could not parse "${error.url}".`,
        retryable: false,
      };
    }
    if (error.status === 404) {
      return { title: 'Scene not found', message: `${where} returned HTTP 404.`, retryable: false };
    }
    if (error.status !== undefined) {
      return {
        title: 'Could not load the scene',
        message: `${where} returned HTTP ${error.status}.`,
        retryable: error.retryable,
      };
    }
    if (error.phase === 'decode' || error.phase === 'worker') {
      return {
        title: 'Could not read the scene',
        // The parser's own message names the actual problem - the wrong PLY
        // flavor, a bad ZIP, a truncated file. Guessing "unsupported or
        // corrupt" on its behalf reads as "your file is broken" even when it
        // is perfectly valid and simply not a format this build reads.
        // Some messages already name the file; don't say it twice.
        message: error.message.includes(sceneLabel)
          ? error.message
          : `${sceneLabel}: ${error.message}`,
        retryable: false,
      };
    }
    // fetch / manifest with no HTTP status = a network-level failure. A CORS
    // rejection lands here too and is indistinguishable from a dropped
    // connection - the browser hands JS an opaque TypeError on purpose - so a
    // cross-origin URL gets a message that covers the far likelier cause and
    // says what the host has to change. There is no client-side workaround.
    if (isCrossOrigin(error.url)) {
      return {
        title: 'Could not load that URL',
        message:
          `${where} could not be fetched. The server hosting it must allow cross-origin ` +
          'requests (Access-Control-Allow-Origin), and for streamed formats also allow the ' +
          'Range header and expose Content-Range. Otherwise, download the file and drop it here.',
        retryable: error.retryable,
      };
    }
    return {
      title: 'Network error',
      message: `Could not reach ${where}. Check your connection and try again.`,
      retryable: error.retryable,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  // The auto-format detector throws a plain Error for an unknown extension;
  // give it a clearer heading than the generic fallback.
  if (/unsupported.*(format|extension)/i.test(message)) {
    return {
      title: 'Unsupported format',
      message: `${sceneLabel} is not a splat format this viewer can read (expected .sog, .ply, .spz, .splat or .ksplat).`,
      retryable: false,
    };
  }
  return { title: 'Something went wrong', message, retryable: false };
}

/**
 * Whether a scene URL points at another origin - the only case where CORS can
 * be what failed. Unparseable or relative URLs are same-origin by definition.
 */
function isCrossOrigin(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url, globalThis.location?.href);
    // A dropped file streams through a blob: URL - local, never a CORS failure.
    if (parsed.protocol === 'blob:') return false;
    return parsed.origin !== globalThis.location?.origin;
  } catch {
    return false;
  }
}

/** Trims a URL to `host/…/basename` for a compact, readable message. */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url, globalThis.location?.href);
    const base = parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.pathname;
    return `${parsed.host}/…/${base}`;
  } catch {
    return url;
  }
}
