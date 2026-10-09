import { Box } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { VideoPreviewSource, VideoPlayerState } from '../message-card-video-utils';
import { VideoFilePreview } from './VideoFilePreview';
import { downloadOriginalVideo, formatVideoTime } from '../message-card-video-utils';
import { clamp, formatSizeBytes } from '../message-card-image-utils';
import { getNextWheelZoom, isInteractivePreviewTarget } from '../message-card-image-preview-utils';
import { AttachmentPreviewZoomBadge } from '../attachment-preview/AttachmentPreviewZoomBadge';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import { AttachmentPreviewPlaybackControls } from '../attachment-preview/MessageCardAttachmentPreviewControls';
import { MessageCardAttachmentPreviewInfoPopover } from '../attachment-preview/MessageCardAttachmentPreviewInfoPopover';
import { MessageCardAttachmentPreviewStage } from '../attachment-preview/MessageCardAttachmentPreviewStage';
import { loadManagedVideo } from '../message-card-video-loading';
import { handleUnauthorizedMediaResponse } from '../message-card-media-fetch';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import type { MessageCardDownloadGuardProps } from '../MessageCardMedia';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';
import {
  ReportTextPreviewAction,
  ReportTextPreviewLayout,
  type AttachmentPreviewReportDraft,
  type AttachmentPreviewReportVisibility,
} from '../attachment-preview/ReportTextPreview';

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
  isDownloadStarting,
  onDownloadStart,
  onChildOverlayChange,
  dismissChildOverlay,
  reportDraft,
  reportVisible,
  onReportVisibleChange,
}: {
  onClose: () => void;
  video: VideoPreviewSource;
  navigation: MessageCardPreviewNavigation;
  onChildOverlayChange?: (open: boolean) => void;
  dismissChildOverlay?: number;
  reportDraft?: AttachmentPreviewReportDraft;
} & MessageCardDownloadGuardProps &
  AttachmentPreviewReportVisibility) {
  const [src, setSrc] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [needsPlayGesture, setNeedsPlayGesture] = useState(false);

  const [infoAnchorEl, setInfoAnchorEl] = useState<HTMLButtonElement | null>(null);
  const infoOpen = infoAnchorEl !== null;
  useEffect(() => onChildOverlayChange?.(infoOpen), [infoOpen, onChildOverlayChange]);
  useEffect(() => {
    if (dismissChildOverlay) setInfoAnchorEl(null);
  }, [dismissChildOverlay]);

  const [playerState, setPlayerState] = useState<VideoPlayerState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    playbackRate: 1,
  });
  const openHref = typeof video.source === 'string' ? video.source : null;

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
      if (
        video.source.startsWith('/api/messenger/media/') &&
        !video.source.includes('/thumbnail')
      ) {
        return loadManagedVideo(
          video.source,
          (url) => {
            setCachedVideoSrc(cacheKey, url);
            setSrc(url);
          },
          (cause) =>
            setPlayerState((state) => ({
              ...state,
              error: { code: 'VIDEO_LOAD_ERROR', message: 'Не вдалося завантажити відео.', cause },
            })),
        );
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
  }, [video.source, video.sizeBytes, video.id, video.name, loadAttempt]);

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
    setNeedsPlayGesture(false);
  }, [navigation.index, video.source]);

  const requestPlay = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    void element
      .play()
      .then(() => setNeedsPlayGesture(false))
      .catch((cause: unknown) => {
        if (videoRef.current !== element) return;
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
          setNeedsPlayGesture(true);
          return;
        }
        setPlayerState((state) => ({
          ...state,
          error: { code: 'VIDEO_PLAY_ERROR', message: 'Не вдалося відтворити відео.', cause },
        }));
      });
  }, []);

  useEffect(() => {
    if (src) requestPlay();
  }, [src, requestPlay]);

  const handlePlayPause = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    if (element.paused) requestPlay();
    else element.pause();
  }, [requestPlay]);

  const handleLoadTimeout = useCallback(() => {
    setPlayerState((state) => ({
      ...state,
      error: {
        code: 'VIDEO_LOAD_ERROR',
        message: 'Завантаження відео триває надто довго. Спробуйте ще раз.',
      },
    }));
  }, []);

  const retryLoad = useCallback(() => {
    if (typeof video.source === 'string') videoBlobUrlCache.delete(video.source);
    setSrc(null);
    setNeedsPlayGesture(false);
    setPlayerState((state) => ({ ...state, error: undefined, isPlaying: false }));
    setLoadAttempt((attempt) => attempt + 1);
  }, [video.source]);

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

  const handleClose = useCallback(() => {
    const v = videoRef.current;
    if (v) v.pause();
    onClose();
  }, [onClose]);
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
        playerState={playerState}
        videoRef={videoRef}
        onPlayPause={handlePlayPause}
        onStop={handleStop}
        onVolumeChange={handleVolumeChange}
        onMuteToggle={handleMuteToggle}
        onRateChange={handleRateChange}
        onSeek={handleSeek}
      />
    </Box>
  );

  const sourceStage = (
    <MessageCardAttachmentPreviewStage
      ref={setStageEl}
      kind="video"
      onPointerDown={resetHideControlsTimer}
      onDoubleClick={handleStageDoubleClick}
      onPrimaryClick={(_, region) => {
        if (region === 'background') handleClose();
      }}
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
        <VideoFilePreview
          videoRef={videoRef}
          src={src}
          onRetry={retryLoad}
          onRequestPlay={requestPlay}
          needsPlayGesture={needsPlayGesture}
          onLoadTimeout={handleLoadTimeout}
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
      <Box
        data-attachment-preview-video-controls
        onDoubleClick={(event) => event.stopPropagation()}
        sx={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 1300,
          width: '100%',
          pointerEvents: 'none',
          '& > *': {
            pointerEvents: 'auto',
          },
        }}
      >
        {controls}
      </Box>
    </MessageCardAttachmentPreviewStage>
  );
  const stage = (
    <ReportTextPreviewLayout source={sourceStage} draft={reportDraft} visible={reportVisible} />
  );

  const header = (
    <MessageCardAttachmentPreviewHeader
      fileName={video.name}
      openHref={openHref}
      download={{ onDownload: () => downloadOriginalVideo(video) }}
      navigation={navigation}
      additionalActions={
        reportDraft != null ? (
          <ReportTextPreviewAction
            kind={reportDraft.kind}
            active={reportVisible}
            onClick={() => onReportVisibleChange(!reportVisible)}
          />
        ) : null
      }
      onClose={handleClose}
      onInfoClick={(event) => {
        setInfoAnchorEl(event.currentTarget);
        onChildOverlayChange?.(true);
      }}
      downloadKey={`media:${String(video.id ?? '')}`}
      isDownloadStarting={isDownloadStarting}
      onDownloadStart={onDownloadStart}
    />
  );
  const infoPopover = (
    <MessageCardAttachmentPreviewInfoPopover
      open={infoOpen}
      anchorEl={infoAnchorEl}
      onClose={() => {
        setInfoAnchorEl(null);
        onChildOverlayChange?.(false);
      }}
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
      stage={stage}
      header={header}
      infoPopover={infoPopover}
      navigation={navigation}
      swipeEnabled={zoom <= 100}
    />
  );
}
