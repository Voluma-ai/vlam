export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Minimal session event surface; camera/controller math still uses real Three.js. */
export class SessionEvents {
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, callback: () => void) {
    const callbacks = this.listeners.get(type) ?? new Set<() => void>();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type: string, callback: () => void) {
    this.listeners.get(type)?.delete(callback);
  }
  emit(type: string) {
    for (const callback of this.listeners.get(type) ?? []) callback();
  }
}
