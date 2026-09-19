/**
 * @vitest-environment happy-dom
 */
import type { ComponentProps, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let latestDialogOnClose: ((event: Event, reason: string) => void) | null = null;
let dialogEscapeListenerInstalled = false;
const dialogProps: Array<{ disableRestoreFocus?: boolean }> = [];
let latestDocumentKind: string | null = null;
let latestSwipeEnabled: boolean | null = null;

vi.mock('@mui/material', () => {
  const passthrough =
    (tag: string) =>
    ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <div {...props}>{children}</div>
    );

  return {
    Box: passthrough('div'),
    ButtonBase: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <button {...props}>{children}</button>
    ),
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
    Divider: passthrough('hr'),
    IconButton: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <button {...props}>{children}</button>
    ),
    Popover: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? <div>{children}</div> : null,
    Menu: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? <div role="menu">{children}</div> : null,
    MenuItem: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <button {...props}>{children}</button>
    ),
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
    TextField: ({
      label,
      value,
      onChange,
      fullWidth: _fullWidth,
      multiline: _multiline,
      minRows: _minRows,
      maxRows: _maxRows,
      autoFocus: _autoFocus,
      size: _size,
      sx: _sx,
      ...props
    }: {
      label?: string;
      value?: string;
      onChange?: (event: { target: { value: string } }) => void;
      fullWidth?: boolean;
      multiline?: boolean;
      minRows?: number;
      maxRows?: number;
      autoFocus?: boolean;
      size?: string;
      sx?: unknown;
    } & Record<string, unknown>) => (
      <textarea
        aria-label={label}
        value={value ?? ''}
        onChange={(event) => onChange?.({ target: { value: event.currentTarget.value } })}
        {...props}
      />
    ),
    Tooltip: ({ children }: { children?: ReactNode }) => children,
    Typography: passthrough('div'),
    useMediaQuery: () => false,
    useTheme: () => ({ palette: { divider: '#000' } }),
  };
});

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewStage.tsx', () => ({
  MessageCardAttachmentPreviewStage: ({
    children,
    onDoubleClick,
  }: {
    children?: ReactNode;
    onDoubleClick?: () => void;
  }) => (
    <div data-preview-stage="document" onDoubleClick={onDoubleClick}>
      {children}
    </div>
  ),
}));

vi.mock('../../attachment-preview/useAttachmentPreviewSwipe.ts', () => ({
  useAttachmentPreviewSwipe: ({ enabled }: { enabled: boolean }) => {
    latestSwipeEnabled = enabled;
  },
}));

vi.mock('../PdfDocumentPreview.tsx', () => ({
  PdfDocumentPreview: () => <div data-document-kind="pdf" />,
}));

vi.mock('../DocxDocumentPreview.tsx', () => ({
  DocxDocumentPreview: () => <div data-document-kind="docx" />,
}));

vi.mock('../XlsxDocumentPreview.tsx', () => ({
  XlsxDocumentPreview: () => <div data-document-kind="xlsx" />,
}));

vi.mock('../CsvDocumentPreview.tsx', () => ({
  CsvDocumentPreview: () => <div data-document-kind="csv" />,
}));

vi.mock('../../text-document-preview.tsx', () => ({
  TxtDocumentPreview: () => {
    latestDocumentKind = 'txt';
    return <div>Помилка перегляду</div>;
  },
  MarkdownDocumentPreview: () => {
    latestDocumentKind = 'md';
    return <div>Помилка перегляду</div>;
  },
}));

import { MessageCardAttachmentPreviewProvider } from '../../attachment-preview/MessageCardAttachmentPreviewProvider.tsx';
import { DocumentAttachmentPreviewRenderer } from '../DocumentAttachmentPreviewRenderer.tsx';

type TestDocumentPreviewDialogProps = {
  documents: ComponentProps<typeof DocumentAttachmentPreviewRenderer>['document'][];
  currentIndex?: number;
  initialIndex?: number;
  open: boolean;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  isDownloadStarting: (downloadKey: string) => boolean;
  onDownloadStart: (downloadKey: string) => boolean;
  reportDraft?: ComponentProps<typeof DocumentAttachmentPreviewRenderer>['reportDraft'];
};

