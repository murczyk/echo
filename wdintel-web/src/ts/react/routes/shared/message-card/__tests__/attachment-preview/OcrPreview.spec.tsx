/**
 * @vitest-environment happy-dom
 */
import { createElement, type ElementType, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getMediaOcrStatus, getMediaSummary } = vi.hoisted(() => ({
  getMediaOcrStatus: vi.fn(),
  getMediaSummary: vi.fn(),
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
  Tooltip: ({ children, title }: { children?: ReactNode; title?: string }) => (
    <span data-tooltip={title}>{children}</span>
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

vi.mock('../../../../../services/api/ocr', () => ({ getMediaOcrStatus }));
vi.mock('../../../../../services/api/media-summary', () => ({ getMediaSummary }));

import {
  getOcrDownloadItems,
  getOcrInfoSections,
  getOcrInfoSeverity,
  OcrPreviewAction,
  OcrSplitPreview,
} from '../../attachment-preview/OcrPreview';

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
    expect(buttons[1]?.getAttribute('aria-label')).toContain('черга: 2');
    expect(buttons[2]?.disabled).toBe(false);
    expect(buttons[2]?.getAttribute('aria-label')).toContain('помилкою');
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

    expect(getMediaOcrStatus).toHaveBeenCalledWith('media-id');
    expect(onOcrChange).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'completed', processedPages: 2 }),
    );
    root.unmount();
  });

  it('opens the summary over the original pane and restores split view', async () => {
    getMediaSummary.mockResolvedValueOnce({
      state: 'completed',
      summary: 'Короткий опис',
      who: 'Підрозділ',
      whereText: null,
      whatHappened: null,
      whatNext: null,
      purpose: null,
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
          }}
          visible
          fullPane
          onOcrChange={vi.fn()}
          onFullPaneChange={onFullPaneChange}
          summary={{ state: 'queued', lastError: null }}
          summaryVisible
          onSummaryChange={onSummaryChange}
          onSummaryVisibleChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(onFullPaneChange).toHaveBeenCalledWith(false);
    expect(getMediaSummary).toHaveBeenCalledWith('media-id');
    expect(onSummaryChange).toHaveBeenCalledWith({ state: 'completed', lastError: null });
    expect(container.textContent).toContain('Короткий опис');
    expect(container.textContent).toContain('Хто: Підрозділ');
    root.unmount();
  });
});
