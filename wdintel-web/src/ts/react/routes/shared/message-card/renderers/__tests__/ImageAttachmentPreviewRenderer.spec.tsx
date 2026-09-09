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
import { act, Children, forwardRef, isValidElement, useLayoutEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const imageEditorMocks = vi.hoisted(() => ({ handleEscape: vi.fn(() => true) }));

vi.mock('../../../image-editor/ImageEditor.tsx', () => ({
  ImageEditor: ({
    registerEscapeHandler,
    onSaveReplacement,
  }: {
    registerEscapeHandler?: (handler: (() => boolean) | null) => void;
    onSaveReplacement: (result: { file: File }) => void;
    onSaveAsNew: (result: { file: File }) => void;
  }) => {
    useLayoutEffect(() => {
      if (!registerEscapeHandler) return;
      registerEscapeHandler(imageEditorMocks.handleEscape);
      return () => registerEscapeHandler(null);
    }, [registerEscapeHandler]);
    return (
      <div data-testid="mock-image-editor">
        <button
          aria-label="Застосувати редактор"
          onClick={() =>
            onSaveReplacement({ file: new File(['edited'], 'edited.png', { type: 'image/png' }) })
          }
        />
      </div>
    );
  },
}));

type DialogRecord = {
  disableRestoreFocus?: boolean;
  disableEscapeKeyDown?: boolean;
  fullScreen?: boolean;
  paperSx?: Record<string, unknown>;
  onClose?: (event: unknown, reason: 'backdropClick' | 'escapeKeyDown') => void;
};

const dialogProps: DialogRecord[] = [];
let latestActionProps: {
  copyStatus: 'idle' | 'copying' | 'copied' | 'error';
  canCopyImage: boolean;
  onCopyImage: () => void;
} | null = null;
let latestStageProps: {
  currentHref: string;
  zoom: number;
  pan: { x: number; y: number };
  onImageLoad: (image: HTMLImageElement) => void;
  onStartPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onStopPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
} | null = null;
const loadedImage = document.createElement('img');

Object.defineProperty(loadedImage, 'naturalWidth', { value: 24 });
Object.defineProperty(loadedImage, 'naturalHeight', { value: 16 });

vi.mock('@mui/material', () => ({
  Alert: ({ children }: { children?: ReactNode }) => <div role="alert">{children}</div>,
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CircularProgress: () => <div data-loading-spinner />,
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
  Divider: (props: Record<string, unknown>) => <hr {...props} />,
  IconButton: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
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
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useMediaQuery: () => false,
  useTheme: () => ({
    palette: { divider: '#000', text: { secondary: '#666' }, background: { default: '#fff' } },
  }),
}));

vi.mock('../../attachment-preview/message-card-preview-config.ts', () => ({
  getMessageCardAttachmentPreviewConfig: () => ({ disableRestoreFocus: true }),
}));

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewHeader.tsx', () => ({
  MessageCardAttachmentPreviewHeader: ({
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
    navigation: {
      index: number;
      count: number;
      disabled?: boolean;
      onPrevious: () => void;
      onNext: () => void;
    };
    additionalActions: ReactElement<{
      status: 'idle' | 'copying' | 'copied' | 'error';
      enabled: boolean;
      onCopy: () => void;
    }>;
    status?: ReactNode;
    onInfoClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    onClose: () => void;
  }) => {
    const copyAction = Children.toArray(additionalActions.props.children).find(
      (child) => isValidElement(child) && typeof child.props.onCopy === 'function',
    ) as ReactElement<{
      status: 'idle' | 'copying' | 'copied' | 'error';
      enabled: boolean;
      onCopy: () => void;
    }>;
    latestActionProps = {
      copyStatus: copyAction.props.status,
      canCopyImage: copyAction.props.enabled,
      onCopyImage: copyAction.props.onCopy,
    };
    const hasCarousel = navigation.count > 1;
    return (
      <div
        data-actions
        data-copy-status={copyAction.props.status}
        data-copy-enabled={String(copyAction.props.enabled)}
      >
        <button aria-label="Інформація" onClick={onInfoClick} />
        {additionalActions}
        <a aria-label="Відкрити в новій вкладці" href={openHref} />
        <a aria-label="Завантажити" download={download.fileName} href={download.href} />
        {status}
        {hasCarousel ? (
          <button
            aria-label="Попереднє"
            disabled={navigation.disabled}
            onClick={navigation.onPrevious}
          />
        ) : null}
        <span
          data-attachment-preview-counter
        >{`${navigation.index + 1} / ${navigation.count}`}</span>
        {hasCarousel ? (
          <button
            aria-label="Наступне"
            disabled={navigation.disabled}
            onClick={navigation.onNext}
          />
        ) : null}
        <button aria-label="Закрити" onClick={onClose} />
      </div>
    );
  },
}));

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewControls.tsx', () => ({
  AttachmentPreviewMobileCarouselNav: ({
    navigation,
  }: {
    navigation: { index: number; count: number; onPrevious: () => void; onNext: () => void };
  }) => (
    <div data-mobile-carousel>
      <button aria-label="Попереднє" onClick={navigation.onPrevious} />
      <span>{`${navigation.index + 1} / ${navigation.count}`}</span>
      <button aria-label="Наступне" onClick={navigation.onNext} />
    </div>
  ),
}));

