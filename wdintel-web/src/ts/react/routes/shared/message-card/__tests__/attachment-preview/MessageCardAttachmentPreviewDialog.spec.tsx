/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageCardAttachmentPreviewDialog } from '../../attachment-preview/MessageCardAttachmentPreviewDialog';
import type { MessageCardPreviewItem } from '../../attachment-preview/message-card-preview.types';

vi.mock('@mui/material', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
}));

const imageEditorEscapeHandler = vi.fn(() => false);
const consumeInitialAction = vi.fn();

vi.mock('../../renderers/ImageAttachmentPreviewRenderer', () => ({
  ImageAttachmentPreviewRenderer: ({
    registerEditorEscapeHandler,
    onEditModeChange,
    initialAction,
    onInitialActionConsumed,
  }: {
    registerEditorEscapeHandler?: (handler: (event: KeyboardEvent) => boolean) => void;
    onEditModeChange?: (editing: boolean) => void;
    initialAction?: 'edit-image';
    onInitialActionConsumed?: () => void;
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
      <div data-renderer="image">
        <button aria-label="Почати редагування" onClick={() => onEditModeChange?.(true)} />
        <button aria-label="Завершити редагування" onClick={() => onEditModeChange?.(false)} />
        <input data-image-editor-local-escape onKeyDown={(event) => event.stopPropagation()} />
      </div>
    );
  },
}));

vi.mock('../../renderers/VideoAttachmentPreviewRenderer', () => ({
  VideoAttachmentPreviewRenderer: () => <div data-renderer="video" />,
}));

vi.mock('../../renderers/DocumentAttachmentPreviewRenderer', () => ({
  DocumentAttachmentPreviewRenderer: () => <div data-renderer="document" />,
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

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    imageEditorEscapeHandler.mockClear();
    consumeInitialAction.mockClear();
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
});