function TestDocumentPreviewDialog(props: TestDocumentPreviewDialogProps) {
  if (!props.open || props.documents.length === 0) return null;

  return (
    <MessageCardAttachmentPreviewProvider
      attachments={props.documents.map((document) => ({ type: 'document', value: document }))}
      initialIndex={props.currentIndex ?? props.initialIndex ?? 0}
      onClose={props.onClose}
      onIndexChange={props.onIndexChange}
      isDownloadStarting={props.isDownloadStarting}
      onDownloadStart={props.onDownloadStart}
      reportDraft={props.reportDraft}
    />
  );
}
describe('DocumentAttachmentPreviewRenderer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    latestDialogOnClose = null;
    dialogEscapeListenerInstalled = false;
    dialogProps.splice(0);
    latestDocumentKind = null;
    latestSwipeEnabled = null;
  });

  it('closes the dialog on Escape', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <TestDocumentPreviewDialog
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

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('keeps arrow keys on editable controls from changing the preview index', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onIndexChange = vi.fn();

    await act(async () => {
      root.render(
        <TestDocumentPreviewDialog
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

    const input = document.createElement('input');
    document.body.querySelector('[role="dialog"]')?.appendChild(input);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    expect(onIndexChange).not.toHaveBeenCalled();
    root.unmount();
  });

  it('renders txt and markdown previews without zoom controls', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TestDocumentPreviewDialog
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
    expect(document.body.querySelector('button[aria-label="Скачати"]')).not.toBeNull();
    root.unmount();
  });

  it('keeps the dialog open when switching from pdf to txt previews', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TestDocumentPreviewDialog
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

    await act(async () => {
      root.render(
        <TestDocumentPreviewDialog
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
    expect(document.body.querySelector('[data-preview-stage="document"]')).not.toBeNull();
    root.unmount();
  });

  it('resets zoom when switching between zoomable documents', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const documents: TestDocumentPreviewDialogProps['documents'] = [
      {
        href: 'https://example.test/files/report.pdf',
        fileName: 'report.pdf',
        kind: 'pdf',
      },
      {
        href: 'https://example.test/files/report.docx',
        fileName: 'report.docx',
        kind: 'docx',
      },
    ];
    const commonProps = {
      documents,
      open: true,
      onClose: vi.fn(),
      onIndexChange: vi.fn(),
      isDownloadStarting: () => false,
      onDownloadStart: vi.fn(() => true),
    };

    await act(async () => {
      root.render(<TestDocumentPreviewDialog {...commonProps} currentIndex={0} />);
    });

    expect(document.body.querySelector('[data-attachment-preview-report-pane]')).toBeNull();

    await act(async () => {
      document.body
        .querySelector('[data-preview-stage="document"]')
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('150%');

    await act(async () => {
      root.render(<TestDocumentPreviewDialog {...commonProps} currentIndex={1} />);
    });

    expect(document.body.textContent).toContain('100%');
    expect(document.body.textContent).not.toContain('150%');
    root.unmount();
  });

  it('keeps the report editor open while switching documents', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onReportTextChange = vi.fn();
    const documents: TestDocumentPreviewDialogProps['documents'] = [
      {
        href: 'https://example.test/files/report-1.pdf',
        fileName: 'report-1.pdf',
        kind: 'pdf',
      },
      {
        href: 'https://example.test/files/report-2.pdf',
        fileName: 'report-2.pdf',
        kind: 'pdf',
      },
    ];
    const commonProps = {
      documents,
      open: true,
      onClose: vi.fn(),
      onIndexChange: vi.fn(),
      isDownloadStarting: () => false,
      onDownloadStart: vi.fn(() => true),
      reportDraft: {
        value: 'Чернетка донесення',
        onChange: onReportTextChange,
      },
    };

    await act(async () => {
      root.render(<TestDocumentPreviewDialog {...commonProps} currentIndex={0} />);
    });

    const textarea = document.body.querySelector(
      'textarea[aria-label="Текст розвіддонесення"]',
    ) as HTMLTextAreaElement | null;

    expect(document.body.querySelector('[data-attachment-preview-report-pane]')).not.toBeNull();
    expect(textarea?.value).toBe('Чернетка донесення');
    expect(
      document.body.querySelector('button[aria-label="Сховати розвіддонесення"]'),
    ).not.toBeNull();

    await act(async () => {
      root.render(<TestDocumentPreviewDialog {...commonProps} currentIndex={1} />);
    });

    expect(document.body.textContent).toContain('2 / 2');
    expect(document.body.querySelector('[data-attachment-preview-report-pane]')).not.toBeNull();

    await act(async () => {
      const nextTextarea = document.body.querySelector(
        'textarea[aria-label="Текст розвіддонесення"]',
      ) as HTMLTextAreaElement | null;
      if (nextTextarea == null) throw new Error('report textarea not found');
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(nextTextarea, 'Оновлений текст');
      nextTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onReportTextChange).toHaveBeenCalledWith('Оновлений текст');
    root.unmount();
  });

  it.each([
    ['xlsx', false],
    ['csv', false],
    ['pdf', true],
    ['docx', true],
  ] as const)('sets base-zoom carousel swipes for %s previews to %s', async (kind, expected) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TestDocumentPreviewDialog
          documents={[
            {
              href: `https://example.test/files/report.${kind}`,
              fileName: `report.${kind}`,
              kind,
            },
            {
              href: 'https://example.test/files/other.pdf',
              fileName: 'other.pdf',
              kind: 'pdf',
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

    expect(latestSwipeEnabled).toBe(expected);
    root.unmount();
  });

  it('keeps dialog actions visible when a text preview errors', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TestDocumentPreviewDialog
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

    expect(latestDocumentKind).toBe('txt');
    expect(document.body.textContent).toContain('Помилка перегляду');
    expect(document.body.querySelector('button[aria-label="Інформація"]')).not.toBeNull();
    expect(
      document.body.querySelector('button[aria-label="Відкрити в новій вкладці"]'),
    ).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Скачати"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Закрити"]')).not.toBeNull();
    root.unmount();
  });
});
