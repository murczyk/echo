/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  IconButton: ({
    children,
    disabled,
    ...props
  }: {
    children?: ReactNode;
    disabled?: boolean;
  } & Record<string, unknown>) => (
    <button disabled={disabled} {...props}>
      {children}
    </button>
  ),
  Slider: () => <div />,
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useTheme: () => ({ palette: { divider: '#000' } }),
}));

import { MessageCardImagePreviewActions } from './MessageCardImagePreviewActions';

describe('MessageCardImagePreviewActions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('disables image copy before the preview image is loaded', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardImagePreviewActions
          currentHref="https://example.test/image.png"
          downloadFileName="image.png"
          hasCarousel={false}
          copyStatus="idle"
          canCopyImage={false}
          resolvedIndex={0}
          imageCount={1}
          onCopyImage={vi.fn()}
          onGoToPrevious={vi.fn()}
          onGoToNext={vi.fn()}
          onInfoClick={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    const copyButton = document.body.querySelector('button[aria-label="Скопіювати зображення"]');
    expect(copyButton).not.toBeNull();
    expect((copyButton as HTMLButtonElement).disabled).toBe(true);
    root.unmount();
  });
});
