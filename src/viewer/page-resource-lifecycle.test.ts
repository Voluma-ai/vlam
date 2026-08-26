import { describe, expect, it, vi } from 'vitest';
import {
  installPageResourceLifecycle,
  type PageLifecycleEvent,
  type PageLifecycleTarget,
} from './page-resource-lifecycle';

class FakePageLifecycleTarget implements PageLifecycleTarget {
  private readonly listeners = new Map<
    'pagehide' | 'pageshow',
    Array<(event: PageLifecycleEvent) => void>
  >();

  addEventListener(
    type: 'pagehide' | 'pageshow',
    listener: (event: PageLifecycleEvent) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: 'pagehide' | 'pageshow', persisted: boolean): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ persisted });
  }
}

describe('installPageResourceLifecycle', () => {
  it('disposes once even when pagehide enters the back-forward cache', () => {
    const target = new FakePageLifecycleTarget();
    const dispose = vi.fn();
    installPageResourceLifecycle(target, dispose, vi.fn());

    target.dispatch('pagehide', true);
    target.dispatch('pagehide', false);

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('reloads a cached page after its resources were disposed', () => {
    const target = new FakePageLifecycleTarget();
    const reload = vi.fn();
    installPageResourceLifecycle(target, vi.fn(), reload);

    target.dispatch('pageshow', false);
    target.dispatch('pageshow', true);
    expect(reload).not.toHaveBeenCalled();

    target.dispatch('pagehide', true);
    target.dispatch('pageshow', true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
