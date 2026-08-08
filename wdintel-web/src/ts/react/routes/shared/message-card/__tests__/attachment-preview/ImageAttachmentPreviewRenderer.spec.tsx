/**
 * @vitest-environment happy-dom
 */
import type {
  ComponentProps,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
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
  IconButton: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useTheme: () => ({
    palette: { divider: '#000', text: { secondary: '#666' }, background: { default: '#fff' } },
  }),
}));

vi.mock('../../attachment-preview/message-card-preview-config', () => ({
  getMessageCardAttachmentPreviewConfig: () => previewConfig,
}));

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewActions', () => ({
  MessageCardAttachmentPreviewActions: ({
    openHref,
    download,
    navigation,
    additionalActions,
    status,
    onInfoClick,
    onClose,
  }: {
    openHref: string;
    download: { href: string; fileName: string };
    navigation: { index: number; count: number; onPrevious: () => void; onNext: () => void };
    additionalActions: ReactElement<{
      status: 'idle' | 'copying' | 'copied' | 'error';
      enabled: boolean;
      onCopy: () => void;
    }>;
    status?: ReactNode;
    onInfoClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    onClose: () => void;
  }) => {
    latestActionProps = {
      copyStatus: additionalActions.props.status,
      canCopyImage: additionalActions.props.enabled,
      onCopyImage: additionalActions.props.onCopy,
    };
    const hasCarousel = navigation.count > 1;
    return (
      <div
        data-actions
        data-copy-status={additionalActions.props.status}
        data-copy-enabled={String(additionalActions.props.enabled)}
      >
        <button aria-label="Інформація" onClick={onInfoClick} />
        {additionalActions}
        <a aria-label="Відкрити в новій вкладці" href={openHref} />
        <a aria-label="Завантажити" download={download.fileName} href={download.href} />
        {status}
        {hasCarousel ? <button aria-label="Попереднє" onClick={navigation.onPrevious} /> : null}
        <span
          data-attachment-preview-counter
        >{`${navigation.index + 1} / ${navigation.count}`}</span>
        {hasCarousel ? <button aria-label="Наступне" onClick={navigation.onNext} /> : null}
        <button aria-label="Закрити" onClick={onClose} />
      </div>
    );
  },
}));

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewControls', () => ({
  AttachmentPreviewZoomControls: ({
    zoom,
    isFullscreen,
    canFullscreen,
    onZoomChange,
    onToggleFullscreen,
  }: {
    zoom: number;
    isFullscreen: boolean;
    canFullscreen: boolean;
    onZoomChange: (zoom: number) => void;
    onToggleFullscreen: () => void;
  }) => {
    latestControlsProps = {
      zoom,
      isFullscreen,
      canFullscreen,
      onSetPreviewZoom: onZoomChange,
      onToggleFullscreen,
    };
    return (
      <div data-controls data-zoom={zoom} data-fullscreen={String(isFullscreen)}>
        <button aria-label="Збільшити" onClick={() => onZoomChange(zoom + 10)} />
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

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewStage', () => ({
  MessageCardAttachmentPreviewStage: forwardRef<
    HTMLDivElement,
    {
      children?: ReactNode;
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
      onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => void;
    }
  >(({ children, onPointerDown, onPointerUp, onPointerLeave }, ref) => {
    const image = children as ReactElement<{
      href: string;
      zoom: number;
      pan: { x: number; y: number };
      onLoad: (image: HTMLImageElement) => void;
    }>;
    latestStageProps = {
      currentHref: image.props.href,
      zoom: image.props.zoom,
      pan: image.props.pan,
      onImageLoad: image.props.onLoad,
      onStartPan: onPointerDown,
      onStopPan: onPointerUp,
    };
    return (
      <div
        ref={ref}
        data-stage={latestStageProps?.currentHref}
        data-zoom={String(latestStageProps?.zoom)}
        data-pan-x={String(latestStageProps?.pan.x)}
        data-pan-y={String(latestStageProps?.pan.y)}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
      >
        {children}
      </div>
    );
  }),
}));

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewInfoPopover', () => ({
  MessageCardAttachmentPreviewInfoPopover: () => null,
}));

vi.mock('../../copy-image-to-clipboard', () => ({
  canCopyImageToClipboard: vi.fn(() => true),
  copyImageToClipboard: vi.fn().mockResolvedValue(undefined),
}));

import { MessageCardAttachmentPreviewProvider } from '../../attachment-preview/MessageCardAttachmentPreviewProvider';
import { copyImageToClipboard } from '../../copy-image-to-clipboard';
import { ImageAttachmentPreviewRenderer } from '../../renderers/ImageAttachmentPreviewRenderer';

type TestImagePreviewDialogProps = {
  imageHrefs: ComponentProps<typeof ImageAttachmentPreviewRenderer>['image'][];
  currentIndex?: number;
  initialIndex?: number;
  open: boolean;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  isDownloadStarting?: (downloadKey: string) => boolean;
  onDownloadStart?: (downloadKey: string) => boolean;
};

