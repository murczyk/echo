/**
 * @vitest-environment happy-dom
 */
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject, SyntheticEvent } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VideoPlayerState, VideoPreviewSource } from './message-card-video-utils';

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
let latestVideoProps: {
  src: string | null;
  error?: { message: string };
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  onLoadedMetadata?: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onTimeUpdate?: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onVolumeChange?: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onRateChange?: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onError?: (event: SyntheticEvent<HTMLVideoElement>) => void;
  videoRef: RefObject<HTMLVideoElement>;
  hasCarousel?: boolean;
  onGoToPrevious?: () => void;
  onGoToNext?: () => void;
} | null = null;
let latestActionProps: {
  hasCarousel: boolean;
  resolvedIndex: number;
  videoCount: number;
  onGoToPrevious?: () => void;
  onGoToNext?: () => void;
  onInfoClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onClose: () => void;
} | null = null;
let latestInfoProps: {
  open: boolean;
  duration: number;
} | null = null;

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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

vi.mock('./message-card-preview-config', () => ({
  getMessageCardPreviewShellConfig: () => previewConfig,
}));

vi.mock('./MessageCardVideoPreviewStage', () => ({
  MessageCardVideoPreviewStage: ({
    src,
    error,
    isPlaying,
    onPlay,
    onPause,
    onEnded,
    onLoadedMetadata,
    onTimeUpdate,
    onVolumeChange,
    onRateChange,
    onError,
    videoRef,
    hasCarousel,
    onGoToPrevious,
    onGoToNext,
  }: {
    src: string | null;
    error?: { message: string };
    isPlaying: boolean;
    onPlay: () => void;
    onPause: () => void;
    onEnded: () => void;
    onLoadedMetadata?: (event: SyntheticEvent<HTMLVideoElement>) => void;
    onTimeUpdate?: (event: SyntheticEvent<HTMLVideoElement>) => void;
    onVolumeChange?: (event: SyntheticEvent<HTMLVideoElement>) => void;
    onRateChange?: (event: SyntheticEvent<HTMLVideoElement>) => void;
    onError?: (event: SyntheticEvent<HTMLVideoElement>) => void;
    videoRef: RefObject<HTMLVideoElement>;
    hasCarousel?: boolean;
    onGoToPrevious?: () => void;
    onGoToNext?: () => void;
  }) => {
    latestVideoProps = {
      src,
      error,
      isPlaying,
      onPlay,
      onPause,
      onEnded,
      onLoadedMetadata,
      onTimeUpdate,
      onVolumeChange,
      onRateChange,
      onError,
      videoRef,
      hasCarousel,
      onGoToPrevious,
      onGoToNext,
    };

    return (
      <div data-video-stage>
        <video ref={videoRef} data-video-src={src ?? ''} data-video-error={error?.message ?? ''} />
        {error ? <div>{error.message}</div> : null}
      </div>
    );
  },
}));

