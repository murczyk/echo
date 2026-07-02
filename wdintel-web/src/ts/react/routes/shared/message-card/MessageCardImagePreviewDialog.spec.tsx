/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardRef } from 'react';

const dialogProps: Array<{ disableRestoreFocus?: boolean }> = [];

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Dialog: ({
    children,
    open,
    disableRestoreFocus,
  }: {
    children?: ReactNode;
    open?: boolean;
    disableRestoreFocus?: boolean;
  }) => {
    if (open) dialogProps.push({ disableRestoreFocus });
    return open ? <div role="dialog">{children}</div> : null;
  },
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useTheme: () => ({
    palette: { divider: '#000', text: { secondary: '#666' }, background: { default: '#fff' } },
  }),
}));

vi.mock('./MessageCardImagePreviewActions', () => ({
  MessageCardImagePreviewActions: () => <div />,
  MessageCardImagePreviewControls: () => <div />,
}));

vi.mock('./MessageCardImagePreviewStage', () => ({
  MessageCardImagePreviewStage: forwardRef<HTMLDivElement, { children?: ReactNode }>(
    (_props, _ref) => <div />,
  ),
}));

vi.mock('./MessageCardImagePreviewInfoPopover', () => ({
  MessageCardImagePreviewInfoPopover: () => null,
}));

import { MessageImagePreviewDialog } from './MessageCardImagePreviewDialog';

describe('MessageImagePreviewDialog', () => {
  afterEach(() => {
    dialogProps.splice(0);
    document.body.innerHTML = '';
  });

  it('disables restore focus on the image preview dialog', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageImagePreviewDialog
          imageHrefs={[{ href: 'https://example.test/image.png' } as never]}
          open
          onClose={vi.fn()}
          onIndexChange={vi.fn()}
        />,
      );
    });

    expect(dialogProps.at(-1)?.disableRestoreFocus).toBe(true);
    root.unmount();
  });
});
