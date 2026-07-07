/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act, forwardRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dialogProps: Array<{ disableRestoreFocus?: boolean }> = [];
let latestActionProps: {
  copyStatus: 'idle' | 'copying' | 'copied' | 'error';
  canCopyImage: boolean;
  onCopyImage: () => void;
} | null = null;
let latestStageProps: {
  currentHref: string;
  onImageLoad: (image: HTMLImageElement) => void;
} | null = null;
const loadedImage = document.createElement('img');

Object.defineProperty(loadedImage, 'naturalWidth', { value: 24 });
Object.defineProperty(loadedImage, 'naturalHeight', { value: 16 });

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
  MessageCardImagePreviewActions: ({
    copyStatus,
    canCopyImage,
    onCopyImage,
  }: {
    copyStatus: 'idle' | 'copying' | 'copied' | 'error';
    canCopyImage: boolean;
    onCopyImage: () => void;
  }) => {
    latestActionProps = { copyStatus, canCopyImage, onCopyImage };
    return (
      <div data-copy-status={copyStatus} data-copy-enabled={String(canCopyImage)}>
        <button aria-label="Скопіювати зображення" onClick={onCopyImage} />
      </div>
    );
  },
  MessageCardImagePreviewControls: () => <div />,
}));

vi.mock('./MessageCardImagePreviewStage', () => ({
  MessageCardImagePreviewStage: forwardRef<
    HTMLDivElement,
    {
      currentHref: string;
      onImageLoad: (image: HTMLImageElement) => void;
    }
  >(({ currentHref, onImageLoad }, ref) => {
    latestStageProps = { currentHref, onImageLoad };
    return <div ref={ref} data-stage={currentHref} />;
  }),
}));

vi.mock('./MessageCardImagePreviewInfoPopover', () => ({
  MessageCardImagePreviewInfoPopover: () => null,
}));

vi.mock('./copy-image-to-clipboard', () => ({
  canCopyImageToClipboard: vi.fn(() => true),
  copyImageToClipboard: vi.fn().mockResolvedValue(undefined),
}));

import { MessageImagePreviewDialog } from './MessageCardImagePreviewDialog';
import { copyImageToClipboard } from './copy-image-to-clipboard';

describe('MessageImagePreviewDialog', () => {
  afterEach(() => {
    dialogProps.splice(0);
    latestActionProps = null;
    latestStageProps = null;
    document.body.innerHTML = '';
    vi.mocked(copyImageToClipboard).mockReset();
    vi.mocked(copyImageToClipboard).mockResolvedValue(undefined);
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

  it('shows copy errors and resets the status when the carousel index changes', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    vi.mocked(copyImageToClipboard).mockRejectedValueOnce(new Error('copy failed'));

    await act(async () => {
      root.render(
        <MessageImagePreviewDialog
          imageHrefs={[
            { href: 'https://example.test/image-1.png' } as never,
            { href: 'https://example.test/image-2.png' } as never,
          ]}
          currentIndex={0}
          open
          onClose={vi.fn()}
          onIndexChange={vi.fn()}
        />,
      );
    });

    await act(async () => {
      latestStageProps?.onImageLoad(loadedImage);
      await Promise.resolve();
    });

    expect(latestActionProps).not.toBeNull();

    await act(async () => {
      await latestActionProps?.onCopyImage();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      document.body.querySelector('[data-copy-status]')?.getAttribute('data-copy-status'),
    ).toBe('error');

    await act(async () => {
      root.render(
        <MessageImagePreviewDialog
          imageHrefs={[
            { href: 'https://example.test/image-1.png' } as never,
            { href: 'https://example.test/image-2.png' } as never,
          ]}
          currentIndex={1}
          open
          onClose={vi.fn()}
          onIndexChange={vi.fn()}
        />,
      );
    });

    await act(async () => {
      latestStageProps?.onImageLoad(loadedImage);
      await Promise.resolve();
    });

    expect(
      document.body.querySelector('[data-copy-status]')?.getAttribute('data-copy-status'),
    ).toBe('idle');
    root.unmount();
  });
});
