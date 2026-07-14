/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let latestPaperProps: Record<string, unknown> | null = null;

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Dialog: ({
    children,
    open,
    PaperProps,
  }: {
    children?: ReactNode;
    open?: boolean;
    PaperProps?: Record<string, unknown>;
  }) => {
    if (open) {
      latestPaperProps = PaperProps ?? null;
    }

    return open ? (
      <div role="dialog" aria-label={String(PaperProps?.['aria-label'] ?? '')}>
        {children}
      </div>
    ) : null;
  },
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { MessageCardPreviewShell } from './MessageCardPreviewShell';
import { getMessageCardPreviewShellConfig } from './message-card-preview-config';

function getByRole(role: string, name: string) {
  const element = document.body.querySelector(`[role="${role}"]`);
  if (element?.getAttribute('aria-label') === name) {
    return element;
  }

  throw new Error(`Unable to find role=${role} name=${name}`);
}

describe('MessageCardPreviewShell', () => {
  afterEach(() => {
    latestPaperProps = null;
    document.body.innerHTML = '';
  });

  it('exposes the dialog name on the paper element', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardPreviewShell
          open
          isFullscreen={false}
          ariaLabel="Перегляд тесту"
          onClose={vi.fn()}
          config={getMessageCardPreviewShellConfig('image')}
          stage={<div>stage</div>}
        />,
      );
    });

    expect(getByRole('dialog', 'Перегляд тесту')).toBeTruthy();
    expect(latestPaperProps?.['aria-label']).toBe('Перегляд тесту');
    root.unmount();
  });
});
