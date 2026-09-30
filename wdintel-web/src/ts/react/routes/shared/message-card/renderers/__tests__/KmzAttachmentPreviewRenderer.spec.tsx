/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  getKmzAttachmentConversionStatus: vi.fn(),
  getKmzAttachmentPreview: vi.fn(),
  getNativeKmlAttachmentPreview: vi.fn(),
  retryKmzAttachmentConversion: vi.fn(),
  kmzAttachmentConversionDownloadUrl: vi.fn(),
}));

vi.mock('../../../../../services/api/kmz-attachment-conversion', () => apiMock);
vi.mock('../../KmzAttachmentPreviewMap', () => ({
  KmzAttachmentPreviewMap: () => <div data-preview-map />,
}));
vi.mock('../../CoordinateMapPreviewControls', () => ({
  CoordinateMapPreviewControls: () => <div data-preview-controls />,
}));
vi.mock('../../attachment-preview/MessageCardAttachmentPreviewHeader', () => ({
  MessageCardAttachmentPreviewHeader: ({ overflowAction }: { overflowAction?: ReactNode }) => (
    <div data-overflow={String(overflowAction != null)} data-preview-header>
      {overflowAction}
    </div>
  ),
}));
vi.mock('../../attachment-preview/MessageCardAttachmentPreviewLayout', () => ({
  MessageCardAttachmentPreviewLayout: ({
    header,
    stage,
  }: {
    header: ReactNode;
    stage: ReactNode;
  }) => (
    <>
      {header}
      {stage}
    </>
  ),
}));
vi.mock('../../../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify: vi.fn() }),
}));

import { KmzAttachmentPreviewRenderer } from '../KmzAttachmentPreviewRenderer';

const navigation = { index: 0, count: 1, onPrevious: vi.fn(), onNext: vi.fn() };
const preview = { points: [], lineStrings: [], polygons: [] };

describe('KmzAttachmentPreviewRenderer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getNativeKmlAttachmentPreview.mockResolvedValue(preview);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads a native KML preview directly without scheduling or polling conversion', async () => {
    await act(async () => {
      root.render(
        <KmzAttachmentPreviewRenderer
          source={{
            mediaId: 'native-kml',
            originalHref: '/api/messenger/media/native-kml',
            fileName: 'map.kml',
            initialStatus: 'done',
            nativeFormat: 'kml',
            nativePreview: true,
            previewStatus: 'ready',
          }}
          navigation={navigation}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(apiMock.getNativeKmlAttachmentPreview).toHaveBeenCalled());
    expect(apiMock.getNativeKmlAttachmentPreview).toHaveBeenCalledWith('native-kml', {
      signal: expect.any(AbortSignal),
    });
    expect(apiMock.getKmzAttachmentConversionStatus).not.toHaveBeenCalled();
    expect(apiMock.getKmzAttachmentPreview).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Додаткові завантаження"]')).toBeNull();
  });

  it('does not request an oversized native source and keeps its original download available', async () => {
    await act(async () => {
      root.render(
        <KmzAttachmentPreviewRenderer
          source={{
            mediaId: 'large-kmz',
            originalHref: '/api/messenger/media/large-kmz',
            fileName: 'large.kmz',
            initialStatus: 'done',
            nativeFormat: 'kmz',
            nativePreview: true,
            previewStatus: 'limit_exceeded',
          }}
          navigation={navigation}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(apiMock.getNativeKmlAttachmentPreview).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Перевищено ліміт попереднього перегляду');
  });

  it('requeues a failed conversion before polling its status again', async () => {
    apiMock.getKmzAttachmentConversionStatus.mockResolvedValue({
      status: 'error',
      error: 'worker failed',
      convertedFileName: null,
    });
    apiMock.retryKmzAttachmentConversion.mockResolvedValue({ status: 'pending' });

    await act(async () => {
      root.render(
        <KmzAttachmentPreviewRenderer
          source={{
            mediaId: 'converted-source',
            originalHref: '/api/messenger/media/converted-source',
            fileName: 'source.gpx',
            initialStatus: 'pending',
          }}
          navigation={navigation}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(apiMock.getKmzAttachmentConversionStatus).toHaveBeenCalled());
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Повторити',
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });

    expect(apiMock.retryKmzAttachmentConversion).toHaveBeenCalledWith('converted-source');
    await vi.waitFor(() =>
      expect(apiMock.getKmzAttachmentConversionStatus).toHaveBeenCalledTimes(2),
    );
  });

  it('offers a completed converted KMZ only through the secondary download menu', async () => {
    apiMock.getKmzAttachmentConversionStatus.mockResolvedValue({
      status: 'done',
      error: null,
      convertedFileName: 'source_converted.kmz',
    });
    apiMock.getKmzAttachmentPreview.mockResolvedValue(preview);
    apiMock.kmzAttachmentConversionDownloadUrl.mockReturnValue('/converted/source.kmz');

    await act(async () => {
      root.render(
        <KmzAttachmentPreviewRenderer
          source={{
            mediaId: 'converted-source',
            originalHref: '/api/messenger/media/converted-source',
            fileName: 'source.gpx',
            initialStatus: 'done',
          }}
          navigation={navigation}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(apiMock.getKmzAttachmentPreview).toHaveBeenCalled());
    expect(container.querySelector('[data-preview-header]')?.getAttribute('data-overflow')).toBe(
      'true',
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Додаткові завантаження"]')).not.toBeNull(),
    );
    expect(container.querySelector('[aria-label="Завантажити конвертований KMZ"]')).toBeNull();
  });
});
