import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoPreviewSource, VideoPlayerState } from './message-card-video-utils';
import { MessageCardVideoPreviewStage } from './MessageCardVideoPreviewStage';
import {
  MessageCardVideoPreviewActions,
  MessageCardVideoPreviewControls,
} from './MessageCardVideoPreviewActions';
import { MessageCardVideoPreviewInfoPopover } from './MessageCardVideoPreviewInfoPopover';
import { getMessageCardPreviewShellConfig } from './message-card-preview-config';
import { MessageCardPreviewShell } from './MessageCardPreviewShell';

export function MessageCardVideoPreviewDialog({
  open,
  onClose,
  videos,
  initialIndex = 0,
  currentIndex,
  onIndexChange,
}: {
  open: boolean;
  onClose: () => void;
  videos: VideoPreviewSource[];
  initialIndex?: number;
  currentIndex?: number;
  onIndexChange?: (index: number) => void;
}) {
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
      if (
        !video.source.startsWith('blob:') &&
        !video.source.startsWith('data:') &&
        video.source.startsWith('/')
      ) {
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
  }, [open, video?.source]);

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