vi.mock('../../attachment-preview/AttachmentPreviewZoomBadge.tsx', () => ({
  AttachmentPreviewZoomBadge: ({ zoom }: { zoom: number }) => (
    <div data-zoom-badge>{`${Math.round(zoom)}%`}</div>
  ),
}));

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewStage.tsx', () => ({
  MessageCardAttachmentPreviewStage: forwardRef<
    HTMLDivElement,
    {
      children?: ReactNode;
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
      onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => void;
      onDoubleClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
    }
  >(({ children, onPointerDown, onPointerUp, onPointerLeave, onDoubleClick }, ref) => {
    const image = (Array.isArray(children) ? children[0] : children) as ReactElement<{
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
      onDoubleClick,
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
        onDoubleClick={onDoubleClick}
      >
        {children}
      </div>
    );
  }),
}));

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewInfoPopover.tsx', () => ({
  MessageCardAttachmentPreviewInfoPopover: () => null,
}));

vi.mock('../../copy-image-to-clipboard.ts', () => ({
  canCopyImageToClipboard: vi.fn(() => true),
  copyImageToClipboard: vi.fn().mockResolvedValue(undefined),
}));

import { MessageCardAttachmentPreviewProvider } from '../../attachment-preview/MessageCardAttachmentPreviewProvider.tsx';
import { copyImageToClipboard } from '../../copy-image-to-clipboard.ts';
import { ImageAttachmentPreviewRenderer } from '../ImageAttachmentPreviewRenderer.tsx';
import type {
  ImageEditingCapability,
  ImageEditorSource,
} from '../../../image-editor/image-editor.types.ts';

type TestImagePreviewDialogProps = {
  imageHrefs: ComponentProps<typeof ImageAttachmentPreviewRenderer>['image'][];
  currentIndex?: number;
  initialIndex?: number;
  open: boolean;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  isDownloadStarting?: (downloadKey: string) => boolean;
  onDownloadStart?: (downloadKey: string) => boolean;
  imageEditing?: ImageEditingCapability;
  initialAction?: 'edit-image';
  reportDraft?: ComponentProps<typeof ImageAttachmentPreviewRenderer>['reportDraft'];
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
      imageEditing={props.imageEditing}
      initialAction={props.initialAction}
      reportDraft={props.reportDraft}
    />
  );
}

// @test-scope safeguard: prevents image evidence from losing bounded zoom/pan, editor Escape ownership, copy feedback, or fullscreen preview state
describe('ImageAttachmentPreviewRenderer', () => {
  afterEach(() => {
    dialogProps.splice(0);
    latestActionProps = null;
    latestStageProps = null;
    imageEditorMocks.handleEscape.mockClear();
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
    expect(dialog?.disableEscapeKeyDown).toBe(true);
    expect(dialog?.fullScreen).toBe(true);
    expect(dialog?.paperSx).toMatchObject({
      width: '100vw',
      height: '100svh',
      maxWidth: '100vw',
      maxHeight: '100svh',
    });
    root.unmount();
  });

  it('shows the shared report text field when opened from report mode', async () => {
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
          reportDraft={{ value: 'Текст із дровера', onChange: vi.fn() }}
        />,
      );
    });

    const textarea = document.body.querySelector(
      'textarea[aria-label="Текст розвіддонесення"]',
    ) as HTMLTextAreaElement | null;

    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe('Текст із дровера');
    expect(
      document.body.querySelector('button[aria-label="Сховати розвіддонесення"]'),
    ).not.toBeNull();

    const pane = document.body.querySelector('[data-attachment-preview-report-pane]');
    expect(pane?.classList.contains('overflow-visible')).toBe(true);
    root.unmount();
  });

  it('hides the toolbar divider when OCR and summary actions are unavailable', async () => {
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

    expect(container.querySelectorAll('hr')).toHaveLength(0);
    root.unmount();
  });

  it('uses fullscreen geometry and closes on one Escape', async () => {
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

    const fullscreenDialog = dialogProps.at(-1);
    expect(fullscreenDialog?.disableEscapeKeyDown).toBe(true);
    expect(fullscreenDialog?.fullScreen).toBe(true);
    expect(fullscreenDialog?.paperSx).toMatchObject({
      width: '100vw',
      height: '100svh',
      maxWidth: '100vw',
      maxHeight: '100svh',
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('keeps Escape in editor ownership while source and lazy editor loading complete', async () => {
    const onClose = vi.fn();
    const loadSource = vi.fn<(image: unknown, signal: AbortSignal) => Promise<ImageEditorSource>>();
    let resolveSource: (source: ImageEditorSource) => void;
    loadSource.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSource = resolve;
        }),
    );
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
          initialAction="edit-image"
          imageEditing={{
            canEdit: () => true,
            loadSource,
            applyReplacement: vi.fn(),
            addAsNew: vi.fn(),
          }}
        />,
      );
    });
    await vi.waitFor(() => expect(loadSource).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveSource!({ blob: new Blob(['source']), fileName: 'photo.jpg', mimeType: 'image/jpeg' });
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="mock-image-editor"]')).not.toBeNull(),
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(imageEditorMocks.handleEscape).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    root.unmount();
  });

  it('releases loading Escape ownership after a current source failure #3099', async () => {
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
          initialAction="edit-image"
          imageEditing={{
            canEdit: () => true,
            loadSource: vi.fn().mockRejectedValue(new Error('source failed')),
            applyReplacement: vi.fn(),
            addAsNew: vi.fn(),
          }}
        />,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain('source failed'));
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(onClose).toHaveBeenCalledOnce();
    act(() => root.unmount());
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

  it('keeps wheel zoom attached to the stage', async () => {
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
      stage.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, clientX: 500, clientY: 300 }),
      );
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
    expect(latestStageProps?.pan.y).toBeCloseTo(-300, 6);

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

  it('keeps the carousel counter and header visible in fullscreen', async () => {
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

    expect(document.body.querySelector('[data-actions]')).not.toBeNull();
    root.unmount();
  });
});
