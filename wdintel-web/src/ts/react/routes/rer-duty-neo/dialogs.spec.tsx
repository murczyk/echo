/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dialogProps: Array<{ disableRestoreFocus?: boolean }> = [];

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Dialog: ({ children, open, disableRestoreFocus }: { children?: ReactNode; open?: boolean; disableRestoreFocus?: boolean }) => {
    if (open) dialogProps.push({ disableRestoreFocus });
    return open ? <div role="dialog">{children}</div> : null;
  },
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: () => <input />,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { CommentDialog, DeleteConfirmDialog } from './dialogs';

describe('message card dialogs', () => {
  afterEach(() => {
    dialogProps.splice(0);
    document.body.innerHTML = '';
  });

  it('disables restore focus on the shared comment dialog', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <CommentDialog
          open
          messagePreview={null}
          commentText=""
          onCommentTextChange={vi.fn()}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />,
      );
    });

    expect(dialogProps.at(-1)?.disableRestoreFocus).toBe(true);
    root.unmount();
  });

  it('disables restore focus on the shared delete confirm dialog', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DeleteConfirmDialog open onClose={vi.fn()} onConfirm={vi.fn()} />);
    });

    expect(dialogProps.at(-1)?.disableRestoreFocus).toBe(true);
    root.unmount();
  });
});
