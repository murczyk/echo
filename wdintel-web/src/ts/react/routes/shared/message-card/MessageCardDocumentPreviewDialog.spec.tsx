/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let latestDialogOnClose: ((event: Event, reason: string) => void) | null = null;
let dialogEscapeListenerInstalled = false;

vi.mock('@mui/material', () => {
  const passthrough =
    (tag: string) =>
    ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => <div {...props}>{children}</div>;

  return {
    Box: passthrough('div'),
    Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => <button {...props}>{children}</button>,
    Dialog: ({ children, open, onClose }: { children?: ReactNode; open?: boolean; onClose?: (event: Event, reason: string) => void }) => {
      latestDialogOnClose = onClose ?? null;
      if (open && !dialogEscapeListenerInstalled) {
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            latestDialogOnClose?.(event, 'escapeKeyDown');
          }
        });
        dialogEscapeListenerInstalled = true;
      }

      return open ? <div role="dialog">{children}</div> : null;
    },
    DialogActions: passthrough('div'),
    DialogContent: passthrough('div'),
    IconButton: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => <button {...props}>{children}</button>,
    Popover: ({ children, open }: { children?: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
    Slider: ({ value, onChange }: { value?: number; onChange?: (event: unknown, value: number | number[]) => void }) => (
      <input
        type="range"
        value={value ?? 0}
        onChange={(event) => {
          onChange?.(event, Number((event.currentTarget as HTMLInputElement).value));
        }}
      />
    ),
    Stack: passthrough('div'),
    Tooltip: ({ children }: { children?: ReactNode }) => children,
    Typography: passthrough('div'),
    useTheme: () => ({ palette: { divider: '#000' } }),
  };
});

vi.mock('./MessageCardDocumentPreviewStage', () => ({
  MessageCardDocumentPreviewStage: () => <div data-document-stage />,
}));

import { MessageCardDocumentPreviewDialog } from './MessageCardDocumentPreviewDialog';

describe('MessageCardDocumentPreviewDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    latestDialogOnClose = null;
    dialogEscapeListenerInstalled = false;
  });

  it('exits fullscreen on Escape before closing the dialog', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <MessageCardDocumentPreviewDialog
          documents={[
            {
              href: 'https://example.test/files/report.pdf',
              fileName: 'report.pdf',
              sizeBytes: 1024,
              contentType: 'application/pdf',
              kind: 'pdf',
            },
          ]}
          open
          onClose={onClose}
          onIndexChange={vi.fn()}
        />,
      );
    });

    const fullscreenButton = document.body.querySelector('button[aria-label="Повноекранний режим"]');
    expect(fullscreenButton).not.toBeNull();

    await act(async () => {
      fullscreenButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.querySelector('button[aria-label="Вийти з повноекранного режиму"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(document.body.querySelector('button[aria-label="Повноекранний режим"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Вийти з повноекранного режиму"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('keeps arrow keys on the zoom slider from changing the preview index', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onIndexChange = vi.fn();

    await act(async () => {
      root.render(
        <MessageCardDocumentPreviewDialog
          documents={[
            {
              href: 'https://example.test/files/report-1.pdf',
              fileName: 'report-1.pdf',
              sizeBytes: 1024,
              contentType: 'application/pdf',
              kind: 'pdf',
            },
            {
              href: 'https://example.test/files/report-2.pdf',
              fileName: 'report-2.pdf',
              sizeBytes: 2048,
              contentType: 'application/pdf',
              kind: 'pdf',
            },
          ]}
          currentIndex={0}
          open
          onClose={vi.fn()}
          onIndexChange={onIndexChange}
        />,
      );
    });

    const slider = document.body.querySelector('input[type="range"]');
    expect(slider).not.toBeNull();

    await act(async () => {
      slider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    expect(onIndexChange).not.toHaveBeenCalled();
    root.unmount();
  });
});