vi.mock('./MessageCardVideoPreviewActions', () => ({
  MessageCardVideoPreviewControls: ({
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
  MessageCardVideoPreviewActions: ({
    video,
    hasCarousel,
    resolvedIndex,
    videoCount,
    onGoToPrevious,
    onGoToNext,
    onInfoClick,
    onClose,
  }: {
    video: VideoPreviewSource;
    hasCarousel: boolean;
    resolvedIndex: number;
    videoCount: number;
    onGoToPrevious?: () => void;
    onGoToNext?: () => void;
    onInfoClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    onClose: () => void;
  }) => {
    latestActionProps = {
      hasCarousel,
      resolvedIndex,
      videoCount,
      onGoToPrevious,
      onGoToNext,
      onInfoClick,
      onClose,
    };

    return (
      <div data-actions>
        <button aria-label="Інформація" onClick={onInfoClick} />
        <button aria-label="Завантажити" />
        {hasCarousel ? <button aria-label="Попереднє" onClick={onGoToPrevious} /> : null}
        {hasCarousel ? (
          <span data-video-counter>{`${resolvedIndex + 1} / ${videoCount}`}</span>
        ) : null}
        {hasCarousel ? <button aria-label="Наступне" onClick={onGoToNext} /> : null}
        <button aria-label="Закрити" onClick={onClose} />
        <a aria-label="video-source" href={typeof video.source === 'string' ? video.source : ''} />
      </div>
    );
  },
}));

vi.mock('./MessageCardVideoPreviewInfoPopover', () => ({
  MessageCardVideoPreviewInfoPopover: ({ open, duration }: { open: boolean; duration: number }) => {
    latestInfoProps = { open, duration };
    return open ? <div data-info-open="true" data-duration={duration} /> : null;
  },
}));

import { MessageCardVideoPreviewDialog } from './MessageCardVideoPreviewDialog';

describe('MessageCardVideoPreviewDialog', () => {
  afterEach(() => {
    dialogProps.splice(0);
    previewConfig = {
      layout: 'media',
      disableRestoreFocus: false,
      supportsFullscreen: true,
      disableEscapeKeyDownInFullscreen: true,
    };
    latestControlsProps = null;
    latestVideoProps = null;
    latestActionProps = null;
    latestInfoProps = null;
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
        <MessageCardVideoPreviewDialog
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
    expect(dialogProps.at(-1)?.fullScreen).toBe(false);
    expect(dialogProps.at(-1)?.paperSx).toMatchObject({
      width: { xs: '96vw', sm: '92vw' },
      height: '92svh',
      maxWidth: 'min(92vw, 1280px)',
      maxHeight: '92svh',
    });

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
    expect(document.body.querySelector('[data-video-src]')?.getAttribute('data-video-src')).toBe(
      '/assets/local.mp4',
    );
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
    expect(document.body.querySelector('[data-video-src]')?.getAttribute('data-video-src')).toBe(
      'blob:https://example.test/video',
    );

    remote.root.unmount();
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith('blob:https://example.test/video');
  });

  it('shows the existing video-load error when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false } as never);

    renderDialog({
      videos: [{ id: 'remote', name: 'remote.mp4', source: 'https://example.test/remote.mp4' }],
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Не вдалося завантажити відео.');
    expect(latestVideoProps?.error?.message).toBe('Не вдалося завантажити відео.');
  });

  it('resets playback state when the index changes or the dialog reopens', async () => {
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
      latestVideoProps?.onPlay();
      latestVideoProps?.onTimeUpdate?.({ currentTarget: video } as never);
      latestVideoProps?.onVolumeChange?.({ currentTarget: video } as never);
    });

    expect(latestControlsProps?.playerState.isPlaying).toBe(true);
    expect(latestControlsProps?.playerState.currentTime).toBe(37);

    await act(async () => {
      root.render(
        <MessageCardVideoPreviewDialog
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
      latestVideoProps?.onPlay();
      latestVideoProps?.onPause();
      latestVideoProps?.onEnded();
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

  it('exits fullscreen on Escape without closing, and closes outside fullscreen while pausing', async () => {
    const onClose = vi.fn();
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    renderDialog({
      onClose,
      videos: [{ id: 'video-1', name: 'video.mp4', source: '/video.mp4' }],
    });

    await act(async () => {
      latestControlsProps?.onToggleFullscreen();
    });

    expect(dialogProps.at(-1)?.disableEscapeKeyDown).toBe(true);
    expect(latestControlsProps?.playerState.isFullscreen).toBe(true);
    expect(document.body.querySelector('[data-actions]')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(latestControlsProps?.playerState.isFullscreen).toBe(false);
    expect(document.body.querySelector('[data-actions]')).not.toBeNull();

    const close = dialogProps.at(-1)?.onClose;
    await act(async () => {
      close?.({}, 'backdropClick');
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(pauseSpy).toHaveBeenCalled();
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
    expect(document.body.querySelector('[aria-label="Завантажити"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Попереднє"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Наступне"]')).not.toBeNull();

    await act(async () => {
      latestActionProps?.onGoToPrevious?.();
      latestActionProps?.onGoToNext?.();
    });

    expect(onIndexChange).toHaveBeenNthCalledWith(1, 0);
    expect(onIndexChange).toHaveBeenNthCalledWith(2, 2);
  });

  it('keeps the info popover wired and action bar hidden in fullscreen', async () => {
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

    expect(document.body.querySelector('[data-actions]')).toBeNull();
    expect(document.body.querySelector('[data-controls]')).not.toBeNull();
  });
});
