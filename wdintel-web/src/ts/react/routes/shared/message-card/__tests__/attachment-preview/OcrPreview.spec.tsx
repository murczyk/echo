/**
 * @vitest-environment happy-dom
 */
import { createElement, forwardRef, type ElementType, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getMediaOcrStatus, getMediaSummary, retryMediaSummary, mapCoordinates, useMediaQueryMock } =
  vi.hoisted(() => ({
    getMediaOcrStatus: vi.fn(),
    getMediaSummary: vi.fn(),
    retryMediaSummary: vi.fn(),
    mapCoordinates: vi.fn(),
    useMediaQueryMock: vi.fn().mockReturnValue(false),
  }));

vi.mock('@mui/material', () => ({
  alpha: () => 'transparent',
  Box: forwardRef<
    HTMLElement,
    { component?: ElementType; children?: ReactNode; sx?: unknown } & Record<string, unknown>
  >(function MockBox({ component = 'div', children, sx: _sx, ...props }, ref) {
    return createElement(component, { ...props, ref }, children);
  }),
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  Chip: ({ label }: { label?: ReactNode }) => <span>{label}</span>,
  CircularProgress: () => <span data-progress />,
  IconButton: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  LinearProgress: () => <span data-linear-progress />,
  Skeleton: () => <span data-skeleton />,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SvgIcon: ({ children }: { children?: ReactNode }) => <svg>{children}</svg>,
  Tooltip: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
    <span>
      {children}
      <span data-tooltip-content="true">{title}</span>
    </span>
  ),
  Typography: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
  useMediaQuery: (query: string) => useMediaQueryMock(query),
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ breakpoints: { down: () => '' } }),
}));

vi.mock('@mui/icons-material/Fullscreen', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/FullscreenExit', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/Refresh', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/Visibility', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/Close', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/Description', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/InfoOutlined', () => ({ default: () => <span /> }));

vi.mock('../../../../../services/api/ocr', () => ({ getMediaOcrStatus }));
vi.mock('../../../../../services/api/media-summary', () => ({
  getMediaSummary,
  retryMediaSummary,
}));
vi.mock('../../../../../services/api/location', () => ({ mapCoordinates }));

