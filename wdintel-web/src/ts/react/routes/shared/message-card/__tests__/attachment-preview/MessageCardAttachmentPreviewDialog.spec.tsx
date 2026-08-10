/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageCardAttachmentPreviewDialog } from '../../attachment-preview/MessageCardAttachmentPreviewDialog';
import type { MessageCardPreviewItem } from '../../attachment-preview/message-card-preview.types';

vi.mock('@mui/material', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
}));

vi.mock('../../renderers/ImageAttachmentPreviewRenderer', () => ({
  ImageAttachmentPreviewRenderer: () => <div data-renderer="image" />,
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
});
