import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { Box, CircularProgress, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';

import type {
  VideoPreviewError,
  VideoPreviewSource,
  VideoPlayerState,
} from '../message-card-video-utils';
import { downloadOriginalVideo, formatVideoTime } from '../message-card-video-utils';
import { clamp, formatSizeBytes } from '../message-card-image-utils';
import { getNextWheelZoom, isInteractivePreviewTarget } from '../message-card-image-preview-utils';
import { AttachmentPreviewZoomBadge } from '../attachment-preview/AttachmentPreviewZoomBadge';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import { AttachmentPreviewPlaybackControls } from '../attachment-preview/MessageCardAttachmentPreviewControls';
import { MessageCardAttachmentPreviewInfoPopover } from '../attachment-preview/MessageCardAttachmentPreviewInfoPopover';
import { MessageCardAttachmentPreviewStage } from '../attachment-preview/MessageCardAttachmentPreviewStage';
import { getMessageCardAttachmentPreviewConfig } from '../attachment-preview/message-card-preview-config';
import { handleUnauthorizedMediaResponse } from '../message-card-media-fetch';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import type { MessageCardDownloadGuardProps } from '../MessageCardMedia';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';

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

function VideoPreview({
  src,
  error,
  zoom = 100,
  pan = { x: 0, y: 0 },
  onPlay,
  onPause,
  onEnded,
  onLoadedMetadata,
  onTimeUpdate,
  onVolumeChange,
  onRateChange,
  onError,
  videoRef,
}: {
  src: string | null;
  error?: VideoPreviewError;
  zoom?: number;
  pan?: { x: number; y: number };
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  onLoadedMetadata?: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onTimeUpdate?: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onVolumeChange?: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onRateChange?: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onError?: (event: SyntheticEvent<HTMLVideoElement>) => void;
  videoRef: React.RefObject<HTMLVideoElement>;
}) {
  const [clickAction, setClickAction] = useState<'play' | 'pause'>('play');
  const [showIcon, setShowIcon] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const clickActionTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (clickActionTimer.current) window.clearTimeout(clickActionTimer.current);
    },
    [],
  );

  return (
    <>
      {src ? (
        <video
          ref={videoRef}
          src={src}
          controls={false}
          preload="metadata"
          playsInline
          onLoadStart={() => setIsBuffering(true)}
          onWaiting={() => setIsBuffering(true)}
          onCanPlay={() => setIsBuffering(false)}
          onPlaying={() => setIsBuffering(false)}
          onPlay={onPlay}
          onPause={onPause}
          onEnded={onEnded}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onVolumeChange={onVolumeChange}
          onRateChange={onRateChange}
          onError={onError}
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            if (clickActionTimer.current) window.clearTimeout(clickActionTimer.current);
            if (video.paused) {
              video.play().catch(console.error);
              setClickAction('play');
            } else {
              video.pause();
              setClickAction('pause');
            }
            setShowIcon(true);
            clickActionTimer.current = window.setTimeout(() => setShowIcon(false), 300);
          }}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            display: error ? 'none' : 'block',
            cursor: 'pointer',
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`,
            transformOrigin: 'center center',
            transition: zoom === 100 ? 'transform 120ms ease-out' : 'none',
            willChange: 'transform',
          }}
        />
      ) : null}

      {(!src && !error) || (src && !error && isBuffering) ? (
        <Box
          role="status"
          aria-live="polite"
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 2,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            pointerEvents: 'none',
          }}
        >
          <CircularProgress size={22} />
          <Typography variant="body2" color="text.secondary">
            Скачування та розшифровка медіа
          </Typography>
        </Box>
      ) : null}

      {src && !error ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 10,
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 72,
              height: 72,
              borderRadius: '50%',
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
              color: '#fff',
              backdropFilter: 'blur(2px)',
              boxShadow: 3,
              opacity: showIcon ? 1 : 0,
              transform: showIcon ? 'scale(1)' : 'scale(1.3)',
              transition: showIcon ? 'none' : 'opacity 0.4s ease-out, transform 0.4s ease-out',
            }}
          >
            {clickAction === 'play' ? (
              <PlayArrowIcon sx={{ fontSize: 44, ml: 0.5 }} />
            ) : (
              <PauseIcon sx={{ fontSize: 44 }} />
            )}
          </Box>
        </Box>
      ) : null}

      {error ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            p: 3,
            textAlign: 'center',
            backgroundColor: 'background.default',
          }}
        >
          <Typography variant="body1" color="error" gutterBottom>
            {error.message}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Спробуйте завантажити оригінальний файл відео.
          </Typography>
        </Box>
      ) : null}
    </>
  );
}

const VIDEO_BLOB_CACHE_LIMIT = 50;
const videoBlobUrlCache = new Map<string, string>();

function getCachedVideoSrc(key: string): string | undefined {
  return videoBlobUrlCache.get(key);
}

function setCachedVideoSrc(key: string, src: string) {
  if (videoBlobUrlCache.has(key)) {
    return;
  }
  if (videoBlobUrlCache.size >= VIDEO_BLOB_CACHE_LIMIT) {
    const oldestKey = videoBlobUrlCache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldSrc = videoBlobUrlCache.get(oldestKey);
      if (oldSrc && oldSrc.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(oldSrc);
        } catch {
          // ignore
        }
      }
      videoBlobUrlCache.delete(oldestKey);
    }
  }
  videoBlobUrlCache.set(key, src);
}

export function VideoAttachmentPreviewRenderer({
  onClose,
  video,
  navigation,
  isFullscreen,
  onFullscreenChange,
  isDownloadStarting,
  onDownloadStart,
}: {
  onClose: () => void;
  video: VideoPreviewSource;
  navigation: MessageCardPreviewNavigation;
  isFullscreen: boolean;
  onFullscreenChange: (isFullscreen: boolean) => void;
} & MessageCardDownloadGuardProps) {
  const [src, setSrc] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

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
  const previewConfig = getMessageCardAttachmentPreviewConfig('video');
  const canFullscreen = previewConfig.supportsFullscreen;
  const dialogIsFullscreen = canFullscreen && isFullscreen;
  const openHref = typeof video.source === 'string' ? video.source : null;
  const changeFullscreen = useCallback(
    (value: boolean) => onFullscreenChange(value),
    [onFullscreenChange],
  );

  useEffect(() => {
    const cacheKey =
      typeof video.source === 'string'
        ? video.source
        : video.id || `${video.name}-${video.sizeBytes ?? 0}`;

    const cachedSrc = getCachedVideoSrc(cacheKey);
    if (cachedSrc) {
      setSrc(cachedSrc);
      return;
    }

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
          setCachedVideoSrc(cacheKey, source);
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
            setCachedVideoSrc(cacheKey, blobUrl);
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
        };
      }
      if (video.source.startsWith('/') || video.source.startsWith('data:')) {
        setCachedVideoSrc(cacheKey, video.source);
        setSrc(video.source);
        return;
      }
      if (video.source.startsWith('blob:')) {
        setCachedVideoSrc(cacheKey, video.source);
        setSrc(video.source);
        return;
      }
    }

    let isMounted = true;

    const source =
      typeof video.source === 'string' ? video.source : URL.createObjectURL(video.source);

    if (typeof video.source !== 'string') {
      setCachedVideoSrc(cacheKey, source);
      setSrc(source);
    } else {
      fetch(source)
        .then((res) => {
          handleUnauthorizedMediaResponse(res, source);
          if (!res.ok) throw new Error('Video fetch failed');
          return res.blob();
        })
        .then((blob) => {
          if (!isMounted) return;
          const createdUrl = URL.createObjectURL(blob);
          setCachedVideoSrc(cacheKey, createdUrl);
          setSrc(createdUrl);
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
    };
  }, [video.source, video.sizeBytes, video.id, video.name]);

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
  }, [video]);

  useEffect(() => {
    if (!src) return;
    const v = videoRef.current;
    if (!v) return;
    v.play().catch(() => {});
  }, [src]);

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
    changeFullscreen(!dialogIsFullscreen);
  }, [canFullscreen, changeFullscreen, dialogIsFullscreen]);

  const handleClose = useCallback(() => {
    const v = videoRef.current;
    if (v) v.pause();
    changeFullscreen(false);
    onClose();
  }, [changeFullscreen, onClose]);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideControlsTimerRef = useRef<number | null>(null);

  const resetHideControlsTimer = useCallback(() => {
    setControlsVisible(true);

    if (hideControlsTimerRef.current !== null) {
      window.clearTimeout(hideControlsTimerRef.current);
      hideControlsTimerRef.current = null;
    }

    if (playerState.isPlaying) {
      hideControlsTimerRef.current = window.setTimeout(() => {
        setControlsVisible(false);
        hideControlsTimerRef.current = null;
      }, 2000);
    }
  }, [playerState.isPlaying]);

  useEffect(() => {
    resetHideControlsTimer();
    return () => {
      if (hideControlsTimerRef.current !== null) {
        window.clearTimeout(hideControlsTimerRef.current);
        hideControlsTimerRef.current = null;
      }
    };
  }, [playerState.isPlaying, resetHideControlsTimer]);

  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    setZoom(100);
    setPan({ x: 0, y: 0 });
  }, [navigation.index, video.source]);

  useEffect(() => {
    if (stageEl === null) return;

    let touchStartDist = 0;
    let touchStartZoom = 100;

    const handleStageWheelNative = (event: WheelEvent) => {
      if (isInteractivePreviewTarget(event.target)) return;

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setZoom((currentZoom) => {
          const nextZoom = getNextWheelZoom(
            currentZoom,
            event.deltaY,
            event.deltaMode,
            stageEl.clientHeight,
          );
          if (nextZoom === 100) {
            setPan({ x: 0, y: 0 });
          }
          return nextZoom;
        });
      }
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        const t1 = event.touches[0];
        const t2 = event.touches[1];
        if (!t1 || !t2) return;
        touchStartDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        setZoom((currentZoom) => {
          touchStartZoom = currentZoom;
          return currentZoom;
        });
      }
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length === 2 && touchStartDist > 0) {
        event.preventDefault();
        const t1 = event.touches[0];
        const t2 = event.touches[1];
        if (!t1 || !t2) return;
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const scale = dist / touchStartDist;
        const clamped = clamp(touchStartZoom * scale, 100, 400);
        if (clamped === 100) {
          setPan({ x: 0, y: 0 });
        }
        setZoom(clamped);
      }
    };

    const handleTouchEnd = () => {
      touchStartDist = 0;
    };

    let gestureStartZoom = 100;

    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      setZoom((currentZoom) => {
        gestureStartZoom = currentZoom;
        return currentZoom;
      });
    };

    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      const gestureEvent = event as unknown as { scale: number };
      if (typeof gestureEvent.scale === 'number') {
        const clamped = clamp(gestureStartZoom * gestureEvent.scale, 100, 400);
        if (clamped === 100) {
          setPan({ x: 0, y: 0 });
        }
        setZoom(clamped);
      }
    };

    const handleGestureEnd = (event: Event) => {
      event.preventDefault();
    };

    stageEl.addEventListener('wheel', handleStageWheelNative, { passive: false });
    stageEl.addEventListener('gesturestart', handleGestureStart, { passive: false });
    stageEl.addEventListener('gesturechange', handleGestureChange, { passive: false });
    stageEl.addEventListener('gestureend', handleGestureEnd, { passive: false });
    stageEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    stageEl.addEventListener('touchmove', handleTouchMove, { passive: false });
    stageEl.addEventListener('touchend', handleTouchEnd, { passive: true });
    stageEl.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      stageEl.removeEventListener('wheel', handleStageWheelNative);
      stageEl.removeEventListener('gesturestart', handleGestureStart);
      stageEl.removeEventListener('gesturechange', handleGestureChange);
      stageEl.removeEventListener('gestureend', handleGestureEnd);
      stageEl.removeEventListener('touchstart', handleTouchStart);
      stageEl.removeEventListener('touchmove', handleTouchMove);
      stageEl.removeEventListener('touchend', handleTouchEnd);
      stageEl.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [stageEl]);

  const handleStageDoubleClick = () => {
    setZoom((currentZoom) => {
      if (currentZoom > 100) {
        setPan({ x: 0, y: 0 });
        return 100;
      }
      return 150;
    });
  };

  const stage = (
    <MessageCardAttachmentPreviewStage
      ref={setStageEl}
      kind="video"
      isFullscreen={dialogIsFullscreen}
      onPointerDown={resetHideControlsTimer}
      onDoubleClick={handleStageDoubleClick}
    >
      <Box
        onMouseMove={resetHideControlsTimer}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          position: 'relative',
        }}
      >
        <VideoPreview
          videoRef={videoRef}
          src={src}
          error={playerState.error}
          zoom={zoom}
          pan={pan}
          onPlay={() => setPlayerState((state) => ({ ...state, isPlaying: true }))}
          onPause={() => setPlayerState((state) => ({ ...state, isPlaying: false }))}
          onEnded={() => setPlayerState((state) => ({ ...state, isPlaying: false }))}
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            setPlayerState((state) => ({
              ...state,
              duration: Number.isFinite(element.duration) ? element.duration : 0,
            }));
          }}
          onTimeUpdate={(event) => {
            const element = event.currentTarget;
            setPlayerState((state) => ({ ...state, currentTime: element.currentTime }));
          }}
          onVolumeChange={(event) => {
            const element = event.currentTarget;
            setPlayerState((state) => ({
              ...state,
              volume: element.volume,
              muted: element.muted,
            }));
          }}
          onRateChange={(event) => {
            const element = event.currentTarget;
            setPlayerState((state) => ({
              ...state,
              playbackRate: element.playbackRate as 0.5 | 1 | 1.5 | 2,
            }));
          }}
          onError={(event) => {
            setPlayerState((state) => ({
              ...state,
              error: {
                code: 'VIDEO_LOAD_ERROR',
                message: 'Не вдалося завантажити або відтворити це відео.',
                cause: event,
              },
            }));
          }}
        />
      </Box>
      <AttachmentPreviewZoomBadge
        zoom={zoom}
        onResetZoom={() => {
          setZoom(100);
          setPan({ x: 0, y: 0 });
        }}
      />
    </MessageCardAttachmentPreviewStage>
  );
  const controls = (
    <Box
      onMouseMove={resetHideControlsTimer}
      sx={{
        opacity: controlsVisible || !playerState.isPlaying ? 1 : 0,
        transition: 'opacity 300ms ease-out',
        pointerEvents: controlsVisible || !playerState.isPlaying ? 'auto' : 'none',
        width: '100%',
      }}
    >
      <AttachmentPreviewPlaybackControls
        playerState={{ ...playerState, isFullscreen: dialogIsFullscreen }}
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
    </Box>
  );

  const header = (
    <MessageCardAttachmentPreviewHeader
      fileName={video.name}
      openHref={openHref}
      download={{ onDownload: () => downloadOriginalVideo(video) }}
      navigation={navigation}
      onClose={handleClose}
      onInfoClick={(event) => setInfoAnchorEl(event.currentTarget)}
      isFullscreen={dialogIsFullscreen}
      canFullscreen={canFullscreen}
      onToggleFullscreen={handleToggleFullscreen}
      downloadKey={`media:${String(video.id ?? '')}`}
      isDownloadStarting={isDownloadStarting}
      onDownloadStart={onDownloadStart}
    />
  );
  const infoPopover = (
    <MessageCardAttachmentPreviewInfoPopover
      open={infoOpen}
      anchorEl={infoAnchorEl}
      onClose={() => setInfoAnchorEl(null)}
      fields={[
        {
          label: 'URL',
          value: typeof video.source === 'string' ? video.source : 'Local File',
        },
        { label: 'Файл', value: video.name },
        { label: 'Тип', value: video.mimeType?.trim() || '—' },
        {
          label: 'Розмір файлу',
          value: video.sizeBytes != null ? formatSizeBytes(video.sizeBytes) : '—',
        },
        { label: 'Тривалість', value: formatVideoTime(playerState.duration) },
        ...(video.id?.trim() ? [{ label: 'ID', value: video.id.trim() }] : []),
      ]}
    />
  );

  return (
    <MessageCardAttachmentPreviewLayout
      isFullscreen={dialogIsFullscreen}
      config={previewConfig}
      stage={stage}
      controls={controls}
      header={header}
      infoPopover={infoPopover}
      navigation={navigation}
      swipeEnabled={zoom <= 100}
      onToggleFullscreen={handleToggleFullscreen}
    />
  );
}
