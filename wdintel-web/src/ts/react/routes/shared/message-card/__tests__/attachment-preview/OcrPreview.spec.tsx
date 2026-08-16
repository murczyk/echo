/**
 * @vitest-environment happy-dom
 */
import { createElement, type ElementType, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
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
  IconButton: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children, title }: { children?: ReactNode; title?: string }) => (
    <span data-tooltip={title}>{children}</span>
  ),
  useMediaQuery: () => false,
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ breakpoints: { down: () => '' } }),
}));

vi.mock('@mui/icons-material/Fullscreen', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/FullscreenExit', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/Visibility', () => ({ default: () => <span /> }));

import { OcrPreviewAction, OcrSplitPreview } from '../../attachment-preview/OcrPreview';

describe('OcrPreview', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('enables accepted and degraded results but disables failed results', async () => {
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
    expect(buttons[1]?.disabled).toBe(true);
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
          visible
          fullPane={false}
          onFullPaneChange={vi.fn()}
        />,
      );
    });

    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe('/api/messenger/media/media%2Fid/ocr');
    expect(iframe?.getAttribute('sandbox')).toBe('');
    root.unmount();
  });
});
