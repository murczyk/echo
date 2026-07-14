/**
 * @vitest-environment happy-dom
 */
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { act, forwardRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type DialogRecord = {
  disableRestoreFocus?: boolean;
  disableEscapeKeyDown?: boolean;
  fullScreen?: boolean;
  paperSx?: Record<string, unknown>;
  onClose?: (event: unknown, reason: 'backdropClick' | 'escapeKeyDown') => void;
};

const dialogProps: DialogRecord[] = [];
let previewConfig = {
  layout: 'media' as const,
  disableRestoreFocus: true,
  supportsFullscreen: true,
  disableEscapeKeyDownInFullscreen: true,
};
let latestActionProps: {
  copyStatus: 'idle' | 'copying' | 'copied' | 'error';
  canCopyImage: boolean;
  onCopyImage: () => void;
} | null = null;
let latestControlsProps: {
  zoom: number;
  isFullscreen: boolean;
  canFullscreen: boolean;
  onSetPreviewZoom: (zoom: number) => void;
  onToggleFullscreen: () => void;
} | null = null;
let latestStageProps: {
  currentHref: string;
  zoom: number;
  pan: { x: number; y: number };
  onImageLoad: (image: HTMLImageElement) => void;
  onStartPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onStopPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onExitFullscreen: () => void;
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
    disableEscapeKeyDown,
    fullScreen,
    PaperProps,
    onClose,
  }: {
    children?: ReactNode;
    open?: boolean;
    disableRestoreFocus?: boolean;
    disableEscapeKeyDown?: boolean;
    fullScreen?: boolean;
    PaperProps?: { sx?: Record<string, unknown> };
    onClose?: (event: unknown, reason: 'backdropClick' | 'escapeKeyDown') => void;
  }) => {
    if (open) {
      dialogProps.push({
        disableRestoreFocus,
        disableEscapeKeyDown,
        fullScreen,
        paperSx: PaperProps?.sx,
        onClose,
      });
    }
    return open ? <div role="dialog">{children}</div> : null;
  },
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useTheme: () => ({
    palette: { divider: '#000', text: { secondary: '#666' }, background: { default: '#fff' } },
  }),
}));

vi.mock('./message-card-preview-config', () => ({
  getMessageCardPreviewShellConfig: () => previewConfig,
}));

