// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLocalInboxChangeOrigins } from '../use-local-inbox-change-origins';

type Origins = ReturnType<typeof useLocalInboxChangeOrigins>;

function Harness({ onRender }: { onRender: (origins: Origins) => void }) {
  onRender(useLocalInboxChangeOrigins());
  return null;
}

// @test-scope safeguard: prevents local inbox mutation origins from being lost before matching refresh events arrive.
describe('useLocalInboxChangeOrigins', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  function renderOrigins() {
    let origins: Origins | undefined;
    act(() => root.render(<Harness onRender={(value) => (origins = value)} />));
    return origins!;
  }

  it('buffers an event while the mutation is pending and suppresses it on success', () => {
    const origins = renderOrigins();
    const origin = origins.registerOrigin();

    expect(origins.classifyOrigin(origin)).toBe('ignore');
    origins.completeOrigin(origin);
    expect(origins.classifyOrigin(origin)).toBe('ignore');
  });

  it('requests reconciliation when a pending event is followed by failure', () => {
    const origins = renderOrigins();
    const origin = origins.registerOrigin();

    expect(origins.classifyOrigin(origin)).toBe('ignore');
    expect(origins.failOrigin(origin)).toBe(true);
    expect(origins.classifyOrigin(origin)).toBe('reconcile');
  });

  it('keeps a failed mutation correlated until a delayed event arrives', () => {
    const origins = renderOrigins();
    const origin = origins.registerOrigin();

    expect(origins.failOrigin(origin)).toBe(false);
    act(() => vi.advanceTimersByTime(60 * 60 * 1000));
    expect(origins.classifyOrigin(origin)).toBe('reconcile');
  });

  it('does not classify another tab origin as local', () => {
    const origins = renderOrigins();

    expect(origins.classifyOrigin('another-tab.origin')).toBe('unmatched');
  });

  it('retains the tab prefix and mutation state across Analysis remounts', () => {
    const origins = renderOrigins();
    const origin = origins.registerOrigin();
    origins.completeOrigin(origin);

    act(() => root.unmount());
    root = createRoot(container);
    const remountedOrigins = renderOrigins();

    expect(remountedOrigins.classifyOrigin(origin)).toBe('ignore');
  });

  it('reconciles a current-tab event after its detailed state was evicted', () => {
    const origins = renderOrigins();
    const evictedOrigin = origins.registerOrigin();
    for (let index = 0; index < 4096; index += 1) {
      origins.registerOrigin();
    }

    expect(origins.classifyOrigin(evictedOrigin)).toBe('reconcile');
  });
});
