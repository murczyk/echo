/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let latestDialogOnClose: ((event: Event, reason: string) => void) | null = null;
let dialogEscapeListenerInstalled = false;
const dialogProps: Array<{ disableRestoreFocus?: boolean }> = [];
let latestStageProps: {
  currentIndex: number;
  documents: Array<{ kind: string }>;
  isFullscreen: boolean;
  zoom: number;
} | null = null;

vi.mock('@mui/material', () => {
  const passthrough =
    (tag: string) =>
    ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <div {...props}>{children}</div>
    );

  return {
    Box: passthrough('div'),
    Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <button {...props}>{children}</button>
    ),
    Dialog: ({
      children,
      open,
      onClose,
      disableRestoreFocus,
    }: {
      children?: ReactNode;
      open?: boolean;
      onClose?: (event: Event, reason: string) => void;
      disableRestoreFocus?: boolean;
    }) => {
      if (open) {
        dialogProps.push({ disableRestoreFocus });
      }
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
    IconButton: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <button {...props}>{children}</button>
    ),
    Popover: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? <div>{children}</div> : null,
    Slider: ({
      value,
      onChange,
    }: {
      value?: number;
      onChange?: (event: unknown, value: number | number[]) => void;
    }) => (
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
  MessageCardDocumentPreviewStage: ({
    currentIndex,
    documents,
    isFullscreen,
    zoom,
  }: {
    currentIndex: number;
    documents: Array<{ kind: string }>;
    isFullscreen: boolean;
    zoom: number;
  }) => {
    latestStageProps = { currentIndex, documents, isFullscreen, zoom };
    const currentKind = documents[currentIndex]?.kind ?? 'missing';
    return (
      <div data-document-stage data-document-kind={currentKind}>
        {currentKind === 'txt' || currentKind === 'md' ? <div>Помилка перегляду</div> : null}
      </div>
    );
  },
}));

import { MessageCardDocumentPreviewDialog } from './MessageCardDocumentPreviewDialog';
import { MessageCardDocumentPreviewControls } from './MessageCardDocumentPreviewActions';

describe('MessageCardDocumentPreviewDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    latestDialogOnClose = null;
    dialogEscapeListenerInstalled = false;
    dialogProps.splice(0);
    latestStageProps = null;
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
          isDownloadStarting={() => false}
          onDownloadStart={vi.fn(() => true)}
        />,
      );
    });

    expect(dialogProps.at(-1)?.disableRestoreFocus).toBe(true);

    const fullscreenButton = document.body.querySelector(
      'button[aria-label="Повноекранний режим"]',
    );
    expect(fullscreenButton).not.toBeNull();

    await act(async () => {
      fullscreenButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const fullscreenExitButton = document.body.querySelector(
      'button[aria-label="Вийти з повноекранного режиму"]',
    ) as HTMLButtonElement | null;
    expect(fullscreenExitButton).not.toBeNull();
    fullscreenExitButton?.focus();
    expect(document.activeElement).toBe(fullscreenExitButton);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(document.body.querySelector('button[aria-label="Повноекранний режим"]')).not.toBeNull();
    expect(document.activeElement).toBe(fullscreenExitButton);
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
          isDownloadStarting={() => false}
          onDownloadStart={vi.fn(() => true)}
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

  it('renders txt and markdown previews without zoom or fullscreen controls', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

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
            {
              href: 'https://example.test/files/notes.txt',
              fileName: 'notes.txt',
              sizeBytes: 256,
              contentType: 'text/plain',
              kind: 'txt',
            },
            {
              href: 'https://example.test/files/readme.md',
              fileName: 'readme.md',
              sizeBytes: 128,
              contentType: 'text/markdown',
              kind: 'md',
            },
          ]}
          currentIndex={1}
          open
          onClose={vi.fn()}
          onIndexChange={vi.fn()}
          isDownloadStarting={() => false}
          onDownloadStart={vi.fn(() => true)}
        />,
      );
    });

    expect(document.body.textContent).toContain('2 / 3');
    expect(document.body.querySelector('button[aria-label="Зменшити"]')).toBeNull();
    expect(document.body.querySelector('button[aria-label="Збільшити"]')).toBeNull();
    expect(document.body.querySelector('button[aria-label="Повноекранний режим"]')).toBeNull();
    expect(
      document.body.querySelector('button[aria-label="Вийти з повноекранного режиму"]'),
    ).toBeNull();
    expect(document.body.querySelector('button[aria-label="Інформація"]')).not.toBeNull();
    expect(
      document.body.querySelector('button[aria-label="Відкрити в новій вкладці"]'),
    ).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Завантажити"]')).not.toBeNull();
    expect(document.body.querySelectorAll('button')).toHaveLength(6);
    root.unmount();
  });

  it('leaves fullscreen when switching from pdf to txt previews', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

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
            {
              href: 'https://example.test/files/notes.txt',
              fileName: 'notes.txt',
              sizeBytes: 256,
              contentType: 'text/plain',
              kind: 'txt',
            },
          ]}
          currentIndex={0}
          open
          onClose={vi.fn()}
          onIndexChange={vi.fn()}
          isDownloadStarting={() => false}
          onDownloadStart={vi.fn(() => true)}
        />,
      );
    });

    const fullscreenButton = document.body.querySelector(
      'button[aria-label="Повноекранний режим"]',
    );
    expect(fullscreenButton).not.toBeNull();

    await act(async () => {
      fullscreenButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(
      document.body.querySelector('button[aria-label="Вийти з повноекранного режиму"]'),
    ).not.toBeNull();

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
            {
              href: 'https://example.test/files/notes.txt',
              fileName: 'notes.txt',
              sizeBytes: 256,
              contentType: 'text/plain',
              kind: 'txt',
            },
          ]}
          currentIndex={1}
          open
          onClose={vi.fn()}
          onIndexChange={vi.fn()}
          isDownloadStarting={() => false}
          onDownloadStart={vi.fn(() => true)}
        />,
      );
    });

    expect(document.body.querySelector('button[aria-label="Повноекранний режим"]')).toBeNull();
    expect(
      document.body.querySelector('button[aria-label="Вийти з повноекранного режиму"]'),
    ).toBeNull();
    root.unmount();
  });

  it('keeps dialog actions visible when a text preview errors', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

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
            {
              href: 'https://example.test/files/notes.txt',
              fileName: 'notes.txt',
              sizeBytes: 256,
              contentType: 'text/plain',
              kind: 'txt',
            },
          ]}
          currentIndex={1}
          open
          onClose={vi.fn()}
          onIndexChange={vi.fn()}
          isDownloadStarting={() => false}
          onDownloadStart={vi.fn(() => true)}
        />,
      );
    });

    expect(latestStageProps?.currentIndex).toBe(1);
    expect(document.body.textContent).toContain('Помилка перегляду');
    expect(document.body.querySelector('button[aria-label="Інформація"]')).not.toBeNull();
    expect(
      document.body.querySelector('button[aria-label="Відкрити в новій вкладці"]'),
    ).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Завантажити"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Закрити"]')).not.toBeNull();
    root.unmount();
  });

  it('hides fullscreen controls when the capability disables fullscreen but keeps zoom controls', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardDocumentPreviewControls
          zoom={150}
          isFullscreen={false}
          canFullscreen={false}
          onSetPreviewZoom={vi.fn()}
          onToggleFullscreen={vi.fn()}
        />,
      );
    });

    expect(document.body.querySelector('button[aria-label="Зменшити"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Збільшити"]')).not.toBeNull();
    expect(document.body.querySelector('input[type="range"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Повноекранний режим"]')).toBeNull();
    expect(
      document.body.querySelector('button[aria-label="Вийти з повноекранного режиму"]'),
    ).toBeNull();
    root.unmount();
  });
});
