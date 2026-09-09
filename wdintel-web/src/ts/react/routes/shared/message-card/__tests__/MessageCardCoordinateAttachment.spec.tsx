/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../../../Bindings';
import { MessageCardCoordinateAttachment } from '../MessageCardCoordinateAttachment.tsx';
import {
  CoordinatePreviewLookupError,
  resolveMessageCoordinatePreview,
} from '../message-coordinate-preview.ts';

vi.mock('../message-coordinate-preview.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../message-coordinate-preview')>();
  return {
    ...actual,
    resolveMessageCoordinatePreview: vi.fn(),
  };
});

vi.mock('../attachment-preview/MessageCardAttachmentPreviewProvider.tsx', () => ({
  MessageCardAttachmentPreviewProvider: ({
    attachments,
    initialIndex,
  }: {
    attachments: Array<{
      points: Array<{ lat: number; lng: number; label: string }>;
    }>;
    initialIndex: number;
  }) => {
    const point = attachments[initialIndex]?.points[0];
    return point != null ? (
      <div
        role="dialog"
        data-lat={point.lat}
        data-lng={point.lng}
        data-label={point.label}
        data-index={String(initialIndex)}
        data-attachment-count={String(attachments.length)}
      >
        coordinate-dialog
      </div>
    ) : null;
  },
}));

