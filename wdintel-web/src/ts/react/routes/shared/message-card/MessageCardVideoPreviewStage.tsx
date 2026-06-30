import {
  forwardRef,
  useState,
  useRef,
  useEffect,
  type SyntheticEvent,
} from "react";
import { Box, CircularProgress, Typography } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import type { VideoPreviewError } from "./message-card-video-utils";

export const MessageCardVideoPreviewStage = forwardRef<
  HTMLDivElement,
  {
    src: string | null;
    error?: VideoPreviewError;
    isPlaying: boolean;
    onPlay: () => void;
    onPause: () => void;
    onEnded: () => void;
    onLoadedMetadata?: (event: SyntheticEvent<HTMLVideoElement>) => void;
    onTimeUpdate?: (event: SyntheticEvent<HTMLVideoElement>) => void;
    onVolumeChange?: (event: SyntheticEvent<HTMLVideoElement>) => void;
    onRateChange?: (event: SyntheticEvent<HTMLVideoElement>) => void;
    onError?: (event: SyntheticEvent<HTMLVideoElement>) => void;
    videoRef: React.RefObject<HTMLVideoElement>;
    hasCarousel?: boolean;
    onGoToPrevious?: () => void;
    onGoToNext?: () => void;
  }
>(function MessageCardVideoPreviewStage(
  {
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
  },
  ref,
) {
  const [clickAction, setClickAction] = useState<"play" | "pause">("play");
  const [showIcon, setShowIcon] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const clickActionTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clickActionTimer.current)
        window.clearTimeout(clickActionTimer.current);
    };
  }, []);

  return (
    <Box
      ref={ref}
      className="bg-black ring-1 ring-inset ring-white/5"
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        borderRadius: 1.5,
        overflow: "hidden",
      }}
    >
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
            const v = videoRef.current;
            if (!v) return;
            if (clickActionTimer.current) {
              window.clearTimeout(clickActionTimer.current);
            }
            if (v.paused) {
              v.play().catch(console.error);
              setClickAction("play");
            } else {
              v.pause();
              setClickAction("pause");
            }
            setShowIcon(true);
            clickActionTimer.current = window.setTimeout(() => {
              setShowIcon(false);
            }, 300);
          }}
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            display: error ? "none" : "block",
            cursor: "pointer",
          }}
        />
      ) : null}

      {(!src && !error) || (src && !error && isBuffering) ? (
        <Box sx={{ position: 'absolute', inset: 0, zIndex: 2, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <CircularProgress size={22} />
        </Box>
      ) : null}

      {src && !error ? (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <Box
            className="bg-black/45 text-white/95 backdrop-blur-[2px] shadow-md shadow-black/30"
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 72,
              height: 72,
              borderRadius: "50%",
              opacity: showIcon ? 1 : 0,
              transform: showIcon ? "scale(1)" : "scale(1.3)",
              transition: showIcon
                ? "none"
                : "opacity 0.4s ease-out, transform 0.4s ease-out",
            }}
          >
            {clickAction === "play" ? (
              <PlayArrowIcon sx={{ fontSize: 44, ml: 0.5 }} />
            ) : (
              <PauseIcon sx={{ fontSize: 44 }} />
            )}
          </Box>
        </Box>
      ) : null}

      {error ? (
        <Box
          className="bg-black/80"
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            p: 3,
            textAlign: "center",
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
    </Box>
  );
});
