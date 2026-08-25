/**
 * @vitest-environment happy-dom
 */
import type { ComponentProps, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VideoPlayerState, VideoPreviewSource } from '../../message-card-video-utils';

const authRedirectMocks = vi.hoisted(() => ({
  emitUnauthorizedEvent: vi.fn(),
}));

vi.mock('../../../../../auth-redirect', () => authRedirectMocks);

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
  disableRestoreFocus: false,
  supportsFullscreen: true,
  disableEscapeKeyDownInFullscreen: true,
};
let latestControlsProps: {
  playerState: VideoPlayerState;
  canFullscreen: boolean;
  onPlayPause: () => void;
  onStop: () => void;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  onRateChange: (rate: 0.5 | 1 | 1.5 | 2) => void;
  onSeek: (time: number) => void;
  onToggleFullscreen: () => void;
} | null = null;
let latestActionProps: {
  hasCarousel: boolean;
  resolvedIndex: number;
  videoCount: number;
  openHref?: string | null;
  isFullscreen: boolean;
  onGoToPrevious: () => void;
  onGoToNext: () => void;
  onInfoClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onClose: () => void;
} | null = null;
let latestInfoProps: {
  open: boolean;
  duration: number;
} | null = null;

vi.mock('@mui/material', () => ({
  Box: ({ children, sx, ...props }: { children?: ReactNode; sx?: unknown }) => (
    <div {...props}>{children}</div>
  ),
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  CircularProgress: () => <div data-loading="true" />,
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
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  IconButton: ({
    children,
    onClick,
    'aria-label': ariaLabel,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'aria-label'?: string;
    disabled?: boolean;
  }) => (
    <button aria-label={ariaLabel} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Popover: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Slider: () => <div />,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@mui/icons-material/PlayArrow', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/Pause', () => ({ default: () => <span /> }));

vi.mock('../../attachment-preview/message-card-preview-config', () => ({
  getMessageCardAttachmentPreviewConfig: () => previewConfig,
}));

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewStage', () => ({
  MessageCardAttachmentPreviewStage: ({
    children,
    onDoubleClick,
  }: {
    children?: ReactNode;
    onDoubleClick?: () => void;
  }) => (
    <div data-video-stage onDoubleClick={onDoubleClick}>
      {children}
    </div>
  ),
}));

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewControls', () => ({
  AttachmentPreviewPlaybackControls: ({
    playerState,
    canFullscreen,
    onPlayPause,
    onStop,
    onVolumeChange,
    onMuteToggle,
    onRateChange,
    onSeek,
    onToggleFullscreen,
  }: {
    playerState: VideoPlayerState;
    canFullscreen: boolean;
    onPlayPause: () => void;
    onStop: () => void;
    onVolumeChange: (volume: number) => void;
    onMuteToggle: () => void;
    onRateChange: (rate: 0.5 | 1 | 1.5 | 2) => void;
    onSeek: (time: number) => void;
    onToggleFullscreen: () => void;
  }) => {
    latestControlsProps = {
      playerState,
      canFullscreen,
      onPlayPause,
      onStop,
      onVolumeChange,
      onMuteToggle,
      onRateChange,
      onSeek,
      onToggleFullscreen,
    };

    return (
      <div
        data-controls
        data-playing={String(playerState.isPlaying)}
        data-time={playerState.currentTime}
        data-volume={playerState.volume}
        data-muted={String(playerState.muted)}
        data-rate={playerState.playbackRate}
        data-fullscreen={String(playerState.isFullscreen)}
      >
        <button aria-label="play-pause" onClick={onPlayPause} />
        <button aria-label="stop" onClick={onStop} />
        <button aria-label="mute" onClick={onMuteToggle} />
        {canFullscreen ? <button aria-label="fullscreen" onClick={onToggleFullscreen} /> : null}
      </div>
    );
  },
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

