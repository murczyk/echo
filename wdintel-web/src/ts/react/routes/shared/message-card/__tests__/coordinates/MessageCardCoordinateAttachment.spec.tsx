/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, Tag } from '../../../../../../../Bindings';
import { getTileLayers } from '../../../../../../web-components/analysis-map/tile-layers';
import { CoordinateAttachmentThumbnail } from '../../CoordinateAttachmentThumbnail';
import { CoordinatePreviewMapSurface } from '../../CoordinatePreviewMapSurface';
import { MessageCardCoordinateAttachment } from '../../MessageCardCoordinateAttachment';
import {
  CoordinatePreviewLookupError,
  resolveMessageCoordinatePreview,
} from '../../message-coordinate-preview';

vi.mock('../../message-coordinate-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../message-coordinate-preview')>();
  return {
    ...actual,
    resolveMessageCoordinatePreview: vi.fn(),
  };
});

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewProvider', () => ({
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

vi.mock('../../../../../../web-components/analysis-map/tile-layers', () => ({
  DEFAULT_BASE_LAYER_ID: 'esriWorldImagery',
  getTileLayers: vi.fn(() => ({
    esriWorldImagery: { addTo: vi.fn(), on: vi.fn(), off: vi.fn() },
    googleHybrid: {
      addTo: vi.fn(),
    },
    openStreetMap: { addTo: vi.fn() },
  })),
}));

