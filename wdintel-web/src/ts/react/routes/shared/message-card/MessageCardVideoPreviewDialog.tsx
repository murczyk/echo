import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoPreviewSource, VideoPlayerState } from './message-card-video-utils';
import { MessageCardVideoPreviewStage } from './MessageCardVideoPreviewStage';
import {
  MessageCardVideoPreviewActions,
  MessageCardVideoPreviewControls,
} from './MessageCardVideoPreviewActions';
import { MessageCardVideoPreviewInfoPopover } from './MessageCardVideoPreviewInfoPopover';
import { getMessageCardPreviewShellConfig } from './message-card-preview-config';
import { handleUnauthorizedMediaResponse } from './message-card-media-fetch';
import { MessageCardPreviewShell } from './MessageCardPreviewShell';
import type { MessageCardDownloadGuardProps } from './MessageCardMedia';

const VIDEO_LOCAL_PREFLIGHT_MIN_SIZE_BYTES = 10 * 1024 * 1024;
const VIDEO_LOCAL_PREFLIGHT_RETRY_DELAY_MS = 2_000;
const VIDEO_LOCAL_PREFLIGHT_MAX_RETRY_DELAY_MS = 30_000;

function isManagedLocalVideo(video: VideoPreviewSource): video is VideoPreviewSource & {
  source: string;
} {
  return (
    typeof video.source === 'string' &&
    video.source.startsWith('/api/messenger/media/') &&
    !video.source.includes('/thumbnail')
  );
}

function isSmallLocalVideo(video: VideoPreviewSource): video is VideoPreviewSource & {
  source: string;
} {
  return (
    isManagedLocalVideo(video) &&
    typeof video.sizeBytes === 'number' &&
    Number.isFinite(video.sizeBytes) &&
    video.sizeBytes >= 0 &&
    video.sizeBytes <= VIDEO_LOCAL_PREFLIGHT_MIN_SIZE_BYTES
  );
}

function preflightVideoSize(response: Response): number | null {
  const contentRange = response.headers.get('Content-Range');
  const rangeSize = contentRange?.match(/\/(\d+)$/)?.[1];
  const size =
    rangeSize ?? (response.status === 206 ? null : response.headers.get('Content-Length'));
  if (size === null || size === undefined) return null;
  const value = Number(size);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function videoRetryDelay(response: Response | null, attempt: number): number {
  const fallback = Math.min(
    VIDEO_LOCAL_PREFLIGHT_MAX_RETRY_DELAY_MS,
    VIDEO_LOCAL_PREFLIGHT_RETRY_DELAY_MS * 2 ** attempt,
  );
  const retryAfter = response?.headers.get('Retry-After');
  if (retryAfter === null || retryAfter === undefined) {
    return fallback;
  }

  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.max(fallback, retryAfterSeconds * 1_000);
  }

  const retryAt = Date.parse(retryAfter);
  return Number.isFinite(retryAt) ? Math.max(fallback, retryAt - Date.now()) : fallback;
}

function responseCanBeRetried(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function discardResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response may already be closed.
  }
}