function TestImagePreviewDialog(props: TestImagePreviewDialogProps) {
  if (!props.open) return null;

  return (
    <MessageCardAttachmentPreviewProvider
      attachments={props.imageHrefs.map((image) => ({ type: 'image', value: image }))}
      initialIndex={props.currentIndex ?? props.initialIndex ?? 0}
      onClose={props.onClose}
      onIndexChange={props.onIndexChange}
      isDownloadStarting={props.isDownloadStarting}
      onDownloadStart={props.onDownloadStart}
    />
  );
}

describe('ImageAttachmentPreviewRenderer', () => {
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
        <TestImagePreviewDialog
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
      width: { xs: '100vw', sm: '92vw' },
      height: { xs: '100svh', sm: '92svh' },
      maxWidth: { xs: '100vw', sm: 'min(92vw, 1280px)' },
      maxHeight: { xs: '100svh', sm: '92svh' },
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
        <TestImagePreviewDialog
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
        <TestImagePreviewDialog
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

  it('closes from backdrop and escape outside fullscreen, including blur', async () => {
    const onClose = vi.fn();
    const blurSpy = vi.spyOn(HTMLElement.prototype, 'blur');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TestImagePreviewDialog
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
    await act(async () => {
      root.render(
        <TestImagePreviewDialog
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
        <TestImagePreviewDialog
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

    expect(Number(stage.getAttribute('data-zoom'))).toBeCloseTo(100.1501, 3);
    root.unmount();
  });

  it('preserves the image point under an off-centre wheel cursor', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TestImagePreviewDialog
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
    Object.defineProperties(stage, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 400 },
    });
    stage.getBoundingClientRect = () =>
      ({ left: 100, top: 100, width: 800, height: 400 }) as DOMRect;

    await act(async () => {
      latestControlsProps?.onSetPreviewZoom(200);
    });

    await act(async () => {
      const wheelEvent = new WheelEvent('wheel', { bubbles: true, deltaY: -10 });
      Object.defineProperties(wheelEvent, {
        clientX: { value: 600 },
        clientY: { value: 300 },
      });
      stage.dispatchEvent(wheelEvent);
    });

    const nextZoom = 200 * Math.exp(10 * 0.0015);
    expect(latestStageProps?.zoom).toBeCloseTo(nextZoom, 8);
    expect(latestStageProps?.pan.x).toBeCloseTo(100 - (nextZoom / 200) * 100, 8);
    expect(latestStageProps?.pan.y).toBe(0);
    root.unmount();
  });

  it('uses fitted image dimensions after the image loads for wheel pan clamping', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TestImagePreviewDialog
          imageHrefs={[{ href: 'https://example.test/image.png' } as never]}
          open
          onClose={vi.fn()}
          onIndexChange={vi.fn()}
        />,
      );
    });

    const stage = document.body.querySelector('[data-stage]') as HTMLDivElement;
    Object.defineProperties(stage, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    stage.getBoundingClientRect = () =>
      ({ left: 100, top: 100, width: 800, height: 600 }) as DOMRect;

    await act(async () => {
      latestStageProps?.onImageLoad(loadedImage);
      await Promise.resolve();
    });

    const wheelToZoom = (deltaY: number) => {
      const wheelEvent = new WheelEvent('wheel', { bubbles: true, deltaY });
      Object.defineProperties(wheelEvent, {
        clientX: { value: 500 },
        clientY: { value: 700 },
      });
      stage.dispatchEvent(wheelEvent);
    };

    await act(async () => {
      wheelToZoom(-Math.log(2) / 0.0015);
    });

    expect(latestStageProps?.zoom).toBeCloseTo(200, 8);
    expect(latestStageProps?.pan.y).toBeCloseTo(-233 - 1 / 3, 6);

    await act(async () => {
      wheelToZoom(-Math.log(2) / 0.0015);
    });

    expect(latestStageProps?.zoom).toBeCloseTo(400, 8);
    expect(latestStageProps?.pan.y).toBeCloseTo(-766 - 2 / 3, 6);
    root.unmount();
  });

  it('shows copy errors and resets the status when the carousel index changes', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    vi.mocked(copyImageToClipboard).mockRejectedValueOnce(new Error('copy failed'));

    await act(async () => {
      root.render(
        <TestImagePreviewDialog
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
        <TestImagePreviewDialog
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
        <TestImagePreviewDialog
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

    expect(document.body.querySelector('[data-attachment-preview-counter]')?.textContent).toBe(
      '2 / 2',
    );
    expect(document.body.querySelector('[data-actions]')).not.toBeNull();

    await act(async () => {
      latestControlsProps?.onToggleFullscreen();
    });

    expect(document.body.querySelector('[data-actions]')).toBeNull();
    root.unmount();
  });
});
