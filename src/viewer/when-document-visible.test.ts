import { afterEach, describe, expect, it, vi } from 'vitest';

import { whenDocumentVisible } from './when-document-visible';

type FakeDocument = {
  visibilityState: 'visible' | 'hidden';
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  dispatchVisibilityChange: () => void;
};

function stubDocument(initial: 'visible' | 'hidden'): FakeDocument {
  const listeners = new Set<() => void>();
  const doc: FakeDocument = {
    visibilityState: initial,
    addEventListener(type, listener) {
      if (type === 'visibilitychange') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'visibilitychange') listeners.delete(listener);
    },
    dispatchVisibilityChange() {
      for (const listener of [...listeners]) listener();
    },
  };
  vi.stubGlobal('document', doc);
  return doc;
}

describe('whenDocumentVisible', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves immediately when the document is already visible', async () => {
    stubDocument('visible');
    await expect(whenDocumentVisible(50)).resolves.toBeUndefined();
  });

  it('waits for visibilitychange when the document starts hidden', async () => {
    const doc = stubDocument('hidden');
    const pending = whenDocumentVisible(5_000);
    let done = false;
    void pending.then(() => {
      done = true;
    });

    await Promise.resolve();
    expect(done).toBe(false);

    doc.visibilityState = 'visible';
    doc.dispatchVisibilityChange();
    await pending;
    expect(done).toBe(true);
  });

  it('resolves after the timeout while still hidden', async () => {
    vi.useFakeTimers();
    stubDocument('hidden');
    const pending = whenDocumentVisible(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBeUndefined();
  });
});