export function MessageCardVideoPreviewDialog({
  open,
  onClose,
  videos,
  initialIndex = 0,
  currentIndex,
  onIndexChange,
  isDownloadStarting,
  onDownloadStart,
}: {
  open: boolean;
  onClose: () => void;
  videos: VideoPreviewSource[];
  initialIndex?: number;
  currentIndex?: number;
  onIndexChange?: (index: number) => void;
} & MessageCardDownloadGuardProps) {
  const videoCount = videos?.length ?? 0;
  const hasCarousel = videoCount > 1;
  const resolvedIndex =
    videoCount > 0 ? (((currentIndex ?? initialIndex) % videoCount) + videoCount) % videoCount : 0;
  const video = videoCount > 0 ? videos[resolvedIndex] : null;

  const [src, setSrc] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRootRef = useRef<HTMLDivElement>(null);

  const [infoAnchorEl, setInfoAnchorEl] = useState<HTMLButtonElement | null>(null);
  const infoOpen = infoAnchorEl !== null;

  const [playerState, setPlayerState] = useState<VideoPlayerState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    playbackRate: 1,
    isFullscreen: false,
  });
  const previewConfig = getMessageCardPreviewShellConfig('video');
  const canFullscreen = previewConfig.supportsFullscreen;
  const dialogIsFullscreen = canFullscreen && playerState.isFullscreen;
  const openHref = typeof video?.source === 'string' ? video.source : null;

  useEffect(() => {
    if (!open || !video) return;

    // Drop the previous item's URL so autoplay can't resume it while the next
    // source is still resolving.
    setSrc(null);

    if (typeof video.source === 'string') {
      if (isManagedLocalVideo(video)) {
        let stopped = false;
        let retryTimer: number | null = null;
        const requestController = new AbortController();
        const source = video.source;
        let blobUrl = '';
        let retryAttempt = 0;

        const fail = (cause: unknown) => {
          if (stopped) return;
          setPlayerState((state) => ({
            ...state,
            error: {
              code: 'VIDEO_LOAD_ERROR',
              message: 'Не вдалося завантажити відео.',
              cause,
            },
          }));
        };
        const scheduleRetry = (response: Response | null, request: () => Promise<void>) => {
          const delay = videoRetryDelay(response, retryAttempt);
          retryAttempt += 1;
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            void request();
          }, delay);
        };
        const requestPreflight = async () => {
          let response: Response;
          try {
            response = await fetch(source, {
              headers: {
                Range: 'bytes=0-0',
                'X-Echo-Media-Cache-Preflight': '1',
              },
              signal: requestController.signal,
            });
          } catch {
            if (!requestController.signal.aborted) scheduleRetry(null, requestPreflight);
            return;
          }
          handleUnauthorizedMediaResponse(response, source);
          const videoSize = preflightVideoSize(response);
          await discardResponseBody(response);
          if (stopped) return;
          if (responseCanBeRetried(response.status)) {
            scheduleRetry(response, requestPreflight);
            return;
          }
          if (!response.ok) {
            fail(new Error(`Video preflight failed with status ${response.status}`));
            return;
          }
          if (videoSize !== null && videoSize <= VIDEO_LOCAL_PREFLIGHT_MIN_SIZE_BYTES) {
            void requestSmallVideo();
            return;
          }
          setSrc(source);
        };
        const requestSmallVideo = async () => {
          let response: Response;
          try {
            response = await fetch(source, {
              credentials: 'same-origin',
              signal: requestController.signal,
            });
          } catch {
            if (!requestController.signal.aborted) scheduleRetry(null, requestSmallVideo);
            return;
          }
          handleUnauthorizedMediaResponse(response, source);
          if (stopped) return;
          if (responseCanBeRetried(response.status)) {
            await discardResponseBody(response);
            if (!stopped) scheduleRetry(response, requestSmallVideo);
            return;
          }
          if (!response.ok) {
            await discardResponseBody(response);
            fail(new Error(`Video fetch failed with status ${response.status}`));
            return;
          }

          try {
            const videoBlob = await response.blob();
            if (stopped) return;
            blobUrl = URL.createObjectURL(videoBlob);
            setSrc(blobUrl);
          } catch (error) {
            if (!requestController.signal.aborted) scheduleRetry(null, requestSmallVideo);
          }
        };

        if (isSmallLocalVideo(video)) {
          void requestSmallVideo();
        } else {
          void requestPreflight();
        }
        return () => {
          stopped = true;
          requestController.abort();
          if (retryTimer !== null) window.clearTimeout(retryTimer);
          if (blobUrl !== '') URL.revokeObjectURL(blobUrl);
        };
      }
      if (video.source.startsWith('/') || video.source.startsWith('data:')) {
        setSrc(video.source);
        return;
      }
      if (video.source.startsWith('blob:')) {
        setSrc(video.source);
        return;
      }
    }

    let isMounted = true;
    let blobUrl = '';

    const source =
      typeof video.source === 'string' ? video.source : URL.createObjectURL(video.source);

    if (typeof video.source !== 'string') {
      blobUrl = source;
      setSrc(blobUrl);
    } else {
      fetch(source)
        .then((res) => {
          handleUnauthorizedMediaResponse(res, source);
          if (!res.ok) throw new Error('Video fetch failed');
          return res.blob();
        })
        .then((blob) => {
          if (!isMounted) return;
          blobUrl = URL.createObjectURL(blob);
          setSrc(blobUrl);
        })
        .catch((err) => {
          if (!isMounted) return;
          setPlayerState((s) => ({
            ...s,
            error: {
              code: 'VIDEO_LOAD_ERROR',
              message: 'Не вдалося завантажити відео.',
              cause: err,
            },
          }));
        });
    }

    return () => {
      isMounted = false;
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [open, video?.source, video?.sizeBytes]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
    }
    setPlayerState((s) => ({
      ...s,
      isPlaying: false,
      currentTime: 0,
      error: undefined,
    }));
  }, [resolvedIndex, open]);

  useEffect(() => {
    if (!open || !src) return;
    const v = videoRef.current;
    if (!v) return;
    v.play().catch(() => {});
  }, [open, src]);

  useEffect(() => {
    if (!dialogIsFullscreen) return;
    const handleFullscreenEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setPlayerState((s) => ({ ...s, isFullscreen: false }));
    };
    window.addEventListener('keydown', handleFullscreenEscape, true);
    return () => window.removeEventListener('keydown', handleFullscreenEscape, true);
  }, [dialogIsFullscreen]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (dialogIsFullscreen && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setPlayerState((s) => ({ ...s, isFullscreen: false }));
        return;
      }
      if (!hasCarousel) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        onIndexChange?.(resolvedIndex - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        onIndexChange?.(resolvedIndex + 1);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [dialogIsFullscreen, hasCarousel, open, resolvedIndex, onIndexChange]);

  const handlePlayPause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(console.error);
    } else {
      v.pause();
    }
  }, []);

  const handleStop = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
  }, []);

  const handleVolumeChange = useCallback((volume: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    if (volume > 0 && v.muted) v.muted = false;
  }, []);

  const handleMuteToggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  }, []);

  const handleRateChange = useCallback((rate: 0.5 | 1 | 1.5 | 2) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = rate;
  }, []);

  const handleSeek = useCallback((time: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = time;
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    if (!canFullscreen) return;
    setPlayerState((s) => ({ ...s, isFullscreen: !s.isFullscreen }));
  }, [canFullscreen]);

  const handleClose = useCallback(() => {
    const v = videoRef.current;
    if (v) v.pause();
    onClose();
  }, [onClose]);

  if (!open || !video) return null;

  return (
    <MessageCardPreviewShell
      open={open}
      isFullscreen={dialogIsFullscreen}
      ariaLabel="Перегляд відео"
      onClose={handleClose}
      config={previewConfig}
      stage={
        <MessageCardVideoPreviewStage
          videoRef={videoRef}
          src={src}
          error={playerState.error}
          isPlaying={playerState.isPlaying}
          hasCarousel={hasCarousel}
          onGoToPrevious={() => onIndexChange?.(resolvedIndex - 1)}
          onGoToNext={() => onIndexChange?.(resolvedIndex + 1)}
          onPlay={() => setPlayerState((s) => ({ ...s, isPlaying: true }))}
          onPause={() => setPlayerState((s) => ({ ...s, isPlaying: false }))}
          onEnded={() => setPlayerState((s) => ({ ...s, isPlaying: false }))}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setPlayerState((s) => ({
              ...s,
              duration: Number.isFinite(v.duration) ? v.duration : 0,
            }));
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setPlayerState((s) => ({ ...s, currentTime: v.currentTime }));
          }}
          onVolumeChange={(e) => {
            const v = e.currentTarget;
            setPlayerState((s) => ({
              ...s,
              volume: v.volume,
              muted: v.muted,
            }));
          }}
          onRateChange={(e) => {
            const v = e.currentTarget;
            setPlayerState((s) => ({
              ...s,
              playbackRate: v.playbackRate as any,
            }));
          }}
          onError={(e) => {
            setPlayerState((s) => ({
              ...s,
              error: {
                code: 'VIDEO_LOAD_ERROR',
                message: 'Не вдалося завантажити або відтворити це відео.',
                cause: e,
              },
            }));
          }}
        />
      }
      controls={
        <MessageCardVideoPreviewControls
          playerState={playerState}
          canFullscreen={canFullscreen}
          videoRef={videoRef}
          onPlayPause={handlePlayPause}
          onStop={handleStop}
          onVolumeChange={handleVolumeChange}
          onMuteToggle={handleMuteToggle}
          onRateChange={handleRateChange}
          onSeek={handleSeek}
          onToggleFullscreen={handleToggleFullscreen}
        />
      }
      actions={
        !dialogIsFullscreen ? (
          <MessageCardVideoPreviewActions
            video={video}
            openHref={openHref}
            onClose={handleClose}
            hasCarousel={hasCarousel}
            resolvedIndex={resolvedIndex}
            videoCount={videoCount}
            onGoToPrevious={() => onIndexChange?.(resolvedIndex - 1)}
            onGoToNext={() => onIndexChange?.(resolvedIndex + 1)}
            onInfoClick={(event) => setInfoAnchorEl(event.currentTarget)}
            downloadKey={`media:${String(video.id ?? '')}`}
            isDownloadStarting={isDownloadStarting}
            onDownloadStart={onDownloadStart}
          />
        ) : null
      }
      infoPopover={
        <MessageCardVideoPreviewInfoPopover
          open={infoOpen}
          anchorEl={infoAnchorEl}
          onClose={() => setInfoAnchorEl(null)}
          video={video}
          duration={playerState.duration}
        />
      }
    />
  );
}
