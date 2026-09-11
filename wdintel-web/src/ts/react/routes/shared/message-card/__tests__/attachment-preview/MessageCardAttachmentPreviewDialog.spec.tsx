/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageCardAttachmentPreviewDialog } from '../../attachment-preview/MessageCardAttachmentPreviewDialog';
import type { MessageCardPreviewItem } from '../../attachment-preview/message-card-preview.types';

vi.mock('@mui/material', () => ({
  Box: ({
    children,
    sx: _sx,
    ...props
  }: {
    children?: ReactNode;
    sx?: unknown;
  } & Record<string, unknown>) => <div {...props}>{children}</div>,
  Dialog: ({ children, open }: { children?: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  IconButton: ({
    children,
    sx: _sx,
    ...props
  }: {
    children?: ReactNode;
    sx?: unknown;
  } & Record<string, unknown>) => <button {...props}>{children}</button>,
}));

const imageEditorEscapeHandler = vi.fn(() => false);
const consumeInitialAction = vi.fn();
const reportVisibilityStorageKey = 'echo.message-attachment-preview.report-visible';

vi.mock('../../renderers/ImageAttachmentPreviewRenderer', () => ({
  ImageAttachmentPreviewRenderer: ({
    registerEditorEscapeHandler,
    onEditModeChange,
    initialAction,
    onInitialActionConsumed,
    onClose,
    reportVisible,
    onReportVisibleChange,
  }: {
    registerEditorEscapeHandler?: (handler: (event: KeyboardEvent) => boolean) => void;
    onEditModeChange?: (editing: boolean) => void;
    initialAction?: 'edit-image';
    onInitialActionConsumed?: () => void;
    onClose: () => void;
    reportVisible: boolean;
    onReportVisibleChange: (visible: boolean) => void;
  }) => {
    useLayoutEffect(() => {
      registerEditorEscapeHandler?.(imageEditorEscapeHandler);
      return () => registerEditorEscapeHandler?.(null);
    }, [registerEditorEscapeHandler]);
    useLayoutEffect(() => {
      if (initialAction === 'edit-image') {
        consumeInitialAction();
        onInitialActionConsumed?.();
      }
    }, [initialAction, onInitialActionConsumed]);
    return (
      <div data-renderer="image" data-report-visible={String(reportVisible)}>
        <button
          aria-label="Перемкнути панель розвіддонесення"
          onClick={() => onReportVisibleChange(!reportVisible)}
        />
        <button aria-label="Закрити перегляд" onClick={onClose} />
        <button aria-label="Почати редагування" onClick={() => onEditModeChange?.(true)} />
        <button aria-label="Завершити редагування" onClick={() => onEditModeChange?.(false)} />
        <input data-image-editor-local-escape onKeyDown={(event) => event.stopPropagation()} />
      </div>
    );
  },
}));

vi.mock('../../renderers/VideoAttachmentPreviewRenderer', () => ({
  VideoAttachmentPreviewRenderer: ({ reportVisible }: { reportVisible: boolean }) => (
    <div data-renderer="video" data-report-visible={String(reportVisible)} />
  ),
}));

vi.mock('../../renderers/DocumentAttachmentPreviewRenderer', () => ({
  DocumentAttachmentPreviewRenderer: ({ reportVisible }: { reportVisible: boolean }) => (
    <div data-renderer="document" data-report-visible={String(reportVisible)} />
  ),
}));

vi.mock('../../renderers/CoordinateAttachmentPreviewRenderer', () => ({
  CoordinateAttachmentPreviewRenderer: () => <div data-renderer="coordinate" />,
}));

const items: MessageCardPreviewItem[] = [
  { type: 'image', value: { href: '/image.png' } },
  { type: 'video', value: { id: 'video', name: 'video.mp4', source: '/video.mp4' } },
  { type: 'document', value: { href: '/document.pdf', kind: 'pdf' } },
  {
    type: 'coordinate',
    points: [{ source: 'direct', lat: 50.45, lng: 30.52, label: 'point' }],
  },
];

describe('MessageCardAttachmentPreviewDialog', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    imageEditorEscapeHandler.mockClear();
    consumeInitialAction.mockClear();
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it.each(items)('renders the $type attachment renderer directly', async (item) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () =>
      root?.render(
        <MessageCardAttachmentPreviewDialog
          item={item}
          navigation={{ index: 0, count: 1, onPrevious: vi.fn(), onNext: vi.fn() }}
          onClose={vi.fn()}
        />,
      ),
    );

    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector('[data-renderer]')?.getAttribute('data-renderer')).toBe(
      item.type,
    );
  });

  it('defers a locally handled editor Escape without closing the preview', async () => {
    const onClose = vi.fn();
    const targetEscape = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <MessageCardAttachmentPreviewDialog
          item={items[0]!}
          navigation={{ index: 0, count: 1, onPrevious: vi.fn(), onNext: vi.fn() }}
          onClose={onClose}
        />,
      ),
    );
    const input = container.querySelector('input') as HTMLInputElement;
    input.addEventListener('keydown', targetEscape);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(event));
    expect(imageEditorEscapeHandler).toHaveBeenCalledWith(event);
    expect(targetEscape).toHaveBeenCalledWith(event);
    expect(event.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('consumes attachment arrows while editing and restores them afterwards #3099', async () => {
    const onNext = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <MessageCardAttachmentPreviewDialog
          item={items[0]!}
          navigation={{ index: 0, count: 2, onPrevious: vi.fn(), onNext }}
          onClose={vi.fn()}
        />,
      ),
    );
    await act(async () =>
      (container?.querySelector('[aria-label="Почати редагування"]') as HTMLButtonElement).click(),
    );
    const locked = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => window.dispatchEvent(locked));
    expect(locked.defaultPrevented).toBe(true);
    expect(onNext).not.toHaveBeenCalled();
    await act(async () =>
      (
        container?.querySelector('[aria-label="Завершити редагування"]') as HTMLButtonElement
      ).click(),
    );
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('does not replay initial Edit after mixed-media navigation #3294', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const navigation = { index: 0, count: 3, onPrevious: vi.fn(), onNext: vi.fn() };
    await act(async () =>
      root?.render(
        <MessageCardAttachmentPreviewDialog
          item={items[0]!}
          navigation={navigation}
          onClose={vi.fn()}
          initialAction="edit-image"
        />,
      ),
    );
    expect(consumeInitialAction).toHaveBeenCalledOnce();
    await act(async () =>
      root?.render(
        <MessageCardAttachmentPreviewDialog
          item={items[1]!}
          navigation={{ ...navigation, index: 1 }}
          onClose={vi.fn()}
          initialAction="edit-image"
        />,
      ),
    );
    await act(async () =>
      root?.render(
        <MessageCardAttachmentPreviewDialog
          item={items[0]!}
          navigation={navigation}
          onClose={vi.fn()}
          initialAction="edit-image"
        />,
      ),
    );
    expect(consumeInitialAction).toHaveBeenCalledOnce();
  });

  it('defaults the report panel to visible and preserves it across attachment types', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const navigation = { index: 0, count: items.length, onPrevious: vi.fn(), onNext: vi.fn() };
    const commonProps = {
      navigation,
      onClose: vi.fn(),
      reportDraft: { value: 'Чернетка', onChange: vi.fn() },
    };

    await act(async () =>
      root?.render(<MessageCardAttachmentPreviewDialog item={items[0]!} {...commonProps} />),
    );
    expect(
      container.querySelector('[data-report-visible]')?.getAttribute('data-report-visible'),
    ).toBe('true');

    await act(async () =>
      root?.render(
        <MessageCardAttachmentPreviewDialog
          item={items[1]!}
          {...commonProps}
          navigation={{ ...navigation, index: 1 }}
        />,
      ),
    );
    expect(
      container.querySelector('[data-renderer="video"]')?.getAttribute('data-report-visible'),
    ).toBe('true');

    await act(async () =>
      root?.render(
        <MessageCardAttachmentPreviewDialog
          item={items[3]!}
          {...commonProps}
          navigation={{ ...navigation, index: 3 }}
        />,
      ),
    );
    await act(async () =>
      root?.render(
        <MessageCardAttachmentPreviewDialog
          item={items[2]!}
          {...commonProps}
          navigation={{ ...navigation, index: 2 }}
        />,
      ),
    );
    expect(
      container.querySelector('[data-renderer="document"]')?.getAttribute('data-report-visible'),
    ).toBe('true');
  });

  it('persists report panel visibility across dialog mounts', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const props = {
      item: items[0]!,
      navigation: { index: 0, count: 1, onPrevious: vi.fn(), onNext: vi.fn() },
      onClose: vi.fn(),
      reportDraft: { value: 'Чернетка', onChange: vi.fn() },
    };

    await act(async () => root?.render(<MessageCardAttachmentPreviewDialog {...props} />));
    await act(async () =>
      (
        container?.querySelector(
          '[aria-label="Перемкнути панель розвіддонесення"]',
        ) as HTMLButtonElement
      ).click(),
    );

    expect(localStorage.getItem(reportVisibilityStorageKey)).toBe('false');
    act(() => root?.unmount());
    root = createRoot(container);
    await act(async () => root?.render(<MessageCardAttachmentPreviewDialog {...props} />));
    expect(
      container.querySelector('[data-report-visible]')?.getAttribute('data-report-visible'),
    ).toBe('false');

    await act(async () =>
      (
        container?.querySelector(
          '[aria-label="Перемкнути панель розвіддонесення"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(localStorage.getItem(reportVisibilityStorageKey)).toBe('true');
  });

  it('does not change the report preference outside report mode', async () => {
    localStorage.setItem(reportVisibilityStorageKey, 'true');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () =>
      root?.render(
        <MessageCardAttachmentPreviewDialog
          item={items[0]!}
          navigation={{ index: 0, count: 1, onPrevious: vi.fn(), onNext: vi.fn() }}
          onClose={vi.fn()}
        />,
      ),
    );
    await act(async () =>
      (
        container?.querySelector(
          '[aria-label="Перемкнути панель розвіддонесення"]',
        ) as HTMLButtonElement
      ).click(),
    );

    expect(localStorage.getItem(reportVisibilityStorageKey)).toBe('true');
  });

  it('does not overwrite the report panel preference when closing the dialog', async () => {
    localStorage.setItem(reportVisibilityStorageKey, 'true');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onClose = vi.fn();

    await act(async () =>
      root?.render(
        <MessageCardAttachmentPreviewDialog
          item={items[0]!}
          navigation={{ index: 0, count: 1, onPrevious: vi.fn(), onNext: vi.fn() }}
          onClose={onClose}
          reportDraft={{ value: 'Чернетка', onChange: vi.fn() }}
        />,
      ),
    );
    await act(async () =>
      (container?.querySelector('[aria-label="Закрити перегляд"]') as HTMLButtonElement).click(),
    );

    expect(onClose).toHaveBeenCalledOnce();
    expect(localStorage.getItem(reportVisibilityStorageKey)).toBe('true');
  });
});
