/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const drawerProps: Array<{ ModalProps?: { disableRestoreFocus?: boolean } }> = [];

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Chip: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Drawer: ({ children, open, ModalProps }: { children?: ReactNode; open?: boolean; ModalProps?: { disableRestoreFocus?: boolean } }) => {
    if (open) drawerProps.push({ ModalProps });
    return open ? <div role="dialog">{children}</div> : null;
  },
  IconButton: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: () => <input />,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { AnalysisMessageEditDrawer } from './AnalysisMessageEditDrawer';

describe('AnalysisMessageEditDrawer', () => {
  afterEach(() => {
    drawerProps.splice(0);
    document.body.innerHTML = '';
  });

  it('disables restore focus on the edit drawer modal', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <AnalysisMessageEditDrawer
          message={null}
          open
          saveInFlight={false}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />,
      );
    });

    expect(drawerProps.at(-1)?.ModalProps).toEqual({ disableRestoreFocus: true });
    root.unmount();
  });
});