vi.mock('./MessageCardImagePreviewActions', () => ({
  MessageCardImagePreviewActions: ({
    currentHref,
    downloadFileName,
    hasCarousel,
    copyStatus,
    canCopyImage,
    onCopyImage,
    resolvedIndex,
    imageCount,
    onGoToPrevious,
    onGoToNext,
    onInfoClick,
    onClose,
  }: {
    currentHref: string;
    downloadFileName: string;
    hasCarousel: boolean;
    copyStatus: 'idle' | 'copying' | 'copied' | 'error';
    canCopyImage: boolean;
    onCopyImage: () => void;
    resolvedIndex: number;
    imageCount: number;
    onGoToPrevious: () => void;
    onGoToNext: () => void;
    onInfoClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    onClose: () => void;
  }) => {
    latestActionProps = { copyStatus, canCopyImage, onCopyImage };
    return (
      <div data-actions data-copy-status={copyStatus} data-copy-enabled={String(canCopyImage)}>
        <button aria-label="Інформація" onClick={onInfoClick} />
        <button aria-label="Скопіювати зображення" onClick={onCopyImage} />
        <a aria-label="Відкрити в новій вкладці" href={currentHref} />
        <a aria-label="Завантажити" download={downloadFileName} href={currentHref} />
        {hasCarousel ? <button aria-label="Попереднє" onClick={onGoToPrevious} /> : null}
        <span data-image-preview-counter>{`${resolvedIndex + 1} / ${imageCount}`}</span>
        {hasCarousel ? <button aria-label="Наступне" onClick={onGoToNext} /> : null}
        <button aria-label="Закрити" onClick={onClose} />
      </div>
    );
  },
  MessageCardImagePreviewControls: ({
    zoom,
    isFullscreen,
    canFullscreen,
    onSetPreviewZoom,
    onToggleFullscreen,
  }: {
    zoom: number;
    isFullscreen: boolean;
    canFullscreen: boolean;
    onSetPreviewZoom: (zoom: number) => void;
    onToggleFullscreen: () => void;
  }) => {
    latestControlsProps = {
      zoom,
      isFullscreen,
      canFullscreen,
      onSetPreviewZoom,
      onToggleFullscreen,
    };
    return (
      <div data-controls data-zoom={zoom} data-fullscreen={String(isFullscreen)}>
        <button aria-label="Збільшити" onClick={() => onSetPreviewZoom(zoom + 10)} />
        {canFullscreen ? (
          <button
            aria-label={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
            onClick={onToggleFullscreen}
          />
        ) : null}
      </div>
    );
  },
}));

vi.mock('./MessageCardImagePreviewStage', () => ({
  MessageCardImagePreviewStage: forwardRef<
    HTMLDivElement,
    {
      currentHref: string;
      zoom: number;
      pan: { x: number; y: number };
      onImageLoad: (image: HTMLImageElement) => void;
      onStartPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
      onStopPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
      onExitFullscreen: () => void;
    }
  >(({ currentHref, zoom, pan, onImageLoad, onStartPan, onStopPan, onExitFullscreen }, ref) => {
    latestStageProps = {
      currentHref,
      zoom,
      pan,
      onImageLoad,
      onStartPan,
      onStopPan,
      onExitFullscreen,
    };
    return (
      <div
        ref={ref}
        data-stage={currentHref}
        data-zoom={String(zoom)}
        data-pan-x={String(pan.x)}
        data-pan-y={String(pan.y)}
        onPointerDown={onStartPan}
        onPointerUp={onStopPan}
        onPointerLeave={onStopPan}
      />
    );
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
    previewConfig = {
      layout: 'media',
      disableRestoreFocus: true,
      supportsFullscreen: true,
      disableEscapeKeyDownInFullscreen: true,
    };
    latestActionProps = null;
    latestControlsProps = null;
    latestStageProps = null;
    document.body.innerHTML = '';
    vi.mocked(copyImageToClipboard).mockReset();
    vi.mocked(copyImageToClipboard).mockResolvedValue(undefined);
  });

  it('passes media layout sizing and keeps restore focus disabled', async () => {
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

    const dialog = dialogProps.at(-1);
    expect(dialog?.disableRestoreFocus).toBe(true);
    expect(dialog?.disableEscapeKeyDown).toBe(false);
    expect(dialog?.fullScreen).toBe(false);
    expect(dialog?.paperSx).toMatchObject({
      width: { xs: '96vw', sm: '92vw' },
      height: '92svh',
      maxWidth: 'min(92vw, 1280px)',
      maxHeight: '92svh',
    });
    root.unmount();
  });

  it('uses fullscreen geometry and keeps escape handling inside the dialog', async () => {
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageImagePreviewDialog
          imageHrefs={[{ href: 'https://example.test/image.png' } as never]}
          open
          onClose={onClose}
          onIndexChange={vi.fn()}
        />,
      );
    });

    await act(async () => {
      latestControlsProps?.onToggleFullscreen();
    });

    const fullscreenDialog = dialogProps.at(-1);
    expect(fullscreenDialog?.disableEscapeKeyDown).toBe(true);
    expect(fullscreenDialog?.fullScreen).toBe(true);
    expect(fullscreenDialog?.paperSx).toMatchObject({
      width: '100vw',
      height: '100svh',
      maxWidth: '100vw',
      maxHeight: '100svh',
    });

    const fullscreenToggle = document.body.querySelector(
      '[aria-label="Вийти з повноекранного режиму"]',
    ) as HTMLButtonElement;
    fullscreenToggle.focus();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(fullscreenToggle);
    expect(document.body.querySelector('[data-controls]')?.getAttribute('data-fullscreen')).toBe(
      'false',
    );
    root.unmount();
  });

  it('does not enter fullscreen when the config disables it', async () => {
    previewConfig = {
      layout: 'media',
      disableRestoreFocus: true,
      supportsFullscreen: false,
      disableEscapeKeyDownInFullscreen: true,
    };

    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageImagePreviewDialog
          imageHrefs={[{ href: 'https://example.test/image.png' } as never]}
          open
          onClose={onClose}
          onIndexChange={vi.fn()}
        />,
      );
    });

    expect(latestControlsProps?.canFullscreen).toBe(false);
    expect(document.body.querySelector('[aria-label="Повноекранний режим"]')).toBeNull();
    expect(dialogProps.at(-1)?.fullScreen).toBe(false);
    expect(dialogProps.at(-1)?.disableEscapeKeyDown).toBe(false);
    expect(document.body.querySelector('[data-actions]')).not.toBeNull();

    await act(async () => {
      latestControlsProps?.onToggleFullscreen();
    });

    expect(latestControlsProps?.isFullscreen).toBe(false);
    expect(dialogProps.at(-1)?.fullScreen).toBe(false);

    await act(async () => {
      dialogProps.at(-1)?.onClose?.({} as never, 'escapeKeyDown');
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('closes from backdrop and escape outside fullscreen, including blur reset', async () => {
    const onClose = vi.fn();
    const blurSpy = vi.spyOn(HTMLElement.prototype, 'blur');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageImagePreviewDialog
          imageHrefs={[{ href: 'https://example.test/image.png' } as never]}
          open
          onClose={onClose}
          onIndexChange={vi.fn()}
        />,
      );
    });

    await act(async () => {
      latestControlsProps?.onSetPreviewZoom(180);
    });

    const closeButton = document.body.querySelector('[aria-label="Закрити"]') as HTMLButtonElement;
    closeButton.focus();
    const close = dialogProps.at(-1)?.onClose;

    await act(async () => {
      close?.({}, 'escapeKeyDown');
    });

    expect(blurSpy).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(closeButton);
    expect(document.body.querySelector('[data-controls]')?.getAttribute('data-zoom')).toBe('100');

    await act(async () => {
      root.render(
        <MessageImagePreviewDialog
          imageHrefs={[{ href: 'https://example.test/image.png' } as never]}
          open
          onClose={onClose}
          onIndexChange={vi.fn()}
        />,
      );
    });

    const backdropClose = dialogProps.at(-1)?.onClose;
    await act(async () => {
      backdropClose?.({}, 'backdropClick');
    });

    expect(onClose).toHaveBeenCalledTimes(2);
    blurSpy.mockRestore();
    root.unmount();
  });

  it('keeps wheel zoom attached to the stage and not the controls', async () => {
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

    await act(async () => {
      latestStageProps?.onImageLoad(loadedImage);
      await Promise.resolve();
    });

    const stage = document.body.querySelector('[data-stage]') as HTMLDivElement;
    const controls = document.body.querySelector('[data-controls]') as HTMLDivElement;

    expect(stage.getAttribute('data-zoom')).toBe('100');

    await act(async () => {
      controls.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
    });

    expect(stage.getAttribute('data-zoom')).toBe('100');

    await act(async () => {
      stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
    });

    expect(stage.getAttribute('data-zoom')).toBe('125');
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

  it('keeps the carousel counter and fullscreen action hiding intact', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

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

    expect(document.body.querySelector('[data-image-preview-counter]')?.textContent).toBe('2 / 2');
    expect(document.body.querySelector('[data-actions]')).not.toBeNull();

    await act(async () => {
      latestControlsProps?.onToggleFullscreen();
    });

    expect(document.body.querySelector('[data-actions]')).toBeNull();
    root.unmount();
  });
});