vi.mock('../../../../web-components/analysis-map/tile-layers', () => ({
  DEFAULT_BASE_LAYER_ID: 'esriWorldImagery',
  getTileLayers: vi.fn(() => ({
    esriWorldImagery: { addTo: vi.fn() },
    googleHybrid: {
      addTo: vi.fn(),
    },
    openStreetMap: { addTo: vi.fn() },
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
    fitBounds() {
      return map;
    },
    getContainer() {
      return container;
    },
    invalidateSize: vi.fn(),
    remove: vi.fn(),
  };
  const marker = {
    bindTooltip() {
      return marker;
    },
    addTo() {
      return marker;
    },
    remove: vi.fn(),
  };

  return {
    map: vi.fn(() => map),
    circleMarker: vi.fn(() => marker),
    latLngBounds: vi.fn(() => ({})),
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

describe('MessageCardCoordinateAttachment', () => {
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

  // @test-scope regression: https://github.com/echoua/echo/issues/3324
  it('shows a direct preview and opens the coordinate dialog', async () => {
    const msg = { pointTokens: [] } as InboxMessage;
    vi.mocked(resolveMessageCoordinatePreview).mockResolvedValue({
      points: [{ source: 'direct', lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355' }],
      etalons: [],
      lookupError: null,
    });

    await act(async () => {
      root.render(<MessageCardCoordinateAttachment msg={msg} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const button = container.querySelector(
      'button[aria-label="Open 50.45044, 30.52355 on map"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.getAttribute('style')).toContain('width: 100%');
    expect(button?.getAttribute('style')).toContain('height: 100%');
    expect(button?.getAttribute('style')).toContain('max-width: none');
    expect(button?.getAttribute('style')).toContain('flex-grow: 0');
    expect(button?.getAttribute('style')).toContain('flex-shrink: 0');
    expect(button?.getAttribute('style')).toContain('flex-basis: auto');
    expect(
      container
        .querySelector('[data-coordinate-preview-root]')
        ?.classList.contains('message-card-coordinate-preview'),
    ).toBe(true);
    expect(
      container.querySelector('[data-coordinate-preview-tile]')?.getAttribute('style'),
    ).toEqual(expect.stringContaining('height: 100%'));
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

  // @test-scope regression: https://github.com/echoua/echo/issues/3324
  it('shows one unified preview with the numeric point count', async () => {
    const msg = { pointTokens: [] } as InboxMessage;
    vi.mocked(resolveMessageCoordinatePreview).mockResolvedValue({
      points: [
        { source: 'palitra', lat: 50.45, lng: 30.52, label: 'BRAVO' },
        { source: 'palitra', lat: 50.46, lng: 30.53, label: 'CHARLIE' },
        { source: 'palitra', lat: 50.47, lng: 30.54, label: 'DELTA' },
        { source: 'palitra', lat: 50.48, lng: 30.55, label: 'ECHO' },
        { source: 'palitra', lat: 50.49, lng: 30.56, label: 'FOXTROT' },
        { source: 'palitra', lat: 50.5, lng: 30.57, label: 'GOLF' },
        { source: 'palitra', lat: 50.51, lng: 30.58, label: 'HOTEL' },
        { source: 'palitra', lat: 50.52, lng: 30.59, label: 'INDIA' },
        { source: 'palitra', lat: 50.53, lng: 30.6, label: 'JULIET' },
      ],
      etalons: ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA'],
      lookupError: null,
    });

    await act(async () => {
      root.render(<MessageCardCoordinateAttachment msg={msg} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelectorAll('button[aria-label^="Open "]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-coordinate-preview-count]')).toHaveLength(1);
    expect(container.querySelector('[data-coordinate-preview-count]')?.textContent).toBe('9');
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3324
  it('renders an inline retry error when the resolver rejects for a palette list failure', async () => {
    const msg = { pointTokens: [] } as InboxMessage;
    vi.mocked(resolveMessageCoordinatePreview)
      .mockRejectedValueOnce(new Error('palette list failed'))
      .mockResolvedValueOnce({
        points: [{ source: 'palitra', lat: 50.45, lng: 30.52, label: 'BRAVO' }],
        etalons: ['BRAVO'],
        lookupError: null,
      });

    await act(async () => {
      root.render(<MessageCardCoordinateAttachment msg={msg} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Не вдалося завантажити точку мапи');
    const retry = container.querySelector(
      'button[aria-label="Повторити завантаження координат"]',
    ) as HTMLButtonElement;
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

  // @test-scope regression: https://github.com/echoua/echo/issues/3324
  it('renders an inline retry error when the resolver rejects for a point lookup failure', async () => {
    const msg = { pointTokens: [] } as InboxMessage;
    vi.mocked(resolveMessageCoordinatePreview)
      .mockRejectedValueOnce(new Error('point search failed'))
      .mockResolvedValueOnce({
        points: [{ source: 'palitra', lat: 50.45, lng: 30.52, label: 'BRAVO' }],
        etalons: ['BRAVO'],
        lookupError: null,
      });

    await act(async () => {
      root.render(<MessageCardCoordinateAttachment msg={msg} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Не вдалося завантажити точку мапи');

    const retry = container.querySelector(
      'button[aria-label="Повторити завантаження координат"]',
    ) as HTMLButtonElement;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('button[aria-label="Open BRAVO on map"]')).not.toBeNull();
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3324
  it('ECHO-3324 keeps partial lookup errors inside the valid coordinate tile', async () => {
    const msg = { pointTokens: [] } as InboxMessage;
    vi.mocked(resolveMessageCoordinatePreview).mockResolvedValue({
      points: [
        { source: 'palitra', lat: 50.45, lng: 30.52, label: 'BRAVO' },
        { source: 'palitra', lat: 50.46, lng: 30.53, label: 'CHARLIE' },
      ],
      etalons: ['BRAVO', 'CHARLIE'],
      lookupError: new CoordinatePreviewLookupError(
        'point-search',
        new Error('point search failed'),
      ),
    });

    await act(async () => {
      root.render(<MessageCardCoordinateAttachment msg={msg} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const host = container.querySelector('[data-coordinate-preview-root]');
    const tile = container.querySelector('[data-coordinate-preview-tile]');
    const overlay = container.querySelector('[data-coordinate-preview-retry-overlay]');
    expect(host?.contains(tile)).toBe(true);
    expect(host?.contains(overlay)).toBe(true);
    expect(container.querySelector('[data-coordinate-preview-count]')?.textContent).toBe('2');
    expect(overlay?.getAttribute('title')).toBe('point search failed');
    expect(
      overlay?.querySelector('button[aria-label="Повторити завантаження координат"]'),
    ).not.toBeNull();
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3324
  it('keeps successful document points visible while retrying a failed document request', async () => {
    const retry = createDeferred<{
      points: { source: 'document'; lat: number; lng: number; label: string }[];
      etalons: string[];
      lookupError: null;
    }>();
    vi.mocked(resolveMessageCoordinatePreview)
      .mockResolvedValueOnce({
        points: [
          { source: 'document', lat: 47.1, lng: 35.2, label: 'Дамба' },
          { source: 'document', lat: 47.2, lng: 35.3, label: 'Міст' },
        ],
        etalons: [],
        lookupError: new CoordinatePreviewLookupError(
          'document-coordinates',
          new Error('document failed'),
        ),
      })
      .mockImplementationOnce(() => retry.promise);

    await act(async () => {
      root.render(<MessageCardCoordinateAttachment msg={{ media: [] } as InboxMessage} />);
      await Promise.resolve();
    });

    const retryButton = container.querySelector(
      'button[aria-label="Повторити завантаження координат"]',
    ) as HTMLButtonElement;
    const host = container.querySelector('[data-coordinate-preview-root]');
    expect(host?.contains(container.querySelector('[data-coordinate-preview-tile]'))).toBe(true);
    expect(host?.contains(container.querySelector('[data-coordinate-preview-retry-overlay]'))).toBe(
      true,
    );
    expect(container.querySelector('[data-coordinate-preview-count]')?.textContent).toBe('2');

    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('button[aria-label="Open Дамба on map"]')).not.toBeNull();
    expect(retryButton.disabled).toBe(true);

    await act(async () => {
      retry.resolve({
        points: [
          { source: 'document', lat: 47.1, lng: 35.2, label: 'Дамба' },
          { source: 'document', lat: 47.2, lng: 35.3, label: 'Міст' },
        ],
        etalons: [],
        lookupError: null,
      });
      await Promise.resolve();
    });

    expect(
      container.querySelector('button[aria-label="Повторити завантаження координат"]'),
    ).toBeNull();
    expect(container.querySelector('button[aria-label="Open Дамба on map"]')).not.toBeNull();
  });

  // @test-scope safeguard: prevents a missing coordinate preview from presenting a false attachment tile.
  it('stays silent for a genuine preview miss', async () => {
    const msg = { pointTokens: [] } as InboxMessage;
    vi.mocked(resolveMessageCoordinatePreview).mockResolvedValue(null);

    await act(async () => {
      root.render(<MessageCardCoordinateAttachment msg={msg} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toBe('');
  });

  // @test-scope safeguard: prevents a stale coordinate lookup failure from replacing the current message preview.
  it('ignores stale async errors after the message changes', async () => {
    const first = createDeferred<never>();
    const second = createDeferred<{
      points: { source: 'palitra'; lat: number; lng: number; label: string }[];
      etalons: string[];
      lookupError: null;
    } | null>();

    vi.mocked(resolveMessageCoordinatePreview)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const firstMsg = { pointTokens: [], text: 'first message' } as InboxMessage;
    const secondMsg = { pointTokens: [], text: 'second message' } as InboxMessage;

    await act(async () => {
      root.render(<MessageCardCoordinateAttachment msg={firstMsg} />);
    });

    await act(async () => {
      root.render(<MessageCardCoordinateAttachment msg={secondMsg} />);
    });

    await act(async () => {
      first.reject(new Error('stale failure'));
      await Promise.resolve();
    });

    await act(async () => {
      second.resolve({
        points: [{ source: 'palitra', lat: 50.45, lng: 30.52, label: 'BRAVO' }],
        etalons: ['BRAVO'],
        lookupError: null,
      });
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Не вдалося завантажити точку мапи');
    expect(container.querySelector('button[aria-label="Open BRAVO on map"]')).not.toBeNull();
  });
});
