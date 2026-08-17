/**
 * @vitest-environment happy-dom
 */
import { createElement, type ElementType, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getMediaOcrStatus, getMediaSummary, mapCoordinates } = vi.hoisted(() => ({
  getMediaOcrStatus: vi.fn(),
  getMediaSummary: vi.fn(),
  mapCoordinates: vi.fn(),
}));

vi.mock('@mui/material', () => ({
  alpha: () => 'transparent',
  Box: ({
    component = 'div',
    children,
    sx: _sx,
    ...props
  }: {
    component?: ElementType;
    children?: ReactNode;
    sx?: unknown;
  }) => createElement(component, props, children),
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  Chip: ({ label }: { label?: ReactNode }) => <span>{label}</span>,
  CircularProgress: () => <span data-progress />,
  IconButton: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  LinearProgress: () => <span data-linear-progress />,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
    <span>
      {children}
      <span data-tooltip-content="true">{title}</span>
    </span>
  ),
  Typography: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
  useMediaQuery: () => false,
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
vi.mock('../../../../../services/api/media-summary', () => ({ getMediaSummary }));
vi.mock('../../../../../services/api/location', () => ({ mapCoordinates }));

import {
  getOcrDownloadItems,
  getOcrInfoSections,
  getOcrInfoSeverity,
  OcrPreviewAction,
  OcrSplitPreview,
} from '../../attachment-preview/OcrPreview';
import { MessageCardMediaSummary } from '../../attachment-preview/MediaSummaryPreview';

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
    expect(iframe?.getAttribute('sandbox')).toBe('');
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
});
