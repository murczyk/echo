/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PowerSnackbarProvider } from '../../../../components/PowerSnackbar';
import { AnalysisMapPane } from '.././AnalysisMapPane';

function buildProps(
  overrides: Partial<Parameters<typeof AnalysisMapPane>[0]> = {},
): Parameters<typeof AnalysisMapPane>[0] {
  return {
    mapAttrs: {
      daterange: '',
      daterangeLoading: '',
      messages: '',
      settlementMessagesHasMore: 'false',
      palitras: '',
      palitrasLoaded: '',
      palitrasLoadState: 'idle',
      points: '',
      settlements: '',
      canShowSettlements: 'false',
      showSettlements: 'false',
      selectedUnits: '',
    },
    search: '',
    visible: true,
    onDateRangeChange: vi.fn(),
    onLoadMessages: vi.fn(async () => true),
    onLoadSettlementMessages: vi.fn(async () => true),
    onUnitClick: vi.fn(),
    ...overrides,
  };
}

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// @test-scope safeguard: preserves map load-state ownership and user-visible error handling so late or paged map requests cannot misrepresent the selected settlement data.
describe('AnalysisMapPane', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('delays visibility until the next frame', async () => {
    vi.useFakeTimers();

    await act(async () => {
      root.render(<AnalysisMapPane {...buildProps({ visible: true })} />);
    });

    const map = container.querySelector('analysis-map');
    expect(map?.getAttribute('visibility')).toBe('false');

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(map?.getAttribute('visibility')).toBe('true');
  });

  it('shows Delta KML loading failures in a toast', async () => {
    await act(async () => {
      root.render(
        <PowerSnackbarProvider>
          <AnalysisMapPane {...buildProps()} />
        </PowerSnackbarProvider>,
      );
    });

    const map = container.querySelector('analysis-map');
    await act(async () => {
      map?.dispatchEvent(
        new CustomEvent('delta-kml-load-error', {
          detail: { message: 'HTTP 500' },
        }),
      );
    });

    expect(document.body.textContent).toContain('Не вдалося завантажити шар Delta KML: HTTP 500');
  });

  it('exposes a loading state while map messages are being fetched', async () => {
    const load = deferredPromise<boolean>();
    const onLoadSettlementMessages = vi.fn(() => load.promise);

    await act(async () => {
      root.render(<AnalysisMapPane {...buildProps({ onLoadSettlementMessages })} />);
    });

    const map = container.querySelector('analysis-map');
    expect(map).not.toBeNull();

    await act(async () => {
      map?.dispatchEvent(
        new CustomEvent('load-settlement-messages', {
          detail: { settlementId: 7 },
          bubbles: true,
        }),
      );
    });

    expect(onLoadSettlementMessages).toHaveBeenCalledWith(7, null);
    expect(map?.getAttribute('messages-loading')).toBe('true');

    await act(async () => {
      load.resolve(true);
      await load.promise;
    });

    expect(map?.getAttribute('messages-loading')).toBe('false');
    expect(map?.getAttribute('messages-load-serial')).toBe('1');
  });

  it('does not advance the message serial when the load resolves without popup content', async () => {
    const load = deferredPromise<boolean>();
    const onLoadMessages = vi.fn(() => load.promise);

    await act(async () => {
      root.render(<AnalysisMapPane {...buildProps({ onLoadMessages })} />);
    });

    const map = container.querySelector('analysis-map');
    expect(map).not.toBeNull();

    await act(async () => {
      map?.dispatchEvent(
        new CustomEvent('load-messages-description', {
          detail: { messageIds: [1] },
          bubbles: true,
        }),
      );
    });

    expect(map?.getAttribute('messages-loading')).toBe('true');
    expect(map?.getAttribute('messages-load-serial')).toBe('0');

    await act(async () => {
      load.resolve(false);
      await load.promise;
    });

    expect(map?.getAttribute('messages-loading')).toBe('false');
    expect(map?.getAttribute('messages-load-serial')).toBe('0');
  });

  it('passes a settlement cursor when the popup requests another page', async () => {
    const onLoadSettlementMessages = vi.fn(async () => true);
    await act(async () => {
      root.render(<AnalysisMapPane {...buildProps({ onLoadSettlementMessages })} />);
    });

    const map = container.querySelector('analysis-map');
    await act(async () => {
      map?.dispatchEvent(
        new CustomEvent('load-settlement-messages', {
          detail: { settlementId: 7, beforeIdNoninclusive: 20 },
          bubbles: true,
        }),
      );
    });

    expect(onLoadSettlementMessages).toHaveBeenCalledWith(7, 20);
  });
});