vi.mock('leaflet', () => {
  class GridLayer {
    private handlers = new Map<string, Set<() => void>>();

    addTo() {
      return this;
    }

    on(event: string, handler: () => void) {
      this.handlers.set(event, new Set([...(this.handlers.get(event) ?? []), handler]));
      return this;
    }

    off(event: string, handler?: () => void) {
      if (handler == null) this.handlers.delete(event);
      else this.handlers.get(event)?.delete(handler);
      return this;
    }

    fire(event: string) {
      this.handlers.get(event)?.forEach((handler) => handler());
      return this;
    }
  }
  class LayerGroup {
    eachLayer() {}
  }
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
    getBounds() {
      return { contains: vi.fn(() => true) };
    },
    remove: vi.fn(),
  };
  const marker = {
    bindTooltip: vi.fn(() => marker),
    addTo() {
      return marker;
    },
    remove: vi.fn(),
  };
  const rectangle = {
    addTo() {
      return rectangle;
    },
    remove: vi.fn(),
  };

  return {
    GridLayer,
    LayerGroup,
    map: vi.fn(() => map),
    circleMarker: vi.fn(() => marker),
    rectangle: vi.fn(() => rectangle),
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
    vi.useRealTimers();
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
    expect(container.querySelector('[data-coordinate-preview-count]')?.textContent).toBe('1');
    expect(container.textContent).not.toContain('50.45044, 30.52355');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      button?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-coordinate-hover-preview]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Відкрити на мапі');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('data-lat')).toBe('50.45044');
    expect(dialog?.getAttribute('data-lng')).toBe('30.52355');
  });

  it('keeps the map preview mounted when an equivalent message object is reloaded', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 180,
      height: 120,
    } as DOMRect);
    const leaflet = await import('leaflet');
    const buildMessage = () =>
      ({
        text: '50.45044, 30.52355',
        coords: null,
        coordsWithLocality: [],
        media: [],
        pointTokens: [{ etalon: 'ALPHA' }],
        tags: [1],
      }) as InboxMessage;
    const buildTagsMap = () => ({ 1: { id: 1, isPalitra: true } }) as Record<number, Tag>;
    vi.mocked(resolveMessageCoordinatePreview).mockResolvedValue({
      points: [{ source: 'direct', lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355' }],
      etalons: [],
      lookupError: null,
    });

    await act(async () => {
      root.render(
        <MessageCardCoordinateAttachment msg={buildMessage()} tagsMap={buildTagsMap()} />,
      );
      await Promise.resolve();
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    const previewButton = container.querySelector(
      'button[aria-label="Open 50.45044, 30.52355 on map"]',
    );
    expect(previewButton).not.toBeNull();
    expect(resolveMessageCoordinatePreview).toHaveBeenCalledTimes(1);
    expect(leaflet.map).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <MessageCardCoordinateAttachment msg={buildMessage()} tagsMap={buildTagsMap()} />,
      );
      await Promise.resolve();
    });

    expect(resolveMessageCoordinatePreview).toHaveBeenCalledTimes(1);
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="Open 50.45044, 30.52355 on map"]')).toBe(
      previewButton,
    );
    rectSpy.mockRestore();
  });

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
    expect(container.textContent).toContain('9');
    expect(container.textContent).not.toContain('точок');
    expect(container.textContent).not.toContain('+1');
    expect(container.querySelectorAll('[data-coordinate-preview-count]')).toHaveLength(1);
    expect(container.querySelector('[data-coordinate-preview-count]')?.textContent).toBe('9');
    const button = container.querySelector('button[aria-label="Open BRAVO on map"]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('style')).toContain('width: 100%');
    expect(button?.getAttribute('style')).toContain('height: 100%');
    expect(button?.getAttribute('style')).toContain('max-width: none');
    expect(button?.getAttribute('style')).toContain('flex-grow: 0');
    expect(button?.getAttribute('style')).toContain('flex-shrink: 0');
    expect(button?.getAttribute('style')).toContain('flex-basis: auto');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      button?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-coordinate-hover-preview]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Відкрити на мапі');
    expect(container.textContent).not.toContain('+1');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[role="dialog"]')?.getAttribute('data-index')).toBe('0');
    expect(container.querySelector('[role="dialog"]')?.getAttribute('data-attachment-count')).toBe(
      '1',
    );
  });

  it('updates the thumbnail without recreating the map when a coordinate is removed', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 180,
      height: 120,
    } as DOMRect);
    const leaflet = await import('leaflet');
    const points = [
      { source: 'direct' as const, lat: 50.45, lng: 30.52, label: 'BRAVO' },
      { source: 'direct' as const, lat: 50.46, lng: 30.53, label: 'CHARLIE' },
    ];

    await act(async () => {
      root.render(<CoordinateAttachmentThumbnail points={points} onOpen={vi.fn()} />);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(leaflet.map).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ preferCanvas: false }),
    );

    await act(async () => {
      root.render(<CoordinateAttachmentThumbnail points={[points[1]]} onOpen={vi.fn()} />);
      await Promise.resolve();
    });

    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(leaflet.circleMarker).toHaveBeenCalledTimes(3);
    expect(leaflet.circleMarker).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ interactive: false }),
    );
    expect(leaflet.circleMarker.mock.results[0]?.value.bindTooltip).not.toHaveBeenCalled();
    rectSpy.mockRestore();
  });

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

    const retry = container.querySelector(
      'button[aria-label="Повторити завантаження координат"]',
    ) as HTMLButtonElement;
    expect(retry).not.toBeNull();
    expect(retry.getAttribute('aria-describedby')).not.toBeNull();
    expect(container.querySelector('[data-coordinate-preview-tile]')).toBeNull();

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

    const firstMsg = { pointTokens: [], text: '50.45, 30.52' } as InboxMessage;
    const secondMsg = { pointTokens: [], text: '50.46, 30.53' } as InboxMessage;

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

  it('ECHO-3380 opens the medium preview only after sustained mouse hover and closes after leaving both surfaces', async () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    await act(async () => {
      root.render(
        <CoordinateAttachmentThumbnail
          points={[{ source: 'direct', lat: 50.45, lng: 30.52, label: 'BRAVO' }]}
          onOpen={onOpen}
        />,
      );
    });
    const trigger = container.querySelector('button[aria-label="Open BRAVO on map"]');
    expect(document.body.querySelector('[data-coordinate-hover-preview]')).toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      vi.advanceTimersByTime(599);
    });
    expect(document.body.querySelector('[data-coordinate-hover-preview]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    const preview = document.body.querySelector('[data-coordinate-hover-preview]');
    expect(preview).not.toBeNull();
    expect(trigger?.getAttribute('aria-describedby')).toBe(preview?.id);

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
      preview?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      vi.advanceTimersByTime(120);
    });
    expect(document.body.querySelector('[data-coordinate-hover-preview]')).not.toBeNull();

    await act(async () => {
      preview?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
      vi.advanceTimersByTime(120);
    });
    expect(document.body.querySelector('[data-coordinate-hover-preview]')).toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it.each(['mouse', 'pen'] as const)(
    'ECHO-3380 opens the medium preview for a %s pointer when hover none matches',
    async (pointerType) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({ matches: true })),
      );
      await act(async () => {
        root.render(
          <CoordinateAttachmentThumbnail
            points={[{ source: 'direct', lat: 50.45, lng: 30.52, label: 'BRAVO' }]}
            onOpen={vi.fn()}
          />,
        );
      });
      const trigger = container.querySelector('button[aria-label="Open BRAVO on map"]');
      const pointerEnter = new Event('pointerover', { bubbles: true });
      Object.defineProperty(pointerEnter, 'pointerType', { value: pointerType });
      await act(async () => {
        trigger?.dispatchEvent(pointerEnter);
        vi.advanceTimersByTime(600);
      });
      expect(document.body.querySelector('[data-coordinate-hover-preview]')).not.toBeNull();
    },
  );

  it('ECHO-3380 opens the medium preview on focus but rejects touch pointer interaction', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    await act(async () => {
      root.render(
        <CoordinateAttachmentThumbnail
          points={[{ source: 'direct', lat: 50.45, lng: 30.52, label: 'BRAVO' }]}
          onOpen={vi.fn()}
        />,
      );
    });
    const trigger = container.querySelector('button[aria-label="Open BRAVO on map"]');
    const touchEnter = new Event('pointerover', { bubbles: true });
    Object.defineProperty(touchEnter, 'pointerType', { value: 'touch' });
    await act(async () => {
      trigger?.dispatchEvent(touchEnter);
      vi.advanceTimersByTime(600);
    });
    expect(document.body.querySelector('[data-coordinate-hover-preview]')).toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(document.body.querySelector('[data-coordinate-hover-preview]')).not.toBeNull();
  });

  it('ECHO-3380 keeps the map loading until its primary tile succeeds', async () => {
    const leaflet = await import('leaflet');
    const primaryLayer = new leaflet.GridLayer();
    vi.mocked(getTileLayers).mockReturnValue({ esriWorldImagery: primaryLayer } as never);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 180,
      height: 120,
    } as DOMRect);
    await act(async () => {
      root.render(
        <CoordinatePreviewMapSurface
          points={[{ source: 'direct', lat: 50.45, lng: 30.52, label: 'BRAVO' }]}
          mode="thumbnail"
        />,
      );
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(container.querySelector('.coordinate-preview-map-skeleton')).not.toBeNull();
    await act(async () => {
      primaryLayer.fire('tileload');
    });
    expect(container.querySelector('.coordinate-preview-map-skeleton')).toBeNull();
  });

  it('ECHO-3380 renders the map fallback when initialization fails', async () => {
    const leaflet = await import('leaflet');
    vi.mocked(leaflet.map).mockImplementationOnce(() => {
      throw new Error('map unavailable');
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 180,
      height: 120,
    } as DOMRect);
    await act(async () => {
      root.render(
        <CoordinatePreviewMapSurface
          points={[{ source: 'direct', lat: 50.45, lng: 30.52, label: 'BRAVO' }]}
          mode="thumbnail"
        />,
      );
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(container.textContent).toContain('Не вдалося завантажити мапу');
  });

  it('ECHO-3380 removes a partially initialized map when the base layer fails', async () => {
    const leaflet = await import('leaflet');
    const primaryLayer = new leaflet.GridLayer();
    const addTo = vi.spyOn(primaryLayer, 'addTo').mockImplementation(() => {
      throw new Error('base layer unavailable');
    });
    const off = vi.spyOn(primaryLayer, 'off');
    vi.mocked(getTileLayers).mockReturnValue({ esriWorldImagery: primaryLayer } as never);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 180,
      height: 120,
    } as DOMRect);

    await act(async () => {
      root.render(
        <CoordinatePreviewMapSurface
          points={[{ source: 'direct', lat: 50.45, lng: 30.52, label: 'BRAVO' }]}
          mode="thumbnail"
        />,
      );
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(addTo).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Не вдалося завантажити мапу');
    expect(leaflet.map).toHaveBeenCalledOnce();
    const map = vi.mocked(leaflet.map).mock.results[0]?.value;
    expect(map.remove).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledWith('tileload', expect.any(Function));
    expect(off).toHaveBeenCalledWith('load', expect.any(Function));

    expect(() => root.unmount()).not.toThrow();
    expect(map.remove).toHaveBeenCalledOnce();
  });
});