vi.mock('../../attachment-preview/AttachmentPreviewZoomBadge', () => ({
  AttachmentPreviewZoomBadge: ({ zoom }: { zoom: number }) => (
    <div data-zoom-badge>{`${Math.round(zoom)}%`}</div>
  ),
}));

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewHeader', () => ({
  MessageCardAttachmentPreviewHeader: ({
    openHref,
    navigation,
    onInfoClick,
    isFullscreen,
    canFullscreen,
    onToggleFullscreen,
    onClose,
  }: {
    openHref?: string | null;
    navigation: { index: number; count: number; onPrevious: () => void; onNext: () => void };
    onInfoClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    isFullscreen: boolean;
    canFullscreen: boolean;
    onToggleFullscreen: () => void;
    onClose: () => void;
  }) => {
    const hasCarousel = navigation.count > 1;
    latestActionProps = {
      openHref,
      hasCarousel,
      resolvedIndex: navigation.index,
      videoCount: navigation.count,
      isFullscreen,
      onGoToPrevious: navigation.onPrevious,
      onGoToNext: navigation.onNext,
      onInfoClick,
      onClose,
    };

    return (
      <div data-actions>
        <button aria-label="Інформація" onClick={onInfoClick} />
        {typeof openHref === 'string' && openHref.trim() !== '' ? (
          <a aria-label="Відкрити в новій вкладці" href={openHref} />
        ) : null}
        <button aria-label="Скачати" />
        {canFullscreen ? (
          <button
            aria-label={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
            onClick={onToggleFullscreen}
          />
        ) : null}
        {hasCarousel ? <button aria-label="Попереднє" onClick={navigation.onPrevious} /> : null}
        {hasCarousel ? (
          <span
            data-attachment-preview-counter
          >{`${navigation.index + 1} / ${navigation.count}`}</span>
        ) : null}
        {hasCarousel ? <button aria-label="Наступне" onClick={navigation.onNext} /> : null}
        <button aria-label="Закрити" onClick={onClose} />
      </div>
    );
  },
}));

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewInfoPopover', () => ({
  MessageCardAttachmentPreviewInfoPopover: ({ open }: { open: boolean }) => {
    latestInfoProps = { open, duration: 0 };
    return open ? <div data-info-open="true" /> : null;
  },
}));

import { MessageCardAttachmentPreviewProvider } from '../../attachment-preview/MessageCardAttachmentPreviewProvider';
import { VideoAttachmentPreviewRenderer } from '../../renderers/VideoAttachmentPreviewRenderer';

type TestVideoPreviewDialogProps = {
  videos: ComponentProps<typeof VideoAttachmentPreviewRenderer>['video'][];
  currentIndex?: number;
  initialIndex?: number;
  open: boolean;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  isDownloadStarting: (downloadKey: string) => boolean;
  onDownloadStart: (downloadKey: string) => boolean;
};

function TestVideoPreviewDialog(props: TestVideoPreviewDialogProps) {
  if (!props.open) return null;

  return (
    <MessageCardAttachmentPreviewProvider
      attachments={props.videos.map((video) => ({ type: 'video', value: video }))}
      initialIndex={props.currentIndex ?? props.initialIndex ?? 0}
      onClose={props.onClose}
      onIndexChange={props.onIndexChange}
      isDownloadStarting={props.isDownloadStarting}
      onDownloadStart={props.onDownloadStart}
    />
  );
}

