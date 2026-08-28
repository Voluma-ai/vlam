/**
 * The library's diagnostic output, behind one replaceable hook.
 *
 * A library that writes straight to the host console gives embedders no way
 * out - and some of these sites are per-item (a malformed chunk in a large
 * streamed scene can warn on every tick). Everything routes through
 * {@link setVlamLogHandler} instead, so a host can forward VLAM! diagnostics
 * into its own logger, or silence them entirely.
 *
 * Worker scopes are the deliberate exception: `load-worker.ts` and
 * `sort-worker.ts` run in a separate realm with no access to this module's
 * state, and plumbing a handler across `postMessage` would mean serializing
 * user callbacks. Neither worker logs today - failures travel back as
 * structured messages - so there is nothing to route.
 */

/** Severity of a library diagnostic. */
export type VlamLogLevel = 'warn' | 'error';

/**
 * Receives library diagnostics. `message` is already prefixed with `vlam:`;
 * `details` carries any extra values the call site passed.
 */
export type VlamLogHandler = (level: VlamLogLevel, message: string, ...details: unknown[]) => void;

const defaultHandler: VlamLogHandler = (level, message, ...details) => {
  if (level === 'error') console.error(message, ...details);
  else console.warn(message, ...details);
};

let handler: VlamLogHandler | null = defaultHandler;

/**
 * Redirects (or silences) every diagnostic the library emits.
 *
 * @param next - A handler to receive diagnostics, `null` to drop them
 * silently, or omitted/`undefined` to restore the default console handler.
 *
 * @example
 * setVlamLogHandler((level, message) => myLogger.log(level, message));
 * setVlamLogHandler(null); // silence VLAM! entirely
 */
export function setVlamLogHandler(next?: VlamLogHandler | null): void {
  handler = next === undefined ? defaultHandler : next;
}

/** Emits a `vlam:`-prefixed warning through the current handler. */
export function warn(message: string, ...details: unknown[]): void {
  handler?.('warn', `vlam: ${message}`, ...details);
}

/** Emits a `vlam:`-prefixed error through the current handler. */
export function logError(message: string, ...details: unknown[]): void {
  handler?.('error', `vlam: ${message}`, ...details);
}
