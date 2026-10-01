/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getStatus: vi.fn(),
  retry: vi.fn(),
  worker: vi.fn(),
  fetch: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@mui/material', () => ({
  Box: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  CircularProgress: () => <span>spinner</span>,
  IconButton: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  MenuItem: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  Stack: ({ children }: any) => <div>{children}</div>,
  Tooltip: ({ children }: any) => <>{children}</>,
  Typography: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));
vi.mock('@mui/icons-material/MoreVert', () => ({ default: () => <span>more</span> }));
vi.mock('../../../../../components/PowerAlert', () => ({
  PowerAlert: ({ children, action }: any) => (
    <div role="alert">
      {children}
      {action}
    </div>
  ),
}));
vi.mock('../../../../../components/PowerMenu', () => ({
  PowerMenu: ({ children, open }: any) => (open ? <div>{children}</div> : null),
}));
vi.mock('../../../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify: api.notify }),
}));
vi.mock('../../../../../services/api/kmz-attachment-conversion', () => ({
  getKmzAttachmentConversionStatus: api.getStatus,
  kmzAttachmentConversionDownloadUrl: (id: string) => `/converted/${id}`,
  retryKmzAttachmentConversion: api.retry,
}));
vi.mock('../../../../../services/api/client', () => ({ isAbortError: () => false }));
vi.mock('../../document-preview-utils', () => ({ fetchCachedDocumentResponse: api.fetch }));
vi.mock('../../workers/worker-client', () => ({ runWorkerTask: api.worker }));
vi.mock('../../KmzAttachmentPreviewMap', () => ({
  KmzAttachmentPreviewMap: () => <div data-testid="map" />,
}));
vi.mock('../../CoordinateMapPreviewControls', () => ({ CoordinateMapPreviewControls: () => null }));
vi.mock('../../attachment-preview/MessageCardAttachmentPreviewLayout', () => ({
  MessageCardAttachmentPreviewLayout: ({ header, stage }: any) => (
    <div>
      {header}
      {stage}
    </div>
  ),
}));
vi.mock('../../attachment-preview/MessageCardAttachmentPreviewHeader', () => ({
  MessageCardAttachmentPreviewHeader: ({ download, overflowAction, status }: any) => (
    <div>
      <a data-testid="original" href={download.href} download={download.fileName} />
      {status}
      {overflowAction}
    </div>
  ),
}));

import { KmzAttachmentPreviewRenderer } from '../KmzAttachmentPreviewRenderer';
import type { KmzAttachmentPreviewSource } from '../../attachment-preview/message-card-preview.types';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const navigation = { hasPrevious: false, hasNext: false, onPrevious: vi.fn(), onNext: vi.fn() };
const nativeSource = {
  mediaId: 'native',
  fileName: 'route.kml',
  contentType: 'application/vnd.google-earth.kml+xml',
  originalHref: '/original/native',
  initialStatus: 'pending' as const,
};
const convertedSource = {
  mediaId: 'converted',
  fileName: 'route.gpx',
  contentType: 'application/gpx+xml',
  originalHref: '/original/converted',
  initialStatus: 'pending' as const,
};

async function render(source: KmzAttachmentPreviewSource = nativeSource) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <KmzAttachmentPreviewRenderer source={source} navigation={navigation} onClose={vi.fn()} />,
    );
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