import {
  getOcrDownloadItems,
  getOcrInfoSections,
  getOcrInfoSeverity,
  OcrPreviewAction,
  OcrSplitPreview,
} from '../../attachment-preview/OcrPreview';
import {
  clearMediaSummaryCache,
  MEDIA_SUMMARY_CACHE_LIMIT,
  MediaSummaryOverlay,
  MessageCardMediaSummary,
  MessageCardMediaSummaryCarousel,
} from '../../attachment-preview/MediaSummaryPreview';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('OcrPreview', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    clearMediaSummaryCache();
  });

  it('exposes exports and quality details only for a completed usable result', () => {
    const degraded = {
      state: 'completed',
      qualityStatus: 'degraded',
      processedPages: 2,
      totalPages: 2,
      lastError: null,
      queueSize: null,
      attempts: 0,
      statusLog: [],
    } as const;
    expect(getOcrDownloadItems('media/id', degraded, 'scan.png')).toHaveLength(4);
    expect(getOcrDownloadItems('media/id', { ...degraded, state: 'queued' }, 'scan.png')).toEqual(
      [],
    );
    expect(getOcrInfoSeverity(degraded)).toBe('warning');
    expect(getOcrInfoSections(degraded)[0]?.status).toEqual({
      label: 'Знижена якість',
      severity: 'warning',
    });
    expect(getOcrInfoSeverity({ ...degraded, qualityStatus: 'failed' })).toBe('error');
  });

  it('keeps the eye action available for pending, completed, and failed results', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <>
          <OcrPreviewAction
            ocr={{
              state: 'completed',
              qualityStatus: 'degraded',
              processedPages: 2,
              totalPages: 2,
              lastError: null,
              queueSize: null,
              attempts: 0,
              statusLog: [],
            }}
            active={false}
            onClick={vi.fn()}
          />
          <OcrPreviewAction
            ocr={{
              state: 'pending',
              qualityStatus: null,
              processedPages: 0,
              totalPages: 0,
              lastError: null,
              queueSize: 2,
              attempts: 0,
              statusLog: [],
            }}
            active={false}
            onClick={vi.fn()}
          />
          <OcrPreviewAction
            ocr={{
              state: 'failed',
              qualityStatus: 'failed',
              processedPages: 1,
              totalPages: 2,
              lastError: 'failed',
              queueSize: null,
              attempts: 3,
              statusLog: [],
            }}
            active={false}
            onClick={vi.fn()}
          />
        </>,
      );
    });

    const buttons = container.querySelectorAll('button');
    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[0]?.getAttribute('aria-label')).toContain('якість знижена');
    expect(buttons[1]?.disabled).toBe(false);
    expect(buttons[1]?.getAttribute('aria-label')).toContain('попереду: 2');
    expect(buttons[2]?.disabled).toBe(false);
    expect(buttons[2]?.getAttribute('aria-label')).toContain('помилкою');
    root.unmount();
  });

  it('shows items ahead and a compact processing log', async () => {
    const submitted = {
      state: 'submitted',
      qualityStatus: null,
      processedPages: 1,
      totalPages: 3,
      lastError: null,
      queueSize: 0,
      attempts: 0,
      statusLog: [{ at: Date.now(), message: 'Передано до OCR-extractor.' }],
    };
    getMediaOcrStatus.mockResolvedValue(submitted);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OcrSplitPreview
          source={<div data-source />}
          mediaId="media-id"
          ocr={submitted}
          visible
          fullPane={false}
          onOcrChange={vi.fn()}
          onFullPaneChange={vi.fn()}
          summary={null}
          summaryVisible={false}
          onSummaryChange={vi.fn()}
          onSummaryVisibleChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Обробляється · попереду: 0');
    expect(container.textContent).toContain('Опрацьовано сторінок: 1 із 3.');
    expect(container.textContent).toContain('Хід обробки');
    expect(container.textContent).toContain('Передано до OCR-extractor.');
    root.unmount();
  });

  it('loads the same-origin OCR endpoint in a sandboxed iframe', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OcrSplitPreview
          source={<div data-source />}
          mediaId="media/id"
          ocr={{
            state: 'completed',
            qualityStatus: 'accepted',
            processedPages: 1,
            totalPages: 1,
            lastError: null,
            queueSize: null,
            attempts: 0,
            statusLog: [],
          }}
          visible
          fullPane={false}
          onOcrChange={vi.fn()}
          onFullPaneChange={vi.fn()}
          summary={null}
          summaryVisible={false}
          onSummaryChange={vi.fn()}
          onSummaryVisibleChange={vi.fn()}
        />,
      );
    });

    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe('/api/messenger/media/media%2Fid/ocr?revision=0');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(container.querySelector('[data-ocr-scroll-container]')).not.toBeNull();
    root.unmount();
  });

  it('refreshes an in-progress result and opens it when completed', async () => {
    getMediaOcrStatus.mockResolvedValueOnce({
      state: 'completed',
      qualityStatus: 'accepted',
      processedPages: 2,
      totalPages: 2,
      lastError: null,
      queueSize: null,
      attempts: 0,
      statusLog: [],
    });
    const onOcrChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OcrSplitPreview
          source={<div data-source />}
          mediaId="media-id"
          ocr={{
            state: 'pending',
            qualityStatus: null,
            processedPages: 0,
            totalPages: 0,
            lastError: null,
            queueSize: 2,
            attempts: 0,
            statusLog: [],
          }}
          visible
          fullPane={false}
          onOcrChange={onOcrChange}
          onFullPaneChange={vi.fn()}
          summary={null}
          summaryVisible={false}
          onSummaryChange={vi.fn()}
          onSummaryVisibleChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(getMediaOcrStatus).toHaveBeenCalledWith('media-id', {
      signal: expect.any(AbortSignal),
    });
    expect(onOcrChange).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'completed', processedPages: 2 }),
    );
    root.unmount();
  });

  it('opens the summary beneath the original pane and restores split view', async () => {
    getMediaSummary.mockResolvedValueOnce({
      state: 'completed',
      summary: 'Короткий опис',
      coordinates: [],
      lastError: null,
      sourceKind: 'ocr_text',
      sourceCharCount: 100,
      aiEngineName: 'Gemma',
      modelName: 'gemma',
    });
    const onFullPaneChange = vi.fn();
    const onSummaryChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OcrSplitPreview
          source={<div data-source />}
          mediaId="media-id"
          ocr={{
            state: 'completed',
            qualityStatus: 'accepted',
            processedPages: 1,
            totalPages: 1,
            lastError: null,
            queueSize: null,
            attempts: 0,
            statusLog: [],
          }}
          visible
          fullPane
          onOcrChange={vi.fn()}
          onFullPaneChange={onFullPaneChange}
          summary={{ state: 'queued', lastError: null, hasCoordinates: false }}
          summaryVisible
          onSummaryChange={onSummaryChange}
          onSummaryVisibleChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(onFullPaneChange).toHaveBeenCalledWith(false);
    expect(getMediaSummary).toHaveBeenCalledWith(
      'media-id',
      { signal: expect.any(AbortSignal) },
      'messenger',
    );
    expect(onSummaryChange).toHaveBeenCalledWith({
      state: 'completed',
      lastError: null,
      hasCoordinates: false,
    });
    expect(container.textContent).toContain('Короткий опис');
    expect(container.textContent).not.toContain('Хто:');
    root.unmount();
  });

  it('renders one locality-aware list item per coordinate and escapes plain text', async () => {
    mapCoordinates.mockResolvedValueOnce([
      {
        coords: { lat: 47.1, lon: 35.2 },
        locality: {
          settlementName: 'Малокатеринівка',
          direction: 'NE',
          region: null,
          country: null,
          distanceM: 2300,
          isRf: false,
        },
      },
      { coords: { lat: 47.2, lon: 35.3 }, locality: null },
    ]);
    getMediaSummary.mockResolvedValueOnce({
      state: 'completed',
      summary: '<script>summary()</script>',
      coordinates: [
        {
          title: '<img src=x onerror=alert(1)>',
          description: '<script>description()</script>',
          plannedMeans: '<svg onload=plannedMeans()>',
          coordinateSystem: 'sk42',
          value: 'X=5291456, Y=6662340',
        },
        {
          title: '<img src=x onerror=alert(1)>',
          description: '<script>description()</script>',
          plannedMeans: '<svg onload=plannedMeans()>',
          coordinateSystem: 'mgrs',
          value: '37U DR 05997 22279',
        },
      ],
      lastError: null,
      sourceKind: 'ocr_text',
      sourceCharCount: 100,
      aiEngineName: 'Gemma',
      modelName: 'gemma',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OcrSplitPreview
          source={<div data-source />}
          mediaId="media-id"
          ocr={null}
          visible={false}
          fullPane={false}
          onOcrChange={vi.fn()}
          onFullPaneChange={vi.fn()}
          summary={{ state: 'completed', lastError: null, hasCoordinates: true }}
          summaryVisible
          onSummaryChange={vi.fn()}
          onSummaryVisibleChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[data-media-summary-completed-layout="split"]')).not.toBeNull();
    expect(container.querySelector('[data-media-summary-coordinate-column="true"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-media-summary-coordinate-item="true"]')).toHaveLength(
      2,
    );
    expect(container.querySelectorAll('[data-media-summary-coordinate-info="true"]')).toHaveLength(
      2,
    );
    expect(container.textContent).toContain('<script>summary()</script>');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.textContent).toContain('<script>description()</script>');
    expect(container.textContent).toContain('<svg onload=plannedMeans()>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('svg[onload]')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent?.match(/<img src=x onerror=alert\(1\)>/g)).toHaveLength(2);
    expect(container.textContent).toContain('СК-42');
    expect(container.textContent).toContain('MGRS');
    expect(container.textContent).toContain('2,3 км на пн-сх від Малокатеринівка');
    expect(mapCoordinates).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('discards an OCR response after navigating to another attachment', async () => {
    const oldResponse = deferred<{
      state: string;
      qualityStatus: null;
      processedPages: number;
      totalPages: number;
      lastError: null;
      queueSize: null;
      attempts: number;
      statusLog: never[];
    }>();
    getMediaOcrStatus
      .mockImplementationOnce(() => oldResponse.promise)
      .mockResolvedValueOnce({
        state: 'completed',
        qualityStatus: 'accepted',
        processedPages: 2,
        totalPages: 2,
        lastError: null,
        queueSize: null,
        attempts: 0,
        statusLog: [],
      });
    const onOcrChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const pending = {
      state: 'pending',
      qualityStatus: null,
      processedPages: 0,
      totalPages: 0,
      lastError: null,
      queueSize: null,
      attempts: 0,
      statusLog: [],
    };
    const render = (mediaId: string) => (
      <OcrSplitPreview
        source={<div data-source={mediaId} />}
        mediaId={mediaId}
        ocr={pending}
        visible
        fullPane={false}
        onOcrChange={onOcrChange}
        onFullPaneChange={vi.fn()}
        summary={null}
        summaryVisible={false}
        onSummaryChange={vi.fn()}
        onSummaryVisibleChange={vi.fn()}
      />
    );

    await act(async () => {
      root.render(render('old-media'));
      await Promise.resolve();
    });
    await act(async () => {
      root.render(render('new-media'));
      await Promise.resolve();
    });
    await act(async () => {
      oldResponse.resolve({
        state: 'failed',
        qualityStatus: null,
        processedPages: 0,
        totalPages: 0,
        lastError: null,
        queueSize: null,
        attempts: 1,
        statusLog: [],
      });
      await Promise.resolve();
    });

    expect(onOcrChange).toHaveBeenCalledTimes(1);
    expect(onOcrChange).toHaveBeenCalledWith(expect.objectContaining({ state: 'completed' }));
    root.unmount();
  });

  it('discards a summary response after navigating to another attachment', async () => {
    const oldResponse = deferred<Record<string, unknown>>();
    getMediaSummary
      .mockImplementationOnce(() => oldResponse.promise)
      .mockResolvedValueOnce({
        state: 'completed',
        summary: 'Новий опис',
        coordinates: [],
        lastError: null,
        sourceKind: 'ocr_text',
        sourceCharCount: 10,
        aiEngineName: 'Gemma',
        modelName: 'gemma',
      });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const status = { state: 'completed', lastError: null, hasCoordinates: false };

    await act(async () => {
      root.render(<MessageCardMediaSummary mediaId="old-media" status={status} />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<MessageCardMediaSummary mediaId="new-media" status={status} />);
      await Promise.resolve();
    });
    await act(async () => {
      oldResponse.resolve({
        state: 'completed',
        summary: 'Старий опис',
        coordinates: [],
        lastError: null,
        sourceKind: 'ocr_text',
        sourceCharCount: 10,
        aiEngineName: 'Gemma',
        modelName: 'gemma',
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Новий опис');
    expect(container.textContent).not.toContain('Старий опис');
    expect(container.querySelector('[data-media-summary-inline="true"]')).not.toBeNull();
    root.unmount();
  });

  it('invalidates a cached terminal summary when its status becomes processing', async () => {
    const requestCount = getMediaSummary.mock.calls.length;
    getMediaSummary
      .mockResolvedValueOnce({
        state: 'completed',
        summary: 'Старий опис',
        coordinates: [],
        lastError: null,
        sourceKind: 'ocr_text',
        sourceCharCount: 10,
        aiEngineName: 'Gemma',
        modelName: 'gemma',
      })
      .mockResolvedValueOnce({
        state: 'queued',
        summary: null,
        coordinates: [],
        lastError: null,
        sourceKind: 'ocr_text',
        sourceCharCount: 0,
        aiEngineName: 'Gemma',
        modelName: 'gemma',
      });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardMediaSummary
          mediaId="media-id"
          status={{ state: 'completed', lastError: null, hasCoordinates: false }}
        />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Старий опис');

    await act(async () => {
      root.render(
        <MessageCardMediaSummary
          mediaId="media-id"
          status={{ state: 'queued', lastError: null, hasCoordinates: false }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getMediaSummary).toHaveBeenCalledTimes(requestCount + 2);
    expect(container.textContent).toContain('Опис у черзі');
    expect(container.textContent).not.toContain('Старий опис');
    root.unmount();
  });

  it('evicts the least recently used summary when the cache limit is reached', async () => {
    const requestCount = getMediaSummary.mock.calls.length;
    for (let index = 0; index < MEDIA_SUMMARY_CACHE_LIMIT + 2; index += 1) {
      getMediaSummary.mockImplementationOnce(async (mediaId: string) => ({
        state: 'completed',
        summary: `Опис ${mediaId}`,
        coordinates: [],
        lastError: null,
        sourceKind: 'ocr_text',
        sourceCharCount: 10,
        aiEngineName: 'Gemma',
        modelName: 'gemma',
      }));
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const status = { state: 'completed', lastError: null, hasCoordinates: false };
    const renderSummary = async (mediaId: string) => {
      await act(async () => {
        root.render(<MessageCardMediaSummary mediaId={mediaId} status={status} />);
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    for (let index = 0; index < MEDIA_SUMMARY_CACHE_LIMIT; index += 1) {
      await renderSummary(`media-${index}`);
    }
    await renderSummary('media-0');
    await renderSummary('media-overflow');
    await renderSummary('media-1');

    expect(getMediaSummary).toHaveBeenCalledTimes(requestCount + MEDIA_SUMMARY_CACHE_LIMIT + 2);
    expect(getMediaSummary).toHaveBeenLastCalledWith(
      'media-1',
      { signal: expect.any(AbortSignal) },
      'messenger',
    );
    root.unmount();
  });

  it('hides technical summary errors from messenger users', async () => {
    const internalError = 'at wdintel-rs/src/media_summary/worker.rs line 166 column 55';
    getMediaSummary.mockRejectedValueOnce(new Error(internalError));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardMediaSummary
          mediaId="media-id"
          status={{
            state: 'failed',
            lastError: internalError,
            hasCoordinates: false,
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Не вдалося завантажити стислий опис');
    expect(container.textContent).not.toContain(internalError);
    root.unmount();
  });

  it('requeues a failed summary instead of only refreshing it', async () => {
    getMediaSummary.mockResolvedValueOnce({
      state: 'failed',
      summary: null,
      coordinates: [],
      lastError: 'Internal server error',
      sourceKind: 'ocr_text',
      sourceCharCount: 10,
      aiEngineName: 'Gemma',
      modelName: 'gemma',
    });
    retryMediaSummary.mockResolvedValueOnce({
      state: 'queued',
      summary: null,
      coordinates: [],
      lastError: null,
      sourceKind: 'ocr_text',
      sourceCharCount: 10,
      aiEngineName: 'Gemma',
      modelName: 'gemma',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardMediaSummary
          mediaId="media-id"
          status={{ state: 'failed', lastError: null, hasCoordinates: false }}
        />,
      );
      await Promise.resolve();
    });
    const retry = container.querySelector<HTMLButtonElement>(
      '[aria-label="Повторити стислий опис"]',
    );
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });

    expect(retryMediaSummary).toHaveBeenCalledWith(
      'media-id',
      { signal: expect.any(AbortSignal) },
      'messenger',
    );
    expect(container.textContent).toContain('Опис у черзі');
    root.unmount();
  });

  it('keeps technical summary errors available in the OCR admin overlay', async () => {
    const internalError = 'media summary response is not valid JSON';
    getMediaSummary.mockResolvedValueOnce({
      state: 'failed',
      summary: null,
      coordinates: [],
      lastError: internalError,
      sourceKind: 'ocr_text',
      sourceCharCount: 10,
      aiEngineName: 'Gemma',
      modelName: 'gemma',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MediaSummaryOverlay
          source={<div />}
          mediaId="media-id"
          status={{
            state: 'failed',
            lastError: internalError,
            hasCoordinates: false,
          }}
          visible
          onStatusChange={vi.fn()}
          onClose={vi.fn()}
          summaryAccess="admin-ocr"
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain(internalError);
    root.unmount();
  });

  it('keeps all fifteen images in a carousel when only five have summaries', async () => {
    getMediaSummary
      .mockResolvedValueOnce({
        state: 'completed',
        summary: 'Перший опис',
        coordinates: [],
        lastError: null,
        sourceKind: 'ocr_text',
        sourceCharCount: 10,
        aiEngineName: 'Gemma',
        modelName: 'gemma',
      })
      .mockResolvedValueOnce({
        state: 'completed',
        summary: 'Другий опис',
        coordinates: [],
        lastError: null,
        sourceKind: 'ocr_text',
        sourceCharCount: 10,
        aiEngineName: 'Gemma',
        modelName: 'gemma',
      });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardMediaSummaryCarousel
          media={[
            ...Array.from({ length: 15 }, (_, index) => ({
              id: `image-${index + 1}`,
              summary:
                index >= 3 && index < 8
                  ? { state: 'completed', lastError: null, hasCoordinates: false }
                  : null,
            })),
          ]}
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelectorAll('[data-media-summary-inline="true"]')).toHaveLength(1);
    expect(container.textContent).toContain('4/15');
    expect(container.textContent).toContain('Перший опис');
    const previous = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Попередній стислий опис"]',
    );
    const next = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Наступний стислий опис"]',
    );
    expect(previous?.disabled).toBe(false);
    expect(next?.disabled).toBe(false);

    await act(async () => {
      next?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('5/15');
    expect(container.textContent).toContain('Другий опис');
    expect(container.textContent).not.toContain('Перший опис');
    expect(previous?.disabled).toBe(false);
    expect(next?.disabled).toBe(false);
    expect(getMediaSummary).toHaveBeenCalledWith('image-5', undefined, 'messenger');
    root.unmount();
  });

  it('hides the summary carousel when no media has a summary', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardMediaSummaryCarousel
          media={Array.from({ length: 4 }, (_, index) => ({
            id: `image-${index + 1}`,
            summary: null,
          }))}
        />,
      );
    });

    expect(container.querySelector('[data-media-summary-carousel="true"]')).toBeNull();
    root.unmount();
  });

  it('supports expand and collapse of summary text in carousel', async () => {
    const longSummary = 'Перший рядок опису.\n'.repeat(5) + 'Останній рядок опису.';
    getMediaSummary.mockResolvedValueOnce({
      state: 'completed',
      summary: longSummary,
      coordinates: [],
      lastError: null,
      sourceKind: 'ocr_text',
      sourceCharCount: 100,
      aiEngineName: 'Gemma',
      modelName: 'gemma',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardMediaSummaryCarousel
          media={[
            {
              id: 'image-1',
              summary: { state: 'completed', lastError: null, hasCoordinates: false },
            },
          ]}
        />,
      );
      await Promise.resolve();
    });

    const expandBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Розгорнути опис"]',
    );
    expect(expandBtn).not.toBeNull();
    expect(expandBtn?.disabled).toBe(false);

    await act(async () => {
      expandBtn?.click();
      await Promise.resolve();
    });

    const collapseBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Згорнути опис"]',
    );
    expect(collapseBtn).not.toBeNull();

    await act(async () => {
      collapseBtn?.click();
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Розгорнути опис"]'),
    ).not.toBeNull();
    root.unmount();
  });

  it('renders no result state when summary is empty', async () => {
    getMediaSummary.mockResolvedValueOnce({
      state: 'completed',
      summary: '',
      coordinates: [],
      lastError: null,
      sourceKind: 'ocr_text',
      sourceCharCount: 0,
      aiEngineName: 'Gemma',
      modelName: 'gemma',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardMediaSummaryCarousel
          media={[
            {
              id: 'image-1',
              summary: { state: 'completed', lastError: null, hasCoordinates: false },
            },
          ]}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Не розпізнаний контент');
    root.unmount();
  });

  it('renders error state and retries on retry button click', async () => {
    getMediaSummary.mockResolvedValueOnce({
      state: 'failed',
      summary: '',
      coordinates: [],
      lastError: 'Помилка розпізнавання',
      sourceKind: 'ocr_text',
      sourceCharCount: 0,
      aiEngineName: 'Gemma',
      modelName: 'gemma',
    });
    retryMediaSummary.mockResolvedValueOnce({
      state: 'completed',
      summary: 'Успішний опис після повтору',
      coordinates: [],
      lastError: null,
      sourceKind: 'ocr_text',
      sourceCharCount: 20,
      aiEngineName: 'Gemma',
      modelName: 'gemma',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardMediaSummaryCarousel
          media={[
            {
              id: 'image-1',
              summary: { state: 'failed', lastError: null, hasCoordinates: false },
            },
          ]}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Не вдалося створити опис');
    const retryBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Повторити стислий опис"]',
    );
    expect(retryBtn).not.toBeNull();

    await act(async () => {
      retryBtn?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Успішний опис після повтору');
    root.unmount();
  });

  it('keeps both panels open on desktop and closes summary on mobile (mutually exclusive)', async () => {
    useMediaQueryMock.mockReturnValue(false);
    const onSummaryVisibleChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OcrSplitPreview
          source={<div data-source />}
          mediaId="media-id"
          ocr={{
            state: 'completed',
            qualityStatus: 'accepted',
            processedPages: 1,
            totalPages: 1,
            lastError: null,
            queueSize: null,
            attempts: 0,
            statusLog: [],
          }}
          visible
          fullPane={false}
          onOcrChange={vi.fn()}
          onFullPaneChange={vi.fn()}
          summary={{ state: 'completed', lastError: null, hasCoordinates: false }}
          summaryVisible
          onSummaryChange={vi.fn()}
          onSummaryVisibleChange={onSummaryVisibleChange}
        />,
      );
    });

    expect(onSummaryVisibleChange).not.toHaveBeenCalled();

    useMediaQueryMock.mockReturnValue(true);
    await act(async () => {
      root.render(
        <OcrSplitPreview
          source={<div data-source />}
          mediaId="media-id"
          ocr={{
            state: 'completed',
            qualityStatus: 'accepted',
            processedPages: 1,
            totalPages: 1,
            lastError: null,
            queueSize: null,
            attempts: 0,
            statusLog: [],
          }}
          visible
          fullPane={false}
          onOcrChange={vi.fn()}
          onFullPaneChange={vi.fn()}
          summary={{ state: 'completed', lastError: null, hasCoordinates: false }}
          summaryVisible
          onSummaryChange={vi.fn()}
          onSummaryVisibleChange={onSummaryVisibleChange}
        />,
      );
    });

    expect(onSummaryVisibleChange).toHaveBeenCalledWith(false);
    root.unmount();
  });
});
