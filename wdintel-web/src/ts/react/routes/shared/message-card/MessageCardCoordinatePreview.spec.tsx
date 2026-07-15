/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../../Bindings';
import { MessageCardCoordinatePreview } from './MessageCardCoordinatePreview';
import { resolveMessageCoordinatePreview } from './message-coordinate-preview';

vi.mock('./message-coordinate-preview', () => ({
  resolveMessageCoordinatePreview: vi.fn(),
}));

vi.mock('./MessageCardCoordinateMapDialog', () => ({
  MessageCardCoordinateMapDialog: ({
    open,
    coordinate,
  }: {
    open: boolean;
    coordinate: { lat: number; lng: number; label: string };
  }) =>
    open ? (
      <div
        role="dialog"
        data-lat={coordinate.lat}
        data-lng={coordinate.lng}
        data-label={coordinate.label}
      >
        coordinate-dialog
      </div>
    ) : null,
}));

vi.mock('../../../../web-components/analysis-map/tile-layers', () => ({
  getTileLayers: vi.fn(() => ({
    googleHybrid: {
      addTo: vi.fn(),
    },
  })),
}));

vi.mock('leaflet', () => {
  const container = {
    style: {} as Record<string, string>,
  };
  const map = {
    setView() {
      return map;
    },
    getContainer() {
      return container;
    },
    invalidateSize: vi.fn(),
    remove: vi.fn(),
  };
  const marker = {
    addTo() {
      return marker;
    },
    remove: vi.fn(),
  };

  return {
    map: vi.fn(() => map),
    circleMarker: vi.fn(() => marker),
  };
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('MessageCardCoordinatePreview', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IntersectionObserver', undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
      document.body.innerHTML = '';
    });
    vi.unstubAllGlobals();
  });

  it('shows a direct preview and opens the coordinate dialog', async () => {
    const msg = { pointTokens: [] } as InboxMessage;
    vi.mocked(resolveMessageCoordinatePreview).mockResolvedValue({
      source: 'direct',
      point: { lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355' },
      etalons: [],
      pointCount: 1,
    });

    await act(async () => {
      root.render(<MessageCardCoordinatePreview msg={msg} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const button = container.querySelector(
      'button[aria-label="Open 50.45044, 30.52355 on map"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(container.firstElementChild?.getAttribute('style')).toContain('width: 180px');
    expect(container.firstElementChild?.getAttribute('style')).toContain('max-width: 100%');
    expect(button?.getAttribute('style')).toContain('height: 120px');
    expect(container.textContent).not.toContain('+');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      button?.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-popper-placement="top"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Відкрити на мапі');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('data-lat')).toBe('50.45044');
    expect(dialog?.getAttribute('data-lng')).toBe('30.52355');
  });

  it('keeps the palitra badge and search string for palitra previews', async () => {
    const msg = { pointTokens: [] } as InboxMessage;
    vi.mocked(resolveMessageCoordinatePreview).mockResolvedValue({
      source: 'palitra',
      point: { lat: 50.45, lng: 30.52, label: 'BRAVO' },
      etalons: ['ALPHA', 'BRAVO'],
      pointCount: 2,
    });

    await act(async () => {
      root.render(<MessageCardCoordinatePreview msg={msg} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('+1');
    const button = container.querySelector('button[aria-label="Open BRAVO on map"]');
    expect(button).not.toBeNull();
    expect(container.firstElementChild?.getAttribute('style')).toContain('width: 180px');
    expect(container.firstElementChild?.getAttribute('style')).toContain('max-width: 100%');
    expect(button?.getAttribute('style')).toContain('height: 120px');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      button?.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-popper-placement="top"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Відкрити на мапі');
    expect(container.textContent).toContain('+1');
  });

  it('renders an inline retry error when the resolver rejects for a palette list failure', async () => {
    const msg = { pointTokens: [] } as InboxMessage;
    vi.mocked(resolveMessageCoordinatePreview)
      .mockRejectedValueOnce(new Error('palette list failed'))
      .mockResolvedValueOnce({
        source: 'palitra',
        point: { lat: 50.45, lng: 30.52, label: 'BRAVO' },
        etalons: ['BRAVO'],
        pointCount: 1,
      });

    await act(async () => {
      root.render(<MessageCardCoordinatePreview msg={msg} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Не вдалося завантажити точку мапи');
    const retry = container.querySelector('button[aria-label="Повторити"]') as HTMLButtonElement;
    expect(retry).not.toBeNull();

    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('button[aria-label="Open BRAVO on map"]')).not.toBeNull();
  });

  it('renders an inline retry error when the resolver rejects for a point lookup failure', async () => {
    const msg = { pointTokens: [] } as InboxMessage;
    vi.mocked(resolveMessageCoordinatePreview)
      .mockRejectedValueOnce(new Error('point search failed'))
      .mockResolvedValueOnce({
        source: 'palitra',
        point: { lat: 50.45, lng: 30.52, label: 'BRAVO' },
        etalons: ['BRAVO'],
        pointCount: 1,
      });

    await act(async () => {
      root.render(<MessageCardCoordinatePreview msg={msg} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Не вдалося завантажити точку мапи');

    const retry = container.querySelector('button[aria-label="Повторити"]') as HTMLButtonElement;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('button[aria-label="Open BRAVO on map"]')).not.toBeNull();
  });

  it('stays silent for a genuine preview miss', async () => {
    const msg = { pointTokens: [] } as InboxMessage;
    vi.mocked(resolveMessageCoordinatePreview).mockResolvedValue(null);

    await act(async () => {
      root.render(<MessageCardCoordinatePreview msg={msg} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toBe('');
  });

  it('ignores stale async errors after the message changes', async () => {
    const first = createDeferred<never>();
    const second = createDeferred<{
      source: 'palitra';
      point: { lat: number; lng: number; label: string };
      etalons: string[];
      pointCount: number;
    } | null>();

    vi.mocked(resolveMessageCoordinatePreview)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const firstMsg = { pointTokens: [] } as InboxMessage;
    const secondMsg = { pointTokens: [] } as InboxMessage;

    await act(async () => {
      root.render(<MessageCardCoordinatePreview msg={firstMsg} />);
    });

    await act(async () => {
      root.render(<MessageCardCoordinatePreview msg={secondMsg} />);
    });

    await act(async () => {
      first.reject(new Error('stale failure'));
      await Promise.resolve();
    });

    await act(async () => {
      second.resolve({
        source: 'palitra',
        point: { lat: 50.45, lng: 30.52, label: 'BRAVO' },
        etalons: ['BRAVO'],
        pointCount: 1,
      });
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Не вдалося завантажити точку мапи');
    expect(container.querySelector('button[aria-label="Open BRAVO on map"]')).not.toBeNull();
  });
});