describe('KmzAttachmentPreviewRenderer', () => {
  it('loads a native document and keeps its original download', async () => {
    api.getStatus.mockResolvedValue({ status: 'pending', convertedFileName: null });
    api.fetch.mockResolvedValue({ buffer: new ArrayBuffer(1) });
    api.worker.mockResolvedValue({
      points: [{ coords: { lat: 50, lng: 30 } }],
      lineStrings: [],
      polygons: [],
    });

    await render();
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="map"]')).not.toBeNull());

    expect(api.fetch).toHaveBeenCalledWith(
      '/original/native',
      expect.any(Number),
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(host?.querySelector('[data-testid="original"]')?.getAttribute('href')).toBe(
      '/original/native',
    );
    expect(api.getStatus).toHaveBeenCalledWith('native', { signal: expect.any(AbortSignal) });
  });

  it('keeps a native KML map independent of a failed conversion job', async () => {
    api.getStatus
      .mockResolvedValueOnce({ status: 'error', error: 'conversion failed' })
      .mockResolvedValueOnce({ status: 'done', convertedFileName: 'route_converted.kmz' });
    api.retry.mockResolvedValue(undefined);
    api.fetch.mockResolvedValue({ buffer: new ArrayBuffer(1) });
    api.worker.mockResolvedValue({
      points: [{ coords: { lat: 50, lng: 30 } }],
      lineStrings: [],
      polygons: [],
    });

    await render({ ...nativeSource, initialStatus: 'error' });
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="map"]')).not.toBeNull());
    const map = host?.querySelector('[data-testid="map"]');
    await vi.waitFor(() =>
      expect(host?.querySelector('[aria-label="Повторити конвертацію KMZ"]')).not.toBeNull(),
    );
    expect(api.notify).not.toHaveBeenCalled();
    await act(async () =>
      (
        host?.querySelector('[aria-label="Повторити конвертацію KMZ"]') as HTMLButtonElement
      ).click(),
    );
    await vi.waitFor(() => expect(api.retry).toHaveBeenCalledWith('native'));
    await vi.waitFor(() =>
      expect(host?.querySelector('[aria-label="Додаткові завантаження"]')).not.toBeNull(),
    );
    expect(host?.querySelector('[data-testid="map"]')).toBe(map);
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed conversion download available for oversized KML', async () => {
    api.getStatus.mockResolvedValue({ status: 'done', convertedFileName: 'route_converted.kmz' });
    await render({ ...nativeSource, sizeBytes: 25 * 1024 * 1024 + 1 });

    await vi.waitFor(() => expect(host?.textContent).toContain('Перевищено ліміт'));
    await vi.waitFor(() =>
      expect(host?.querySelector('[aria-label="Додаткові завантаження"]')).not.toBeNull(),
    );
    expect(api.fetch).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-testid="original"]')?.getAttribute('href')).toBe(
      '/original/native',
    );
  });

  it('loads converted KMZ and exposes separate original and converted downloads', async () => {
    api.getStatus.mockResolvedValue({ status: 'done', convertedFileName: 'route_converted.kmz' });
    api.fetch.mockResolvedValue({ buffer: new ArrayBuffer(1) });
    api.worker.mockResolvedValue({
      points: [{ coords: { lat: 50, lng: 30 } }],
      lineStrings: [],
      polygons: [],
    });

    await render(convertedSource);
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="map"]')).not.toBeNull());
    await act(async () =>
      (host?.querySelector('[aria-label="Додаткові завантаження"]') as HTMLButtonElement).click(),
    );

    expect(host?.querySelector('[data-testid="original"]')?.getAttribute('href')).toBe(
      '/original/converted',
    );
    expect(host?.querySelector('a[href="/converted/converted"]')?.getAttribute('download')).toBe(
      'route_converted.kmz',
    );
  });

  it('retries a failed native fetch', async () => {
    api.fetch
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValue({ buffer: new ArrayBuffer(1) });
    api.worker.mockResolvedValue({
      points: [{ coords: { lat: 50, lng: 30 } }],
      lineStrings: [],
      polygons: [],
    });

    await render();
    await vi.waitFor(() => expect(host?.textContent).toContain('network failed'));
    await act(async () =>
      (
        Array.from(host?.querySelectorAll('button') ?? []).find(
          (button) => button.textContent === 'Повторити',
        ) as HTMLButtonElement
      ).click(),
    );
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="map"]')).not.toBeNull());
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a failed conversion until its completed KMZ replaces the error', async () => {
    api.getStatus
      .mockResolvedValueOnce({ status: 'error', error: 'conversion failed' })
      .mockResolvedValueOnce({ status: 'done', convertedFileName: 'route_converted.kmz' });
    api.retry.mockResolvedValue(undefined);
    api.fetch.mockResolvedValue({ buffer: new ArrayBuffer(1) });
    api.worker.mockResolvedValue({
      points: [{ coords: { lat: 50, lng: 30 } }],
      lineStrings: [],
      polygons: [],
    });

    await render(convertedSource);
    await vi.waitFor(() => expect(host?.textContent).toContain('conversion failed'));
    await act(async () =>
      (
        Array.from(host?.querySelectorAll('button') ?? []).find(
          (button) => button.textContent === 'Повторити',
        ) as HTMLButtonElement
      ).click(),
    );
    await vi.waitFor(() => expect(api.retry).toHaveBeenCalledWith('converted'));
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="map"]')).not.toBeNull());
    expect(api.fetch).toHaveBeenCalledWith(
      '/converted/converted',
      expect.any(Number),
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it('retries fetching a completed converted KMZ after a preview failure', async () => {
    api.getStatus.mockResolvedValue({ status: 'done', convertedFileName: 'route_converted.kmz' });
    api.fetch.mockRejectedValueOnce(new Error('network failed')).mockResolvedValue({
      buffer: new ArrayBuffer(1),
    });
    api.worker.mockResolvedValue({
      points: [{ coords: { lat: 50, lng: 30 } }],
      lineStrings: [],
      polygons: [],
    });

    await render(convertedSource);
    await vi.waitFor(() => expect(host?.textContent).toContain('network failed'));
    await act(async () =>
      (
        Array.from(host?.querySelectorAll('button') ?? []).find(
          (button) => button.textContent === 'Повторити',
        ) as HTMLButtonElement
      ).click(),
    );
    await vi.waitFor(() => expect(host?.querySelector('[data-testid="map"]')).not.toBeNull());
    expect(api.fetch).toHaveBeenCalledTimes(2);
    expect(api.retry).not.toHaveBeenCalled();
  });

  it('stops a stalled file fetch with a retryable timeout error', async () => {
    vi.useFakeTimers();
    try {
      api.getStatus.mockResolvedValue({ status: 'pending', convertedFileName: null });
      let requestSignal: AbortSignal | undefined;
      api.fetch.mockImplementation((_: string, __: number, ___: string, signal: AbortSignal) => {
        requestSignal = signal;
        return new Promise(() => undefined);
      });

      await render();
      await act(async () => vi.advanceTimersByTimeAsync(20_000));

      expect(requestSignal?.aborted).toBe(true);
      expect(host?.textContent).toContain('Час очікування');
      expect(host?.textContent).toContain('KMZ_REQUEST_TIMEOUT');
      expect(
        Array.from(host?.querySelectorAll('button') ?? []).map((button) => button.textContent),
      ).toContain('Повторити');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a stalled conversion status request with a retryable timeout error', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      api.getStatus.mockImplementation((_: string, { signal }: { signal: AbortSignal }) => {
        requestSignal = signal;
        return new Promise(() => undefined);
      });

      await render(convertedSource);
      await act(async () => vi.advanceTimersByTimeAsync(20_000));

      expect(requestSignal?.aborted).toBe(true);
      expect(host?.textContent).toContain('Час очікування');
      expect(host?.textContent).toContain('KMZ_REQUEST_TIMEOUT');
      expect(host?.querySelector('button')?.textContent).toBe('Повторити');
    } finally {
      vi.useRealTimers();
    }
  });
});
