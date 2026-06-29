import DownloadIcon from "@mui/icons-material/Download";
import InfoIcon from "@mui/icons-material/Info";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import {
  Box,
  Button,
  DialogActions,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  VideoPreviewSource,
  VideoPlayerState,
} from "./message-card-video-utils";
import {
  formatVideoTime,
  downloadOriginalVideo,
} from "./message-card-video-utils";
import {
  PlayPauseButton,
  StopButton,
  VolumeControl,
  SpeedSelect,
  VideoProgressSlider,
} from "./MessageCardVideoControls";

export function MessageCardVideoPreviewControls({
  playerState,
  onPlayPause,
  onStop,
  onVolumeChange,
  onMuteToggle,
  onRateChange,
  onSeek,
  onToggleFullscreen,
  videoRef,
}: {
  playerState: VideoPlayerState;
  onPlayPause: () => void;
  onStop: () => void;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  onRateChange: (rate: 0.5 | 1 | 1.5 | 2) => void;
  onSeek: (time: number) => void;
  onToggleFullscreen: () => void;
  videoRef: React.RefObject<HTMLVideoElement>;
}) {
  const {
    isPlaying,
    currentTime,
    duration,
    volume,
    muted,
    playbackRate,
    isFullscreen,
  } = playerState;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        flex: 1,
        minWidth: 0,
        backgroundColor: "black",
        py: 1.5,
        px: 3,
        borderRadius: 2,
      }}
    >
      <PlayPauseButton isPlaying={isPlaying} onPlayPause={onPlayPause} />
      <StopButton onStop={onStop} />

      <Box
        sx={{
          flex: 1,
          mx: { xs: 1, sm: 2 },
          minWidth: 100,
          display: "flex",
          alignItems: "center",
        }}
      >
        <VideoProgressSlider
          currentTime={currentTime}
          duration={duration}
          onSeek={onSeek}
          videoRef={videoRef}
        />
      </Box>

      <Typography
        variant="body2"
        sx={{
          whiteSpace: "nowrap",
          color: "rgba(244, 247, 251, 0.8)",
          fontFamily: "monospace",
          mr: { xs: 1, sm: 1 },
        }}
      >
        {formatVideoTime(currentTime)} / {formatVideoTime(duration)}
      </Typography>

      <VolumeControl
        volume={volume}
        muted={muted}
        onVolumeChange={onVolumeChange}
        onMuteToggle={onMuteToggle}
      />

      <Box sx={{ mr: { xs: 0, sm: 1 }, ml: { xs: 1, sm: 1 } }}>
        <SpeedSelect
          playbackRate={playbackRate}
          onRateChange={onRateChange}
        />
      </Box>

      <Tooltip
        title={
          isFullscreen
            ? "Вийти з повноекранного режиму"
            : "Повноекранний режим"
        }
        enterDelay={300}
      >
        <IconButton
          size="small"
          onClick={onToggleFullscreen}
          sx={{ color: "inherit" }}
        >
          {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
        </IconButton>
      </Tooltip>
    </Box>
  );
}

export function MessageCardVideoPreviewActions({
  video,
  onClose,
  hasCarousel,
  resolvedIndex,
  videoCount,
  onGoToPrevious,
  onGoToNext,
  onInfoClick,
}: {
  video: VideoPreviewSource;
  onClose: () => void;
  hasCarousel: boolean;
  resolvedIndex: number;
  videoCount: number;
  onGoToPrevious?: () => void;
  onGoToNext?: () => void;
  onInfoClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <DialogActions
      sx={{
        px: 2,
        py: "20px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 2,
      }}
    >
      <Box sx={{ flex: 1, display: "flex", justifyContent: "flex-start", gap: 0.5 }}>
        <Tooltip title="Інформація" enterDelay={300}>
          <IconButton
            size="small"
            onClick={onInfoClick}
            sx={{ color: "rgba(244, 247, 251, 0.72)" }}
          >
            <InfoIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Завантажити" enterDelay={300}>
          <IconButton
            size="small"
            onClick={() => downloadOriginalVideo(video)}
            sx={{ color: "rgba(244, 247, 251, 0.72)" }}
          >
            <DownloadIcon />
          </IconButton>
        </Tooltip>
      </Box>
      {hasCarousel && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Tooltip title="Попереднє" enterDelay={300}>
            <IconButton
              size="small"
              onClick={onGoToPrevious}
              sx={{ color: "rgba(244, 247, 251, 0.72)" }}
            >
              <ChevronLeftIcon />
            </IconButton>
          </Tooltip>
          <Typography
            variant="body2"
            sx={{
              color: "rgba(244, 247, 251, 0.72)",
              fontWeight: 700,
              letterSpacing: 0,
              px: 1,
              py: 0.25,
              borderRadius: 1,
              border: "1px solid rgba(244, 247, 251, 0.12)",
              backgroundColor: "rgba(244, 247, 251, 0.08)",
            }}
          >
            {`${resolvedIndex + 1} / ${videoCount}`}
          </Typography>
          <Tooltip title="Наступне" enterDelay={300}>
            <IconButton
              size="small"
              onClick={onGoToNext}
              sx={{ color: "rgba(244, 247, 251, 0.72)" }}
            >
              <ChevronRightIcon />
            </IconButton>
          </Tooltip>
        </Box>
      )}
      <Box sx={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
        <Button onClick={onClose} sx={{ flexShrink: 0, ml: 1 }}>
          Закрити
        </Button>
      </Box>
    </DialogActions>
  );
}
