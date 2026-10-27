import { isVideoPreviewStream, useVideoPreviewStream } from '../use-video-preview-stream';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { releaseNativeMedia } from '../attachment-preview/native-media-lifecycle';

export function VideoFilePreview({
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
  onRetry,
  onRequestPlay,
  needsPlayGesture,
  onLoadTimeout,
  onStreamError,
  loadTimeoutMs = 30_000,
  nativeControls = false,
}: {
  src: string | null;
  onRetry: () => void;
  onRequestPlay: () => void;
  needsPlayGesture: boolean;
  onLoadTimeout: () => void;
  onStreamError?: (cause: unknown) => void;
  error?: { message: string };
  loadTimeoutMs?: number;
  nativeControls?: boolean;
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
  useVideoPreviewStream(
    error ? null : src,
    videoRef,
    onRequestPlay,
    onStreamError ?? onLoadTimeout,
  );
  const [clickAction, setClickAction] = useState<'play' | 'pause'>('play');
  const [showIcon, setShowIcon] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const clickActionTimer = useRef<number | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const beginLoading = () => {
    setIsBuffering(true);
    setLoadAttempt((attempt) => attempt + 1);
  };

  useEffect(() => {
    if (!src || !isBuffering || error || needsPlayGesture) return;
    const timer = window.setTimeout(onLoadTimeout, loadTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [src, isBuffering, error, needsPlayGesture, onLoadTimeout, loadTimeoutMs, loadAttempt]);

  const hasSource = Boolean(src);
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video) releaseNativeMedia(video);
    };
  }, [hasSource, videoRef]);

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
          src={isVideoPreviewStream(src) ? undefined : src}
          controls={nativeControls}
          preload="metadata"
          playsInline
          onLoadStart={beginLoading}
          onWaiting={beginLoading}
          onSeeking={beginLoading}
          onSeeked={() => setIsBuffering(false)}
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
          onClick={
            nativeControls
              ? undefined
              : () => {
                  const video = videoRef.current;
                  if (!video) return;
                  if (clickActionTimer.current) window.clearTimeout(clickActionTimer.current);
                  if (video.paused) {
                    onRequestPlay();
                    setClickAction('play');
                  } else {
                    video.pause();
                    setClickAction('pause');
                  }
                  setShowIcon(true);
                  clickActionTimer.current = window.setTimeout(() => setShowIcon(false), 300);
                }
          }
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

      {(!src && !error) || (src && !error && isBuffering && !needsPlayGesture) ? (
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
            Завантаження відео
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

      {needsPlayGesture && !error ? (
        <Button onClick={onRequestPlay} sx={{ position: 'absolute', zIndex: 11 }}>
          Торкніться, щоб відтворити
        </Button>
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
          <Button onClick={onRetry}>Повторити завантаження</Button>
        </Box>
      ) : null}
    </>
  );
}