describe('VideoAttachmentPreviewRenderer', () => {
  afterEach(() => {
    vi.useRealTimers();
    dialogProps.splice(0);
    previewConfig = {
      layout: 'media',
      disableRestoreFocus: false,
      supportsFullscreen: true,
      disableEscapeKeyDownInFullscreen: true,
    };
    latestControlsProps = null;
    latestActionProps = null;
    latestInfoProps = null;
    authRedirectMocks.emitUnauthorizedEvent.mockReset();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderDialog({
    open = true,
    onClose = vi.fn(),
    onIndexChange = vi.fn(),
    videos,
    currentIndex,
  }: {
    open?: boolean;
    onClose?: () => void;
    onIndexChange?: (index: number) => void;
    videos: VideoPreviewSource[];
    currentIndex?: number;
  }) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <TestVideoPreviewDialog
          open={open}
          onClose={onClose}
          videos={videos}
          currentIndex={currentIndex}
          onIndexChange={onIndexChange}
        />,
      );
    });

    return { root, onClose, onIndexChange };
  }

  it('passes media layout sizing and keeps restore focus disabled false', () => {
    const { root } = renderDialog({
      videos: [{ id: 'video-1', name: 'video.mp4', source: '/video.mp4' }],
    });

    expect(dialogProps.at(-1)?.disableRestoreFocus).toBe(false);
    expect(dialogProps.at(-1)?.disableEscapeKeyDown).toBe(false);
    expect(dialogProps.at(-1)?.fullScreen).toBe(true);
    expect(dialogProps.at(-1)?.paperSx).toMatchObject({
      width: '100vw',
      height: '100svh',
      maxWidth: '100vw',
      maxHeight: '100svh',
    });

    root.unmount();
  });

  it('explains that pending media is being downloaded and decrypted', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const { root } = renderDialog({
      videos: [{ id: 'video-1', name: 'video.mp4', source: '/video.mp4' }],
    });

    expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
      'Скачування та розшифровка медіа',
    );
    expect(document.body.querySelector('[data-loading="true"]')).not.toBeNull();

    await act(async () => {
      document.body.querySelector('video')?.dispatchEvent(new Event('canplay', { bubbles: true }));
    });

    expect(document.body.querySelector('[role="status"]')).toBeNull();

    root.unmount();
  });

  it('bypasses fetch for same-origin sources and fetches remote sources into blob URLs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const createObjectUrlSpy = vi
      .spyOn(globalThis.URL, 'createObjectURL')
      .mockReturnValue('blob:https://example.test/video');
    const revokeObjectUrlSpy = vi
      .spyOn(globalThis.URL, 'revokeObjectURL')
      .mockImplementation(() => {});

    const sameOrigin = renderDialog({
      videos: [{ id: 'local', name: 'local.mp4', source: '/assets/local.mp4' }],
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.body.querySelector('video')?.getAttribute('src')).toBe('/assets/local.mp4');
    sameOrigin.root.unmount();

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      blob: async () => new Blob(['video'], { type: 'video/mp4' }),
    } as never);

    const remote = renderDialog({
      videos: [{ id: 'remote', name: 'remote.mp4', source: 'https://example.test/remote.mp4' }],
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledWith('https://example.test/remote.mp4');
    expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('video')?.getAttribute('src')).toBe(
      'blob:https://example.test/video',
    );

    act(() => remote.root.unmount());
    expect(revokeObjectUrlSpy).not.toHaveBeenCalled();
  });

  it('retries a busy large local video preflight before assigning its source', async () => {
    vi.useFakeTimers();
    const firstBodyCancel = vi.fn().mockResolvedValue(undefined);
    const secondBodyCancel = vi.fn().mockResolvedValue(undefined);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers({ 'Retry-After': '2' }),
        body: { cancel: firstBodyCancel },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        status: 206,
        headers: new Headers(),
        body: { cancel: secondBodyCancel },
      } as never);

    const { root } = renderDialog({
      videos: [
        {
          id: 'large-local-busy',
          name: 'large.mp4',
          source: '/api/messenger/media/large-local-busy',
          sizeBytes: 10 * 1024 * 1024 + 1,
        },
      ],
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      '/api/messenger/media/large-local-busy',
      expect.objectContaining({
        headers: {
          Range: 'bytes=0-0',
          'X-Echo-Media-Cache-Preflight': '1',
        },
      }),
    );
    expect(document.body.querySelector('video')).toBeNull();
    expect(firstBodyCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(secondBodyCancel).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('video')?.getAttribute('src')).toBe(
      '/api/messenger/media/large-local-busy',
    );

    root.unmount();
  });

  it('routes local video 401 responses through the unauthorized handler', async () => {
    const responseBodyCancel = vi.fn().mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      body: { cancel: responseBodyCancel },
    } as never);

    const largeVideo = renderDialog({
      videos: [
        {
          id: 'large-local-401',
          name: 'large.mp4',
          source: '/api/messenger/media/large-local-401',
          sizeBytes: 10 * 1024 * 1024 + 1,
        },
      ],
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(authRedirectMocks.emitUnauthorizedEvent).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(responseBodyCancel).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Не вдалося завантажити відео.');
    largeVideo.root.unmount();

    authRedirectMocks.emitUnauthorizedEvent.mockClear();
    fetchSpy.mockClear();

    const smallVideo = renderDialog({
      videos: [
        {
          id: 'small-local-401',
          name: 'small.mp4',
          source: '/api/messenger/media/small-local-401',
          sizeBytes: 1024,
        },
      ],
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(authRedirectMocks.emitUnauthorizedEvent).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Не вдалося завантажити відео.');
    smallVideo.root.unmount();
  });

  it('retries network and gateway failures with capped backoff during large-video preflight', async () => {
    vi.useFakeTimers();
    const gatewayBodyCancel = vi.fn().mockResolvedValue(undefined);
    const successBodyCancel = vi.fn().mockResolvedValue(undefined);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce({
        ok: false,
        status: 504,
        headers: new Headers({ 'Retry-After': '3' }),
        body: { cancel: gatewayBodyCancel },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        status: 206,
        headers: new Headers(),
        body: { cancel: successBodyCancel },
      } as never);

    const { root } = renderDialog({
      videos: [
        {
          id: 'large-local-retry',
          name: 'large.mp4',
          source: '/api/messenger/media/large-local-retry',
          sizeBytes: 10 * 1024 * 1024 + 1,
        },
      ],
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('video')).toBeNull();
    expect(document.body.textContent).not.toContain('Не вдалося завантажити відео.');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(gatewayBodyCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_999);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(successBodyCancel).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('video')?.getAttribute('src')).toBe(
      '/api/messenger/media/large-local-retry',
    );

    root.unmount();
  });

  it('retries busy small local videos while keeping the loading stage visible', async () => {
    vi.useFakeTimers();
    const firstBodyCancel = vi.fn().mockResolvedValue(undefined);
    const createObjectUrlSpy = vi
      .spyOn(globalThis.URL, 'createObjectURL')
      .mockReturnValue('blob:small-local-video');
    const revokeObjectUrlSpy = vi
      .spyOn(globalThis.URL, 'revokeObjectURL')
      .mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers({ 'Retry-After': '2' }),
        body: { cancel: firstBodyCancel },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        blob: async () => new Blob(['video'], { type: 'video/mp4' }),
      } as never);

    const { root } = renderDialog({
      videos: [
        {
          id: 'small-local',
          name: 'small.mp4',
          source: '/api/messenger/media/small-local',
          sizeBytes: 1024,
        },
      ],
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(firstBodyCancel).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('video')).toBeNull();
    expect(document.body.textContent).not.toContain('Не вдалося завантажити відео.');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('video')?.getAttribute('src')).toBe(
      'blob:small-local-video',
    );

    act(() => root.unmount());
    expect(revokeObjectUrlSpy).not.toHaveBeenCalled();
  });

  it('shows the existing video-load error when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false } as never);

    renderDialog({
      videos: [
        {
          id: 'remote-failure',
          name: 'remote.mp4',
          source: 'https://example.test/remote-failure.mp4',
        },
      ],
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Не вдалося завантажити відео.');
    expect(document.body.textContent).toContain('Не вдалося завантажити відео.');
  });

  it('resets playback state only when the selected video changes', async () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const { root } = renderDialog({
      currentIndex: 0,
      videos: [
        { id: 'video-1', name: 'video-1.mp4', source: '/video-1.mp4' },
        { id: 'video-2', name: 'video-2.mp4', source: '/video-2.mp4' },
      ],
    });

    const video = document.body.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { value: 37, writable: true, configurable: true });

    await act(async () => {
      video.dispatchEvent(new Event('play', { bubbles: true }));
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      video.dispatchEvent(new Event('volumechange', { bubbles: true }));
    });

    expect(latestControlsProps?.playerState.isPlaying).toBe(true);
    expect(latestControlsProps?.playerState.currentTime).toBe(37);

    await act(async () => {
      document.body
        .querySelector('[data-video-stage]')
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(document.body.querySelector('[data-zoom-badge]')?.textContent).toBe('150%');

    const pauseCallsBeforeEquivalentRerender = pauseSpy.mock.calls.length;
    await act(async () => {
      root.render(
        <TestVideoPreviewDialog
          open
          onClose={vi.fn()}
          videos={[
            { id: 'video-1', name: 'video-1.mp4', source: '/video-1.mp4' },
            { id: 'video-2', name: 'video-2.mp4', source: '/video-2.mp4' },
          ]}
          currentIndex={0}
          onIndexChange={vi.fn()}
        />,
      );
    });

    expect(pauseSpy).toHaveBeenCalledTimes(pauseCallsBeforeEquivalentRerender);
    expect(latestControlsProps?.playerState.isPlaying).toBe(true);
    expect(latestControlsProps?.playerState.currentTime).toBe(37);
    expect(document.body.querySelector('[data-zoom-badge]')?.textContent).toBe('150%');

    await act(async () => {
      root.render(
        <TestVideoPreviewDialog
          open
          onClose={vi.fn()}
          videos={[
            { id: 'video-1', name: 'video-1.mp4', source: '/video-1.mp4' },
            { id: 'video-2', name: 'video-2.mp4', source: '/video-2.mp4' },
          ]}
          currentIndex={1}
          onIndexChange={vi.fn()}
        />,
      );
    });

    expect(pauseSpy).toHaveBeenCalled();
    expect(latestControlsProps?.playerState.isPlaying).toBe(false);
    expect(latestControlsProps?.playerState.currentTime).toBe(0);
    expect(document.body.querySelector('[data-zoom-badge]')?.textContent).toBe('100%');
    root.unmount();
  });

  it('preserves play, stop, seek, volume, mute, and rate callbacks', async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    renderDialog({
      videos: [{ id: 'video-1', name: 'video.mp4', source: '/video.mp4' }],
    });

    const video = document.body.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { value: 9, writable: true, configurable: true });
    Object.defineProperty(video, 'volume', { value: 0.2, writable: true, configurable: true });
    Object.defineProperty(video, 'muted', { value: true, writable: true, configurable: true });
    Object.defineProperty(video, 'playbackRate', { value: 1, writable: true, configurable: true });
    Object.defineProperty(video, 'paused', { value: true, configurable: true });

    await act(async () => {
      latestControlsProps?.onPlayPause();
    });

    expect(playSpy).toHaveBeenCalled();

    await act(async () => {
      video.dispatchEvent(new Event('play', { bubbles: true }));
      video.dispatchEvent(new Event('pause', { bubbles: true }));
      video.dispatchEvent(new Event('ended', { bubbles: true }));
    });

    expect(latestControlsProps?.playerState.isPlaying).toBe(false);

    await act(async () => {
      latestControlsProps?.onSeek(21);
      latestControlsProps?.onVolumeChange(0.6);
      latestControlsProps?.onMuteToggle();
      latestControlsProps?.onRateChange(1.5);
    });

    expect(video.currentTime).toBe(21);
    expect(video.volume).toBe(0.6);
    expect(video.muted).toBe(true);
    expect(video.playbackRate).toBe(1.5);

    Object.defineProperty(video, 'paused', { value: false, configurable: true });

    await act(async () => {
      latestControlsProps?.onStop();
    });

    expect(pauseSpy).toHaveBeenCalled();
    expect(video.currentTime).toBe(0);
  });

  it('exits fullscreen before closing the dialog on Escape', async () => {
    const onClose = vi.fn();
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    renderDialog({
      onClose,
      videos: [{ id: 'video-1', name: 'video.mp4', source: '/video.mp4' }],
    });

    expect(dialogProps.at(-1)?.disableEscapeKeyDown).toBe(false);
    expect(latestControlsProps?.playerState.isFullscreen).toBe(true);
    expect(document.body.querySelector('[data-actions]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(latestControlsProps?.playerState.isFullscreen).toBe(false);
    expect(dialogProps.at(-1)?.fullScreen).toBe(false);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('does not enter fullscreen when the config disables it', async () => {
    previewConfig = {
      layout: 'media',
      disableRestoreFocus: false,
      supportsFullscreen: false,
      disableEscapeKeyDownInFullscreen: true,
    };

    const onClose = vi.fn();
    renderDialog({
      onClose,
      videos: [{ id: 'video-1', name: 'video.mp4', source: '/video.mp4' }],
    });

    expect(latestControlsProps?.canFullscreen).toBe(false);
    expect(document.body.querySelector('[aria-label="fullscreen"]')).toBeNull();
    expect(dialogProps.at(-1)?.fullScreen).toBe(false);
    expect(dialogProps.at(-1)?.disableEscapeKeyDown).toBe(false);
    expect(document.body.querySelector('[data-actions]')).not.toBeNull();

    await act(async () => {
      latestControlsProps?.onToggleFullscreen();
    });

    expect(latestControlsProps?.playerState.isFullscreen).toBe(false);
    expect(dialogProps.at(-1)?.fullScreen).toBe(false);

    await act(async () => {
      dialogProps.at(-1)?.onClose?.({} as never, 'escapeKeyDown');
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps carousel arrows, counter, and info/download actions intact', async () => {
    const onIndexChange = vi.fn();
    renderDialog({
      currentIndex: 1,
      onIndexChange,
      videos: [
        { id: 'video-1', name: 'video-1.mp4', source: '/video-1.mp4' },
        { id: 'video-2', name: 'video-2.mp4', source: '/video-2.mp4' },
      ],
    });

    expect(document.body.textContent).toContain('2 / 2');
    expect(document.body.querySelector('[aria-label="Інформація"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Скачати"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Попереднє"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Наступне"]')).not.toBeNull();

    await act(async () => {
      latestActionProps?.onGoToPrevious?.();
      latestActionProps?.onGoToNext?.();
    });

    expect(onIndexChange).toHaveBeenNthCalledWith(1, 0);
    expect(onIndexChange).toHaveBeenNthCalledWith(2, 0);
  });

  it('keeps the info popover, header, and controls wired in fullscreen', async () => {
    renderDialog({
      videos: [{ id: 'video-1', name: 'video.mp4', source: '/video.mp4' }],
    });

    await act(async () => {
      latestActionProps?.onInfoClick?.({
        currentTarget: document.createElement('button'),
      } as never);
    });

    expect(latestInfoProps?.open).toBe(true);
    expect(document.body.querySelector('[data-info-open="true"]')).not.toBeNull();

    await act(async () => {
      latestControlsProps?.onToggleFullscreen();
    });

    expect(document.body.querySelector('[data-actions]')).not.toBeNull();
    expect(document.body.querySelector('[data-controls]')).not.toBeNull();
  });
});
